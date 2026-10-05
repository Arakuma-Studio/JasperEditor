//! End-to-end tests of the `jasper-mg` binary: CLI contract, frame count and straight alpha.
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_jasper-mg");

fn fixture(name: &str) -> String {
    format!("{}/../../fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

/// Runs the binary with a spec on stdin; returns (exit code, stdout bytes, stderr text).
fn run_stdin(args: &[&str], spec: &Value) -> (i32, Vec<u8>, String) {
    let mut child = Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn jasper-mg");
    if let Err(error) = child
        .stdin
        .take()
        .unwrap()
        .write_all(spec.to_string().as_bytes())
    {
        // Invalid command options can be rejected before the process reads its spec.
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        out.stdout,
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn events(stderr: &str) -> Vec<Value> {
    stderr
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

#[test]
fn version_is_json() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    assert!(out.status.success());
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["name"], "jasper-mg");
    assert_eq!(v["fframes"], "1.0.3");
}

#[test]
fn lower_third_fixture_renders_every_frame_in_order() {
    let spec: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("lower-third.json")).unwrap())
            .unwrap();
    // Small output keeps the test fast; the frame count is what matters.
    let mut small = spec.clone();
    small["width"] = json!(384);
    small["height"] = json!(216);
    let (code, stdout, stderr) = run_stdin(
        &["render", "--spec", "-", "--raw-rgba", "--threads", "4"],
        &small,
    );
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout.len(), 384 * 216 * 4 * 150);
    let ev = events(&stderr);
    assert_eq!(ev.first().unwrap()["event"], "start");
    assert_eq!(ev.first().unwrap()["frames"], 150);
    assert_eq!(ev.last().unwrap()["event"], "done");
    assert_eq!(ev.last().unwrap()["frames"], 150);
    assert!(
        ev.iter()
            .any(|e| e["event"] == "progress" && e["done"] == 150)
    );
    // frame 0 is fully transparent (nothing has grown yet), a mid frame is not
    let frame = 384 * 216 * 4;
    assert!(stdout[..frame].chunks(4).all(|px| px[3] == 0));
    assert!(stdout[60 * frame..61 * frame].chunks(4).any(|px| px[3] > 0));
}

#[test]
fn straight_alpha_probe_pixel_stays_white() {
    // A 50 % white background with no fade: straight alpha must keep RGB at 255 (fframes' own
    // encoder path would give 128,128,128,128 — R-FF §5).
    let spec = json!({
        "template": {"id": "title-card", "version": 1},
        "params": {"title": "", "subtitle": "", "background": [1, 1, 1, 0.5], "fadeInFrames": 0, "fadeOutFrames": 0},
        "width": 64, "height": 36, "fps": {"num": 30, "den": 1}, "durationFrames": 3
    });
    let (code, stdout, stderr) = run_stdin(&["render", "--spec", "-", "--raw-rgba"], &spec);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout.len(), 64 * 36 * 4 * 3);
    let px = &stdout[(10 * 64 + 10) * 4..(10 * 64 + 10) * 4 + 4];
    assert_eq!(&px[..3], &[255, 255, 255]);
    assert!((127..=129).contains(&px[3]), "alpha {}", px[3]);
}

#[test]
fn invalid_specs_exit_with_code_2() {
    let bad = json!({"template": {"id": "lower-third", "version": 1}, "params": {"unknown": 1},
                     "width": 64, "height": 36, "fps": {"num": 30, "den": 1}, "durationFrames": 3});
    let (code, stdout, stderr) = run_stdin(&["render", "--spec", "-", "--raw-rgba"], &bad);
    assert_eq!(code, 2);
    assert!(stdout.is_empty());
    let ev = events(&stderr);
    assert_eq!(ev.last().unwrap()["event"], "error");
    let unknown = json!({"template": {"id": "nope", "version": 1}, "params": {},
                         "width": 64, "height": 36, "fps": {"num": 30, "den": 1}, "durationFrames": 3});
    let (code, _, stderr) = run_stdin(
        &[
            "frame",
            "--spec",
            "-",
            "--frame",
            "0",
            "--out",
            "/unused.png",
        ],
        &unknown,
    );
    assert_eq!(code, 2);
    assert_eq!(events(&stderr).last().unwrap()["code"], "INVALID_SPEC");
    let ok = json!({"template": {"id": "title-card", "version": 1}, "params": {},
                    "width": 64, "height": 36, "fps": {"num": 30, "den": 1}, "durationFrames": 3});
    let (code, _, stderr) = run_stdin(
        &[
            "frame",
            "--spec",
            "-",
            "--frame",
            "3",
            "--out",
            "/unused.png",
        ],
        &ok,
    );
    assert_eq!(code, 2);
    assert_eq!(events(&stderr).last().unwrap()["code"], "INVALID_SPEC");
    assert_eq!(run_stdin(&["render", "--spec", "-"], &ok).0, 2);
    let missing = Command::new(BIN)
        .args(["render", "--spec", "/nonexistent.json", "--raw-rgba"])
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(2));
}

#[test]
fn frame_writes_a_png() {
    let dir = std::env::temp_dir().join(format!("jasper-mg-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("f.png");
    let status = Command::new(BIN)
        .args([
            "frame",
            "--spec",
            &fixture("title-card.json"),
            "--frame",
            "60",
            "--out",
        ])
        .arg(&out)
        .status()
        .unwrap();
    assert!(status.success());
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(&bytes[12..16], b"IHDR");
    assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 1920);
    assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 1080);
    let _ = std::fs::remove_dir_all(dir);
}
