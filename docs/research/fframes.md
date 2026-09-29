# fframes as JasperEditor's CPU motion-graphics engine

Research spike, 2026-09-29. Upstream: <https://github.com/dmtrKovalenko/fframes>, MIT, site <https://fframes.studio>.
Studied at commit `90a1b29` ("chore: release 1.0.3", 2026-09-29). All crates are version **1.0.3** on crates.io.
Test machine: Linux x64, 12 cores, 47 GB RAM, no GPU, rustc 1.96, system ffmpeg 6.1.1.
Scratch work lives in `/tmp/jasper-research/fframes/` (`src/` = upstream clone, `lower-third/` = stock scaffold,
`alpha-lt/` = the JasperEditor spike with a runtime JSON spec, straight-alpha pipe, and WASM bridge,
`skia-test/` = Skia raster/shader test, `proj2/` = shared-target-dir test).

---

## 0. TL;DR

- **What it is.** A Rust library. A video is a struct that implements `fframes::Video`. `render_frame(frame, ctx) -> Svgr`
  returns an SVG tree for each frame. You write that tree with the `svgr!` proc macro (JSX-like SVG plus `{rust exprs}`).
  You animate with the `timeline!` macro (keyframes, easings, springs). The tree is rasterized by **tiny-skia (CPU,
  default)** or **Skia (GPU Vulkan/Metal, or Skia raster on CPU)**, then encoded by libav, which is linked in
  statically. There is no JSON/DSL layer. **Every video is a Rust crate and has to be compiled.**
- **It works on this machine with no GPU.** A 1080p template renders at **~180–260 fps** on 12 cores with the CPU
  backend. The polygon-heavy `low-poly-art` example renders 600 frames at 1080p60 in 4.3 s (~140 fps).
- **The same crate compiles to WASM.** `fframes-editor-controller` exposes `render_frame(frame) -> String`, which
  returns an **SVG string**. We measured **~37 µs/frame** in Node, so a Remotion `<Sequence>` can show fframes graphics
  live by injecting that SVG. A spec can be swapped at runtime (`update_video`) without reloading the module.
- **Alpha works, with caveats:**
  1. fframes' own encoder writes **premultiplied RGB into a straight-alpha pixel format**. Semi-transparent pixels
     come out darkened: 50% white decodes as `(128,128,128,128)`.
  2. The in-process segment encoder **dropped frames** with `prores_ks` (144 of 150) and `qtrle` (149 of 150).
  3. The prebuilt libav has **no `png` encoder** and no libvpx unless you add the `vpx` feature.

  **Fix:** render frames with `fframes::Previewer`, which already returns straight RGBA (`RgbaFrame::from_premultiplied`
  un-premultiplies), and pipe raw RGBA into the system ffmpeg. Verified output: **VP9+alpha WebM (3.1 s for 150
  frames), ProRes 4444 (6.6 s), PNG sequence (1.9 s)**, correct straight alpha, and all frames present.
- **Compile latency is the main UX risk.** Measured on this box:
  - Cold build: 60–100 s.
  - Release incremental edit: ~9.8 s.
  - **Dev-profile incremental (opt-level 1 crate, deps at opt 3, debug=0): ~1.8 s**, and it renders as fast as release.
  - A new crate that shares a warm target dir: ~9.4 s for its first build, ~1.8 s after that.
  - WASM incremental: ~1.7 s.

  **Recommendation:** ship a **precompiled template library that reads parameters at runtime** (zero compile for
  99% of edits). Keep a **warm "scratch crate" + shared target dir** for agent-authored custom graphics
  (~2 s per edit). Use **WASM → SVG** for live preview inside the Remotion Player.

---

## 1. Repository and crate layout

| path (upstream) | crate | role |
|---|---|---|
| `fframes/` | `fframes` | Core: `Video`/`Scene` traits, `svgr!` re-export, `timeline!` animation, text layout, audio map/mix/analysis, CPU renderer (`renderer/cpu.rs`), encoder (`renderer/encoder*.rs`, `segment_writer.rs`, `concatenator.rs`), `Previewer` (`renderer/preview.rs`), and the per-project CLI (`renderer/cli.rs`, feature `cli`). |
| `fframes-media/` | `fframes-media` | ffmpeg decode (audio/video), fonts, images, subtitles; links `ffmpeg-sys-fframes` (prebuilt static FFmpeg 9). |
| `svgr-macro/` | `svgr-macro` | The `svgr!` proc macro. With feature `compile-time-svgtree`, subtrees that have no `{}` are parsed and hashed at compile time, and renderers cache them. |
| `media-dir-macro/` | `fframes-media-dir-macro` | `include_media_dir!(pub struct XMedia, "media")` embeds a folder in the binary. Fonts register by family name; audio is decoded to mono at compile time. |
| `fframes-skia-renderer/` | `fframes_skia_renderer` | Skia backend (features `vulkan`, `metal`). `SkiaCpuCtx` is Skia raster on CPU. It is the **only backend that runs shaders**. |
| `fframes-native-player/` | `fframes_native_player` | Real-time preview window (GPU, audio) for the `preview` CLI command. |
| `fframes-editor-controller/` | `fframes-editor-controller` | WASM bridge: the `impl_wasm_bridge_for!` macro, `WasmEditor` (`render_frame` → SVG string). |
| `fframes-editor/` | `@fframes/editor` (npm) | ReScript + React 19 + Tailwind 4 web editor (player, timeline, scene map). Renders the SVG string into the DOM and registers fonts through `FontFace`. |
| `cargo-fframes/` | `cargo-fframes` | `cargo fframes new` scaffolder (templates in `cargo-fframes/templates/*.tmpl`). |
| `webvtt-parser/` | `webvtt-parser` | Subtitles. |
| `skills/fframes-video/` | – | The official **agent skill** (`SKILL.md` + `references/{api,design,audio}.md`). Served at `https://fframes.studio/.well-known/agent-skills` (`scripts/build-skills-index.mjs`) for `npx skills add https://fframes.studio`. |
| `examples/*` | – | 15 example videos. Each is a lib+bin crate plus `editor/editor-bridge` (WASM) and `editor/` (Vite app). |
| `render-bench/vs-remotion/` | – | Benchmark against Remotion 4.0.529: 1M text nodes, fframes GPU 1.5×–2.85× faster, CPU backend close to GPU on an M4 Max. The README notes the CPU path "wrote 299 frames instead of 300". |

Upstream has no JSON/DSL layer, no scene-graph file format, and no runtime interpreter. **The authoring surface is
Rust code.** For JasperEditor that is the central fact: something (an agent, or a template with runtime params) has to
turn the editor's spec into Rust, or precompiled Rust has to read the spec.

---

## 2. Authoring model (how a video is expressed)

### 2.1 Project shape (`cargo fframes new`)

```
my-video/
  Cargo.toml          # fframes = { version = "=1.0.3", features = ["compile-time-svgtree","cli"] } (+ h264 on non-windows)
  media/              # include_media_dir! (starter font DMSans-Medium.ttf)
  src/lib.rs          # struct MyVideo + impl Video
  src/main.rs         # fframes::cli::new(&video, RenderOptions{..}).args(args).run()
  tests/frames.rs     # snapshot tests + "no warnings in any frame"
```

Scaffolder flags: `--template single-scene|multi-scene`, `--format landscape|portrait|square|uhd`, `--fps`, `--title`,
`--backend cpu|skia-metal|skia-vulkan`, `--dir`, `--git`, `--fframes-path`, `-y`. A crate made outside the fframes repo
gets its own `[workspace]` and pins `fframes = "=<cli version>"`.

### 2.2 `Video` trait

```rust
impl Video for MyVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;
    const BACKGROUND_COLOR: Color = Color::TRANSPARENT;          // alpha output
    fn duration(&self) -> Duration<'_> { Duration::Seconds(5.0) } // Seconds|Frames|FromAudio|FromVideo|Auto, supports + -
    fn audio(&self) -> AudioMap<'_> { AudioMap::none() }
    fn define_scenes(&self) -> Scenes<'_> { /* optional */ }
    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> { svgr!(<svg ...>...</svg>) }
}
```

- `FPS/WIDTH/HEIGHT/BACKGROUND_COLOR` are **associated consts**, fixed at compile time. `RenderOptions` has
  `override_fps` and `scale_resolution` for runtime adjustment. **Const generics work** (tested in `proj2/`):
  `impl<const W: usize, const H: usize> Video for T<'_, W, H> { const WIDTH: usize = W; ... }`. One binary can
  therefore carry 16:9, 9:16 and 1:1 variants and choose one at runtime.
- `duration()`, `audio()` and `render_frame()` are ordinary runtime methods. **All content can come from runtime data
  such as a JSON spec**, as long as it is precomputed in the constructor. `render_frame` runs on several threads: it
  must not do I/O or panic, and it should cache in `OnceLock`.

### 2.3 `svgr!`

SVG markup with `{expr}` in attributes and text children. An expression can be a string, number, `Color`, `Transform`,
another `Svgr`, or `Vec<Svgr>`. Comments are `// ...` lines. Subtrees that are fully literal (no `{}`) get a
compile-time `static_hash` and are cached across frames. The upstream advice: keep decoration static, and put the
animated values on a wrapping `<g transform={..} opacity={..}>`. Gradients, masks, clipPath and filters go in `<defs>`.
Blur and shadow filters are expensive on the CPU backend unless the subtree is static.

### 2.4 Animation (`timeline!`)

```rust
let x = frame.animate(&fframes::timeline!(
    at 0.0, animate -80.0_f32 => 0.0, Easing::Spring { mass: 1.0, stiffness: 180.0, damping: 20.0 },
    at 2.5 => 2.8, animate 0.0_f32 => 60.0, Easing::EaseIn,
));
// runtime start time (data-driven stagger), used in our spike for a spec-driven "out" time:
let out = frame.animate_runtime(fframes::AnimateRuntimeInput {
    on_second: spec.hold_until_s, from: 1.0_f32, to: 0.0,
    animation_runtime: &fframes::animation::AnimationRuntime::new(0.35, &Easing::EaseIn),
});
```

- Animatable values: `f32`, `f64`, `Color` and `Transform`.
- Easings: `Linear`, `EaseIn`, `EaseOut`, `EaseInOut`, `CubicBezier(..)`, `Spring{..}`. A spring settles on its own time.
- `frame.animate_loop(..)` loops an animation.
- Keyframe times are seconds relative to the current scene.
- **Mapping to the Jasper keyframe model:** our spec's keyframe arrays can drive `animate_runtime` segments directly, or
  be turned into generated `timeline!` calls.

### 2.5 Scenes, text, media, audio, shaders

- **Scenes.** Implement `Scene { duration, render_frame, overlap?, audio? }` and return them from `define_scenes`. In the
  root `render_frame`, call `ctx.render_scenes(&frame)`. `Overlap::Previous(0.4)` gives cross-fades. The CLI addresses
  scenes by struct name (`Intro@1.5s`).
- **Text.**
  - Fonts are measured from the actual font files: `frame.text_width`, `frame.text_fit(.., TextOverflow::Ellipsis)`
    and `frame.text_break_lines(..)` (returns a `<text>` with `<tspan>` lines).
  - All three return `None` when the font is not loaded, which is normal in the web editor.
  - `font-weight` must be numeric.
- **Media.**
  - Static media is embedded with `include_media_dir!`.
  - Runtime media uses `MediaDirectory::read_folder("dir")?.process_media_source()?`, and
    `CombinedMediaProvider::from([...])` merges providers.
  - Lookup: `ctx.get_image/get_audio/get_video/get_subtitles`.
  - `frame.get_synced_video_frame(ctx, "clip.mp4", &SyncVideoFrameInput{..})` puts footage inside a frame.
  - `frame.visualize_audio_frame(..)` provides audio spectrum bars.
- **Audio.** `AudioMap::from([AudioTrack::new("music.mp3", Second(0.)..Eof).gain_db(-16.).fade_in(1.).duck_under_voice(), ...])`.
  The mix is sample-accurate and output is stereo, with a -1 dBFS limiter. The CLI adds `audio analyze` (LUFS, true
  peak, silence, per-scene) and `audio render -o a.wav`. **For JasperEditor the audio lives on the main timeline, so
  fframes MG clips should be silent.** Keep `AudioMap::none()`.
- **Shaders.**
  - `fframes::Shader::sksl(src)` or `Shader::shadertoy(glsl)`, then `.draw(&frame, ShaderUniforms::new().float(..).color(..).image(..))`,
    placed with `<image href={layer.href()} ..>`.
  - They run **only on the Skia backend**. tiny-skia draws nothing in their place, and the web editor shows a
    placeholder.
  - On this machine we ran a full-frame domain-warped fbm SkSL shader (`examples/shaders/src/shaders/aurora.sksl`)
    through `SkiaCpuCtx` (Skia raster, no GPU): 180 frames at 1080p took **62.9 s (~2.9 fps)**. Shaders on CPU work but
    are slow. Budget them for small or short layers, or render them at `--scale 0.5`.

### 2.6 The per-project CLI (`fframes::cli`, feature `cli`)

Each generated binary has the same commands. They are machine-friendly: `--json` prints one JSON document on stdout and
**NDJSON progress on stderr**.

| command | notes |
|---|---|
| `render [RANGE] [-o out.ext] [--draft]` | Container comes from the extension; encoder settings come from `RenderOptions.video_encoder_options` in `main.rs`, with no CLI flag for codec or pixel format. `--draft` = half size + fastest preset. |
| `frame 1s,50%,Intro@end [-o dir] [--svg]` | PNGs with **straight alpha**, plus diagnostics. |
| `strip [RANGE] -n 12`, `onion RANGE -n 6` | Contact sheet / motion trail PNGs (for agents). |
| `svg TIME` | The frame as SVG after usvg conversion. **Text is converted to paths**, so it is font-independent. |
| `timeline`, `inspect [--fail-on warning]` | Structure; problem detection without rasterizing (missing fonts/media, clipped text, NaN transforms, panics; exit 2). |
| `snapshot`, `audio render/analyze/at`, `preview` | Visual regression; audio tools; GPU preview window (needs `fframes_native_player`). |

Observed `--json` progress stream (stderr), ideal for a daemon progress bar:

```
{"event":"start","frames":30}
{"event":"progress","done":3,"total":30,"elapsed":0.081}
...
{"event":"done","output":"/tmp/.../range.mov","elapsed":0.453}
```

Custom flags: define `#[derive(clap::Args)] struct Args { #[arg(long, global = true)] spec: Option<String> }`, call
`cli::parse::<Args>()`, then `.args(args)`. This is how a template takes `--spec spec.json` with no recompile (verified).

---

## 3. Backends

| backend | how | speed (this box) | shaders | notes |
|---|---|---|---|---|
| `fframes::cpu::CpuRenderingBackend` (default) | tiny-skia, `concurrency = logical cores`; the video is split into GOP-aligned segments, one encoder per worker, then concatenated | scaffold template 180f 1080p: 0.7–1.0 s; low-poly-art 600f 1080p60: 4.27 s (1015% CPU, 830 MB RSS) | no (drawn as nothing) | `cache_capacity` (static subtree cache, default 20), `text_cache_capacity`. |
| Skia `SkiaCpuCtx` (`SkiaFFramesRenderer::new_cpu`) | Skia raster surface | same template: 1.08 s (≈ tiny-skia) | **yes, on CPU** | Needs `fframes_skia_renderer` with the `vulkan` feature so the **prebuilt** Skia is downloaded (cold build 77 s). A CPU-only feature set has no prebuilt and compiles Skia from source (~20 min, libclang). The binary loads Vulkan lazily, so `ldd` shows only libstdc++ extra. |
| Skia Vulkan/Metal | GPU | upstream: ~10× CPU for raster-heavy scenes; roughly equal for text-heavy scenes | yes | Not usable here (no GPU). Relevant for the Electron desktop app on user machines. |

Recommendation: **the default CPU backend for everything, and Skia-raster only for templates that need shaders.**
Add Vulkan/Metal later as an optional desktop accelerator.

---

## 4. The WASM / browser path

- `fframes-editor-controller` (cdylib) plus the `impl_wasm_bridge_for!(MyVideo<'static>, MyMedia)` macro produce a
  `#[wasm_bindgen] struct WasmBridge` with:
  - `prepare(fps?) -> VideoMetadata` (`durationInFrames`, `fps`, `width`, `height`, `scenesTimeline`, `audioMap`)
  - `render_frame(frame: bigint) -> string` (**SVG markup**)
  - `render_preview_frame` (base64-inlined media)
  - `add_image_source` / `add_audio_source` / `add_video_source_placeholder` / `add_subtitles_source`
  - `ingest_font`, `get_static_font_data_by_index` (embedded fonts, so the page can register them via `FontFace`)
- Rust side `WasmEditor::replace(video)` (exposed per bridge as `update_video`) swaps the video without reloading the
  module.
- The official editor (`fframes-editor/src/Player.res`) calls `render_frame(BigInt(frame))` and puts the SVG into the
  DOM. Fonts are registered in `services/MediaResolvers.ts` → `new FontFace(name, buf)`. Video sources are decoded
  with WebCodecs (`services/VideoFrameDecoder.ts`, mediabunny).
- Build: `cargo build --release -p <bridge> --target wasm32-unknown-unknown`, then
  `wasm-bindgen --target web|nodejs` (upstream uses `wasm-pack build --target web`).
- **Measured in the spike** (`alpha-lt/editor-bridge`, `smoke.cjs`):

  | measurement | result |
  |---|---|
  | cold wasm build | 20.8 s |
  | incremental wasm build | 1.7 s |
  | `.wasm` size | 1.05 MB raw, 558 KB after wasm-bindgen (no wasm-opt) |
  | `create_wasm_bridge` + `prepare` | 5.5 ms |
  | 150 × `render_frame` | 5.6 ms total (≈37 µs/frame) |
  | `set_spec(json)` (our own `#[wasm_bindgen] impl WasmBridge` calling `update_video`) | works; the next `render_frame` shows the new text |
- Gotchas we hit:
  1. **`getrandom 0.3` via `ahash` breaks `wasm32-unknown-unknown`.** Fix: add
     `getrandom03 = { package = "getrandom", version = "0.3", features = ["wasm_js"] }` to the bridge and
     `.cargo/config.toml`: `[target.wasm32-unknown-unknown] rustflags = ["--cfg", 'getrandom_backend="wasm_js"']`.
  2. The generated JS does `require("@fframes/editor")` for `load_audio_wasm_callback`, and it expects a global
     `__fframes_get_video_frame(filename, pts, preview)`. Outside the official editor, stub both, or depend on
     `@fframes/editor`.
  3. `render_frame` takes an `i64`, so JS must pass a `BigInt`.
  4. The wasm bridge must build the video lib with `default-features = false`. Gate `cli` and `compile-time-svgtree`
     behind a `renderer` feature, as the examples do. **Feature unification then makes release builds of the bin and
     of the wasm bridge in one target dir invalidate each other** (+9 s each switch). Use separate target dirs, or
     build the wasm lib with the same feature set.
- **Fidelity caveat.** In the browser, the SVG is rasterized by Chromium or WebKit, not by tiny-skia/resvg:
  - Text shaping, filter details and anti-aliasing can differ slightly from the native render.
  - Shaders show a placeholder.
  - Text-measuring helpers return `None` until fonts are ingested.

  For pixel-exact preview, use the native `svg` command (text already turned into paths) or the rendered alpha proxy.

---

## 5. Hands-on log (exact commands, timings, failures)

All times are wall clock on the 12-core box.

```bash
git clone --depth 50 https://github.com/dmtrKovalenko/fframes /tmp/jasper-research/fframes/src

# 1) CLI: built from the clone (same code as crates.io 1.0.3)
cargo install --locked --path src/cargo-fframes --root /tmp/jasper-research/fframes/bin      # 13.7 s
export PATH=/tmp/jasper-research/fframes/bin/bin:$PATH

# 2) scaffold a CPU project
cargo fframes new lower-third --template single-scene --backend cpu --format landscape --fps 30 --title "JasperEditor" --yes
cd lower-third && cargo build --release                                                     # 63 s -> LINK FAILURE (below)
```

**Failure 1: x264 link.**

```
rust-lld: error: unable to find library -lx264
```

Cause: the template turns on `features = ["h264","libav-agree-gpl"]` for non-Windows targets. The box has only the
runtime `libx264.so.164` and no `libx264-dev`. Workaround attempt: symlink `libx264.so` and pass
`RUSTFLAGS="-L <dir>"` (the RUSTFLAGS change forced a 72 s full rebuild). The result:

```
rust-lld: error: undefined symbol: x264_encoder_open_163
```

The **prebuilt FFmpeg archive** (`~/.cache/ffmpeg-sys-fframes/binaries-9.0.0/ffmpeg-x86_64-unknown-linux-gnu-...-gpl-...-x264.tar.gz`,
79 MB) is compiled against **x264 ABI 163**, while Ubuntu 24.04 ships ABI 164. Options: install the matching
`libx264-dev`, build FFmpeg from source (`FFMPEG_FORCE_BUILD=1`, which needs nasm and the dev packages, and takes
minutes), or **drop the `h264` feature**. We dropped it. JasperEditor does not need fframes to produce H.264: final
delivery encoding belongs to our native ffmpeg pipeline.

```bash
# remove the [target.'cfg(not(windows))'.dependencies] fframes h264 line from Cargo.toml, then:
cargo build --release          # 24.8 s (ffmpeg-sys + fframes + crate; the non-x264 prebuilt archive was already cached)
./target/release/lower-third timeline      # "1920x1080 @ 30 fps, 180 frames (6.00s)"
./target/release/lower-third inspect       # 0.01 s, "checked 24 frames: no problems found"
./target/release/lower-third frame 1s,50%,end   # 0.10 s
./target/release/lower-third strip -n 12        # 0.08 s
./target/release/lower-third render -o out_default.mp4   # 0.69 s, 180 frames, falls back to mpeg4/yuv420p (no x264), 307 MB RSS
```

**Spike `alpha-lt`** (a transparent, parameterized lower third). Sources are in `/tmp/jasper-research/fframes/alpha-lt/`
and key excerpts are in the Appendix.

```bash
cargo build --release                          # fresh target, warm registry + ffmpeg cache: 62 s
./target/release/alpha-lt --codec prores4444 render -o out_prores4444.mov   # 17.1 s, only 144/150 frames (!)
./target/release/alpha-lt --codec png        render -o out_png.mov          # FAIL: "Can not find encoder png, continue with mpeg4"
                                                                            #       "Pixel format `AV_PIX_FMT_RGBA` is not supported for current codec"
./target/release/alpha-lt --codec qtrle      render -o out_qtrle.mov        # 0.28 s, 149/150 frames (!)
./target/release/alpha-lt --codec ffv1       render -o out_ffv1.mkv         # 2.1 s, 150 frames, but also muxes a silent ac3 audio stream
./target/release/alpha-lt --spec spec2.json frame 1.5s                      # runtime params: different name/color/duration, 0.04 s, no rebuild
```

**Alpha correctness check.** Frame 60, pixel (10,10) is a 50% white probe rect. Pixel (400,960) is a `#0b1020` bar at
72% opacity.

| source | probe (10,10) | bar (400,960) | verdict |
|---|---|---|---|
| `qtrle` (fframes encoder) | (128,128,128,128) | (8,12,23,184) | **premultiplied data tagged as straight** → dark fringes |
| `ffv1` (fframes encoder) | (128,128,128,128) | (8,12,23,184) | same |
| `prores_ks` 4444 (fframes encoder) | (128,128,128,129) | (8,12,23,185) | same |
| `frame` command PNG | (255,255,255,128) | (11,17,32,184) | correct straight alpha |
| **pipe → ffmpeg `libvpx-vp9` yuva420p** | (255,255,255,129) | (9,18,31,185) | correct |
| **pipe → ffmpeg `prores_ks` 4444** | (255,255,255,129) | (11,17,32,185) | correct |

Root cause in upstream code:
- `fframes/src/renderer/cpu.rs` submits `pixmap.data()` (tiny-skia is **premultiplied**) to `SegmentWriter`.
- `fframes/src/renderer/encoder_frame.rs::FrameFormatConvertor::new` declares the source as `AV_PIX_FMT_RGBA`
  (straight), and `sws_scale` converts it with no un-premultiply.
- The preview path un-premultiplies in `RgbaFrame::from_premultiplied` (`fframes/src/renderer/preview.rs`).

Workarounds:
- Composite fframes-encoded files as premultiplied: ffmpeg `overlay=...:alpha=premultiplied`, or an `unpremultiply`
  pass.
- Better: **the pipe approach below.**
- Or upstream a fix: un-premultiply in `fill_from_rgba_pixmap` when the output pixel format has alpha. It is a small
  PR worth sending.

**The pipe approach (recommended export path).** `alpha-lt/src/bin/pipe.rs`: N threads, one `Previewer` +
`CpuFrameRenderer` each, round-robin frames, reorder buffer, raw straight-RGBA to stdout.

```bash
P=./target/release/pipe
$P > /dev/null                                                                    # 0.57 s  (150 frames, ~263 fps raw render)
$P | ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 30 -i - \
    -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 30 -deadline realtime -cpu-used 8 -row-mt 1 -auto-alt-ref 0 lt_vp9a.webm   # 3.07 s, 112 KB, alpha_mode=1, 150 frames
$P | ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 30 -i - \
    -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -vendor apl0 lt_prores.mov                                              # 6.60 s, 14 MB, 150 frames
$P | ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 30 -i - -compression_level 1 pngseq/f%05d.png                         # 1.87 s, 6.9 MB
# composite sanity check over footage (the result image showed a clean lower third over testsrc2):
ffmpeg -f lavfi -i testsrc2=s=1920x1080:r=30:d=5 -c:v libvpx-vp9 -i lt_vp9a.webm \
    -filter_complex "[0][1]overlay=shortest=1" ...
```

Note: decode VP9 alpha with `-c:v libvpx-vp9` **before** `-i`. The native vp9 decoder drops the alpha side channel.

**Compile-latency matrix** (`alpha-lt`, one small `lib.rs` edit in the `svgr!` markup):

| scenario | time |
|---|---|
| cold release build, empty target, cold registry | 63 s (+ ~79 MB FFmpeg prebuilt download, cached in `~/.cache/ffmpeg-sys-fframes`) |
| cold release build, empty target, warm registry + FFmpeg cache | 62 s |
| release, edit `lib.rs` → binary | **9.8 s** (release: LLVM opt of the crate + link of a 34 MB static binary) |
| release, no-op | 0.26 s |
| dev profile cold (template default: crate `opt-level=1`, deps `opt-level=3`) | 103 s (87 s with `CARGO_PROFILE_DEV_DEBUG=0`) |
| dev, edit `lib.rs` → binary (debug=2) | 2.5 s |
| **dev, edit `lib.rs` → binary (debug=0)** | **1.7–1.8 s** |
| render speed dev vs release binary (qtrle, 150f) | 0.35 s vs 0.31 s (hot code lives in deps built at opt 3) |
| **new crate** (`proj2`) with **shared warm `CARGO_TARGET_DIR`**, dev | 9.4 s first build (only the new crate compiles), then ~1.8 s/edit |
| const-generic size change (`proj2`, 1080×1920) | 7.6 s |
| WASM bridge cold / incremental | 20.8 s / 1.7 s |
| Skia (vulkan feature, prebuilt download) cold release | 77 s; shader edit rebuild 10.8 s |
| upstream workspace, `motion-graphics` + `low-poly-art` examples, cold release | 131 s |
| `wasm-bindgen-cli 0.2.129` install | 39 s |
| disk | target dirs 1.8–6.2 GB each; binaries 25–37 MB (static libav) |

Other failures and notes:
- `motion-graphics` example: `--video-codec mpeg4 render` fails with `libav error -22: Invalid argument`, because its
  hard-coded x264 `codec_params` are passed to mpeg4. `EncoderOptions.codec_params` goes to whatever encoder is
  chosen, so **validate codec/param pairs ourselves**. Upstream docs warn that bad params can even segfault libav.
- `EncoderOptions.pixel_format` is **not** silently downgraded despite the doc comment: `stream.rs::make_video` returns
  `InvalidPixFmt`.
- mkv output from the fframes encoder adds an ac3 audio stream even when there is no audio.
- The CPU backend's `preview` command needs `fframes_native_player`, which the cpu template does not include.

---

## 6. Output formats for overlaying on footage

| target use | format | produced how | alpha | verdict |
|---|---|---|---|---|
| Live preview in Remotion Player (Chromium: web, Electron, Android) | **SVG per frame from WASM** | `bridge.render_frame(f)` | native SVG transparency | **Best.** Zero encode, instant parameter edits. |
| Proxy clip in Player (Chromium/Firefox) | **WebM VP9 yuva420p** | pipe → system ffmpeg `libvpx-vp9` | yes (`alpha_mode=1`) | Good. Small (112 KB for 5 s), 3 s to encode. **Safari/iOS cannot decode VP9 alpha.** |
| Proxy for Safari/iOS PWA | HEVC-with-alpha (`hvc1`, VideoToolbox only) or PNG/WebP sprite, or the WASM SVG path | – | – | Use WASM SVG on iOS. HEVC alpha needs Apple hardware to encode. |
| Mastering / export compositing (native ffmpeg) | **ProRes 4444** (`prores_ks -profile:v 4 yuva444p10le`) or **PNG sequence** | pipe → system ffmpeg | yes | ProRes 4444 is the NLE standard: 14 MB for 5 s, 6.6 s to encode. PNG seq is fastest and lossless. |
| Lossless intermediate | `qtrle` .mov / `ffv1` .mkv | fframes encoder | premultiplied + frame-drop bug | Avoid until upstream is fixed. |
| Final delivery H.264/HEVC/AV1 | – | our native export pipeline composites the MG layer over footage | n/a | fframes should not own delivery encoding. |

---

## 7. Integration designs for JasperEditor

Context: JasperEditor's timeline items are the `EditorStarterItem` union in `src/editor/items/item-type.ts`
(`image|text|video|solid|captions|audio|gif`), rendered through `src/editor/items/inner-layer.tsx`. Video uses
`@remotion/media`'s `<Video>` or `OffthreadVideo` (`src/editor/items/video/video-layer.tsx`). The sibling
orquester repo uses a Fastify + tsx daemon at `apps/daemon`, which we will mirror.

A new item type is common to all three designs:

```ts
// src/editor/items/motion-graphic/motion-graphic-item-type.ts
export type MotionGraphicItem = BaseItem & CanHaveRotation & {
  type: 'motion-graphic';
  templateId: string;          // e.g. "lower-third@1" (template library) or "custom:<hash>" (agent-authored)
  params: Record<string, unknown>; // validated by the template's JSON Schema (zod mirror)
  canvas: '16x9' | '9x16' | '1x1';
  renderState:                 // proxy/master artifacts produced by the daemon
    | {status: 'none'} | {status: 'rendering'; progress: number}
    | {status: 'ready'; proxyAssetId: string /* webm vp9a */; masterAssetId?: string /* prores4444 or png-seq */};
  fadeInDurationInSeconds: number; fadeOutDurationInSeconds: number;
};
```

Add it to the union in `item-type.ts`, add a branch in `inner-layer.tsx`, add an inspector at
`src/editor/inspector/motion-graphic-inspector.tsx` (auto-generated from the JSON Schema), and add a timeline preview.

### Design C (build first): precompiled, parameterized template library

A Rust workspace in the monorepo, e.g. `native/mg/`:

```
native/mg/
  Cargo.toml                    # [workspace]; profile.dev: opt-level=1, deps opt-level=3, debug=0; profile.release: lto="thin"
  crates/jasper-mg-core/        # shared: spec types (serde), easing helpers, keyframe -> animate_runtime adapter, fonts in media/
  crates/jasper-mg-templates/   # lib: one module per template (lower_third, title_card, callout, counter, progress_bar, ...)
                                #      enum AnyTemplate { LowerThird(..), TitleCard(..) } implementing fframes::Video by delegation
                                #      const-generic canvas sizes <W,H> for 16:9 / 9:16 / 1:1
  crates/jasper-mg-cli/         # bin "jasper-mg": `render --spec spec.json --canvas 16x9 --out - (raw rgba) | --out file`,
                                #  `frame`, `inspect`, `schema` (prints JSON Schema of every template), `--json` NDJSON progress
  crates/jasper-mg-wasm/        # cdylib: impl_wasm_bridge_for!(AnyTemplate<'static>, Media) + set_spec(json)
```

- **One binary, one wasm, N templates.** `impl_wasm_bridge_for!` defines a single `WasmBridge` type per crate, so the
  enum-dispatch `AnyTemplate` is how many templates share one module.
- **The spec is read at runtime:**
  - Text, colors, timings, keyframes, and positions inside the template canvas.
  - Durations: `duration()` returns `Duration::Seconds(spec.duration)`.
  - User images, logos and fonts: `MediaDirectory::read_folder(tmpdir)` with the files the daemon drops in.
  - **Edits never recompile.**
- **Render path (daemon, Node):**
  1. Spawn `jasper-mg render --spec - --canvas 16x9 --raw-rgba`.
  2. Pipe it into the system/bundled ffmpeg twice (or tee): a VP9-alpha WebM proxy and ProRes 4444 or a PNG sequence
     for export.
  3. Parse `{"event":"progress"}` from stderr and push it to the editor over WebSocket, into `renderState.progress`.
  4. Budget: 5 s at 1080p → about 0.6 s of render + about 3 s of VP9 encode on 12 cores.
- **Scale resolution** to the project's size with `RenderOptions.scale_resolution = projectHeight / 1080`.
- **CI** builds `jasper-mg` for linux-x64/arm64, darwin-x64/arm64 and win-x64. Windows needs `FFMPEG_DIR` pointing at
  an FFmpeg 9 shared build. Electron ships them as `extraResources`, and the daemon resolves the path per platform.
- **Pros:** zero compile latency, deterministic, testable (snapshot tests per template via `fframes::snapshot`),
  offline, agent-friendly (the agent fills JSON that the schema validates).
  **Cons:** new looks need a release. The expressiveness is whatever the templates expose.

### Design B: WASM live preview inside the Remotion Player

```tsx
// src/editor/items/motion-graphic/motion-graphic-layer.tsx (sketch)
import {useCurrentFrame, delayRender, continueRender} from 'remotion';
import {getMgBridge} from './mg-wasm'; // lazy-loads /mg/jasper_mg_wasm_bg.wasm once, registers embedded fonts via FontFace

export const MotionGraphicLayer = ({item}: {item: MotionGraphicItem}) => {
  const frame = useCurrentFrame();                       // relative to the item's <Sequence>
  const bridge = useMgBridge(item.templateId, item.params, item.canvas); // set_spec on params change (async, delayRender until ready)
  const svg = useMemo(() => bridge?.render_frame(BigInt(frame)) ?? '', [bridge, frame]);
  return <div style={{position: 'absolute', left: item.left, top: item.top, width: item.width, height: item.height,
                      transform: `rotate(${item.rotation}deg)`, opacity: item.opacity}}
              dangerouslySetInnerHTML={{__html: svg.replace('<svg ', '<svg width="100%" height="100%" ')}} />;
};
```

- **One WASM instance per template** (or one shared `AnyTemplate` bridge per item), cached by
  `templateId + hash(params)`. `set_spec` costs microseconds. Render costs ~37 µs/frame, so scrubbing is effectively
  free.
- The JS glue `require('@fframes/editor')` needs a tiny ESM shim module aliased in `vite.config.ts`
  (`resolve.alias['@fframes/editor'] = './src/editor/items/motion-graphic/fframes-shim.ts'`), unless audio is
  used. Define `globalThis.__fframes_get_video_frame = () => null`, or back it with the asset cache if templates embed
  footage.
- **This also works in Remotion server/lambda renders.** Chrome renders the SVG, so exports through the existing
  `src/routes/api/render.ts` path "just work", with no alpha video needed.
- **Fidelity:** browser SVG vs tiny-skia raster differ slightly (text, filters), and shaders show a placeholder. For
  frame-exact export, prefer design C's ProRes master. Treat WASM as preview, or accept Chrome raster as final when
  exporting through Remotion.
- **Works on iOS Safari (PWA)**, where VP9-alpha proxies do not.

### Design A: agent-authored custom graphics (codegen + compile daemon)

For "make me an animated bar chart of these numbers with this brand style" when no template fits:

1. The agent (with the upstream `skills/fframes-video` skill vendored into our agent prompt, adapted to our crate)
   writes `src/lib.rs` for a **persistent scratch crate** `native/mg/crates/jasper-mg-scratch/`. Codegen is either
   free-form Rust or a stricter JSON→Rust generator for a "motion spec" (layers, keyframes, easings) that emits
   `svgr!` + `timeline!`.
2. The daemon runs `cargo build --bin scratch --message-format=json`, dev profile, `debug=0`, with the **shared warm
   target dir** that ships with the desktop app or is prewarmed on first launch. It feeds compiler diagnostics back to
   the agent.
3. The agent self-checks with `scratch inspect --json` and `strip -n 12` (contact sheet PNG for a vision model), as
   the skill prescribes.
4. The daemon renders through the same pipe → ffmpeg path. Content-addressed caching: `hash(lib.rs)` → the binary is
   copied to `~/.jasper/mg-cache/<hash>` so undo/redo never recompiles. `hash(lib.rs + params)` → the proxy/master
   assets.
5. Optional: build the same lib for `wasm32` (~1.7 s incremental) to get a live SVG preview (design B) for custom
   graphics.
6. A good custom graphic can be "promoted" into the template library (design C) by a human or agent PR.

- **Measured latency:** ~1.8 s compile + ~0.6 s render + 3 s VP9 encode for a 5 s clip. Show the SVG/WASM or
  `frame` preview first and encode in the background.
- **Requirements:** the Rust toolchain on the machine that runs the daemon. That is fine for a server or desktop
  build, and **not possible on web-only or mobile PWA clients**, so run design A server-side for web/PWA.
- **Sandboxing:** agent-written Rust is arbitrary code, and so is `build.rs` in dependencies. Run builds and renders
  in a container or firejail with no network after the dependency prefetch (`cargo fetch` + `--offline`), with CPU
  and memory limits. Forbid new dependencies: the agent edits only `src/lib.rs`, and `Cargo.toml` is locked.

### Recommended plan

1. **Phase 1:** design C with 5–8 templates, plus the pipe → VP9-alpha proxy and ProRes/PNG-seq master, plus the
   `motion-graphic` item type.
2. **Phase 2:** design B (WASM SVG preview) for instant parameter scrubbing and iOS.
3. **Phase 3:** design A (agent codegen) with the scratch crate and warm target, server-side for web and local for
   Electron.

---

## 8. Compile-time latency: risk and mitigations

The risk: first-time setup (60–130 s cold, plus 79 MB FFmpeg and optional Skia downloads, plus 2–6 GB target dirs),
and 10 s per edit if someone uses `--release` naively. Mitigations, in order of impact:

1. **Do not compile per edit.** Templates read JSON at runtime (design C). Confirmed: `--spec spec2.json` changes
   name, color, duration and position with no rebuild.
2. **Use the dev profile for codegen builds:** crate `opt-level=1`, `[profile.dev.package."*"] opt-level=3`
   (already in the scaffold template), and `debug=0`. Measured 1.7–1.8 s per edit, with render speed equal to
   release.
3. **One shared, pre-warmed `CARGO_TARGET_DIR`** for all generated or scratch crates, with identical `Cargo.lock` and
   feature sets. A new crate then costs only its own compile (9.4 s first time, 1.8 s after). Keep **bin and wasm
   builds in separate target dirs** to avoid feature-unification churn (we measured +9 s for each switch).
4. **Prefer one persistent scratch crate** that the agent overwrites, rather than a new crate per graphic.
   Incremental compilation state then carries over.
5. **Pre-warm at install time.** Ship the target dir as a tarball for the desktop app, or run `cargo build` for
   the scratch crate on first launch in the background. Vendor the FFmpeg prebuilt with `FFMPEG_BINARIES_CACHE` /
   `FFMPEG_BINARIES_URL` (the `ffmpeg-sys-fframes` env vars in its `build_prebuilt.rs`) so nothing depends on GitHub
   at runtime.
6. **sccache** (`RUSTC_WRAPPER=sccache`) helps across machines and CI and for cold builds of identical dependency
   graphs. It does **not** help incremental local edits, because sccache does not cache incremental crates. Use it on
   CI and render workers, not for the edit loop.
7. The linker is already `rust-lld` (default on x86_64 Linux as of rustc 1.90+, seen in the link line). `mold` could
   shave a little more; it is not installed here.
8. `cargo check --message-format=json` (faster than build) gives quick agent feedback before the full build.
9. Keep `lto` off for scratch builds. Use `lto="thin"` only for the shipped template binary.

---

## 9. Licensing and distribution

- fframes and its crates: MIT.
- **libav is statically linked into every fframes binary** (`fframes-media` → `ffmpeg-sys-fframes` with
  `build`+`static`; this cannot be turned off on non-wasm targets).
  - Without `libav-agree-gpl` + x264/x265 it is LGPL-2.1+. Distributing the static binary (Electron `extraResources`)
    brings **LGPL static-linking obligations**: provide object files or a relinkable form plus notices, or build
    against shared libav.
  - Enabling `h264`/`h265` + `libav-agree-gpl` makes the binary **GPL**. Avoid that in shipped templates; do H.264
    in the separate ffmpeg process.
- Skia (BSD) prebuilts are downloaded from rust-skia releases at build time.

---

## 10. Open questions / to verify during implementation

- Can `@remotion/media` `<Video>` (WebCodecs/mediabunny) decode VP9 alpha in the Player? The HTML5 `<Video>` from
  `remotion` and `OffthreadVideo transparent` support it in Chromium. Verify before relying on WebM proxies inside
  `VideoLayer`. Design B avoids the question.
- Upstream bugs worth reporting, or fixing in a patch crate:
  1. Premultiplied alpha in the encoder path.
  2. Segment-concat frame loss (`prores_ks` 144/150, `qtrle` 149/150; the upstream bench README also saw 299/300 on
     CPU).
  3. `png` encoder missing from the prebuilt, because `--disable-autodetect` drops zlib.
  4. The mkv phantom ac3 track.
- Windows builds: need `FFMPEG_DIR` (FFmpeg 9 shared) + LLVM. The Electron win-x64 artifact must bundle those DLLs.
- A fidelity diff harness (WASM/Chrome SVG vs tiny-skia PNG per template, with `odiff` as upstream uses) to decide
  whether Remotion-rendered SVG is acceptable as the final export.
- Throughput with many concurrent MG renders on the 12-core box: each render uses all cores by default. The daemon
  should cap it with a job queue, the `THREADS` env var of the pipe binary, or `CpuRenderingBackend.concurrency`.

---

## Appendix: spike source excerpts (`/tmp/jasper-research/fframes/alpha-lt`)

`Cargo.toml` (key parts):

```toml
[dependencies]
fframes = { version = "=1.0.3" }            # no h264: avoids the x264 ABI issue and GPL
serde = { version = "1", features = ["derive"] }
serde_json = "1"
[features]
default = ["renderer"]
renderer = ["fframes/compile-time-svgtree", "fframes/cli"]
[[bin]]  name = "alpha-lt"  path = "src/main.rs"      required-features = ["renderer"]
[[bin]]  name = "pipe"      path = "src/bin/pipe.rs"  required-features = ["renderer"]
[workspace]  members = [".", "editor-bridge"]
[profile.dev]  opt-level = 1
[profile.dev.package."*"]  opt-level = 3
```

`src/lib.rs` (the template, which reads the spec at runtime):

```rust
#[derive(Debug, Clone, Deserialize)] #[serde(default)]
pub struct LowerThirdSpec { pub name: String, pub title: String, pub accent: String,
                            pub duration_s: f32, pub hold_until_s: f32, pub x: f32, pub y: f32 }

impl Video for AlphaLtVideo<'_> {
    const FPS: usize = 30; const WIDTH: usize = 1920; const HEIGHT: usize = 1080;
    const BACKGROUND_COLOR: Color = Color::TRANSPARENT;
    fn duration(&self) -> Duration<'_> { Duration::Seconds(self.spec.duration_s) }
    fn audio(&self) -> AudioMap<'_> { AudioMap::none() }
    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let s = self.spec;
        let bar_w = frame.animate(&fframes::timeline!(at 0.0 => 0.5, animate 0.5_f32 => 760.0, Easing::EaseOut));
        let slide = frame.animate(&fframes::timeline!(at 0.15, animate -60.0_f32 => 0.0,
                                  Easing::Spring { mass: 1.0, stiffness: 220.0, damping: 22.0 }));
        let out = frame.animate_runtime(fframes::AnimateRuntimeInput { on_second: s.hold_until_s, from: 1.0_f32, to: 0.0,
                  animation_runtime: &fframes::animation::AnimationRuntime::new(0.35, &Easing::EaseIn) });
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" viewBox={format!("0 0 {WIDTH} {HEIGHT}")} width={WIDTH} height={HEIGHT}>
                <g opacity={out} transform={Transform::translate(s.x, s.y)}>
                    <rect x="0" y="0" width={bar_w} height="150" rx="10" fill="#0b1020" fill-opacity="0.72" />
                    <rect x="0" y="0" width="10" height="150" rx="4" fill={s.accent.as_str()} />
                    <g transform={Transform::translate(slide, 0)}>
                        <text x="40" y="70" font-family="DM Sans" font-size="56" font-weight="500" fill="#ffffff">{s.name.as_str()}</text>
                    </g>
                    <text x="40" y="122" font-family="DM Sans" font-size="32" font-weight="500" fill={s.accent.as_str()}>{s.title.as_str()}</text>
                </g>
            </svg>
        )
    }
}
```

`src/main.rs` (fframes CLI with runtime `--spec` and an encoder switch):

```rust
#[derive(Debug, clap::Args)]
struct Args { #[arg(long, global = true)] spec: Option<String>,
              #[arg(long, global = true, default_value = "prores4444")] codec: String }
// ...
let (encoder, pix, params, out) = match args.app.codec.as_str() {
    "prores4444" => ("prores_ks", AVPixelFormat::AV_PIX_FMT_YUVA444P10LE, Some(&[("profile","4"),("alpha_bits","16"),("vendor","apl0")][..]), "out.mov"),
    "qtrle"      => ("qtrle", AVPixelFormat::AV_PIX_FMT_ARGB, None, "out.mov"),
    "ffv1"       => ("ffv1",  AVPixelFormat::AV_PIX_FMT_BGRA, None, "out.mkv"),
    _            => ("mpeg4", AVPixelFormat::AV_PIX_FMT_YUV420P, None, "out.mp4"),
};
let options = RenderOptions { media: Some(&media), video_encoder_options: EncoderOptions {
    preferred_encoder: Some(encoder), pixel_format: pix, codec_params: params, ..Default::default() }, ..Default::default() };
cli::new(&video, options).default_output(out).args(args).run()
```

`src/bin/pipe.rs` (straight-alpha raw RGBA to stdout, all frames in order):

```rust
let probe = Previewer::new(&video, &options).expect("previewer");
let total = probe.timeline().duration_in_frames;
let (tx, rx) = sync_channel::<(usize, Vec<u8>)>(threads * 2);
std::thread::scope(|s| {
    for w in 0..threads {
        let tx = tx.clone(); let (video, options) = (&video, &options);
        s.spawn(move || {
            let mut p = Previewer::new(video, options).expect("previewer");
            let mut r = CpuFrameRenderer::default();
            let mut f = w;
            while f < total { tx.send((f, p.render(f, &mut r).expect("render").pixels)).unwrap(); f += threads; }
        });
    }
    drop(tx);
    let mut out = BufWriter::with_capacity(1 << 24, std::io::stdout().lock());
    let (mut pending, mut next) = (BTreeMap::new(), 0);
    for (i, px) in rx { pending.insert(i, px);
        while let Some(px) = pending.remove(&next) { out.write_all(&px).unwrap(); next += 1; } }
    out.flush().unwrap();
});
```

`editor-bridge/lib.rs` (WASM + live spec swap):

```rust
#![cfg(target_arch = "wasm32")]
use fframes_editor_controller::prelude::*;
impl_wasm_bridge_for!(AlphaLtVideo<'static>, AlphaLtMedia);
lazy_static! { static ref MEDIA: AlphaLtMedia = AlphaLtMedia::prepare().expect("static media"); }
fn leak_spec(json: &str) -> Result<&'static LowerThirdSpec, JsValue> {
    Ok(Box::leak(Box::new(serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?)))
}
#[wasm_bindgen] pub fn create_wasm_bridge(spec_json: String) -> Result<WasmBridge, JsValue> {
    console_error_panic_hook::set_once();
    Ok(WasmBridge::new(AlphaLtVideo { media: &MEDIA, spec: leak_spec(&spec_json)? }, &MEDIA))
}
#[wasm_bindgen] impl WasmBridge {
    pub async fn set_spec(&self, spec_json: String) -> Result<VideoMetadata, JsValue> {
        self.update_video(AlphaLtVideo { media: &MEDIA, spec: leak_spec(&spec_json)? }).await
    }
}
```

(`Box::leak` per edit leaks the old spec, a few hundred bytes each. In production, keep specs in an arena or a
`static RwLock<Vec<Arc<Spec>>>` and use an owned-data video type.)

Build and run in Node:

```bash
cargo build --release -p alpha-lt-bridge --target wasm32-unknown-unknown
wasm-bindgen --target nodejs --out-dir pkg-node target/wasm32-unknown-unknown/release/alpha_lt_bridge.wasm
node smoke.cjs   # init 5.5 ms; 150 frames 5.6 ms; set_spec -> "Edited live" present in next frame's SVG
```
