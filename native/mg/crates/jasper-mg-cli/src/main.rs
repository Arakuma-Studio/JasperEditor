//! `jasper-mg` — JasperEditor's motion-graphics renderer (ARCHITECTURE §10.2 CLI contract).
//!
//! ```text
//! jasper-mg --version                                    JSON {name, version, fframes, renderer, templates}
//! jasper-mg schema                                       JSON {templates: [...]} with JSON Schemas
//! jasper-mg render --spec <file|-> --raw-rgba [--threads N]
//!                                                        raw straight-alpha RGBA frames on stdout, in order
//! jasper-mg frame --spec <file|-> --frame N --out f.png  one straight-alpha PNG
//! jasper-mg svg --spec <file|-> --frame N                the SVG markup of one frame (parity checks)
//! ```
//!
//! stderr carries NDJSON progress: `{"event":"start",...}`, `{"event":"progress","done":k,"total":n}`,
//! `{"event":"done",...}` or `{"event":"error","message":...}`. Exit codes: 0 ok, 2 invalid spec,
//! 1 anything else.
use clap::{Parser, Subcommand};
use fframes::{Color, CpuFrameRenderer, FrameRenderer, Previewer, RenderOptions, Video};
use jasper_mg_core::MgSpec;
use jasper_mg_templates::{AnyTemplate, MgMedia, Prepared, RENDERER_VERSION, catalog};
use serde_json::json;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::Instant;

const FFRAMES_VERSION: &str = "1.0.3";
const MAX_SPEC_BYTES: u64 = 1024 * 1024;

#[derive(Parser)]
#[command(
    name = "jasper-mg",
    disable_version_flag = true,
    about = "JasperEditor motion-graphics renderer (fframes)"
)]
struct Cli {
    /// Print version information as JSON and exit.
    #[arg(long)]
    version: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Print the template catalog with the JSON Schema of every template's params.
    Schema,
    /// Render every frame of a spec as raw straight-alpha RGBA to stdout.
    Render {
        /// Spec file, or `-` for stdin.
        #[arg(long)]
        spec: String,
        /// Write width*height*4 bytes per frame (RGBA, straight alpha) to stdout.
        #[arg(long)]
        raw_rgba: bool,
        /// Worker threads (default: `JASPER_MG_THREADS` or all cores). The engine passes its CPU slots.
        #[arg(long)]
        threads: Option<usize>,
    },
    /// Render one frame to a PNG (straight alpha).
    Frame {
        #[arg(long)]
        spec: String,
        #[arg(long)]
        frame: u32,
        #[arg(long)]
        out: PathBuf,
    },
    /// Print the SVG markup of one frame.
    Svg {
        #[arg(long)]
        spec: String,
        #[arg(long)]
        frame: u32,
    },
}

enum CliError {
    /// Exit 2.
    Spec(String),
    /// Exit 1.
    Other(String),
}

type CliResult<T = ()> = Result<T, CliError>;

fn event(value: serde_json::Value) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{value}");
    let _ = err.flush();
}

fn write_output(mut out: impl Write, value: impl std::fmt::Display) -> CliResult {
    writeln!(out, "{value}").map_err(|e| CliError::Other(format!("stdout: {e}")))
}

fn read_spec_text(reader: impl Read) -> CliResult<String> {
    let mut text = String::new();
    reader
        .take(MAX_SPEC_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| CliError::Spec(format!("cannot read spec: {e}")))?;
    if text.len() as u64 > MAX_SPEC_BYTES {
        return Err(CliError::Spec(format!(
            "spec exceeds {MAX_SPEC_BYTES} bytes"
        )));
    }
    Ok(text)
}

fn read_spec(path: &str) -> CliResult<Prepared> {
    let text = if path == "-" {
        read_spec_text(std::io::stdin().lock())?
    } else {
        let file = std::fs::File::open(path)
            .map_err(|e| CliError::Spec(format!("cannot read spec {path}: {e}")))?;
        read_spec_text(file)?
    };
    let spec = MgSpec::parse(&text).map_err(|e| CliError::Spec(e.0))?;
    Prepared::new(spec).map_err(|e| CliError::Spec(e.0))
}

/// Runs `$body` with `$v` bound to the `AnyTemplate<W, H>` of the spec's design canvas.
macro_rules! with_video {
    ($prepared:expr, |$v:ident| $body:expr) => {
        match $prepared.canvas() {
            (1920, 1080) => {
                let $v = AnyTemplate::<1920, 1080>::new($prepared);
                $body
            }
            (1080, 1920) => {
                let $v = AnyTemplate::<1080, 1920>::new($prepared);
                $body
            }
            _ => {
                let $v = AnyTemplate::<1080, 1080>::new($prepared);
                $body
            }
        }
    };
}

fn media() -> CliResult<MgMedia> {
    MgMedia::new().map_err(|e| CliError::Other(format!("embedded media: {e:?}")))
}

fn options(media: &MgMedia) -> RenderOptions<'_, '_> {
    RenderOptions {
        media: Some(media),
        default_font: "Inter",
        ..Default::default()
    }
}

fn parse_threads(raw: &str) -> CliResult<usize> {
    raw.parse::<usize>()
        .ok()
        .filter(|n| (1..=64).contains(n))
        .ok_or_else(|| CliError::Spec("worker threads must be an integer within 1..=64".into()))
}

fn threads_for(requested: Option<usize>) -> CliResult<usize> {
    if let Some(threads) = requested {
        return parse_threads(&threads.to_string());
    }
    match std::env::var("JASPER_MG_THREADS") {
        Ok(raw) => parse_threads(&raw),
        Err(std::env::VarError::NotUnicode(_)) => Err(CliError::Spec(
            "JASPER_MG_THREADS must contain an integer within 1..=64".into(),
        )),
        Err(std::env::VarError::NotPresent) => Ok(std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(64)),
    }
}

/// Each worker has one rendezvous channel, so a slow frame cannot accumulate later frames in memory.
fn render_raw<V: Video>(
    video: &V,
    prepared: &Prepared,
    media: &MgMedia,
    threads: usize,
) -> CliResult {
    let (w, h) = (prepared.spec.width, prepared.spec.height);
    let total = prepared.spec.duration_frames as usize;
    let frame_bytes = w as usize * h as usize * 4;
    let threads = threads.min(total).max(1);
    let options = options(media);
    let started = Instant::now();
    event(
        json!({"event": "start", "frames": total, "width": w, "height": h, "threads": threads,
                 "template": format!("{}@{}", prepared.spec.template.id, prepared.spec.template.version)}),
    );

    let abort = AtomicBool::new(false);
    let frames = std::thread::scope(|scope| {
        let mut receivers = Vec::with_capacity(threads);
        let mut workers = Vec::with_capacity(threads);
        let outcome = (|| {
            for worker in 0..threads {
                let (tx, rx) = sync_channel::<Result<Vec<u8>, String>>(0);
                receivers.push(rx);
                let (options, abort) = (&options, &abort);
                let handle = std::thread::Builder::new()
                    .spawn_scoped(scope, move || {
                        let mut previewer = match Previewer::new(video, options) {
                            Ok(p) => p,
                            Err(e) => {
                                let _ = tx.send(Err(format!("previewer: {e}")));
                                return;
                            }
                        };
                        let mut renderer = CpuFrameRenderer::default();
                        let mut f = worker;
                        while f < total && !abort.load(Ordering::Relaxed) {
                            let result = previewer
                                .svg_tree(f)
                                .and_then(|tree| {
                                    renderer.render_tree(&tree, Color::TRANSPARENT, w, h)
                                })
                                .map(|frame| frame.pixels)
                                .map_err(|e| format!("frame {f}: {e}"));
                            let failed = result.is_err();
                            if tx.send(result).is_err() || failed {
                                break;
                            }
                            f += threads;
                        }
                    })
                    .map_err(|e| {
                        CliError::Other(format!("cannot start render worker {worker}: {e}"))
                    })?;
                workers.push(handle);
            }

            let mut out = std::io::BufWriter::with_capacity(1 << 24, std::io::stdout().lock());
            let step = (total / 100).max(1);
            for index in 0..total {
                let pixels = receivers[index % threads]
                    .recv()
                    .map_err(|e| {
                        CliError::Other(format!("render worker stopped before frame {index}: {e}"))
                    })?
                    .map_err(CliError::Other)?;
                if pixels.len() != frame_bytes {
                    return Err(CliError::Other(format!(
                        "frame {index}: {} bytes, expected {frame_bytes}",
                        pixels.len()
                    )));
                }
                out.write_all(&pixels)
                    .map_err(|e| CliError::Other(format!("stdout: {e}")))?;
                let done = index + 1;
                if done.is_multiple_of(step) || done == total {
                    event(json!({"event": "progress", "done": done, "total": total,
                                 "elapsed": started.elapsed().as_secs_f64()}));
                }
            }
            out.flush()
                .map_err(|e| CliError::Other(format!("stdout: {e}")))?;
            Ok(total)
        })();
        abort.store(true, Ordering::Relaxed);
        drop(receivers);
        let mut panicked = false;
        for worker in workers {
            panicked |= worker.join().is_err();
        }
        if panicked {
            Err(CliError::Other("render worker panicked".into()))
        } else {
            outcome
        }
    })?;
    event(json!({"event": "done", "frames": frames, "elapsed": started.elapsed().as_secs_f64()}));
    Ok(())
}

fn render_png<V: Video>(
    video: &V,
    prepared: &Prepared,
    media: &MgMedia,
    frame: u32,
    out: &PathBuf,
) -> CliResult {
    let options = options(media);
    let mut previewer =
        Previewer::new(video, &options).map_err(|e| CliError::Other(format!("previewer: {e}")))?;
    let mut renderer = CpuFrameRenderer::default();
    let tree = previewer
        .svg_tree(frame as usize)
        .map_err(|e| CliError::Other(format!("frame {frame}: {e}")))?;
    let rgba = renderer
        .render_tree(
            &tree,
            Color::TRANSPARENT,
            prepared.spec.width,
            prepared.spec.height,
        )
        .map_err(|e| CliError::Other(format!("frame {frame}: {e}")))?;
    rgba.save_png(out)
        .map_err(|e| CliError::Other(format!("png: {e}")))?;
    event(json!({"event": "done", "frames": 1, "output": out}));
    Ok(())
}

fn check_frame(prepared: &Prepared, frame: u32) -> CliResult {
    if frame >= prepared.spec.duration_frames {
        return Err(CliError::Spec(format!(
            "frame {frame} is outside the spec (0..{})",
            prepared.spec.duration_frames
        )));
    }
    Ok(())
}

fn run(cli: Cli) -> CliResult {
    if cli.version {
        let templates: Vec<String> = catalog()
            .iter()
            .map(|t| format!("{}@{}", t.id, t.version))
            .collect();
        return write_output(
            std::io::stdout().lock(),
            json!({"name": "jasper-mg", "version": env!("CARGO_PKG_VERSION"), "fframes": FFRAMES_VERSION,
                   "renderer": RENDERER_VERSION, "templates": templates}),
        );
    }
    match cli.command {
        None => Err(CliError::Spec(
            "missing command (schema | render | frame | svg); see --help".into(),
        )),
        Some(Command::Schema) => write_output(
            std::io::stdout().lock(),
            json!({ "templates": catalog() }),
        ),
        Some(Command::Render {
            spec,
            raw_rgba,
            threads,
        }) => {
            if !raw_rgba {
                return Err(CliError::Spec(
                    "render needs --raw-rgba (the only output mode)".into(),
                ));
            }
            let prepared = read_spec(&spec)?;
            let threads = threads_for(threads)?;
            let media = media()?;
            with_video!(&prepared, |video| render_raw(
                &video, &prepared, &media, threads
            ))
        }
        Some(Command::Frame { spec, frame, out }) => {
            let prepared = read_spec(&spec)?;
            check_frame(&prepared, frame)?;
            let media = media()?;
            with_video!(&prepared, |video| render_png(
                &video, &prepared, &media, frame, &out
            ))
        }
        Some(Command::Svg { spec, frame }) => {
            let prepared = read_spec(&spec)?;
            check_frame(&prepared, frame)?;
            write_output(std::io::stdout().lock(), prepared.svg(frame))
        }
    }
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(CliError::Spec(message)) => {
            event(json!({"event": "error", "code": "INVALID_SPEC", "message": message}));
            ExitCode::from(2)
        }
        Err(CliError::Other(message)) => {
            event(json!({"event": "error", "code": "RENDER_FAILED", "message": message}));
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct PanickingVideo;

    impl Video for PanickingVideo {
        const FPS: usize = 30;
        const WIDTH: usize = 64;
        const HEIGHT: usize = 36;
        const BACKGROUND_COLOR: Color = Color::TRANSPARENT;

        fn duration(&self) -> fframes::Duration<'_> {
            fframes::Duration::Frames(3)
        }

        fn audio(&self) -> fframes::AudioMap<'_> {
            fframes::AudioMap::none()
        }

        fn render_frame<'a>(
            &'a self,
            _frame: fframes::Frame,
            _ctx: &fframes::FFramesContext<'a, '_>,
        ) -> fframes::Svgr<'a> {
            panic!("failed render worker")
        }
    }

    #[test]
    fn worker_panics_are_reported_as_render_errors() {
        let spec = MgSpec::parse(
            r#"{
            "template":{"id":"title-card","version":1}, "params":{},
            "width":64,"height":36,"fps":{"num":30,"den":1},"durationFrames":3
        }"#,
        )
        .unwrap();
        let prepared = Prepared::new(spec).unwrap();
        let media = MgMedia::new().unwrap();
        assert!(matches!(
            render_raw(&PanickingVideo, &prepared, &media, 3),
            Err(CliError::Other(message)) if message.contains("panicked")
        ));
    }

    #[test]
    fn output_errors_return_render_failures() {
        let mut full = &mut [0_u8; 1][..];
        assert!(matches!(
            write_output(&mut full, "output exceeds writer capacity"),
            Err(CliError::Other(message)) if message.starts_with("stdout:")
        ));
    }

    #[test]
    fn spec_reads_are_bounded_even_for_endless_input() {
        match read_spec_text(std::io::repeat(b' ')) {
            Err(CliError::Spec(message)) => assert!(message.contains("exceeds")),
            _ => panic!("oversized input must be refused"),
        }
    }

    #[test]
    fn invalid_thread_settings_are_refused() {
        for raw in ["", "0", "65", "abc", "-1", "1.5"] {
            assert!(
                matches!(parse_threads(raw), Err(CliError::Spec(_))),
                "{raw}"
            );
        }
        assert!(matches!(parse_threads("1"), Ok(1)));
        assert!(matches!(parse_threads("64"), Ok(64)));
    }
}
