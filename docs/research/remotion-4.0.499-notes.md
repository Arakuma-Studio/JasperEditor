# Remotion 4.0.499 — verified behavior (WP-2C)

Scope: answers to ARCHITECTURE §18 items 2–3, S02 open question 1, S03 §27 item 1 and S04 §27 item 3,
as far as they were verified on this machine (Linux x64, 12 cores, no GPU, Node 20.20, Chrome 150
`/usr/bin/google-chrome`, fixtures from `pnpm fixtures`). "Read" = verified by reading the published
`dist/` code of the pinned packages; "Measured" = verified by running it.

## Player

| Topic | Result | How |
|---|---|---|
| `playbackRate` bounds | `<Player playbackRate>` accepts any non-zero value in **[-10, 10]**; 0 and anything outside throw (`@remotion/player/dist/cjs/utils/validate-playbackrate.js`). There is no imperative `setPlaybackRate`: the rate is a prop (a React re-render of the host on rate changes only). | Read |
| Real-time rates on this box | Playing 1080p30 H.264 through `@remotion/media` `<Video>`: 1× advanced at ~22–27 frames/s once warm (the first second after a seek buffers, ~7 fps); 2× advanced at ~16 frames/s and 4× at ~24 frames/s instead of 60/120 because the Player pauses its clock while the decoder buffers. | Measured (dev handle `window.__jasperMonitor`, 1–3 s windows) |
| Decision (S02:TL-873) | `PlaybackDriver` hands the Player only forward rates in **[0.1, 1]**. Reverse rates and everything above 1× use seek-stepping: a virtual clock advances the playhead on every animation frame and seeks the paused Player ≤ 30×/s. Measured stepping accuracy: 2× → 60.4 frames/s (target 59.9), 4× → 119.4 (119.9), 8× → 241.1 (239.8), −1× → −30.0 (−30). AC-18b (8× within ±5 %) holds. Revisit `NATIVE_MAX_RATE` when proxies (720/540) are the playback tier. | Measured |
| Buffering events | `PlayerRef` emits `waiting` and `resume` (plus `play`, `pause`, `ended`, `seeked`, `frameupdate`, `timeupdate`, `ratechange`, `error`, …; `dist/cjs/event-emitter.d.ts`). `frameupdate` fires every frame and is what the driver reports to the TransportStore; `bufferStateDelayInMilliseconds` controls how fast `waiting` fires. The Program shows a buffering dot from `waiting`/`resume` (PGM-005 precursor). | Read + used |
| CSS-scaled parent | The Player measures itself with `ResizeObserver` `contentRect` divided by the parent's CSS scale (`utils/use-element-size.js`), so sizing it at composition size inside a `transform: scale()` wrapper renders at scale 1 inside and the overlay can share the wrapper's transform (S03 §27 item 2). devicePixelRatio ≠ 1 was not tested (headless DPR 1). | Read + measured |
| Controls/keys | `controls={false}`, `clickToPlay={false}`, `doubleClickToFullscreen={false}`, `spaceKeyToPlayOrPause={false}`, `moveToBeginningWhenEnded={false}`, `acknowledgeRemotionLicense` are all plain props. | Read |
| End of timeline | With `loop={false}` the Player pauses on its last frame and emits `ended`; the driver then pauses the store (or loops In→Out itself when the monitor Loop is on). | Measured |

## Sequences, premount, volume

- `<Sequence premountFor>` cannot be combined with `layout="none"` (throws) — visual clips therefore
  use the default AbsoluteFill layout; audio clips use `layout="none"` without premount. (Read, `Sequence.js`.)
- **Volume callback frame (KND-011).** `volume={(f) => …}` receives `useCurrentFrame() + cumulatedNegativeFrom`
  (`audio/use-audio-frame.js`): the number of frames since the media first became visible. It is
  **not** affected by `trimBefore`. When the `<Sequence from>` is ≥ 0 this equals the clip-local frame;
  when a render range starts inside a clip (`from` < 0) add `-from`. Implemented as
  `volumeFrameToClipFrame` and unit-tested. Values ≥ 100 throw (`volume-safeguard.js`); we cap gain at 16×.
- **`trimBefore` semantics.** Media time = `elapsed × playbackRate + trimBefore / fps`
  (`@remotion/media` `getTimeInSeconds`): `trimBefore` is in composition frames of *media* time and is
  not scaled by the playback rate, and fractional values are accepted. So `trimBefore = sourceIn (s) × fps`.
  Measured with `still:smoke`: sourceIn 2 s, frame 45 at 30 fps → burned-in source time 00:00:03.500;
  with speed 2× → 00:00:05.000.

## `@remotion/media` `<Video>` in the Player vs `renderMedia`/`renderStill`

- Player: decodes with WebCodecs (mediabunny) into a `<canvas>`; frames are drawn upright (it applies
  the container rotation itself). Worked for H.264/AAC MP4 and VP9 WebM served over HTTP with Range.
- Renders: `pnpm --filter @jasper/compositions still:smoke` bundles `remotion-entry.ts` with
  `@remotion/bundler` and renders stills of a video + text sequence with `@remotion/renderer`
  `renderStill` using `/usr/bin/google-chrome` with `chromeMode: 'chrome-for-testing'` (→ `--headless=new`;
  the default `headless-shell` mode passes `--headless=old`, which current Chrome no longer supports).
  `<Video>` rendered frame-accurately (see trimBefore above) — **no `OffthreadVideo` fallback needed**;
  `@remotion/media` still falls back to `OffthreadVideo` by itself when it cannot decode.
  Bundle ≈ 2.5–10 s, each still ≈ 1.3 s.
- **Gotcha for WP-2F:** `renderStill`/`renderMedia` render `composition.props` as resolved by
  `selectComposition`; passing different `inputProps` to `renderStill` alone does not change what is
  rendered. Always `selectComposition({inputProps})` with the props you render.

## VP9 alpha (S04 §27 item 3)

A `libvpx-vp9 -pix_fmt yuva420p` WebM (alpha_mode=1, opaque 320×180 box on a transparent 640×360
frame) decoded **with alpha** in the Player through `@remotion/media` `<Video>`: the canvas pixel inside
the box read `[0,14,253,255]`, outside `[0,0,0,0]`, and with the layer below disabled the monitor showed
only the box over the black background. A plain `<video>` element in the same Chrome also decodes the
alpha. So VP9-alpha preview files are usable for fframes previews in Chromium/Electron (Safari not
tested; S03:KND-060 keeps the PNG/WebP fallback for it). Rendering VP9-alpha in `renderMedia` was not
tested.

## Colour stage frame source (wp-m2-color, S06:CG-041)

Verified in the 4.0.499 sources and end to end (headless Chrome render, Player in Chrome):

- `remotion` 4.0.499 ships canvas **effects**: `createEffect({type, backend: '2d' | 'webgl2' | 'webgpu', setup(target),
  apply({source, target, state, params, width, height, flipSourceY}), cleanup, calculateKey, schema, validateParams})`
  returns a factory of `EffectDescriptor`s. `@remotion/media` `<Video effects={[…]}>` and `<Img effects={[…]}>` run the
  chain on the decoded frame: in the Player on every painted frame (and again when the `effects` prop changes while
  paused: `redrawCurrentFrame`), in renders inside the frame-extraction promise **before** `continueRender`, so the
  captured frame is the graded one. `<Img effects>` renders a `CanvasImage` (numeric `width`/`height` required).
- The chain (`Internals.runEffectChain`) ping-pongs through a per-element canvas pool; WebGL2 pool contexts are
  created with `premultipliedAlpha: true`, `preserveDrawingBuffer: true`, `UNPACK_PREMULTIPLY_ALPHA_WEBGL = true`; the
  last pass is drawn onto the element's 2D canvas with `drawImage`. A lost context marks the canvas and
  `runEffectChain` throws after the pass (`assertContextNotLost`).
- JasperEditor's colour stage (`packages/compositions/src/color/`) is one `webgl2` effect per colour run (the baked
  33³ LUT as an `RGB32F` 3D texture, `texelFetch` tetrahedral — no filtering) plus `2d` `ctx.filter` passes for
  CSS-filter effects that precede a grade. The pass sets `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false` and
  `UNPACK_FLIP_Y_WEBGL = flipSourceY` itself.
- `<OffthreadVideo>` has no `effects`; its `onVideoFrame(img)` fires from `<Img onImageFrame>` **before** the image's
  `continueRender`, so a synchronous `delayRender` + draw into our `ColorCanvas` (Internals `useEffectChainState` +
  `runEffectChain`) is captured in renders. The `<OffthreadVideo>` stays mounted (opacity 0).
- Headless render browser: Remotion's default `chromiumOptions.gl` (no flag) already gives WebGL2 on this host
  (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))`), but that is SwiftShader on the CPU. The engine
  probes `null → angle-egl → angle → egl → vulkan` at start-up and uses the first whose `UNMASKED_RENDERER_WEBGL` is not
  a software rasteriser (SwiftShader, llvmpipe, softpipe, lavapipe, swrast). With none, it uses the first software
  context, trying `swangle → swiftshader` only when no candidate gave WebGL2 at all, and reports `hardware: false`
  (`JASPER_REMOTION_GL` forces one, `off` disables). On Linux the GPU back ends are tried only when a GPU device node
  exists (`/dev/dri/renderD128`, `/dev/nvidia0`, `/dev/dxg`). They open in parallel after the default.
  Measured with the engine's probe and system Chrome on an RTX 3080 Ti (driver 595.99.02, KDE X11) over SSH without
  `DISPLAY`: default → SwiftShader; `angle` → no WebGL2; `angle-egl` → `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX
  3080 Ti/PCIe/SSE2, OpenGL ES 3.2)`; `vulkan` → `ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA …))`. Inside the desktop session
  environment `angle` reaches the GPU too (`OpenGL 4.5.0`). The automatic probe chose `angle-egl` in both environments,
  taking about 1.6 s. Chrome run by hand with only `--use-angle=vulkan` (without Remotion's other Vulkan flags) crashed its GPU
  process there. The JasperVideoStuff session saw the render browser's CPU load drop from 641 % to about 47 % with `angle-egl`. Graded Remotion stills equal the TypeScript reference (`applyLut` of the baked LUT) on 100 % of chart
  pixels (max 1 code value).

## Not verified (follow-ups)

- `numberOfSharedAudioTags` interplay with `@remotion/media` `<Audio>` (we pass 8; `@remotion/media`
  uses Web Audio, the shared tags are for `Html5Audio`).
- Audio levels were not measured by ear/meter; the gain math is unit-tested.
- `@remotion/web-renderer` stills, animated WebP/AVIF component availability, WebGL access to decoded
  frames (S03 §27 item 1, later milestones).
- DevicePixelRatio ≠ 1 / browser zoom alignment of the overlay.
