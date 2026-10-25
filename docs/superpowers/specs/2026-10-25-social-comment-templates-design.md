# Animated social-comment templates — design

Status: draft for approval · 2026-10-25

## 1. Intent

Creators put comments from viewers on screen: a "reply to @user's comment" bubble at the start of a
video, a few comments through it, or a whole run in a "reading your comments" video. Today they
screenshot the comment or use a web generator such as tokcomment.com, which produces still PNGs. Those
images are blurry at video size, can't be edited after insertion, don't animate, and need to be
re-made for every change.

We want JasperEditor to produce these comments natively as **motion-graphics templates**:

- they look as if they were screenshotted from the platform;
- they animate onto the screen (a "pop" the user picks);
- they stay editable on the timeline like any other clip;
- they are sharp at any export resolution, including 4K.

Both people in the editor and AI agents driving the editor must be able to make them quickly and well.
Usage varies. The requester usually puts one at the start of a video; other users place several, by
hand or through an agent.

## 2. Goals

1. Seven comment variants that look like the real platforms. These are the variants tokcomment.com
   offers:

   | Variant id (proposed) | Platform look |
   |---|---|
   | `tiktok-reply` | TikTok "Reply to username's comment" video-reply bubble |
   | `tiktok-comment` | TikTok in-feed comment row |
   | `instagram-post` | Instagram post comment |
   | `instagram-reel-reply` | Instagram "Replying to username" Reels card |
   | `youtube-comment` | YouTube video comment |
   | `youtube-shorts-reply` | YouTube "Comment from @user" Shorts card |
   | `x-post` | X post card |

2. Every variant has light and dark themes and uses the platform's real fonts, icons, verified
   badges, colours, and number and time formats.
3. Entrance animations the user picks per clip:
   - **Classic pop**
   - **Soft spring** (default)
   - **Grow from tail**
   - **Drop & bounce**

   Two optional extras combine with any entrance:
   - **words appear one by one**;
   - **likes tick up**, with the heart thumping at the end.

   The exit is a short reverse of the entrance.
4. Word marks on the comment text: **Highlight**, **Blur** and **Remove**. They are a stated
   improvement over tokcomment and survive later text edits.
5. An excellent human UX:
   - discover the variants in the gallery and insert without overwriting anything;
   - edit through grouped controls that mirror the tokcomment control panel;
   - edit the text directly on the Program monitor;
   - randomize identity and stats;
   - use "Add another";
   - bulk import from a spreadsheet.
6. An excellent agent UX:
   - one call adds one comment or many, every field optional with believable random fill;
   - the call returns the resolved values;
   - human-friendly times are accepted;
   - comments never overwrite each other;
   - a dry run with a preview still is available;
   - every parameter carries a description.
7. Preview and export match exactly (AGENTS.md §4), at any resolution, including export with a
   transparent background.

## 3. Non-goals (this version)

- Reddit, Threads, Facebook, LinkedIn, WhatsApp, Discord. These come later on the same machinery.
- Nested reply threads inside one card. The "View 2 replies" affordance is shown as text only.
- Stacked or scrolling comment feeds inside one clip. Multiple comments are multiple clips.
- A standalone PNG generator UI. Exporting a frame uses the editor's existing still export.
- Recording video replies, or anything resembling posting to platforms.
- Real-person identities. tokcomment's "Celebrity" preset (21 real people with photos and auto-verified
  badges) is **not** copied. Random identities are made up.

## 4. Anti-goals (failure even if it "works")

- It looks off: wrong font, wrong icon, wrong spacing, wrong number format, so viewers can tell it is
  fake.
- Preview and export differ. That includes fonts or emoji silently substituted on the render host.
- An avatar image disappears after a project operation (collect files, exclude unused, delete item,
  relink).
- An agent needs many calls for a batch, or a batch overwrites itself or other clips.
- Editing the text wipes the user's highlights or blurs (tokcomment's behaviour).
- tokcomment's bugs are reproduced:
  - an invisible username in Instagram dark mode;
  - large counts pushing icons out of the card;
  - the YouTube "months" parsed as "hours";
  - "View 0 replies".

## 5. Decisions made by the requester

These are fixed. Change them only with the requester.

- **Fidelity target: indistinguishable from a platform screenshot.** Platform names, logos, icons and
  fonts may be used. AGENTS.md §3 was changed for this ("Templates that replicate a platform's UI may
  use that platform's names, logos, icons and fonts"); the change is not yet committed.
- **Fonts and emoji that can't be bundled are downloaded automatically by the app at runtime**, outside
  the repository. Examples: Chirp, YouTube Sans, SF Pro, Apple Color Emoji. The requester accepted the
  licensing risk this carries; they were told it does not make redistribution licit.
- **Apple emoji come from the image source react-apple-emojis uses (Emojipedia's CDN).** The React
  library itself is not used.
- **tokcomment.com is the layout blueprint** for each variant. The requester's words: "that job was
  already done by tokcomment". Its layouts, sizes and colours are the ground truth for v1. Real platform
  fonts, icons and emoji replace its stand-ins.
- **The AGENTS.md §3 change is the requester's instruction.** They asked for the old item 1 to be
  deleted in full, including the commercial-artwork and brand-asset ban. The rule's text described it as
  invented by an earlier agent. Committing it is a separate step, awaiting the requester's go-ahead.
- **All four entrance styles ship and the user picks per clip.** Word reveal and like tick are
  optional extras.
- **UX for both humans and agents is a first-class requirement.** Usage ranges from one comment at the
  start to many, placed manually or by AI.

## 6. Reference material

- **tokcomment reference set** (not in the repo; screenshots of third-party sites may not be committed
  per AGENTS.md §3 item 3):
  `/var/lib/orquester/workspaces/jaspersito/research/tokcomment-recon/`.
  - Start with `ref/index.md`.
  - Per variant there are:
    - 2× PNGs for light/dark, verified on/off, short/long text, counts, every time unit, each word
      mark, and uploaded vs default avatar;
    - computed-style JSON for every element of the card;
    - every icon as SVG.
  - Caveat: only `tiktok-reply` renders in its real font (Proxima Nova). The other six fell back to
    Liberation Sans because the site never loads Roboto. Use them for layout, colour, spacing and icons,
    not glyph shapes.
- **tokcomment behaviour worth keeping:**
  - Word marks:
    - Highlight is a `#FFE500` pill with black text, 6 px radius and padding `.05em .35em`; adjacent
      highlighted words merge into one pill.
    - Blur is `blur(4px)`.
    - Remove is `opacity: 0` and keeps the gap.
  - Random-stats distribution:
    - likes: 40% 1–500, 30% 500–10k, 20% 10k–100k, 10% 100k–5M;
    - replies: 1–5% of likes;
    - X retweets: 10–30% of likes;
    - X views: 10–50× likes.
  - `@mention` and `#hashtag` colouring.
- **Platform research** (fonts, colours, metrics, formats, verified badges, animation practice) is at
  `/var/lib/orquester/workspaces/jaspersito/research/platform-research.md`, with sources and labels for
  how reliable each value is. The key points:
  - TikTok uses **TikTok Sans** (OFL). The current app uses it; tokcomment's Proxima Nova is the older
    font.
  - YouTube comments use **Roboto**; YouTube Sans is for branding only.
  - X uses **Chirp** and Twemoji.
  - Instagram uses the system font (SF Pro on iOS) and the OS emoji set.
  - Reddit Sans is OFL, for later.

## 7. Architecture

### 7.1 Where it lives

Comment cards are **anime-renderer motion-graphics templates**, the React DOM path, not the Rust
fframes path. Reasons:

- the anime path is the only one with real text shaping and wrapping, CSS (radius, shadow, blur), inline
  images and SVG icons;
- preview and export draw with the same code in Chrome;
- it is already measured for parity: the hybrid export vs `renderStill` gives 99.85% of pixels within
  3/255;
- it needs no Rust twin.

The fframes path cannot wrap text and has no image input.

| Piece | Location |
|---|---|
| Template metadata, param schema, motion model | `packages/mg-templates/src/templates/anime/` |
| React implementation | `packages/motion/src/templates/` |
| Pure helpers: formatters, markup parser, randomizer | `packages/mg-templates` (shared by UI, MCP and renderer) |
| Media plumbing into templates | `packages/project` (spec kinds, integrity), snapshot, `packages/compositions/src/layers/MotionGraphicLayer.tsx` |
| Remote font and emoji assets | `apps/engine` (download, cache, serve) + `packages/compositions/src/fonts.ts` |
| UI | `apps/web/src/panels/motionTemplates/`, `panels/properties/`, Program monitor |
| Agent tools | `apps/mcp/src/tools/` |

Layer rules (`scripts/check-layers.mjs`, `scripts/check-anime.mjs`, inline styles in compositions,
seek-driven anime.js, no wall clock or unseeded randomness) apply as usual.

### 7.2 One template with a `variant` parameter (builder may revisit)

There is a single template, `social-comment@1`, with `variant` as an enum parameter. Switching variant
on a clip is a plain param change that keeps the text, name, avatar and stats, as the requester
expects. Agents also get a single entry point.

The gallery shows one card per variant through a new **presets** facility: a template definition can
declare named param presets (`{id, name, params}`). The gallery and `list_motion_templates` both list
them. Presets are generally useful beyond this feature.

Variant-specific fields are hidden in the UI when they don't apply, for example reposts and views exist
only on X. That needs a small `ui` hint on MG template definitions: groups, labels, a multiline flag,
and visibility by `variant`. Today MG templates get no UI hints (`registry/properties.ts`).

### 7.3 Parameters (v1)

All parameters have defaults that match tokcomment's defaults per variant. Each parameter has a
`.describe()` text, which agents read.

| Group | Params |
|---|---|
| Look | `variant` (enum above); `theme` (`light` \| `dark`); `emojiStyle` (`auto` \| `apple` \| `twemoji` \| `noto`). `auto` picks Apple for TikTok and Instagram, Twemoji for X and Noto for YouTube |
| Author | `displayName`; `handle`; `avatar`; `showProfile` (bool); `verified` (bool). See below for `avatar` |
| Stats | `timeValue` (int ≥ 0); `timeUnit` (`minute`, `hour`, `day`, `week`, `month`, `year`); `likes`, `replies`, `reposts`, `views` (non-negative integers stored raw and formatted per platform); `showReposts`, `showViews` (X) |
| Text | `text`: the comment. Multiline, emoji allowed, word marks as inline markup (§7.5). Max length about 2000 characters |
| Animation | `entrance` (`classic-pop` \| `soft-spring` \| `grow-from-tail` \| `drop-bounce`, default `soft-spring`); `wordReveal` (bool, default off); `likeTick` (bool, default off) |

`avatar` takes one of three values:
- `{mediaId}` for a project media item;
- `{generated: seed}` for a seeded generated avatar;
- `null` for the platform's default silhouette.

Not every variant uses every field. Per tokcomment:
- the Reels and Shorts reply cards have no stats and no verified badge;
- the TikTok reply card has no stats.

The card is laid out on the existing design stages (1080×1920, 1920×1080, 1080×1080). It sits centred
at a default readable size, about 60–75% of frame width on 9:16, which matches real reply stickers.
Position, size and rotation come from the clip's ordinary Motion transform. There are no extra layout
params.

### 7.4 Formatting rules

The formatters are pure, deterministic and locale-independent, for parity. `Intl` output differs
between the preview browser and the render Chrome, so it is not used. Everything lives in
`packages/mg-templates`:

- **Counts per variant**, taken from tokcomment and checked against real platform behaviour where
  known:
  - TikTok: comma-grouped below 10k, then K/M with one decimal.
  - Instagram: comma-grouped.
  - YouTube and X: K/M with one decimal, ".0" dropped.
  - Singular and plural ("1 reply"). Zero replies hides the replies row.
- **Time per variant:** compact `3m/3h/3d/3w/3mo/3y` for TikTok, Instagram and X; "3 months ago" for
  YouTube.
- **@mention and #hashtag colouring per variant**, with correct dark-mode colours.

The builder may refine the exact tables when reference screenshots disagree with tokcomment.

### 7.5 Word marks (Highlight / Blur / Remove)

Marks are stored **inline in `text`**: `==highlight==`, `||blur||`, `~~remove~~`, with `\` escaping.
Reasons:

- the marks travel with the words, so later edits keep them;
- agents can write marks without computing offsets;
- no array parameter is needed, and the Properties panel can't edit arrays today.

Rendering follows tokcomment's look (§6). The parser is pure and fuzzed with fast-check. Unbalanced
markers render literally.

Humans never type markers unless they want to:
- the Properties text control renders marks styled and has Highlight / Blur / Remove / Clear buttons
  for the selection;
- the Program-monitor editor (§7.9) offers the same.

### 7.6 Animation

- Entrance specs, as in the approved sketch:

  | Entrance | Motion | Duration |
  |---|---|---|
  | Classic pop | scale 0 → 1.3 → 1 | ≈270 ms |
  | Soft spring | scale 0.6 → 1, small bounce | ≈450 ms |
  | Grow from tail | scale from the bubble-tail corner (or avatar corner on non-bubble variants) with a −8° → 0° tilt settle | ≈500 ms |
  | Drop & bounce | falls about 60 design px, settles with one bounce | ≈550 ms |

- **Extras:**
  - Word reveal: after the entrance, about 90 ms per word, each word popping from 50% to 100% scale.
    Graphemes are segmented with the existing `segmentText`.
  - Like tick: the count rises 0 → final over about 900 ms, ease-out, then the heart thumps and fills.
    It applies only to variants that show likes.
- **Exit:** about 200 ms, scale to 82% plus fade, eased in.
- Timings go through `animeTemplateTiming`, so short clips compress proportionally.
- Each entrance needs a motion model entry (`motion.ts` `MODELS`), and the extras need `textAt` for the
  tick. The frame-by-frame cue tests enforce both.
- Springs are seek-driven (anime.js spring or closed-form). All randomness comes from `props.seed`.
- Like tick and word reveal must be frame-exact under seeking.

### 7.7 Avatar images in templates (engine capability)

This is a new **media parameter kind for MG templates**. The value is `{mediaId}`.

- **Schema helper and properties:** a schema helper in `mg-templates`; `paramsPropertySpecs` maps it to
  the existing `MediaParamPicker`; dragging from the Project panel onto the field also works.
- **Snapshot and render:** the snapshot resolves template media to signed URLs (as for effect
  params). `AnimeTemplateProps` receives the resolved URLs. The template draws with Remotion `<Img>`,
  so render waits for the decode.
- **Bake key:** must include the media content hash. Today it already finds `mediaId` anywhere in the
  clip.
- **Reference integrity: data-loss fix, done first, with failing regression tests.** Each of these
  must count avatar references held in params:
  - `collectOrphans` / `item.delete`;
  - `mediaUsage`;
  - Project Manager "Exclude Unused" and collect;
  - relink;
  - INV-006 missing-media reporting.

  `repairDocument` sets a dangling avatar to `null` and reports it.
- **Schema bump to v8**, a no-op migration with fixture, compatibility test and `docs/project-files.md`
  row. Older builds would misread these references (their Project Manager drops the avatar), so
  AGENTS.md §0 requires it.
- Generated avatars (`{generated: seed}`) are drawn by the template itself and need no media.

### 7.8 Remote fonts and emoji (engine capability)

This is a **remote asset manifest** for fonts and emoji packs that the app may not bundle.

- **Manifest:** shipped in the repo. Per asset it records id, family/weight/style or pack id, source
  URL or URL template, expected SHA-256 where fixed, format and a licence note. A user-level override
  file in the appdir lets URLs be fixed without a release when platforms move their files.
- **Download and cache:** the engine downloads on first need into `<appdir>/assets/remote/`. It
  verifies the hash, then serves the asset through the existing font routes. Both preview and
  export/bake read the same cached file. Font hashes are already part of the bake key; the emoji pack
  and its version join it.
- **Fonts:**
  - Bundled through the existing catalog where the licence allows: TikTok Sans (OFL), Roboto (already
    bundled).
  - Remote: Chirp, SF Pro, and any others the calibration shows are needed.
  - Template fonts must be loaded explicitly. Today a font named only in template params loads only if
    some text clip also uses it. Fix that so templates never fall back to the host font stack
    (`TEMPLATE_FONT`).
- **Emoji:**
  - The template renders each emoji grapheme as an image from the selected pack. Rendering is
    therefore independent of host fonts and identical in preview and export.
  - Apple images come from the Emojipedia CDN (about 160 px, enough for about 100 px emoji at 4K).
    Twemoji (CC BY 4.0, attribution in notices) and Noto (OFL) come through the same mechanism.
  - Individual emoji download lazily and are cached and hashed on first fetch.
- **Network policy (my call; reconciles the requester's "automatically" with spec OF-002, which bans
  implicit network use):**
  - Remote platform assets are a named network use listed in Settings ▸ Privacy & Network as "Platform
    fonts & emoji for social templates". It is **on by default** and can be switched off.
  - Downloads start automatically when a template needs an asset, with no blocking prompt.
  - The first time, a non-blocking notice names what was fetched, where from, and the licence caveat.
  - Headless, MCP and CLI flows download on demand the same way when the setting is on.
  - When it's off, missing assets give the blocker below.
  - If Settings ▸ Privacy & Network doesn't exist yet, add the minimum: this one toggle plus its
    persisted preference. Validate it with zod.
- **SF Pro (my call):** the manifest points at a direct font-file mirror pinned by SHA-256. The
  requester chose automatic download for "the other ones", and Apple only ships SF Pro inside a DMG.
  The manifest override lets the source be swapped. Extracting the DMG at runtime is out of scope.
- **Failure is never silent** (AGENTS.md §4):
  - Preview shows a visible "font/emoji not available" marker on the card plus a panel warning.
  - The export planner blocks with a reason naming the missing font, or the emoji and pack. The user
    can retry the download, switch `emojiStyle`, or remove the emoji.
  - Offline behaves the same way.

### 7.8a Platform icons, badges and logos (my call)

The real glyphs are taken from each platform's own web app or published brand kit: the heart, reply,
repost, views, bookmark, share and kebab icons, the verified badges, and tokcomment's X header mark if
the real X UI shows it.

- They are committed as inline SVG path data inside the templates. They are tiny, and the amended
  AGENTS.md §3 item 1 allows platform icons in platform-replicating templates.
- Provenance is recorded per glyph: source URL, capture date, and "proprietary; used under the
  platform-template exception". The record lives in a new `licenses/platform-assets.md`, so §3 item 5
  ("provenance must be established") is met.
- tokcomment's lucide stand-ins are **not** used where a real glyph exists. Use lucide only as a
  documented fallback for a glyph that can't be sourced, and list each one in the work note.

### 7.9 Human UX

- **Gallery:**
  - a "Social comments" category in Motion Templates with one card per variant preset;
  - the animated hover preview already exists;
  - double-click, Enter or drag inserts.
- **Insertion never overwrites:** a new **first-free-track placement** puts the clip on the lowest
  video track above the target that is free for the clip's time range, creating a track if needed.
  This is used by the UI insert, "Add another", bulk import and MCP.
- **Properties:**
  - grouped as in §7.3, mirroring tokcomment's left panel;
  - a variant switcher keeps content;
  - Author includes the avatar picker, a verified toggle and a **Randomize identity** button;
  - Stats includes time value plus unit and the counts, with a **Randomize stats** wand;
  - Text uses the marks-aware editor;
  - Look and Animation complete the groups;
  - irrelevant fields are hidden per variant.
- **Randomize:**
  - Writes concrete values into params as one undoable command, so the document stays deterministic.
  - Identity uses a made-up handle and name generator plus a `{generated}` avatar.
  - Stats follow tokcomment's distribution.
  - It lives in `mg-templates` so the UI and MCP share it.
- **Program monitor:**
  - double-click the card to edit its text in place, following the existing `CanvasTextEditor`
    patterns;
  - selecting words shows a small floating Highlight / Blur / Remove / Clear toolbar.
- **Add another:** duplicates the selected comment right after it on the timeline, with a fresh random
  identity and stats, as one undo step.
- **Bulk import:**
  - CSV, or rows pasted from a spreadsheet (TSV).
  - One comment per row, placed sequentially from the playhead at the default duration.
  - Columns use the parameter names (`variant`, `displayName`, `handle`, `text`, `likes`, …), with
    tokcomment's `User`/`Comment`/`Verified` accepted as aliases.
  - A preview table appears before insertion, with row-level validation errors.
  - XLSX is out of scope for v1.
- **Polish:**
  - all strings go through i18n with Spanish in `es.json`;
  - template names, labels and descriptions get added to the model-string catalogue;
  - design tokens only.

### 7.10 Agent UX

- **Batch add.** `add_motion_graphic` accepts either one item or `items[]`, applied as one transaction
  (one undo step).
  - Track defaults to first-free placement for templates. It is no longer a fixed V2 that overwrites.
  - Per item: `template` or `preset` (e.g. `social-comment:x-post`), `params`, `at`, `duration`.
  - Omitted social-comment fields are filled by the shared randomizer from an optional `seed`.
  - The result returns clip ids and **fully resolved params**.
- **`dryRun: true`** returns resolved params plus a preview still (via the existing render preview)
  without changing the document.
- **Times:** `arguments.ts` additionally accepts `"00:03"`, `"3s"` and `"1.5s"` everywhere.
- **Discovery:** `list_motion_templates` includes presets and param descriptions. `TEMPLATES_GUIDE`
  gains a short social-comments section with one example call, including word-mark syntax and
  `emojiStyle`.
- **HTTP and CLI:** these reach the same commands (`/api/agent/tx`, `jasper call add_motion_graphic`).
  No separate code path.

### 7.11 Output

- Vector text and icons, so output is sharp at any resolution. Avatars are limited by their source
  resolution; the UI warns when an avatar is below 2× its drawn size at the export resolution.
- Transparent background (alpha) export works through the existing ProRes 4444 path.

## 8. Verification

Follow AGENTS.md §7. Feature-specific checks:

- **Unit and property tests:**
  - count, time and mention formatters per variant;
  - markup parser (fast-check);
  - randomizer distribution and determinism;
  - first-free placement;
  - batch MCP;
  - time parsing.
- **Regression tests that fail before the avatar-reference fixes**, one per integrity path in §7.7.
  Schema v8 migration fixture and compatibility test.
- **Anime template suites:**
  - catalogue/schema tests;
  - motion-model cue timing, with VARIANTS for every variant × entrance × extras combination that
    matters;
  - templates-review fit tests for long text, huge counts and all canvases;
  - determinism-render and layer-bake e2e (`REMOTION_E2E=1`) for preview vs export parity, including an
    emoji-bearing case.
- **Remote assets:** tests against a local fixture server for download, hash check, override manifest,
  offline and failure, and the export blocker.
- **Visual calibration:** each variant × theme side-by-side with the tokcomment reference set at
  matching scale. Layout, spacing and colour should match tokcomment. The deliberate differences are the
  real fonts, real icons and the fixed tokcomment bugs, and each one is listed in the work note.
  - Real platform screenshots from the requester are used if supplied, but they are not a prerequisite.
  - **The requester signs off** on a side-by-side page (e.g. an HTML render) per variant and theme
    before the variant counts as done.
  - Don't commit the third-party screenshots.
- **UI:** exercise the gallery, insert, Properties, canvas edit, marks, randomize, Add another and bulk
  import in the running app. Run `pnpm e2e` coverage for insert and edit.
- **Docs:**
  - README "Animated templates";
  - MCP guide;
  - new `docs/wp-notes/social-comments.md` with researched behaviour, formulas and limitations;
  - `docs/gaps.md` for anything disabled;
  - `pnpm notices` for Twemoji attribution and any bundled font.

## 9. Left to the builder

- Build order and phasing. A suggested order:
  1. avatar media plumbing and integrity fixes, then the remote asset service, then the formatters and
     markup;
  2. one variant end to end (`tiktok-reply`) through UI and MCP;
  3. the other six variants;
  4. canvas editing, randomize, Add another and bulk import.
- Exact per-variant pixel values. Calibrate from the reference set and the platform fonts.
- The name and handle generator word lists and the generated-avatar style. They must look plausible.
- Whether presets are a generic MG feature (recommended) or social-comment-only, and how the `ui` hints
  are shaped.
- Exact source URLs for remote fonts. They belong in the manifest, not in code.
- How the floating word-mark toolbar and the marks-aware text control are built.

## 10. Risks

- **Remote source URLs change or disappear.** Mitigation: the manifest override and a clear blocker
  rather than a silent fallback.
- **Licensing:** using Chirp, SF Pro and Apple emoji. The requester accepted this risk.
- **Bake performance:** each comment is a Chrome-baked layer on native export. This is fine for a few
  comments; measure a 50-comment batch.
- **Reference fidelity:** tokcomment is itself an imitation and six of its variants rendered in a
  fallback font. Calibration against real screenshots catches what it got wrong.

## 11. Addendum (2026-10-25): app-store review cards

The requester added store reviews to the scope, with reference screenshots stored outside the repo at
`/var/lib/orquester/workspaces/jaspersito/research/store-reviews-ref/`:
- `play-store-review-user-ref.png`: the Play Store review card. Leave out the "Was this review helpful? Yes/No"
  footer, as the requester asked.
- `app-store-web-reviews-user-ref.webp`: App Store review cards in their web/macOS style.
- `app-store-ios-reviews-user-ref.png`: App Store review cards in the iOS App Store app's Ratings & Reviews
  list.

They are three new variants of the same `social-comment@1` template. The template is unreleased, so it is
extended in place.

| Variant id | Look |
|---|---|
| `play-store-review` | Avatar, name, kebab; green stars + date; body clamped with a fade on the last line |
| `app-store-review` | Grey rounded card; orange stars; "name, MM/DD/YYYY"; bold title; body clamped to 4 lines with a blue "more" |
| `app-store-review-ios` | Grey rounded card in the iOS app; bold title + relative date on the right; small stars + username on the right; body |

These come with new parameters:
- `rating`: integer 1–5.
- `title`: the App Store variants; single line, bold.
- `date`: ISO `YYYY-MM-DD`, formatted per variant. Play is `M/D/YY` as in the reference; the App Store web style
  is `MM/DD/YYYY`.
- `edited`: boolean, iOS-only "edited" prefix.
- `truncate`: boolean, default on. When on, the platform's line clamp applies, with the fade or "more".

The iOS variant shows its date relatively (`timeValue`/`timeUnit` → "Sun", "2d", "1y ago" per the iOS app's rules).
All existing behaviour applies to these variants:
- the entrances, word reveal and word marks;
- emoji: Apple for the App Store, Noto for Play;
- avatar media/generated/default where the variant has an avatar;
- Properties controls, with a star-rating control and a date control;
- Program-monitor editing, presets, the randomizer (plausible star distribution, titles, dates), bulk-import
  aliases (`Rating`, `Stars`, `Title`, `Date`) and the agent API.

The like tick has no counterpart here. These variants offer a **star fill** extra in its place: the stars fill one
by one after the entrance.

Fonts:
- Play Store: Google Sans / Roboto per live measurement.
- App Store: SF Pro, through the remote manifest.

Calibration uses the requester's screenshots, plus live measurements of play.google.com and apps.apple.com review
cards where public pages allow.
