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
use jasper_mg_templates::{AnyTemplate, MgMedia, Prepared, RENDERER_VERSION, catalog, schema_json};
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::time::Instant;

const FFRAMES_VERSION: &str = "1.0.3";

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
        /// Write width*height*4 bytes per frame (RGBA, straight alpha) to stdout. Required in M1.
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

fn read_spec(path: &str) -> CliResult<Prepared> {
    let mut text = String::new();
    if path == "-" {
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|e| CliError::Other(format!("cannot read the spec from stdin: {e}")))?;
    } else {
        text = std::fs::read_to_string(path)
            .map_err(|e| CliError::Spec(format!("cannot read spec {path}: {e}")))?;
    }
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

fn threads_for(requested: Option<usize>) -> usize {
    requested
        .or_else(|| {
            std::env::var("JASPER_MG_THREADS")
                .ok()
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
        })
        .clamp(1, 64)
}

/// Renders all frames on `threads` workers (one Previewer + tiny-skia renderer each, round-robin
/// frames) and writes them to stdout in order through a reorder buffer (R-FF Appendix pipe.rs).
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
    let (tx, rx) = sync_channel::<(usize, Result<Vec<u8>, String>)>(threads * 2);
    let outcome: CliResult<usize> = std::thread::scope(|s| {
        for worker in 0..threads {
            let tx = tx.clone();
            let (options, abort) = (&options, &abort);
            s.spawn(move || {
                let mut previewer = match Previewer::new(video, options) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = tx.send((worker, Err(format!("previewer: {e}"))));
                        return;
                    }
                };
                let mut renderer = CpuFrameRenderer::default();
                let mut f = worker;
                while f < total && !abort.load(Ordering::Relaxed) {
                    let result = previewer
                        .svg_tree(f)
                        .and_then(|tree| renderer.render_tree(&tree, Color::TRANSPARENT, w, h))
                        .map(|frame| frame.pixels)
                        .map_err(|e| format!("frame {f}: {e}"));
                    let failed = result.is_err();
                    if tx.send((f, result)).is_err() || failed {
                        break;
                    }
                    f += threads;
                }
            });
        }
        drop(tx);

        let mut out = std::io::BufWriter::with_capacity(1 << 24, std::io::stdout().lock());
        let mut pending: BTreeMap<usize, Vec<u8>> = BTreeMap::new();
        let mut next = 0usize;
        let step = (total / 100).max(1);
        let mut failure: Option<String> = None;
        'recv: for (index, result) in rx.iter() {
            match result {
                Ok(pixels) if pixels.len() == frame_bytes => {
                    pending.insert(index, pixels);
                }
                Ok(pixels) => {
                    failure = Some(format!(
                        "frame {index}: {} bytes, expected {frame_bytes}",
                        pixels.len()
                    ));
                    break 'recv;
                }
                Err(e) => {
                    failure = Some(e);
                    break 'recv;
                }
            }
            while let Some(pixels) = pending.remove(&next) {
                if let Err(e) = out.write_all(&pixels) {
                    failure = Some(format!("stdout: {e}"));
                    break 'recv;
                }
                next += 1;
                if next.is_multiple_of(step) || next == total {
                    event(json!({"event": "progress", "done": next, "total": total,
                                 "elapsed": started.elapsed().as_secs_f64()}));
                }
            }
        }
        if failure.is_none()
            && let Err(e) = out.flush()
        {
            failure = Some(format!("stdout: {e}"));
        }
        abort.store(true, Ordering::Relaxed);
        drop(rx); // unblocks workers waiting on a full channel so the scope can join
        match failure {
            Some(e) => Err(CliError::Other(e)),
            None if next != total => Err(CliError::Other(format!(
                "rendered {next} of {total} frames"
            ))),
            None => Ok(next),
        }
    });
    let frames = outcome?;
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
        println!(
            "{}",
            json!({"name": "jasper-mg", "version": env!("CARGO_PKG_VERSION"), "fframes": FFRAMES_VERSION,
                   "renderer": RENDERER_VERSION, "templates": templates})
        );
        return Ok(());
    }
    match cli.command {
        None => Err(CliError::Spec(
            "missing command (schema | render | frame | svg); see --help".into(),
        )),
        Some(Command::Schema) => {
            println!("{}", schema_json());
            Ok(())
        }
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
            let media = media()?;
            let threads = threads_for(threads);
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
            println!("{}", prepared.svg(frame));
            Ok(())
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
