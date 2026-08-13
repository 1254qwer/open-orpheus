//! Connection-setup injection: the two requests sent immediately after the X11
//! handshake (InternAtom `_NET_WM_MOVERESIZE`, QueryExtension `SHAPE`). Their
//! replies are dropped and parsed by [`super::replies`].

use super::super::codec::*;
use super::super::state::{InjectedType, X11Conn};

pub(crate) fn initial_requests(conn: &mut X11Conn) -> (Vec<u8>, Vec<u8>) {
    let mut req1 = [0u8; 28];
    req1[0] = 16; // InternAtom
    write_u16(&mut req1[2..4], 7, conn.is_le);
    write_u16(&mut req1[4..6], 18, conn.is_le);
    req1[8..26].copy_from_slice(b"_NET_WM_MOVERESIZE");
    conn.server_seq = conn.server_seq.wrapping_add(1);
    conn.seq_offset = conn.seq_offset.wrapping_add(1);
    conn.injected_seqs
        .insert(conn.server_seq, InjectedType::InternAtomNetWmMoveresize);

    let mut req2 = [0u8; 16];
    req2[0] = 98; // QueryExtension
    write_u16(&mut req2[2..4], 4, conn.is_le);
    write_u16(&mut req2[4..6], 5, conn.is_le);
    req2[8..13].copy_from_slice(b"SHAPE");
    conn.server_seq = conn.server_seq.wrapping_add(1);
    conn.seq_offset = conn.seq_offset.wrapping_add(1);
    conn.injected_seqs
        .insert(conn.server_seq, InjectedType::QueryExtensionShape);

    // Offset takes effect at the first injected sequence (server_seq 1);
    // see `X11Conn::begin_injected_requests` for why this matters.
    conn.offset_transitions
        .push((conn.server_seq.wrapping_sub(1), conn.seq_offset));

    (req1.to_vec(), req2.to_vec())
}
