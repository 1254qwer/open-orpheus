/**
 * Pinned versions of the build-time toolchains the packagers install.
 *
 * The Flatpak sandbox vendors these versions as offline sources (prebuilt
 * binaries), while the deb/rpm source packages download the very same versions
 * at build time — so both must agree.
 *
 * `wasm-bindgen` (Cargo.toml), Node (package.json `engines`) and pnpm
 * (`packageManager`) are deliberately absent: they are derived from the project
 * so they always track what it actually builds with.
 */

/** Rust toolchain installed into the Flatpak sandbox. */
export const RUST_VERSION = "1.96.0";

/** `cargo-zigbuild` — napi-rs shells out to it for cross builds. */
export const CARGO_ZIGBUILD_VERSION = "0.23.4";

/** Zig, required by `cargo-zigbuild` as the linker/driver. */
export const ZIG_VERSION = "0.16.0";
