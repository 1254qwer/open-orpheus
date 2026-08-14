//! Sequence-number rewriting: subtract the injection offset from forwarded
//! events so their client-visible sequence stays within the client's own
//! request counter.

use super::super::codec::*;
use super::super::state::X11Conn;

pub(crate) fn rewrite_seq(
    conn: &X11Conn,
    seq: u16,
    evt_code: u8,
    out: &mut [u8],
    out_start: usize,
) {
    if evt_code == 11 {
        // KeymapNotify is unsequenced.
        return;
    }

    let mut applied_offset = 0;
    for &(transition_seq, offset) in &conn.offset_transitions {
        if seq.wrapping_sub(transition_seq) < 32768 {
            applied_offset = offset;
        }
    }
    if applied_offset > 0 {
        let new_seq = seq.wrapping_sub(applied_offset);
        write_u16(&mut out[out_start + 2..out_start + 4], new_seq, conn.is_le);
    }
}
