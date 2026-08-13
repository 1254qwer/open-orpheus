use std::os::fd::RawFd;

use super::super::proxy::{Cmsg, Filtered};
use super::codec::*;
use super::handlers;
use super::state::*;

/// Disposition of the message carrying the first byte of the current chunk —
/// the byte any `SCM_RIGHTS` control data is attached to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HeadDisp {
    /// The byte (and its message) is forwarded.
    Forwarded,
    /// The message was suppressed.
    Dropped,
    /// The message is still incomplete and buffered.
    Buffered,
}

fn split_cmsg(cmsg: Option<Cmsg>) -> (Vec<u8>, Vec<RawFd>) {
    match cmsg {
        Some(Cmsg { bytes, fds }) => (bytes, fds),
        None => (Vec::new(), Vec::new()),
    }
}

fn passthrough(chunk: &[u8], cmsg_bytes: Vec<u8>, cmsg_fds: Vec<RawFd>) -> Filtered {
    Filtered {
        data: chunk.to_vec(),
        cmsg: cmsg_bytes,
        fds_to_close: cmsg_fds,
    }
}

/// Merge this chunk's control data into the direction's pending slot and
/// produce the transport result.
///
/// - `Forwarded`: attach all pending control data to the forwarded bytes and
///   close our copies of the descriptors (the transport's `sendmsg` hands
///   them to the peer).
/// - `Dropped`: the message carrying the control data was suppressed — close
///   every descriptor received for it.
/// - `Buffered`: the message is incomplete — keep the control data pending
///   until its bytes are actually forwarded.
fn assemble(
    pending_bytes: &mut Vec<u8>,
    pending_fds: &mut Vec<RawFd>,
    head: HeadDisp,
    out: Vec<u8>,
    new_bytes: Vec<u8>,
    new_fds: Vec<RawFd>,
) -> Filtered {
    if head == HeadDisp::Dropped {
        // The message carrying these descriptors was suppressed: drop its
        // control data and close both the freshly received and deferred
        // descriptors (they belong to the same dropped message).
        let mut stale = std::mem::take(pending_fds);
        stale.extend(new_fds);
        close_ctrl_fds(stale);
        pending_bytes.clear();
    } else {
        pending_bytes.extend(new_bytes);
        pending_fds.extend(new_fds);
    }

    if head != HeadDisp::Forwarded {
        // The chunk head is still buffered: keep the control data pending
        // until its message's bytes are actually forwarded. Forward `out`
        // (which can only contain injected bytes at this point) without
        // attaching any descriptors to it.
        return Filtered {
            data: out,
            cmsg: Vec::new(),
            fds_to_close: Vec::new(),
        };
    }

    Filtered {
        data: out,
        cmsg: std::mem::take(pending_bytes),
        fds_to_close: std::mem::take(pending_fds),
    }
}

pub(crate) fn feed_inbound(fd: RawFd, chunk: &[u8], cmsg: Option<Cmsg>) -> Option<Filtered> {
    update_last_active_fd(fd);
    let (new_bytes, new_fds) = split_cmsg(cmsg);
    let Some(m) = X11_CONNS.get() else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };
    let Ok(mut map) = m.lock() else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };
    let Some(conn) = map.get_mut(&fd) else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };

    let mut out = Vec::new();
    if !conn.pending_inbound.is_empty() {
        out.append(&mut conn.pending_inbound);
    }
    let mut head = HeadDisp::Forwarded;
    let mut chunk_off = 0;
    if conn.rx_stream_remaining > 0 {
        if conn.rx_stream_drop {
            head = HeadDisp::Dropped;
        }
        let n = conn.rx_stream_remaining.min(chunk.len());
        if !conn.rx_stream_drop {
            out.extend_from_slice(&chunk[..n]);
        }
        if conn.press_remaining > 0 {
            let p_n = conn.press_remaining.min(n);
            conn.press_accum.extend_from_slice(&chunk[..p_n]);
            conn.press_remaining -= p_n;
            if conn.press_remaining == 0 {
                conn.last_button_press = Some(std::mem::take(&mut conn.press_accum));
            }
        }
        conn.rx_stream_remaining -= n;
        if conn.rx_stream_remaining == 0 {
            conn.rx_stream_drop = false;
        }
        chunk_off = n;
    }

    if chunk_off == chunk.len() {
        return Some(assemble(
            &mut conn.rx_ctrl_bytes,
            &mut conn.rx_ctrl_fds,
            head,
            out,
            new_bytes,
            new_fds,
        ));
    }

    let head_idx = conn.rx_buf.len();
    conn.rx_buf.extend_from_slice(&chunk[chunk_off..]);

    let mut off = 0;
    while off < conn.rx_buf.len() {
        if conn.rx_state == State::Setup {
            if conn.rx_buf.len() - off < 8 {
                if off <= head_idx {
                    head = HeadDisp::Buffered;
                }
                break;
            }
            let status = conn.rx_buf[off];
            let total = if status == 1 || status == 2 {
                8 + (r16(&conn.rx_buf[off + 6..off + 8], conn.is_le) as usize) * 4
            } else {
                8 + ((conn.rx_buf[off + 1] as usize + 3) & !3)
            };
            if conn.rx_buf.len() - off < total {
                if off <= head_idx && head_idx < off + total {
                    head = HeadDisp::Buffered;
                }
                break;
            }

            if status == 1 && conn.root_window == 0 && conn.rx_buf.len() - off >= 32 {
                let vendor_len = r16(&conn.rx_buf[off + 24..off + 26], conn.is_le) as usize;
                let num_formats = conn.rx_buf[off + 29] as usize;
                let pad_vendor = (vendor_len + 3) & !3;
                let screen_off = off + 40 + pad_vendor + num_formats * 8;
                if screen_off + 4 <= off + total {
                    conn.root_window = r32(&conn.rx_buf[screen_off..screen_off + 4], conn.is_le);
                }
            }

            if off <= head_idx && head_idx < off + total {
                head = HeadDisp::Forwarded;
            }
            conn.rx_state = State::Connected;
            out.extend_from_slice(&conn.rx_buf[off..off + total]);
            off += total;
        } else {
            if conn.rx_buf.len() - off < 32 {
                if off <= head_idx {
                    head = HeadDisp::Buffered;
                }
                break;
            }
            let code = conn.rx_buf[off];
            let is_reply_or_error = code == 0 || code == 1;

            let total = match code & 0x7F {
                1 | 35 => {
                    let Some(extra) =
                        checked_word_len(r32(&conn.rx_buf[off + 4..off + 8], conn.is_le) as usize)
                    else {
                        log_parser_close(fd, "inbound", "server message length overflow", 0);
                        let mut stale = std::mem::take(&mut conn.rx_ctrl_fds);
                        stale.extend(new_fds);
                        close_ctrl_fds(stale);
                        return None;
                    };
                    let Some(total) = 32usize.checked_add(extra) else {
                        log_parser_close(fd, "inbound", "server message length overflow", 0);
                        let mut stale = std::mem::take(&mut conn.rx_ctrl_fds);
                        stale.extend(new_fds);
                        close_ctrl_fds(stale);
                        return None;
                    };
                    total
                }
                _ => 32,
            };
            let inspect_len = if code & 0x7F == 35 { total.min(40) } else { 32 };
            if conn.rx_buf.len() - off < inspect_len {
                if off <= head_idx && head_idx < off + total {
                    head = HeadDisp::Buffered;
                }
                break;
            }

            let seq = r16(&conn.rx_buf[off + 2..off + 4], conn.is_le);
            let mut drop = false;

            if is_reply_or_error {
                drop = handlers::replies::on_reply(conn, code, seq, off);
            }

            let available = conn.rx_buf.len() - off;
            let forward_len = available.min(total);
            if off <= head_idx && head_idx < off + total {
                head = if drop {
                    HeadDisp::Dropped
                } else if head_idx < off + forward_len {
                    HeadDisp::Forwarded
                } else {
                    HeadDisp::Buffered
                };
            }
            let out_start = out.len();
            if !drop {
                let evt_code = code & 0x7F;
                out.extend_from_slice(&conn.rx_buf[off..off + forward_len]);

                handlers::sequence::rewrite_seq(conn, seq, evt_code, &mut out, out_start);

                let is_press = handlers::button::track_button(conn, evt_code, off, inspect_len);

                if is_press {
                    conn.press_accum.clear();
                    conn.press_accum
                        .extend_from_slice(&out[out_start..out_start + forward_len]);
                    conn.press_remaining = total - forward_len;
                    if conn.press_remaining == 0 {
                        conn.last_button_press = Some(std::mem::take(&mut conn.press_accum));
                    }
                }
            }

            if forward_len < total {
                conn.rx_stream_remaining = total - forward_len;
                conn.rx_stream_drop = drop;
            }
            off += forward_len;
        }
    }
    conn.rx_buf.drain(..off);
    if conn.rx_buf.len() > X11_BUFFER_LIMIT {
        log_parser_close(
            fd,
            "inbound",
            "buffer exceeded hard limit before a full X11 frame was inspectable",
            conn.rx_buf.len(),
        );
        let mut stale = std::mem::take(&mut conn.rx_ctrl_fds);
        stale.extend(new_fds);
        close_ctrl_fds(stale);
        return None;
    }
    Some(assemble(
        &mut conn.rx_ctrl_bytes,
        &mut conn.rx_ctrl_fds,
        head,
        out,
        new_bytes,
        new_fds,
    ))
}

pub(crate) fn feed_outbound(fd: RawFd, chunk: &[u8], cmsg: Option<Cmsg>) -> Option<Filtered> {
    update_last_active_fd(fd);
    let (new_bytes, new_fds) = split_cmsg(cmsg);
    let Some(m) = X11_CONNS.get() else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };
    let Ok(mut map) = m.lock() else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };
    let Some(conn) = map.get_mut(&fd) else {
        return Some(passthrough(chunk, new_bytes, new_fds));
    };

    let mut out = Vec::new();
    let mut chunk_off = 0;
    let mut head = HeadDisp::Forwarded;
    if conn.tx_stream_remaining > 0 {
        let n = conn.tx_stream_remaining.min(chunk.len());
        out.extend_from_slice(&chunk[..n]);
        conn.tx_stream_remaining -= n;
        chunk_off = n;
    }

    if chunk_off == chunk.len() {
        return Some(assemble(
            &mut conn.tx_ctrl_bytes,
            &mut conn.tx_ctrl_fds,
            head,
            out,
            new_bytes,
            new_fds,
        ));
    }

    let head_idx = conn.tx_buf.len();
    conn.tx_buf.extend_from_slice(&chunk[chunk_off..]);

    let mut off = 0;
    while off < conn.tx_buf.len() {
        if conn.tx_state == State::Setup {
            if conn.tx_buf.len() - off < 12 {
                if off <= head_idx {
                    head = HeadDisp::Buffered;
                }
                break;
            }
            let is_le = conn.tx_buf[off] == b'l';
            let nlen = r16(&conn.tx_buf[off + 6..off + 8], is_le);
            let dlen = r16(&conn.tx_buf[off + 8..off + 10], is_le);
            let total = 12 + ((nlen + 3) & !3) as usize + ((dlen + 3) & !3) as usize;
            if conn.tx_buf.len() - off < total {
                if off <= head_idx && head_idx < off + total {
                    head = HeadDisp::Buffered;
                }
                break;
            }

            if off <= head_idx && head_idx < off + total {
                head = HeadDisp::Forwarded;
            }
            conn.is_le = is_le;
            conn.tx_state = State::Connected;
            out.extend_from_slice(&conn.tx_buf[off..off + total]);
            off += total;

            let (req1, req2) = handlers::setup::initial_requests(conn);
            out.extend_from_slice(&req1);
            out.extend_from_slice(&req2);
        } else {
            if conn.tx_buf.len() - off < 4 {
                if off <= head_idx {
                    head = HeadDisp::Buffered;
                }
                break;
            }
            let mut words = r16(&conn.tx_buf[off + 2..off + 4], conn.is_le) as usize;
            let mut hdr = 4;
            if words == 0 {
                if conn.tx_buf.len() - off < 8 {
                    if off <= head_idx {
                        head = HeadDisp::Buffered;
                    }
                    break;
                }
                words = r32(&conn.tx_buf[off + 4..off + 8], conn.is_le) as usize;
                hdr = 8;
            }
            let Some(total) = checked_word_len(words) else {
                log_parser_close(fd, "outbound", "client request length overflow", 0);
                let mut stale = std::mem::take(&mut conn.tx_ctrl_fds);
                stale.extend(new_fds);
                close_ctrl_fds(stale);
                return None;
            };
            if total < hdr {
                log_parser_close(
                    fd,
                    "outbound",
                    "client request length is shorter than its header",
                    conn.tx_buf.len() - off,
                );
                let mut stale = std::mem::take(&mut conn.tx_ctrl_fds);
                stale.extend(new_fds);
                close_ctrl_fds(stale);
                return None;
            }
            if conn.tx_buf.len() - off < total && total <= X11_BUFFER_LIMIT {
                if off <= head_idx && head_idx < off + total {
                    head = HeadDisp::Buffered;
                }
                break;
            }

            conn.client_seq = conn.client_seq.wrapping_add(1);
            conn.server_seq = conn.server_seq.wrapping_add(1);
            let available = conn.tx_buf.len() - off;
            let forward_len = available.min(total);
            out.extend_from_slice(&conn.tx_buf[off..off + forward_len]);
            if forward_len < total {
                conn.tx_stream_remaining = total - forward_len;
            }
            if off <= head_idx && head_idx < off + total {
                head = if head_idx < off + forward_len {
                    HeadDisp::Forwarded
                } else {
                    HeadDisp::Buffered
                };
            }
            off += forward_len;
        }
    }

    conn.tx_buf.drain(..off);
    if conn.tx_buf.len() > X11_BUFFER_LIMIT {
        log_parser_close(
            fd,
            "outbound",
            "buffer exceeded hard limit before a full X11 frame was inspectable",
            conn.tx_buf.len(),
        );
        let mut stale = std::mem::take(&mut conn.tx_ctrl_fds);
        stale.extend(new_fds);
        close_ctrl_fds(stale);
        return None;
    }
    Some(assemble(
        &mut conn.tx_ctrl_bytes,
        &mut conn.tx_ctrl_fds,
        head,
        out,
        new_bytes,
        new_fds,
    ))
}
