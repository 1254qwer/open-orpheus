use std::{
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

use crate::linux::Rect;

use super::super::proxy::{Sink, sink_for};
use super::codec::*;
use super::state::*;

/// Drag the given X11 window by synthesizing the `_NET_WM_MOVERESIZE`
/// protocol: UngrabPointer + SendEvent(ClientMessage) + GetInputFocus.
pub(crate) fn move_window(conn: &mut X11Conn, sink: &Sink, window: u32) -> bool {
    let Some(atom) = conn.net_wm_moveresize else {
        return false;
    };
    if conn.root_window == 0 {
        return false;
    }

    // Three injected requests: UngrabPointer, SendEvent, GetInputFocus.
    conn.begin_injected_requests(3);

    // Synthesize a matching ButtonRelease so the client doesn't see a stuck press.
    if let Some(release) = conn
        .last_button_press
        .as_ref()
        .and_then(|p| build_release(p, conn.is_le))
    {
        conn.pending_inbound.extend_from_slice(&release);
    }

    let payload = build_moveresize_move_payload(conn, window, atom);
    sink.send_to_server(&payload)
}

/// Core ButtonPress → ButtonRelease; XI2 ButtonPress → ButtonRelease.
fn build_release(press: &[u8], is_le: bool) -> Option<Vec<u8>> {
    let mut release = press.to_vec();
    let code = release[0] & 0x7F;
    if code == 4 {
        release[0] = (release[0] & 0x80) | 5;
    } else if code == 35 && release.len() >= 10 {
        write_u16(&mut release[8..10], 5, is_le);
    }
    Some(release)
}

fn build_moveresize_move_payload(conn: &X11Conn, window: u32, atom: u32) -> Vec<u8> {
    let is_le = conn.is_le;
    let mut p = vec![0u8; 56];

    // 1) UngrabPointer — release any active button grab before the move.
    p[0] = 27;
    write_u16(&mut p[2..4], 2, is_le); // request length: 2 words
    write_u32(&mut p[4..8], 0, is_le); // grab window = PointerWindow

    // 2) SendEvent wrapping a ClientMessage(_NET_WM_MOVERESIZE).
    p[8] = 25;
    p[9] = 0; // propagate = false
    write_u16(&mut p[10..12], 11, is_le); // request length: 11 words
    write_u32(&mut p[12..16], conn.root_window, is_le);
    write_u32(&mut p[16..20], 0x180000, is_le); // SubstructureRedirect | SubstructureNotify

    p[20] = 33; // ClientMessage
    p[21] = 32; // format = 32-bit
    write_u16(&mut p[22..24], 0, is_le); // sequence — filled in by the server
    write_u32(&mut p[24..28], window, is_le);
    write_u32(&mut p[28..32], atom, is_le); // _NET_WM_MOVERESIZE
    write_u32(&mut p[32..36], conn.root_x as u32, is_le);
    write_u32(&mut p[36..40], conn.root_y as u32, is_le);
    write_u32(&mut p[40..44], 8, is_le); // direction = _NET_WM_MOVERESIZE_MOVE
    write_u32(&mut p[44..48], conn.button as u32, is_le);
    write_u32(&mut p[48..52], 1, is_le); // source = application

    // 3) GetInputFocus — force an immediate reply so the client's poll/select
    //    wakes and flushes the queued synthetic ButtonRelease; its reply is
    //    dropped via injected_seqs tracking in filter.rs.
    p[52] = 43;
    p[53] = 0; // pad
    write_u16(&mut p[54..56], 1, is_le); // request length: 1 word

    p
}

pub(crate) fn set_input_region(
    conn: &mut X11Conn,
    sink: &Sink,
    window: u32,
    rects: Option<&[Rect]>,
) -> bool {
    let Some(shape_opcode) = conn.shape_opcode else {
        return false;
    };

    conn.begin_injected_requests(1);

    let is_le = conn.is_le;

    if let Some(rects) = rects {
        let num_rects = rects.len();
        let length = 4 + num_rects * 2;
        let mut payload = vec![0u8; length * 4];

        payload[0] = shape_opcode;
        payload[1] = 1; // ShapeRectangles
        write_u16(&mut payload[2..4], length as u16, is_le);
        payload[4] = 0; // operation = ShapeSet
        payload[5] = 2; // destination_kind = ShapeInput
        payload[6] = 0; // ordering = UnSorted
        payload[7] = 0; // pad
        write_u32(&mut payload[8..12], window, is_le);
        write_u16(&mut payload[12..14], 0, is_le); // x_offset
        write_u16(&mut payload[14..16], 0, is_le); // y_offset

        for (i, r) in rects.iter().enumerate() {
            let off = 16 + i * 8;
            write_u16(&mut payload[off..off + 2], r.x as u16, is_le);
            write_u16(&mut payload[off + 2..off + 4], r.y as u16, is_le);
            write_u16(&mut payload[off + 4..off + 6], r.w as u16, is_le);
            write_u16(&mut payload[off + 6..off + 8], r.h as u16, is_le);
        }
        sink.send_to_server(&payload)
    } else {
        let mut payload = [0u8; 20];

        payload[0] = shape_opcode;
        payload[1] = 2; // ShapeMask
        write_u16(&mut payload[2..4], 5, is_le); // length: 5 words = 20 bytes
        payload[4] = 0; // operation = ShapeSet
        payload[5] = 2; // destination_kind = ShapeInput
        payload[6] = 0; // pad
        payload[7] = 0; // pad
        write_u32(&mut payload[8..12], window, is_le);
        write_u16(&mut payload[12..14], 0, is_le); // x_offset
        write_u16(&mut payload[14..16], 0, is_le); // y_offset
        write_u32(&mut payload[16..20], 0, is_le); // source_bitmap = None (0) defaults region reset

        sink.send_to_server(&payload)
    }
}

pub(crate) fn query_pointer(window: u32) -> Option<(i16, i16)> {
    let fd = last_active_fd()?;
    let sink = sink_for(fd)?;
    let write_lock = sink.write_lock.as_ref()?;
    let write_guard = write_lock.lock().ok()?;

    let pending = Arc::new(QueryPointerPending {
        result: Mutex::new(None),
        condvar: Condvar::new(),
    });

    let (is_le, window) = {
        let m = X11_CONNS.get()?;
        let mut map = m.lock().ok()?;
        let conn = map.get_mut(&fd)?;

        conn.query_pointer_pending = Some(Arc::clone(&pending));

        // If window is 0, fall back to the tracked root window
        let effective_window = if window == 0 {
            if conn.root_window == 0 {
                return None;
            }
            conn.root_window
        } else {
            window
        };

        // Manually track the injected QueryPointer request sequence
        conn.server_seq = conn.server_seq.wrapping_add(1);
        conn.seq_offset = conn.seq_offset.wrapping_add(1);
        conn.injected_seqs
            .insert(conn.server_seq, InjectedType::QueryPointer);
        // Offset starts at the injected request's own sequence (see
        // begin_injected_requests for why this matters).
        conn.offset_transitions
            .push((conn.server_seq, conn.seq_offset));
        if conn.offset_transitions.len() > 32 {
            conn.offset_transitions.drain(0..16);
        }
        conn.injected_seqs
            .retain(|&k, _| conn.server_seq.wrapping_sub(k) < 32768);

        (conn.is_le, effective_window)
    };

    let mut payload = [0u8; 8];
    payload[0] = 38; // QueryPointer opcode
    write_u16(&mut payload[2..4], 2, is_le); // length = 2 words
    write_u32(&mut payload[4..8], window, is_le);

    if !sink.send_to_server(&payload) {
        // Roll back sequence tracking and pending state on send failure
        if let Some(m) = X11_CONNS.get()
            && let Ok(mut map) = m.lock()
            && let Some(conn) = map.get_mut(&fd)
        {
            conn.query_pointer_pending = None;
            conn.injected_seqs.remove(&conn.server_seq);
            conn.offset_transitions.pop();
            conn.server_seq = conn.server_seq.wrapping_sub(1);
            conn.seq_offset = conn.seq_offset.wrapping_sub(1);
        }
        return None;
    }
    // Release write lock before waiting — inbound processing in filter.rs does
    // not require the write lock, so the proxy loop can still deliver the reply.
    drop(write_guard);

    // Wait for the reply to arrive via feed_inbound
    let result = {
        let mut result_guard = pending.result.lock().ok()?;
        while result_guard.is_none() {
            let (guard, timeout_result) = pending
                .condvar
                .wait_timeout(result_guard, Duration::from_millis(500))
                .ok()?;
            result_guard = guard;
            if timeout_result.timed_out() {
                // Drop result_guard before acquiring X11_CONNS to avoid
                // deadlock: feed_inbound locks X11_CONNS → pending.result,
                // so we must not hold pending.result while locking X11_CONNS.
                drop(result_guard);
                if let Some(m) = X11_CONNS.get()
                    && let Ok(mut map) = m.lock()
                    && let Some(conn) = map.get_mut(&fd)
                {
                    conn.query_pointer_pending = None;
                }
                return None;
            }
        }
        *result_guard
    };

    // Clean up
    if let Some(m) = X11_CONNS.get()
        && let Ok(mut map) = m.lock()
        && let Some(conn) = map.get_mut(&fd)
    {
        conn.query_pointer_pending = None;
    }

    result
}
