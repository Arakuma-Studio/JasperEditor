# Social-comment templates — work notes

Design: `docs/superpowers/specs/2026-10-25-social-comment-templates-design.md`. Each work package adds its own section.

## Remote fonts & emoji (WP2 `sc/assets`, design §7.8, §7.11)

### What it does

Templates that replicate a platform draw with the platform's fonts and emoji. A template declares them; the render
snapshot loads exactly those faces and emoji images for preview and export; what the app may not ship is downloaded
by the engine on first need, verified, cached and served through the font routes. Nothing is ever substituted: a
missing asset is a visible marker in the Player and a named export blocker.

### Contracts (C2)

| Piece | Where |
|---|---|
| `EmojiPackId = 'apple' \| 'twemoji' \| 'noto'`, `EMOJI_PACK_IDS`, `splitEmoji(text)`, `emojiGraphemes(text, limit?)`, `isEmojiGrapheme(g)`, `emojiKey(g)`, `emojiCodepointKey(g, {stripFe0f?, join?, minDigits?})`, `emojiCodepointCandidates(g, rule)`, `graphemeOfEmojiKey(key)` | `packages/mg-templates/src/emoji.ts` |
| `MgAnimeTemplateDefinition.requiredAssets?(params): TemplateRequiredAssets` (`{ fonts: {family, weight, style}[]; emoji?: { pack, graphemes }; images?: string[] }` — `images`: manifest image ids) | `packages/mg-templates/src/types.ts` |
| `templateRequiredAssets(def, params, paramKeyframes?)`, `templateAssetOptions(registry, {font, emoji})`, `resolveTemplateParams(def, params)`, `TemplateRequiredAssetsSchema` | `packages/mg-templates/src/assets.ts` |
| `SnapshotOptions.templateAssets` (`required`, `font`, `emoji`, `image?`), `RenderTemplateAssets`, `mg.assets` on anime clips, `RenderSnapshot.emoji`, `RenderSnapshot.images`, `fonts[].unicodeRange`, `templateFontId(family)` (`template:<family>`), `emojiTableKey(pack, g)`, `TemplateFaceFile` | `packages/project/src/render/snapshot.ts` |
| `AnimeTemplateProps.emojiUrls` (keyed `${pack}:${grapheme}`; `emojiUrlOf(urls, pack, g)`), `AnimeTemplateProps.imageUrls` (keyed by manifest image id) | `packages/motion/src/templates/types.ts`, `index.ts` |
| `EmojiImage({url, size, alt, pack?, style?})`, `MissingAssetMarker({kind, label, size?, style?})`, `MissingAssetReporterContext`, `TemplateAssetScopeContext`, `retryTemplateAssets()`, `useTemplateAssetEpoch()`, `missingAssetLabel()` | `packages/motion/src/templates/assets.tsx` |
| `MgTemplatePreview` prop `assets?: {font, emoji}` (gallery posters load declared fonts / emoji) | `packages/compositions/src/layers/MotionGraphicLayer.tsx` |
| Manifest `apps/engine/src/remote-assets/manifest.json` (schema `schema.ts`; filled by WP5), override `<appdir>/assets/remote-manifest.override.json` | `apps/engine/src/remote-assets/` |
| Routes: `GET /fonts/remote/<id>-<sha16>.<fmt>`, `GET /fonts/emoji/<pack>/<version>/<key>.<png\|svg>`, `GET /fonts/images/<id>-<sha16>.<png\|jpeg\|webp\|svg>`, `GET/PUT /api/settings/network`, `GET /api/remote-assets`, `POST /api/remote-assets/prefetch`, `POST /api/remote-assets/notice/ack`; event `remoteAssets.changed` | `apps/engine/src/routes/fonts.ts`, `remote-assets.ts`; `packages/api/src/remote-assets.ts` |
| Export blocker `TEMPLATE_ASSETS_UNAVAILABLE` (409; `detail.assets[]` with `kind`, `label`, `reason`, `code`, `retryable`, `clipIds`) | `apps/engine/src/remote-assets/plan.ts`, `export/planner.ts` |

Manifest schema additions beyond the contract (all optional, for packs whose file names need them): `cpJoin` (code
point separator in `{cp}`, default `-`), `cpMinDigits` (zero padding, default none — Noto's `emoji_u0023_20e3` is
`{cp}` with `cpJoin: "_"`, `cpMinDigits: 4`), and `{name}` in `urlTemplate` with a `names` map (canonical key → slug)
for CDNs whose paths carry an emoji name (Emojipedia's `grinning-face_1f600.png`; looked up by the sequence as typed,
without U+FE0F and fully qualified). Font `format` may be `woff2`, `woff`, `ttf` or `otf`; a font entry may carry a CSS
`unicodeRange` — when every entry of one face has one, they are its subset files and load together. An optional
`images` section (`id`, `url`, `sha256`, `format` png / jpeg / webp / svg, `licence`, optional `source`, `width`,
`height`) lists remote images templates declare by id (X's and YouTube's default avatars); they are pinned by SHA-256
like the fonts, served at `/fonts/images/…`, handed to templates as `imageUrls`, follow the same network policy, and a
missing one is a striped "Image … is not available" banner in preview and an export blocker naming it.

### How it flows

1. **Declaration.** `requiredAssets(params)` of the template, evaluated for the params and for the params with each
   keyframe value substituted (a keyframed text or emoji style changes what is drawn; ≤ 64 variants), validated with
   zod and bounded (≤ 32 faces, ≤ 512 emoji per pack); a throwing or invalid hook declares nothing.
2. **Snapshot** (`buildRenderSnapshot`, every consumer that renders passes `templateAssets`): declared faces join
   `fonts` with `fontId: template:<family>` — bundled faces as every subset file (latin, latin-ext) with its CSS
   `unicode-range`, so extended Latin never falls back to a host font; remote faces as one file — and emoji URLs join
   `emoji`. The clip's source carries `mg.assets`. Unresolvable ones become `TEMPLATE_FONT_UNAVAILABLE` /
   `TEMPLATE_EMOJI_UNAVAILABLE` warnings. Nested sequences merge both into the parent. This fixes the old gap where a
   font named only in template params loaded only if a text clip used it: a declaring template never relies on
   `TEMPLATE_FONT`.
3. **Resolution.** Faces: bundled catalogue first, then the manifest, by exact family (case-insensitive), weight and
   style — never another weight or family. Emoji: the pack must be in the manifest; the URL is
   `/fonts/emoji/<pack>/<version>/<every code point, lower hex, "-">.<format>`. Editor: `apps/web/src/remote-assets/resolve.ts`
   over `GET /api/fonts` (which lists remote families with `source: 'remote'` and `emojiPacks`); engine:
   `FontCatalogService.templateFaceFiles` and `RemoteAssetService.emojiUrl`. Text clips never resolve remote families
   (preview and export agree; the text font picker does not offer them).
4. **Layer.** `MotionGraphicLayer` waits for exactly the declared faces, passes `emojiUrls` (the clip's entries of the
   table) and checks what is missing (absent from the snapshot or failed to load). Player: the card is drawn with a
   striped "Font … is not available" banner, emoji drawn by `EmojiImage` without a URL or whose image fails show a
   dashed "?" square of the emoji's size, and everything is reported to the Program monitor. Renders (export, bake,
   still): the layer throws / `EmojiImage` calls `cancelRender`, so a file that broke after planning fails the render
   with the reason instead of exporting a substitute.
5. **Planner.** `planExport` builds the snapshot with engine URLs, then `checkTemplateAssets` downloads every remote
   face and emoji the clips declare (network policy permitting) and throws `TEMPLATE_ASSETS_UNAVAILABLE` naming each
   missing font, or emoji and pack, the clips and the reason ("not in the manifest", `REMOTE_ASSETS_OFF`,
   `DOWNLOAD_NOT_FOUND`, `ASSET_HASH_MISMATCH`…) — before anything renders, on every path (native, hybrid, Remotion,
   stills, previews, layer-bake previews: they all plan through it).
6. **Bake key.** `clipFonts` takes exactly the declared faces, so `KeyMaterial.fonts` holds the SHA-256 of each file
   (remote fonts hashed from the cache); `KeyMaterial.emoji` (present only when the layer draws emoji) holds pack id,
   pack version and each image's SHA-256. The bake document carries signed font and emoji URLs.

### Downloads (`RemoteAssetService`)

- Cache: `<appdir>/assets/remote/fonts/<id>-<sha256[0:16]>.<format>` and `…/emoji/<pack>/<version>/<key>.<format>`
  with `index.json`. Every file is written with `atomicWriteFile` (same-directory temp, fsync, rename, directory
  fsync); the emoji index too (`atomicWriteJson`, per-pack mutex).
- Fonts are pinned by the manifest's SHA-256: a different download is `ASSET_HASH_MISMATCH` and nothing is cached; a
  cached file is re-hashed once per process (a damaged file is reported with its path, not served). The hash prefix in
  the file name makes the URL immutable (`cache-control: immutable` and the service worker's cache-first `/fonts/`).
- Emoji lookups try the sequence as typed and its fully-qualified form (`fullyQualifiedEmoji`: U+FE0F after every
  text-default emoji character, UTS #51), each with or without U+FE0F per the pack rule — a ZWJ sequence typed without
  VS16 (`🏳‍🌈`) still finds Twemoji's `1f3f3-fe0f-200d-1f308.svg`.
- Emoji cannot be pinned in advance: the first verified fetch (PNG magic / SVG root, no HTML pages, no active SVG
  content, size cap) records its SHA-256 in the index; later downloads (cache deleted) must match, else
  `ASSET_HASH_MISMATCH` — a changed upstream needs a pack version bump in the override, which starts a new
  directory and a new bake key. `fe0f: try-both` tries the full sequence, then the one without U+FE0F (only a 404
  moves on).
- Limits: per-host concurrency 4, per attempt timeout 30 s (fonts) / 15 s (emoji), size caps 16 MB / 1 MB (declared
  `content-length` and while streaming), 2 retries with 300 ms doubling backoff for network errors, timeouts, 5xx,
  408 and 429 only. Concurrent requests for one file share one download. Prefetch runs ≤ 8 emoji at a time.
- Errors are `{code, message, detail?, retryable}`: `REMOTE_ASSET_UNKNOWN` (404), `REMOTE_ASSETS_OFF` (409),
  `DOWNLOAD_NOT_FOUND` (404), `DOWNLOAD_FAILED` / `DOWNLOAD_TIMEOUT` (502 / 504, retryable), `DOWNLOAD_TOO_LARGE`,
  `ASSET_HASH_MISMATCH`, `ASSET_BAD_CONTENT` (502), `ASSET_CACHE_WRITE` (500, retryable). Failures are never cached
  (`no-store`).
- The manifest override is re-read when its size or mtime changes; an invalid or oversized (> 4 MB) override is
  ignored and reported (`GET /api/remote-assets` → `manifest.override`), never fatal.
- Serving: the routes are under `/fonts/`, so session auth, signed URLs for the headless browser (`UrlSigner`
  `SIGNABLE`), the dev proxy and the service worker apply unchanged; emoji keys are validated
  (`graphemeOfEmojiKey`: canonical lower-hex, one emoji grapheme) before anything is fetched, and only the manifest's
  current pack version is served.

### Network policy (spec 04 OF-002)

"Platform fonts & emoji for social templates" (`<appdir>/engine/network.json`, zod-validated, a corrupt file reads as
the default) is on by default and shown in Preferences ▸ Privacy & Network with what is cached, the source hosts, the
override state and the licence caveat. Off: no request is made; cached files are still used; missing ones block
exports (`REMOTE_ASSETS_OFF`). An agent turning it on is asked about in the editor (`requireUserApproval`); turning it
off needs no approval. The first successful download records a notice (what, from where, licence caveat) shown once
as a non-blocking toast by the first editor window that sees it and acknowledged in the engine — downloads made by
headless, MCP or CLI renders are announced in the next editor that connects.

### Editor

- The Program monitor prefetches the sequence's declared assets as soon as the document needs them (debounced), so
  every clip is covered, and shows **"N template assets not available"** (bottom left) listing each font / emoji, the
  clips and the reason, with **Retry download** (asks the engine again, then reloads failed fonts and images:
  `retryTemplateAssets`) and **Privacy & Network…**. The catalogue and the prefetch are refreshed on
  `remoteAssets.changed` (settings or manifest).
- Strings are in the i18n catalogue with Spanish translations.

### For the gallery and other Players

`MgTemplatePreview` takes `assets={catalogAssetResolver(catalog)}` (`apps/web/src/remote-assets/resolve.ts`, stable per
catalogue object) to load a declaring template's fonts, emoji and images in gallery posters and hover previews;
without it the poster shows the markers.

### Bundled fonts

TikTok Sans (`@fontsource/tiktok-sans` 5.3.0, OFL-1.1, Copyright 2024 TikTok Inc.) is bundled like the other catalogue
families (latin + latin-ext, every weight 300–900; the templates use 400/500/600/700) and listed in
`THIRD_PARTY_NOTICES.md`. Roboto 400/500/700 (latin + latin-ext) were already bundled. The packaged engine copies
`unicode.json` with each family so subset files carry their ranges.

### Limitations

- The shipped manifest is empty here; WP5 (`sc/platform-glyphs`) adds the real Chirp, SF Pro and pack entries. Tests
  use a local fixture server, never the network.
- Fonts the existing anime templates (Title Reveal, Lower Third (Animated), Callout, Counter) draw are not declared
  and still use the `TEMPLATE_FONT` stack (`Inter` first), as before; only templates that declare assets are covered.
- Bundled template faces load their latin and latin-ext files; other scripts (Cyrillic, Greek, Vietnamese) of a
  bundled family are not loaded, so those characters use the next font of the stack (same in preview and export).
- Emoji images are drawn by the template; `splitEmoji` follows UTS #51 presentation (text-default pictographs such as
  © or ☺ without VS16 stay text). An emoji a pack lacks is a blocker naming it.
- A template face of the variable Inter family (`Inter Variable`) loads its latin file only (no subset ranges are read
  for variable families).

### Verification (2026-10-25, this host: 8 cores shared with other agents)

- Unit / integration (vitest, `--maxWorkers=2`): `packages/mg-templates/test/emoji-assets.test.ts` (segmentation,
  codepoint keys, fully-qualified lookup, fast-check round trips and key fuzzing, `requiredAssets` collection);
  `packages/project/test/template-assets-snapshot.test.ts` (declared faces load without a text clip, emoji / image
  tables, warnings, nested merge); `packages/motion/test/template-assets.test.tsx` (EmojiImage, marker, retry, render
  failure); `packages/compositions/test/template-assets-layer.test.tsx` (emojiUrls / imageUrls, markers, reports, render
  failure, exact face gating, subset files with unicode ranges, failed-face retry); `apps/engine/test/remote-assets.test.ts`
  (local fixture server: download, pinned hash, damaged cache, HTML pages, policy off, offline, timeout, size caps,
  bounded retries, concurrent dedup, per-host limit, emoji pin index, try-both / fully-qualified / `{name}` /
  `cpJoin`+`cpMinDigits` mappings in the platform-glyphs manifest's shape, override reload, prefetch, notice, images,
  subset font entries, fast-check over manifests); `apps/engine/test/remote-assets-routes.test.ts` (catalogue incl.
  TikTok Sans and Roboto 400/500/700, routes with session token / signed URL / anonymous 401, settings and agent
  approval, status / notice, planner blocker for font, emoji, pack and image, bake key covers font hashes, emoji pack
  version and image hashes); `apps/web/test/remote-assets.test.tsx` (catalogue resolution, Program warning and Retry,
  Privacy & Network page, one-time notice).
- `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/template-assets.e2e.test.ts` — **ran** with
  `/usr/bin/google-chrome`: a test-only template (aliased into the test bundle, never shipped) declaring a font and an
  emoji renders byte-identical PNGs with `renderStill` per frame and `renderFrames` at concurrency 1 and 3; the emoji
  image is drawn; serving another file for the same declared face changes the glyphs (ink differs > 10 %); a missing
  emoji or font fails the render. An engine layer-bake e2e with a declaring template needs a shipped declaring
  template (WP4's) inside the engine's Remotion bundle and was not run here.
- Running app (built engine + web on port 48120, appdir `/tmp/jasper-assets`, a local fixture CDN, Title Reveal
  patched locally — not committed — to declare `Chirp` 700 and its emoji): the first download raised the notice toast
  once; with the setting off and an empty cache the card showed the "Font "Chirp" 700 is not available" banner and the
  Program monitor "3 template assets not available" with reasons; switching the setting on in Preferences ▸ Privacy &
  Network downloaded the files, removed the banner without a reload and left "1 template asset not available" for the
  emoji the fixture CDN lacks; `POST /api/exports/plan` answered 409 `TEMPLATE_ASSETS_UNAVAILABLE` naming that emoji,
  its pack and the clip.
