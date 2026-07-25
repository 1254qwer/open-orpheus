#![deny(clippy::all)]

use std::{
    cmp::Ordering,
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};

use napi::{
    bindgen_prelude::{Array, Object, ToNapiValue},
    Env, Error, JsValue, Result, Unknown,
};
use napi_derive::napi;
use rusqlite::{fallible_iterator::FallibleIterator, types::Value, Batch, Connection};
use threadpool::ThreadPool;

use crate::values::{js_to_rusqlite_value, value_to_js_string, value_to_js_value};

mod collation;
mod values;

/// Unwrap a `Result<T, napi::Error>`, or reject the deferred promise and return.
macro_rules! try_or_reject {
    ($expr:expr, $deferred:ident) => {
        match $expr {
            Ok(val) => val,
            Err(err) => {
                $deferred.reject(err);
                return;
            }
        }
    };
}

#[napi]
pub struct Database {
    pool: ThreadPool,
    conn: Arc<Mutex<Connection>>,
}

#[napi]
impl Database {
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let pool = ThreadPool::new(1); // We are locking all along, so simply single threaded pool
        let conn = Connection::open(path).map_err(|err| Error::from_reason(err.to_string()))?;

        // Register custom collations so SQL referencing COLLATE pinyin_desc / pinyin_asc works.
        let _ = conn.create_collation("pinyin_desc", |a: &str, b: &str| -> Ordering {
            collation::compare_pinyin(a, b).reverse()
        });
        let _ = conn.create_collation("pinyin_asc", collation::compare_pinyin);

        Ok(Self {
            pool,
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Execute a single SQL statement with named parameters.
    #[napi(ts_return_type = "Promise<[number, Record<string, unknown>[]]>")]
    pub fn exec_named<'env>(
        &self,
        env: &'env Env,
        sql: String,
        #[napi(ts_arg_type = "Record<string, unknown>")] parameters: Object,
    ) -> Result<Object<'env>> {
        let (deferred, object) = env.create_deferred()?;
        let conn = self.conn.clone();
        let keys = Object::keys(&parameters)?;
        let mut param_values: Vec<(String, Value)> = Vec::with_capacity(keys.len());

        for raw_key in keys {
            let val = parameters.get::<Unknown>(&raw_key)?.unwrap();
            let key =
                if raw_key.starts_with(':') || raw_key.starts_with('@') || raw_key.starts_with('$')
                {
                    raw_key
                } else {
                    format!(":{}", raw_key)
                };
            let rusqlite_val = js_to_rusqlite_value(val)?;
            param_values.push((key, rusqlite_val));
        }
        self.pool.execute(move || {
            let param_refs: Vec<(&str, &dyn rusqlite::types::ToSql)> = param_values
                .iter()
                .map(|(k, v)| (k.as_str(), v as &dyn rusqlite::types::ToSql))
                .collect();

            let conn = try_or_reject!(
                conn.lock().map_err(|e| Error::from_reason(e.to_string())),
                deferred
            );

            let mut stmt = try_or_reject!(
                conn.prepare(&sql)
                    .map_err(|e| Error::from_reason(e.to_string())),
                deferred
            );

            let column_count = stmt.column_count();
            let mut column_names = Vec::with_capacity(column_count);
            for i in 0..column_count {
                let name = try_or_reject!(
                    stmt.column_name(i).map_err(|err| {
                        Error::from_reason(format!(
                            "Failed to get column name for index{}: {}",
                            i, err
                        ))
                    }),
                    deferred
                );
                column_names.push(name.to_string());
            }

            let prev_changes = conn.total_changes();

            let mut rows = try_or_reject!(
                stmt.query(&param_refs[..])
                    .map_err(|err| Error::from_reason(format!(
                        "Failed to execute SQL: {} - {}",
                        err, sql
                    ))),
                deferred
            );

            let mut results = Vec::new();
            loop {
                let row = try_or_reject!(
                    rows.next().map_err(|e| Error::from_reason(e.to_string())),
                    deferred
                );
                match row {
                    Some(row) => {
                        let mut row_obj = HashMap::new();
                        for (i, col_name) in column_names.iter().enumerate() {
                            let val = row.get(i).unwrap();
                            row_obj.insert(col_name.clone(), val);
                        }
                        results.push(row_obj);
                    }
                    None => break,
                }
            }

            let row_affected = conn.total_changes() - prev_changes;

            deferred.resolve(move |env| {
                let mut result = env.create_array(2)?;
                result.set(0, row_affected as f64)?;

                let mut result_rows = env.create_array(results.len() as u32)?;
                for (i, row) in results.into_iter().enumerate() {
                    let mut row_obj = Object::new(&env)?;
                    for (col_name, val) in row.iter() {
                        row_obj.set(col_name, value_to_js_value(&env, val))?;
                    }
                    result_rows.set(i as u32, row_obj).unwrap();
                }
                result.set(1, result_rows).unwrap();

                Ok(result.raw())
            });
        });
        Ok(object)
    }

    /// Execute a single SQL statement with positional (`?`) parameters.
    #[napi(ts_return_type = "Promise<[number, Record<string, unknown>[]]>")]
    pub fn exec<'env>(
        &self,
        env: &'env Env,
        sql: String,
        parameters: Array,
    ) -> Result<Object<'env>> {
        let (deferred, object) = env.create_deferred()?;
        let mut param_values: Vec<Value> = Vec::with_capacity(parameters.len() as usize);

        for i in 0..parameters.len() {
            let param: Unknown = parameters.get(i)?.unwrap();
            param_values.push(js_to_rusqlite_value(param)?);
        }

        let conn = self.conn.clone();
        self.pool.execute(move || {
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = param_values
                .iter()
                .map(|v| v as &dyn rusqlite::types::ToSql)
                .collect();

            let conn = try_or_reject!(
                conn.lock().map_err(|e| Error::from_reason(e.to_string())),
                deferred
            );

            let mut stmt = try_or_reject!(
                conn.prepare(&sql)
                    .map_err(|e| Error::from_reason(e.to_string())),
                deferred
            );

            let column_count = stmt.column_count();
            let mut column_names = Vec::with_capacity(column_count);
            for i in 0..column_count {
                let name = try_or_reject!(
                    stmt.column_name(i).map_err(|err| {
                        Error::from_reason(format!(
                            "Failed to get column name for index{}: {}",
                            i, err
                        ))
                    }),
                    deferred
                );
                column_names.push(name.to_string());
            }

            let prev_changes = conn.total_changes();

            let mut rows = try_or_reject!(
                stmt.query(&param_refs[..])
                    .map_err(|err| Error::from_reason(format!(
                        "Failed to execute SQL: {} - {}",
                        err, sql
                    ))),
                deferred
            );

            let mut results = Vec::new();
            loop {
                let row = try_or_reject!(
                    rows.next().map_err(|e| Error::from_reason(e.to_string())),
                    deferred
                );
                match row {
                    Some(row) => {
                        let mut row_obj = HashMap::new();
                        for (i, col_name) in column_names.iter().enumerate() {
                            let val = row.get(i).unwrap();
                            row_obj.insert(col_name.clone(), val);
                        }
                        results.push(row_obj);
                    }
                    None => break,
                }
            }

            let row_affected = conn.total_changes() - prev_changes;

            deferred.resolve(move |env| {
                let mut result = env.create_array(2)?;
                result.set(0, row_affected as f64)?;

                let mut result_rows = env.create_array(results.len() as u32)?;
                for (i, row) in results.into_iter().enumerate() {
                    let mut row_obj = Object::new(&env)?;
                    for (col_name, val) in row.iter() {
                        row_obj.set(col_name, value_to_js_value(&env, val))?;
                    }
                    result_rows.set(i as u32, row_obj).unwrap();
                }
                result.set(1, result_rows).unwrap();

                Ok(result.raw())
            });
        });
        Ok(object)
    }

    fn execute_sql_impl(
        conn: &Connection,
        sql: String,
    ) -> Result<impl FnOnce(Env) -> Result<napi::sys::napi_value>> {
        let t0 = Instant::now();

        let mut batch = Batch::new(conn, &sql);
        let mut results = Vec::new();
        let prev_changes = conn.total_changes();

        let t1 = Instant::now();

        loop {
            match batch.next() {
                Ok(Some(mut stmt)) => {
                    let column_count = stmt.column_count();
                    let mut column_names = Vec::with_capacity(column_count);
                    for i in 0..column_count {
                        let name = stmt.column_name(i).map_err(|err| {
                            Error::from_reason(format!(
                                "Failed to get column name for index{}: {}",
                                i, err
                            ))
                        })?;
                        column_names.push(name.to_string());
                    }
                    let mut rows = stmt.query([]).map_err(|err| {
                        Error::from_reason(format!("Failed to execute SQL: {} - {}", err, sql))
                    })?;
                    loop {
                        match rows.next() {
                            Ok(Some(row)) => {
                                let mut row_obj = HashMap::new();
                                for (i, col_name) in column_names.iter().enumerate() {
                                    let val = row.get(i).unwrap();
                                    row_obj.insert(col_name.clone(), val);
                                }
                                results.push(row_obj);
                            }
                            Ok(None) => break,
                            Err(err) => {
                                return Err(Error::from_reason(err.to_string()));
                            }
                        }
                    }
                }
                Ok(None) => break, // Finished
                Err(err) => {
                    return Err(Error::from_reason(err.to_string()));
                }
            }
        }

        let t2 = Instant::now();

        let row_affected = conn.total_changes() - prev_changes;

        Ok(move |env: Env| {
            let mut result = env.create_array(3)?;
            result.set(0, 0)?;

            if results.is_empty() {
                result.set(1, ())?; // Undefined
            } else {
                let mut result_rows = env.create_array(results.len() as u32)?;
                for (i, row) in results.into_iter().enumerate() {
                    let mut row_obj = Object::new(&env)?;
                    for (col_name, val) in row.iter() {
                        row_obj.set(col_name, value_to_js_string(&env, val))?;
                    }
                    result_rows.set(i as u32, row_obj).unwrap();
                }
                result.set(1, result_rows)?;
            }

            let mut perf = env.create_array(3)?;
            perf.set(0, (t2 - t0).as_millis() as u32).unwrap();
            perf.set(1, (t1 - t0).as_millis() as u32).unwrap();
            perf.set(2, row_affected as f64).unwrap();
            result.set(2, perf).unwrap();

            Ok(result.raw())
        })
    }

    /// Execute SQL string, returns an array of objects representing rows,
    /// and an array of performance info (total time, execution time, rows affected).
    ///
    /// For NCM, not intended for Open Orpheus.
    #[napi(
        ts_return_type = "Promise<[number, Record<string, string>[], [number, number, number]]>"
    )]
    pub fn execute_sql<'env>(&self, env: &'env Env, sql: String) -> Result<Object<'env>> {
        let (deferred, object) = env.create_deferred()?;
        let conn = self.conn.clone();
        self.pool.execute(move || {
            let conn = try_or_reject!(
                conn.lock().map_err(|e| Error::from_reason(e.to_string())),
                deferred
            );
            match Database::execute_sql_impl(&conn, sql) {
                Ok(x) => {
                    deferred.resolve(x);
                }
                Err(err) => {
                    deferred.reject(err);
                }
            };
        });
        Ok(object)
    }

    /// Execute a SQL contains multiple statements as one transaction.
    ///
    /// For NCM, not intended for Open Orpheus.
    #[napi(
        ts_return_type = "Promise<[number, Record<string, string>[], [number, number, number]]>"
    )]
    pub fn execute_transaction<'env>(
        &mut self,
        env: &'env Env,
        sql: String,
    ) -> Result<Object<'env>> {
        let (deferred, object) = env.create_deferred()?;
        let conn = self.conn.clone();
        self.pool.execute(move || {
            let mut conn = try_or_reject!(
                conn.lock().map_err(|e| Error::from_reason(e.to_string())),
                deferred
            );
            let tx = try_or_reject!(
                conn.transaction()
                    .map_err(|e| Error::from_reason(e.to_string())),
                deferred
            );
            match Database::execute_sql_impl(&tx, sql) {
                Ok(resolver) => {
                    match tx
                        .commit()
                        .map_err(|err| Error::from_reason(err.to_string()))
                    {
                        Ok(_) => {
                            deferred.resolve(resolver);
                        }
                        Err(err) => {
                            deferred.reject(err);
                        }
                    };
                }
                Err(err) => {
                    let _ = tx.rollback(); // Rollback first before rejecting
                    deferred.reject(err);
                }
            };
        });
        Ok(object)
    }

    /// Execute multiple SQL statements inside an array, returns values of the last statement as an array.
    ///
    /// ## Example return
    /// ```json
    /// {
    ///    "value": [
    ///        [
    ///            "a",
    ///            "b"
    ///        ]
    ///}
    /// ```
    ///
    /// For NCM, not intended for Open Orpheus.
    #[napi(ts_return_type = "Promise<{ value: string[][] }>")]
    pub fn execute_sqls<'env>(
        &self,
        env: &'env Env,
        #[napi(ts_arg_type = "string[]")] sqls: Array,
    ) -> Result<Object<'env>> {
        let (deferred, object) = env.create_deferred()?;

        let mut stmts = Vec::with_capacity(sqls.len() as usize);

        for i in 0..sqls.len() {
            let sql: String = sqls.get(i)?.unwrap();
            stmts.push(sql);
        }

        let conn = self.conn.clone();

        self.pool.execute(move || {
            let conn = try_or_reject!(
                conn.lock().map_err(|e| Error::from_reason(e.to_string())),
                deferred
            );
            let mut results = Vec::new();
            for (i, sql) in stmts.iter().enumerate() {
                let mut stmt = try_or_reject!(
                    conn.prepare(sql).map_err(|err| Error::from_reason(format!(
                        "Failed to execute SQL: {} - {}",
                        err, sql
                    ))),
                    deferred
                );
                if i != stmts.len() - 1 {
                    // For all statements except the last one, we just execute them without fetching results
                    let _ = try_or_reject!(
                        stmt.query([]).map_err(|err| {
                            Error::from_reason(format!(
                                "Failed to execute SQL statement: {} - {}",
                                err, sql
                            ))
                        }),
                        deferred
                    );
                } else {
                    // For the last statement, we execute it and fetch results
                    let column_count = stmt.column_count();
                    let mut rows = try_or_reject!(
                        stmt.query([]).map_err(|err| {
                            Error::from_reason(format!(
                                "Failed to execute SQL statement: {} - {}",
                                err, sql
                            ))
                        }),
                        deferred
                    );
                    loop {
                        let row = try_or_reject!(
                            rows.next().map_err(|e| Error::from_reason(e.to_string())),
                            deferred
                        );
                        match row {
                            Some(row) => {
                                let mut row_arr = Vec::new();
                                for i in 0..column_count {
                                    let val = row.get(i).unwrap();
                                    row_arr.push(val);
                                }
                                results.push(row_arr);
                            }
                            None => break,
                        }
                    }
                }
            }
            deferred.resolve(move |env| {
                let value = if results.is_empty() {
                    Some(().into_unknown(&env)?) // Undefined
                } else {
                    let mut result_array = env.create_array(results.len() as u32)?;
                    for (i, row) in results.into_iter().enumerate() {
                        let mut row_obj = env.create_array(row.len() as u32)?;
                        for (i, val) in row.iter().enumerate() {
                            row_obj.set(i as u32, value_to_js_string(&env, val))?;
                        }
                        result_array.set(i as u32, row_obj).unwrap();
                    }
                    Some(result_array.into_unknown(&env)?)
                };
                let mut result = Object::new(&env)?;
                result.set("value", value.unwrap()).unwrap();
                Ok(result)
            });
        });

        Ok(object)
    }
}
