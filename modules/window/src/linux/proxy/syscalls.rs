use std::os::fd::RawFd;

use libc::{c_int, c_long, c_void, msghdr, syscall};

/// Invoke a raw syscall with a variable number of arguments.
#[inline]
pub(crate) fn raw_syscall_ret(num: c_long, args: &[usize]) -> c_long {
    unsafe {
        match args {
            [a0] => syscall(num, *a0),
            [a0, a1] => syscall(num, *a0, *a1),
            [a0, a1, a2] => syscall(num, *a0, *a1, *a2),
            _ => -1,
        }
    }
}

/// Wrapper around the `connect` syscall.
#[inline]
pub(crate) fn call_connect(fd: c_int, addr: *const c_void, addrlen: u32) -> c_int {
    raw_syscall_ret(
        libc::SYS_connect as c_long,
        &[fd as usize, addr as usize, addrlen as usize],
    ) as c_int
}

/// Wrapper around the `close` syscall.
#[inline]
pub(crate) fn call_close(fd: c_int) -> c_int {
    raw_syscall_ret(libc::SYS_close as c_long, &[fd as usize]) as c_int
}

/// Sends raw bytes on the given fd. Injects data naturally proxying it.
pub(crate) fn send_raw_msg(fd: RawFd, data: &[u8]) -> bool {
    let mut iov = libc::iovec {
        iov_base: data.as_ptr() as *mut c_void,
        iov_len: data.len(),
    };
    let msg = msghdr {
        msg_name: std::ptr::null_mut(),
        msg_namelen: 0,
        msg_iov: &mut iov as *mut libc::iovec,
        msg_iovlen: 1,
        msg_control: std::ptr::null_mut(),
        msg_controllen: 0,
        msg_flags: 0,
    };
    let ret = unsafe { libc::sendmsg(fd, &msg as *const msghdr, libc::MSG_NOSIGNAL) };
    ret as usize == data.len()
}
