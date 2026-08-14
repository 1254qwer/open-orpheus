use std::{mem, os::fd::RawFd};

use libc::{AF_UNIX, c_void, sa_family_t, sockaddr, sockaddr_un};

pub(crate) fn checked_word_len(words: usize) -> Option<usize> {
    words.checked_mul(4)
}

pub(crate) fn log_parser_close(fd: RawFd, direction: &str, reason: &str, buffered: usize) {
    eprintln!("[proxy:x11] closing {direction} stream for fd {fd}: {reason}; buffered={buffered}");
}

#[inline]
pub(crate) fn r16(b: &[u8], le: bool) -> u16 {
    if le {
        u16::from_le_bytes(b[0..2].try_into().unwrap())
    } else {
        u16::from_be_bytes(b[0..2].try_into().unwrap())
    }
}

#[inline]
pub(crate) fn r32(b: &[u8], le: bool) -> u32 {
    if le {
        u32::from_le_bytes(b[0..4].try_into().unwrap())
    } else {
        u32::from_be_bytes(b[0..4].try_into().unwrap())
    }
}

#[inline]
pub(crate) fn write_u16(b: &mut [u8], v: u16, le: bool) {
    b[0..2].copy_from_slice(&(if le { v.to_le_bytes() } else { v.to_be_bytes() }));
}

#[inline]
pub(crate) fn write_u32(b: &mut [u8], v: u32, le: bool) {
    b[0..4].copy_from_slice(&(if le { v.to_le_bytes() } else { v.to_be_bytes() }));
}

pub(crate) fn is_x11_socket(addr: *const c_void, addrlen: u32) -> bool {
    if addr.is_null() || (addrlen as usize) < mem::size_of::<sa_family_t>() {
        return false;
    }
    let sa = unsafe { &*(addr as *const sockaddr) };
    if sa.sa_family as i32 != AF_UNIX {
        return false;
    }

    let sun = unsafe { &*(addr as *const sockaddr_un) };
    let path_offset = mem::size_of::<sa_family_t>();
    let path_len = (addrlen as usize)
        .saturating_sub(path_offset)
        .min(sun.sun_path.len());
    if path_len == 0 {
        return false;
    }

    let raw = unsafe { std::slice::from_raw_parts(sun.sun_path.as_ptr() as *const u8, path_len) };
    let candidate = if raw[0] == 0 {
        &raw[1..]
    } else {
        let end = raw.iter().position(|&b| b == 0).unwrap_or(raw.len());
        &raw[..end]
    };
    candidate.windows(11).any(|w| w == b".X11-unix/X")
}
