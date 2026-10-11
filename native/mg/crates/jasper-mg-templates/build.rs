//! Stages the embedded media for `fframes::include_media_dir!` (src/lib.rs).
//!
//! Every asset in the repository has an `<file>.attribution` sidecar next to it (AGENTS.md §3), and
//! `include_media_dir!` refuses a folder that holds anything but media ("File type is not
//! supported"), so the macro cannot read `media/` directly. This script copies the media files —
//! everything except the sidecars — to `<workspace>/target/mg-media`, the folder the macro embeds.
//! The macro resolves its path against the workspace root (rustc's working directory), whatever
//! `CARGO_TARGET_DIR` says, so the staged folder always sits there.
use std::{env, fs, path::Path};

fn main() {
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let src = Path::new(&manifest).join("media");
    let dest = Path::new(&manifest).join("../../target/mg-media");
    println!("cargo:rerun-if-changed=media");
    println!("cargo:rerun-if-changed=build.rs");

    // Start from an empty folder: a file removed from `media/` must not stay embedded.
    if dest.exists() {
        fs::remove_dir_all(&dest).expect("clear the staged media folder");
    }
    fs::create_dir_all(&dest).expect("create the staged media folder");
    let mut staged = 0;
    for entry in fs::read_dir(&src).expect("read crates/jasper-mg-templates/media") {
        let entry = entry.expect("media entry");
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".attribution") || name.starts_with('.') {
            continue;
        }
        fs::copy(&path, dest.join(name.as_ref())).expect("stage a media file");
        staged += 1;
    }
    assert!(
        staged > 0,
        "crates/jasper-mg-templates/media holds no media file"
    );
}
