//! Stages the media files of `media/` into `.media/`, the flat folder `fframes::include_media_dir!` embeds.
//!
//! Every asset in the repository has its `<file>.attribution` sidecar next to it (AGENTS.md §3, checked by
//! `scripts/check-assets.mjs`), but the macro refuses any file it cannot decode, so `media/` itself cannot be the
//! embedded folder. `.media/` is gitignored and holds only the media files (fonts, images, audio, subtitles).
use std::fs;
use std::path::Path;

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "flac", "aac", "ogg", "m4a", "ttf", "ttc", "otf", "otc", "jpeg", "png", "jpg", "vtt",
];

fn is_media(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| MEDIA_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn main() {
    let src = Path::new("media");
    let dst = Path::new(".media");
    println!("cargo:rerun-if-changed=media");
    fs::create_dir_all(dst).expect("create .media");
    // Files removed from media/ leave the staged folder too.
    for entry in fs::read_dir(dst).expect("read .media") {
        let path = entry.expect("entry").path();
        if path.is_file() && !src.join(path.file_name().expect("name")).exists() {
            fs::remove_file(&path).expect("remove stale staged media");
        }
    }
    for entry in fs::read_dir(src).expect("read media") {
        let path = entry.expect("entry").path();
        if !is_media(&path) {
            continue;
        }
        let to = dst.join(path.file_name().expect("name"));
        let bytes = fs::read(&path).expect("read media file");
        // Rewritten only when changed, so the embedding crate is not rebuilt for nothing.
        if fs::read(&to).ok().as_deref() != Some(bytes.as_slice()) {
            fs::write(&to, &bytes).expect("stage media file");
        }
    }
}
