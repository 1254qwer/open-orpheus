//! X11 functionality: interception rules extracted from the stream parser.
//!
//! Each submodule owns one feature. `filter.rs` (the pipeline) calls into these
//! at the points where it parses the relevant messages; the handlers read from
//! `X11Conn` and mutate only the state they own.

pub(crate) mod button;
pub(crate) mod replies;
pub(crate) mod sequence;
pub(crate) mod setup;
