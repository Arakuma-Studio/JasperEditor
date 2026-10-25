
Design: `docs/superpowers/specs/2026-10-25-social-comment-templates-design.md`. Each work package adds its own
section below.


## Social comment core (formats, marks, randomizer)

Workstream WP4 `social-core` (branch `sc/social-core`). Code: `packages/mg-templates/src/social/`
(`variants.ts`, `schema.ts`, `format.ts`, `marks.ts`, `tokenize.ts`, `random.ts`), exported from
`@jasper/mg-templates`. Tests: `packages/mg-templates/test/social-{params,format,marks,random}.test.ts`. Everything
here is pure and deterministic: no `Intl` formatting, no clock, no `Math.random`, and no anime.js (this package may not
import it). The template definition and registration (`social-comment@1`) are WP6, not part of this section.

Sources are labelled as in `research/platform-research.md`: **[tok]** tokcomment reference capture
(`research/tokcomment-recon/ref/`, 2026-10-24), **[S-off]** official, **[S-3p]** third-party, **[E]** estimate or
assumption, not verified against the live platform.

### API

```ts
SOCIAL_VARIANTS, type SocialVariant, VARIANT_LABELS, VARIANT_PLATFORM, isSocialVariant(v)
SOCIAL_PARAM_NAMES, type SocialParamName
VARIANT_CAPABILITIES[variant][param]: boolean            // which params the variant draws
variantsWithParam(param): SocialVariant[]                  // for ui visibleWhen { param: 'variant', in }
resolveEmojiStyle(variant, 'auto' | 'apple' | 'twemoji' | 'noto'): 'apple' | 'twemoji' | 'noto'
socialCommentParamsSchema       // strict; .default()s = tiktok-reply defaults
socialCommentPartialSchema      // same fields, all optional, no defaults (agent / CSV input)
type SocialCommentParams, type SocialCommentInput, type SocialAvatar
socialAvatarSchema, socialAvatarMediaSchema, socialAvatarGeneratedSchema
socialDefaults(variant): SocialCommentParams               // tokcomment defaults, fresh object
formatCount(variant, n, field?: 'likes' | 'replies' | 'reposts' | 'views'): string
formatTime(variant, value, unit): string
formatRepliesLabel(variant, n): string                     // '' = no replies row
parseMarks(text): MarkSpan[]; serializeMarks(spans): string; stripMarks(text): string
applyMark(text, { start, end }, 'highlight' | 'blur' | 'remove' | null): string
tokenizeComment(text, variant): Array<{ text; mark: 'none' | 'highlight' | 'blur' | 'remove'; role: 'plain' | 'mention' | 'hashtag' }>
randomIdentity(seed): { displayName, handle, avatar: { generated } }
generatedAvatar(seed, name?): { style: 'initials' | 'silhouette'; background: { from, to, angleDeg }; foreground; initials }
randomStats(variant, seed): { timeValue, timeUnit, likes, replies, reposts, views }
fillSocialParams(partial: unknown, seed): { ok: true; params; filled: SocialParamName[] } | { ok: false; error; issues }
```

### Params and capabilities

The fields and enums follow design §7.3. Caps: `displayName` is 1–64 characters on one line (no control characters);
`handle` is 1–64 letters (any script), digits, `.`, `_` or `-`, stored without the `@`; counts are integers
0…1e12; `timeValue` is an integer 0…10000. `text` allows 2000 visible characters (marks stripped) and 4000 characters of
markup, so marks never push a valid comment over the limit. Every field has a `.describe()` for agents: which variants
draw it, units, examples and the marks syntax.

`avatar` is `{ mediaId } | { generated: uint32 } | null`. The `{ mediaId }` member is its own schema
(`socialAvatarMediaSchema`) so it can be swapped for the shared `mediaParam()` (contract C1, WP1) without changing the
stored shape. The swap has not been made yet.

Capabilities [tok] (from the controls in `ref/index.md`):

| Variant | Name shown | Verified | Time, likes, replies, like tick | Reposts, views |
|---|---|---|---|---|
| `tiktok-reply` | `displayName` | yes | — | — |
| `tiktok-comment` | `displayName` | yes | yes | — |
| `instagram-post` | `handle` | yes | yes | — |
| `instagram-reel-reply` | `handle` | — | — | — |
| `youtube-comment` | `handle` (as `@handle`) | yes | yes | — |
| `youtube-shorts-reply` | `handle` (as `@handle`) | — | — | — |
| `x-post` | both | yes | yes | yes |

TikTok shows the nickname and Instagram the username [E]. YouTube has shown `@handle` on comments since 2022 [E];
tokcomment shows a bare "Username" there. Look, author avatar, `showProfile` (hides the avatar, tokcomment's profile
toggle), text, entrance and word reveal apply to every variant. Params a variant does not draw keep their values.

Defaults [tok]: TikTok "username", 1 day, 1,393 likes, 2 replies; Instagram "username", 2 weeks, 114 likes,
5 replies; YouTube "Username", 10 months, 72 likes, 2 replies; X "Display Name" / "username", 2 h, 45 replies,
12 reposts, 1.2K likes (stored as 1200) and 12K views (stored as 12000). All variants default to the text "Write any
comment and see what happens 😊", light theme, `emojiStyle: 'auto'`, the default silhouette (`avatar: null`), verified
off, profile shown, the `soft-spring` entrance and no extras. Variants without stats get their platform's stats, so
switching variant within a platform shows tokcomment's numbers. The name field a variant doesn't show gets a neutral
counterpart ("Display Name" / "username").

### Count formatting

tokcomment renders whatever the user types, verbatim [tok] (`07_light_counts-1234567-raw.png`), so the rules come
from the platforms and from design §7.4:

| Platform | Rule | Examples |
|---|---|---|
| TikTok | exact and comma-grouped below 10,000, then K/M/B with one decimal | 1,393 · 9,999 · 12.3K · 123.4K · 1.2M |
| Instagram | as TikTok | 114 · 1,234 · 12.3K · 1.2M |
| YouTube | exact below 1,000, then one decimal only below 10 of a unit | 72 · 1.2K · 12K · 123K · 1.2M · 12M |
| X | exact below 1,000, then K/M/B with one decimal | 45 · 1.2K · 12.3K · 123.4K · 1.2M |

- **Truncation, not rounding.** 1,250 and 1,299 both show "1.2K", and 999,999 shows "999.9K", never "1000K". Basis:
  YouTube documented truncating abbreviated subscriber counts ("4,299 → 4.2K", tubefilter.com/2019/05/21 and
  9to5google.com/2019/05/21). That it applies to likes, and to TikTok, Instagram and X, is **[E]**: no source covers
  them.
- **".0" is dropped** ("1K", "12K", "1M"). This matches tokcomment's X defaults "12K" [tok].
- **B for billions.** Above 999B the whole part is comma-grouped ("1,000B" at the 1e12 cap).
- **Instagram deviates from the design.** Design §7.4 says Instagram is "comma-grouped". The research's
  "1,234 → 12.3K → 1.2M" [E] was adopted instead, so huge counts cannot push icons out of the card (the anti-goal in
  design §4).
- **X exact range is unverified.** X may show exact numbers up to 9,999. One third-party forum post says so; it is
  unconfirmed. The design rule and tokcomment's "1.2K" default were kept.
- **`field` doesn't change the format.** Every platform formats likes, replies, reposts and views alike.
- **Bad input formats as "0".** NaN, ±∞, negatives and non-numbers give "0"; fractions are floored.
- **The arithmetic is exact.** Integers up to 2^53 never hit float rounding.

### Time formatting

- **TikTok, Instagram, X:** compact "3m", "3h", "3d", "3w", "3mo", "3y" [tok] (all six unit captures).
- **YouTube:** "1 minute ago", "3 minutes ago", "10 months ago" [tok], with singular and plural. tokcomment's
  months-shown-as-hours bug is not reproduced: months stay months.
- **Value 0:** "Just now" on TikTok and YouTube, "now" on Instagram and X [E].
- **Value range:** values are floored and clamped to 0…10000. An unknown unit reads as days.
- **Not modelled:** X really switches to dates ("Mar 4") after 24 h [S-3p]. The template follows tokcomment's compact
  form because the params store a relative age, not a date.

### Replies label

- **TikTok:** "View 2 replies" / "View 1 reply" [tok].
- **Instagram:** "View 5 more replies" / "View 1 more reply" [tok]. The singular form is [E].
- **YouTube:** "2 replies" / "1 reply" [tok].
- **The number uses the count format,** e.g. "View 12.3K replies".
- **Empty string means no replies row:**
  - 0 replies. tokcomment's "View 0 replies" bug is fixed.
  - The reply cards (TikTok reply, Reels reply, Shorts reply).
  - X, which shows its reply count by the icon (use `formatCount(…, 'replies')`).

### Word marks

Marks are inline in `text`: `==highlight==`, `||blur||`, `~~remove~~`.

**Grammar** (`marks.ts`):

- **Escapes.** `\` before `\ = | ~` is that character, literally. Any other backslash is literal (`C:\path` survives).
- **Opening and closing.** A doubled marker opens a mark only when a matching unescaped pair follows with at least one
  character between them. The first such pair closes it. Otherwise the characters are literal: unbalanced markers
  render as typed, and `====` is literal.
- **No nesting.** Inside a mark, other markers are literal. Overlap resolves to the mark that opens first:
  `==a ||b== c||` gives highlight "a ||b", then literal " c||".
- **Merging.** Adjacent spans with the same mark merge.
- **Cost.** Parsing is linear: a marker character with no closing pair ahead is not searched again. Tests parse
  200k-character adversarial strings.

**`serializeMarks`** escapes as little as possible:
- a marker character only when it would pair with the next output character;
- a backslash only before an escapable character.

`parseMarks(serializeMarks(spans))` returns the normalised spans. One side effect: `applyMark` rewrites the whole
markup in this canonical form, so an unbalanced literal `==` elsewhere in the text gains an escape (`\==`). The visible
text never changes. When no mark changes, `applyMark` returns the input untouched.

**`applyMark` semantics** follow tokcomment's word-based Advanced Edit [tok `07`–`09`, `15`–`17`]:
- **Coordinates:** ranges are in visible-text UTF-16 code units, clamped, in either order.
- **Whole words:** a range touching part of a word grows to the whole word (a word is a run of non-whitespace). A caret
  marks the word under it. A whitespace-only range changes nothing.
- **One mark per word:** a new mark replaces a different one; `null` clears.
- **Merging:** whitespace between two words with the same mark joins it, so adjacent highlighted words form one pill
  as on tokcomment. Whitespace bordering the changed words whose neighbours differ is unmarked.

**`tokenizeComment` roles** depend on what precedes the marker and on the platform:
- **Start condition:** a mention or hashtag starts at the text start or after a character that is not a letter,
  digit, `_`, `@`, `#`, `&` or `.`. So e-mail addresses, `a#b` and HTML entities stay plain.
- **Mentions:** `@` plus the platform's account-name characters and limit [E]:
  - TikTok: `[A-Za-z0-9_.]`, 24 characters;
  - Instagram: `[A-Za-z0-9_.]`, 30 characters;
  - YouTube: letters of any script, digits, `_ . -`, 30 characters;
  - X: `[A-Za-z0-9_]`, 15 characters.

  Trailing dots are excluded, so a sentence's full stop stays plain. An over-long name, or one followed by `@`, is not
  a mention.
- **Hashtags:** `#` plus letters, marks, digits and `_`, with at least one letter (`#2024` stays plain).

Colours per platform and theme belong to the template (WP6).

### Randomizer

Seeds are any number:
- fractions, negatives and huge values are folded into 32 bits (murmur3 finalizer);
- non-finite seeds read as 0.

The PRNG is mulberry32, with separate salted streams for identity, avatar, stats and fill, so the same seed gives
independent values.

**`randomIdentity`.** Original made-up word lists:
- about 100 given names across languages and genders;
- about 70 surnames;
- verb and noun handle words.

These are combinations, not real people; any match with a real account is coincidental. Display names are "First
Last", "First", "First L.", lower case, or with one emoji. Handles come from the same name parts, in ten styles (e.g.
`luna.makes`, `jake_rides22`, `lunapark`, `luna.park`, `art.by.luna`, `itsluna`). They are lower-case ASCII, at most
15 characters (X's limit, so they suit every variant), and never end in `.` or `_`.

**`generatedAvatar(seed, name?)`.** One of 16 hand-picked two-colour gradients at one of five angles:
- 70% of avatars show up to two initials (from `name`, else from the seed's identity); the rest are a silhouette;
- the foreground is white or a dark ink (`#1F2430`), whichever has more WCAG contrast with the gradient's mean
  luminance;
- the template draws it, and the description is plain data (hex colours, angle, initials).

**`randomStats(variant, seed)`.** tokcomment's distribution (design §6):
- likes: 40% 1–500, 30% 500–10k, 20% 10k–100k, 10% 100k–5M, uniform within the band;
- replies: 1–5% of likes;
- reposts: 10–30% of likes;
- views: 10–50× likes.

Reposts and views are filled for every variant so a switch to X stays plausible. Posting age per platform [E]
(relative weights m/h/d/w/mo/y):

| Platform | Weights (m/h/d/w/mo/y) | Notes |
|---|---|---|
| TikTok | 10/25/30/25/7/3 | |
| Instagram | 10/25/30/35/0/0 | Weeks reach 60 ("56w" [E]) |
| YouTube | 5/15/20/20/25/15 | |
| X | 20/50/20/5/3/2 | |

Value ranges: minutes 1–59, hours 1–23, days 1–6, weeks 1–4, months 1–11, years 1–8.

**`fillSocialParams(partial, seed)`.** Validates with `socialCommentPartialSchema` (strict, so unknown keys fail), then
fills only omitted keys. An explicit `undefined` counts as omitted.
- **Variant:** defaults to `tiktok-reply`.
- **Look, text and animation:** from `socialDefaults(variant)`.
- **Identity and stats:** from the seed.
- **Name and handle:** a given display name gets a matching handle, and a given handle a matching name (filler words
  such as `by`, `its` and the handle-word lists are dropped). A name without Latin letters falls back to a random
  handle.
- **Given likes:** replies, reposts and views scale with them.
- **Result:** fully resolved params that pass `socialCommentParamsSchema`, plus `filled`, the list of keys that were
  filled. Bad input returns `{ ok: false, error, issues }`; the function never throws.

### Verification

- **Commands run:** `pnpm exec vitest run packages/mg-templates/test/social-*.test.ts --maxWorkers=2`.
- **Property tests (fast-check):**
  - formatters never throw on any double, are monotonic and never overstate the count;
  - marks: round-trip for arbitrary spans, idempotence, `applyMark` preserves visible text and is idempotent, no
    throw on binary Unicode (emoji, ZWJ, RTL overrides, lone surrogates);
  - `tokenizeComment` covers the visible text exactly;
  - `fillSocialParams` keeps provided keys, fills exactly the rest and always parses.
- **Mutation check:** disabling the marker escape in `serializeMarks` makes three marks tests fail.
- **Distribution check:** over 20,000 seeds the likes bands come within ±5 percentage points of 40/30/20/10, and every
  ratio stays within its bounds.

### Limitations

- **Unverified platform behaviour:** the [E] items above:
  - truncation outside YouTube subscribers;
  - X's exact-number range;
  - "now" / "Just now";
  - mention character sets.

  They need checking against real screenshots during visual calibration.
- **Surrogate pairs inside marks:** a mark boundary written between the two halves of a surrogate pair (only possible
  by hand-editing markup) splits the pair. Rendering shows replacement glyphs; nothing throws.
- **Mention and hashtag colours** are not here (WP6).

## Platform assets & sources

Work package WP5 (`sc/platform-glyphs`). Real platform icons, badges and default avatars for the templates
(design §7.8a), the data of the remote font/emoji manifest (§7.8, contract C2) and the platform measurements the
templates are calibrated against. Provenance of every asset: [`licenses/platform-assets.md`](../../licenses/platform-assets.md)
(copied into `THIRD_PARTY_NOTICES.md` by `pnpm notices`). Captured 2026-10-25, logged out, public pages only.

### Glyphs — `packages/motion/src/templates/social/glyphs.ts`

Pure data (no React), imported by the template implementation in `packages/motion/src/templates/social/`.

```ts
interface GlyphPath { d: string; fillRule?: 'evenodd' | 'nonzero'; fill?: string /* colour or url(#gradientId) */; fillOpacity?: number }
interface GlyphLinearGradient { id: string; x1: number; y1: number; x2: number; y2: number; stops: { offset: number; color: string }[] } // userSpaceOnUse
interface PlatformGlyph { viewBox: string; paths: GlyphPath[]; gradients?: GlyphLinearGradient[];
  defaultColor?: { light: string; dark: string }; origin: 'live-dom' | 'live-bundle' | 'live-cdn' | 'derived' }
TIKTOK_GLYPHS     heartOutline heartFilled dislike verified more chevronDown creatorLiked
INSTAGRAM_GLYPHS  heartOutline heartFilled verified more
YOUTUBE_GLYPHS    thumbUp thumbUpFilled thumbDown thumbDownFilled reply replyFilled verified more chevronDown
                  creatorHeart creatorHeartBorder pin
X_GLYPHS          reply repost like likeFilled views bookmark share more verifiedBlue verifiedGold verifiedGrey grok
PLATFORM_GLYPHS = { tiktok, instagram, youtube, x }
TIKTOK_DEFAULT_AVATAR: PlatformGlyph
PLATFORM_DEFAULT_AVATARS: Record<'tiktok'|'instagram'|'youtube'|'x', { kind: 'glyph'; glyph } | { kind: 'remote'; image: { url; sha256; width; height; format } } | { kind: 'none'; reason }>
glyphColor(glyph, theme, fallback = 'currentColor'): string
scopeGlyphIds(glyph, scope): PlatformGlyph   // prefixes gradient ids + their url(#…) fills, per rendered instance
```

Rendering contract: draw `<svg viewBox>` with one `<path>` per entry in order; a path without `fill` uses
`currentColor`, which the template sets to `defaultColor[theme]` (or the state colour it needs). Paths with a
`fill` keep it (badges, the TikTok default avatar). Only `X_GLYPHS.verifiedGold` has gradients: render it through
`scopeGlyphIds(glyph, uniqueInstanceId)` and emit `<linearGradient gradientUnits="userSpaceOnUse">` defs, because
SVG ids are document-global and several cards can share a frame.

- **Origins:** the module has 36 glyphs (35 icons and badges plus the TikTok default avatar); 35 come straight from the platforms: the inline SVG their page rendered (`live-dom`),
  an icon component of their own bundle for states a logged-out page does not show (`live-bundle`: TikTok and X
  filled hearts, Instagram filled heart, X Grok mark, TikTok default avatar) or YouTube's icon CDN file (`live-cdn`:
  filled thumbs, comment bubbles). One is `derived`: TikTok's comment **dislike** exists only in the app, so it is
  TikTok's own web thumbs-up rotated 180° about the viewBox centre.
- **No fallbacks:** no tokcomment or lucide stand-in is used.
- **X header mark:** the real X UI puts a Grok "Explain this post" ghost button (with `icon-logo-grok`) left of
  "More" when the post enables Grok analysis for a signed-in viewer (bundle code; not rendered logged out). That is
  the mark tokcomment imitates; `X_GLYPHS.grok` is the real one.
- **Default avatars:** TikTok is a vector (`Icon_Color-Default_Avatar`). X and YouTube exist only as raster images,
  recorded by URL and sha256 (never committed); contract C2 has no image section, so fetching them needs an engine
  route or the media plumbing (not done in WP5). Instagram has no stable public source (signed fbcdn URLs) →
  `kind: 'none'`; templates should use `generatedAvatar` or an uploaded image.
- **TikTok bubble tail:** not an SVG on any platform surface we could reach (tokcomment draws it with CSS, the
  in-app sticker is not on the web); it stays a template-drawn shape.

Tests: `packages/motion/test/social-glyphs.test.ts` (path grammar, colours, gradient references, fast-check of
`scopeGlyphIds`, and that `licenses/platform-assets.md` lists every export with the origin the module records).

### Remote manifest data — `apps/engine/src/remote-assets/manifest.json`

Validated against WP2's `RemoteManifestSchema` (draft in `sc/assets`); every font URL re-downloaded and
sha256-checked and every font loaded with `FontFace` in Chrome; 11 sample graphemes per pack fetched with WP2's
`emojiCodepointCandidates`/`emojiKey` rules (33/33 found).

| Entry | Source | Notes |
|---|---|---|
| `chirp-400/500/700/800`, family `Chirp` | `abs.twimg.com/fonts/subset/Chirp-*.latin.woff2`, the files x.com loads | latin subset only (U+0000–00FF + punctuation; covers Spanish). C2 has no `unicode-range`, so one file per weight; the 6 other subsets are listed in the measurements. |
| `sf-pro-text-400/600/700`, `sf-pro-display-400/600/700` | jsDelivr → `github.com/sahibjotsaggu/San-Francisco-Pro-Fonts@8bfea09…` (2.4k stars, unchanged since 2021) | SF Pro 16.0d18e1 OTF, ~2.2 MB each. Use Text below 20 px design size, Display at 20 px and above (Apple's optical-size rule). |
| `apple` (Emojipedia set 419, Emoji 16.0, 160 px PNG) | `em-content.zobj.net/source/apple/419/{name}` | Emojipedia file names carry a slug, so the pack uses `{name}` + a `names` map (4240 sequences, keyed without U+FE0F; built from react-apple-emojis' data, port record `licenses/ported/react-apple-emojis-names.md`). The images are pixel-identical to iamcal emoji-data v16.0.0 `img-apple-160/{cp}.png` (code-point keyed, `fe0f: keep`, `cpMinDigits: 4`), usable through the override file. |
| `twemoji` 17.0.3 (SVG) | `cdn.jsdelivr.net/gh/jdecked/twemoji@v17.0.3/assets/svg/{cp}.svg` | file names drop U+FE0F except inside ZWJ sequences → `fe0f: try-both`. CC-BY 4.0 attribution in the manifest and the notices. |
| `noto` 17.0 (512 px PNG) | `fonts.gstatic.com/s/e/notoemoji/17.0/{cp}/512.png` | Google's versioned Noto CDN: `cpJoin: "_"`, `cpMinDigits: 4`, `fe0f: try-both`. Chosen over the googlefonts/noto-emoji repo because the repo's `svg/` and `png/` folders have no flag files. |

Not added: TikTok Sans and Roboto (bundled, WP2), YouTube Sans (branding only), Instagram Sans (not the comment
font, see below).

### Findings that change template defaults

- **X shows OS emoji, not Twemoji.** x.com's 2026 web app renders emoji as plain text in the system emoji font;
  its bundles contain no Twemoji code. An iPhone X screenshot therefore shows Apple emoji; the X preset's default
  `emojiStyle` should be `apple`, with `twemoji` as the "X on Windows/older X" look.
- **X 2026 colours:** secondary text and action icons are rgba(0,0,0,.6) / rgba(255,255,255,.6), not the older
  #536471 / #71767B; text #000 / #FFF; verified badges have a cut-out tick; gold badge is a gradient.
- **YouTube 2026:** avatar 36 px (not 40), "N replies" button is #0F0F0F/#F1F1F1 (not blue), handle 12 px/500.
- **TikTok web** uses TikTok Sans as a variable font (body weight 478, 15/22.5 px).
- **Instagram on iPhone = SF Pro** (system font), not Instagram Sans: instagram.com's stack starts with
  `-apple-system`; secondary sources agree the app UI uses San Francisco on iOS; no first-party statement was found
  and the native app could not be inspected here (labelled, not measured).

Full numbers (fonts, sizes, weights, colours per theme, paddings, avatar and badge sizes) with screenshots and JSON
dumps: `/var/lib/orquester/workspaces/jaspersito/research/platform-measurements/index.md` (outside the repo;
screenshots of third-party sites are not committed, AGENTS.md §3 item 3).

### Limits

- Captured logged out: liked/filled states come from bundles, not from a rendered page; Instagram comment-row
  hearts and the X Grok button were not seen rendered.
- TikTok's web theme stayed dark; its light colours are the design-token values, not a light render.
- Hashed X subset URLs (`Chirp-Regular.c88864db…`) change when X redeploys; old files have stayed online so far,
  and the appdir override file can repoint them without a release. The same applies to the Emojipedia set number.
- The YouTube non-owner verified check colour (#606060/#AAAAAA) is inferred from the secondary text colour.

## Presets & UI hints

WP3a (`sc/presets-ui`), contract C3 of the design (§7.2, §7.9 gallery and Properties). Generic motion-graphic
template features; the social-comment template uses them, any other template may.

### Template definition (`@jasper/mg-templates`, types in `@jasper/project` `registry/mg.ts`)

- `presets?: { id, name, description?, params }[]` — `params` holds only what the preset changes. Ids match
  `[a-z0-9][a-z0-9-]*` (≤ 64), unique per template.
- `ui?: { groups?: { id, label, params[] }[]; params?: Record<name, { label?, description?, multiline?,
  visibleWhen?: { param, in[] }, control? }> }`.
- `createMgRegistry` validates both and throws on the first problem (like invalid defaults): presets need a name,
  plain-object params naming only params of the template, and `{...defaults, ...params}` must pass `paramsSchema`;
  groups need unique ids and labels and may only list existing params, each param in at most one group; `ui.params`
  may only name existing params; `label` / `description` / `control` are non-empty strings, `multiline` a boolean;
  `visibleWhen` names another param and lists at least one value, each a valid value of that param (checked with
  the schema, so a misspelt variant fails at start-up / in tests, not silently in the UI).
- `templatePresetParams(def, presetId)` = defaults ⊕ preset params (undefined for an unknown preset).
- `MgTemplateInfo` (what `registry.get` returns) carries `presets` and `ui`; the catalogue JSON
  (`catalogJson()`, `GET /api/motion-graphics/templates`, `@jasper/api` `MgTemplateCatalogEntrySchema.presets` /
  `.ui`) carries JSON copies. Entries without them keep their old shape (the fframes `schemas/catalog.json` mirror of
  the Rust catalogue is unchanged). When jasper-mg is ready, its native entries get the presets and hints of their
  TS twin.

### Template references

`parseMgTemplateRef` (`@jasper/project`): `"<id>"`, `"<id>@<version>"`, `"<id>:<preset>"`,
`"<id>@<version>:<preset>"` → `{ id, version?, preset? }`; null for anything else (empty id, version ≤ 0 or not an
integer, a preset id with other characters, more than one `@` / `:`, over 256 characters). Fuzzed with fast-check
(round trip of every well-formed ref; arbitrary strings never throw).

MCP (`apps/mcp/src/tools/templates.ts` `resolveTemplateRef`): `add_motion_graphic` and
`render_motion_graphic_preview` accept the four forms. Params = template defaults ⊕ preset params ⊕ the call's
`params`. A malformed ref is `E_INVALID_PARAM`; an unknown template, version or preset is `E_NOT_FOUND` with the
existing refs (or "has no presets") as hint. `list_motion_templates` adds per template `presets: [{ref, id, name,
description?, params}]` and per param `label`, `group` and `visibleWhen` from the hints (the `description` prefers the
hint over the schema's `.describe()`). `TEMPLATES_GUIDE` documents the ref syntax. Batching and placement of
`add_motion_graphic` are WP3b's.

### Gallery (Motion Templates ▸ Templates)

- A template with presets shows one card per preset (title = preset name, second line = the template name,
  `data-preset` on the card, accessible name "Preset · Template (Category)") and no card for the bare template.
  Templates without presets are unchanged.
- The poster (anime: `<Thumbnail>`; fframes: the SVG twin) and the hover preview get `params` = the preset's params
  (`MgTemplatePreview` merges them over the defaults).
- Search matches the preset name and id as well as the template name, id, category, description and engine; the
  category filter uses the template's category.
- Double-click / Enter / drag insert the preset: `clip.addMotionGraphic` with defaults ⊕ preset params, History label
  "Add <preset name>" (one undo step). The drag payload (`application/x-jasper-mg-template`) has an optional `preset`
  (zod-validated; `text/plain` = `id@v:preset`); Timeline and Program drops pass it through unchanged. The
  agent-exposed UI command `mg.insert` takes an optional `preset`. An unknown preset is refused with a message, never
  inserted with plain defaults.

### Properties and Effect Controls

- `paramsPropertySpecs(template)` applies the hints after building the specs from the schema (one
  `applyTemplateUi` step, so other param kinds slot in before it unchanged): `label`, `description` (tooltip),
  `ui.multiline` (string params only), `ui.customControl`, `visibleWhen`, and the order: params in no group first
  (schema order), then each group's params in the group's order, tagged `section: {id, label}`. Keyframability is
  unchanged (numeric and colour params of anime templates keep their stopwatches inside groups).
- `templateParamVisible(spec, params)` — compares the param's static value (`clip.params`) with `in` (by value, also
  for arrays). `templateParamSections(specs)` splits the ordered specs into runs per section.
- Properties ▸ Parameters: rows in no group first, then one collapsible sub-section per group (open state persisted
  per template and group id, `properties.template.<templateId>.<groupId>`). With several clips selected (same
  template) a row is shown when it applies to at least one of them; edits apply to all, as before.
- Effect Controls ▸ Template: the same order under collapsible group sub-headers (with a keyframe summary lane);
  hidden rows are left out of the section (so "Reset Template" and the summary lane skip params that do not apply).
- Hidden params stay valid params: agents (`set_motion_graphic_params`) and HTTP clients can still set them, and
  their values are kept when the controlling param changes back (switching variant keeps content).

### Custom controls (`apps/web/src/extensions/index.ts`)

```ts
registerTemplateParamControl(name: string, component: ComponentType<TemplateParamControlProps>): () => void
type TemplateParamControlProps = {
  clipId: string; paramName: string; value: unknown; params: Readonly<Record<string, unknown>>;
  onChange(next: unknown, opts?: { coalesce?: boolean }): void; disabled: boolean;
};
```

- Rendered by `PropertyRow` (both panels) in place of the default editor for rows whose template names the control;
  label, stopwatch, keyframe navigator and reset stay. An unregistered name falls back to the default editor, so a
  template never shows a blank row.
- `onChange` goes through `planSet` → `param.set` (a keyframe at the playhead when the param is animated), one
  undoable transaction; `coalesce: true` adds the coalesce key `template-param:<row>:<clips>`, merging repeated edits
  within the session window (750 ms) into one History entry (drags, typing). Multi-selection: the control sees the
  first clip (`clipId`, `value`, `params`), writes go to every selected clip.
- `disabled` is true while the project is read-only.
- A control that throws while rendering is replaced by a one-line error in its row (`template-param-control-error`);
  the panel keeps working; selecting another clip or param retries.

### Strings (i18n)

`apps/web/i18n/model-strings.ts` (run by `pnpm i18n`) collects, for every template of `mgRegistry`: name, category,
description, preset names and descriptions, group labels, and every param label and tooltip as `paramsPropertySpecs`
produces them (hints, schema titles, `.describe()` texts, humanized names). The runtime translates them where the UI
shows them (card titles, section and group headers, row labels, `title` tooltips, accessible names).

A template author adding or changing a template runs `pnpm i18n`, adds the new keys to
`apps/web/src/i18n/es.json` and checks with `pnpm i18n:check` (fails while a key lacks Spanish). Param values
(enum options, text content) are data and are not translated.

### Counter

`counter@1` now has three presets (Subscribers = the defaults, Percentage, Money Raised) and four groups (Number,
Label, Style, Animation); Decimal Separator shows only when Decimals > 0; Size and Count Seconds read "Number Size"
and "Count Duration". Pixels, params and `renderVersion` are unchanged (metadata only).

### Tests

`packages/mg-templates/test/registry.test.ts` (validation, catalogue JSON, preset params),
`packages/project/test/template-ui.test.ts` (specs: labels, multi-line, custom control, order, sections, visibility;
ref parser + fast-check), `apps/engine/test/mg-presets.test.ts` (catalogue on both engine paths, fake jasper-mg),
`apps/mcp/test/templates.test.ts` (list, preset refs in add and preview, refusals),
`apps/web/test/template-presets-ui.test.tsx` (Properties groups/labels/tooltips/visibility, Effect Controls groups,
stopwatch, collapse, custom control props, undo/redo, coalescing, crash isolation, fallback, read-only),
`apps/web/test/motion-templates-presets.test.tsx` (cards, poster/preview params, search/category, insert by
double-click/Enter/drag/`mg.insert`, refusals).

### Limitations

- `visibleWhen` reads the static value of the controlling param; a keyframed controlling param (numbers, colours)
  is compared by its static value, not its value at the playhead.
- Groups are one level deep; a param belongs to at most one group.

## Template media params

Design §7.7 (WP1 `sc/media`, contract C1). Anime templates can take pictures (a comment's avatar) as params.

### Model

- **Schema helper.** `mediaParam(opts?: { kinds?: Array<'image' | 'video'> })` in `@jasper/mg-templates`
  (`packages/mg-templates/src/params.ts`) is a strict zod schema for `{ mediaId: string } | null`, default `null`
  (= none). Its JSON schema carries `x-jasper-kind: "media"` and `x-jasper-media-kinds` (default `["image"]`);
  the keys are `TEMPLATE_PARAM_KIND_KEY` / `TEMPLATE_MEDIA_KIND` / `TEMPLATE_MEDIA_KINDS_KEY` of `@jasper/project`.
  A media param may sit anywhere inside `params` (e.g. a list of pictures). `createMgRegistry` refuses media params
  on fframes templates: the native renderer has no image input.
- **Reference helpers** (`packages/project/src/param-media.ts`): `collectParamMediaIds(value)` (every `{mediaId}`
  object, first-seen order, `''` skipped), `clipParamMediaIds(clip)` (motion-graphic clips only),
  `templateMediaRefs(value)` (with dotted paths) and `rewriteParamMedia(value, map)` (remap / clear / keep, untouched
  branches keep their identity). Every walk is cycle-safe and bounded (depth ≤ 32, ≤ 100 000 values).
- **Validation.** `validateMgParams` (`clip.addMotionGraphic`, `clip.update {params}`) and `param.set` on
  `params.<name>` go through `assertTemplateMedia` (`commands/handlers/mg-template.ts`): a medium that is not in the
  project is refused with `E_NOT_FOUND`, one of a kind the param does not take with `E_INVALID_PARAM`
  (`templateMediaKindsAt` reads the kinds from the schema, nested paths included). `null` is "none".
- **Schema v8.** `v7→v8` is a version bump only: v7 builds count a clip's own `mediaId` alone, so their orphan
  collection, item delete, Project Manager and paste would drop media referenced only from template params; they
  open v8 files read-only ([project files](../project-files.md)). Fixture `packages/project/test/fixtures/schema-v8.jasper`.

### Reference integrity

Media a template param references are counted wherever a clip's own `mediaId` is:

| Path | Behaviour |
|---|---|
| `collectOrphans` / `clipRefs`, `tx-delta` `orphanRefs` | a medium only a template param uses is kept |
| `item.delete` | in use like a clip's source: `E_IN_USE` naming the clip; with `force` the param is set to `null` (the clip stays; result `clearedParams: [{clipId, params, mediaIds}]`). The Project panel's confirmation says so |
| `media.removeUnused` | already deep-walked every clip (verified by test) |
| `mediaUsage` (Project panel usage, "unused" filter, MCP `list_media`), agent media list | the clip counts once per medium |
| Project Manager `usedMedia` (Exclude Unused, collect, consolidate; the engine copies `plan.files`) | used whole (pictures are never trimmed) |
| INV-006 / INV-014 (full and incremental checks) | a missing medium is reported at `…clips.<id>.params.<path>`; a referenced one is a use, not a leak |
| `repairDocument` | a dangling reference becomes `null` (report `clear-template-media`); no project item is invented for a medium only a template uses |
| Clipboard (`clip.paste`, `project.pasteItems`, `.jgt` graphic templates, timeline import) | the payload carries the medium; a paste into another project remaps the param |
| `.jasper` interchange metadata (OTIO) | the medium travels in the JasperEditor entities; an import that lacks it clears the param with a warning |
| Relink (`media.relink`, Project Manager) | keeps the media id, so references stay valid; the bake key and the graded-preview identity follow the new content |

### Render

- **Snapshot.** `buildRenderSnapshot` resolves template media like effect media (`useMedia`): the handle (engine URL,
  signed in renders) is in `snapshot.media[mediaId]`.
- **Layer.** `MotionGraphicLayer` builds `AnimeTemplateProps.mediaUrls` (`Readonly<Record<mediaId, url>>`) from the
  document's media handles (`ColorDocContext`, as effect media): `mediaSrc` picks the proxy / display picture when
  the original is not browser-decodable; offline or missing media are absent; `{}` when the params reference none.
- **Drawing.** `TemplateImage` (`@jasper/motion/templates`, `packages/motion/src/templates/image.tsx`) is an `<img>`
  (`crossOrigin="anonymous"`) that holds the render with `delayRender` from its first frame until the picture is
  loaded and decoded (`img.decode()`), like `useFxImages`. A load error releases the render and draws
  `TemplateImagePlaceholder` (a neutral dashed box) or the template's `fallback`; it never cancels the render.
- **Exports.** Remotion exports sign every snapshot handle (`remotionProps`); layer bakes sign the media
  `referencedMediaIds` finds in the clip source (template params included) and key the bake on each medium's
  fingerprint, size and mtime (`keyMedia`), so a relinked avatar re-bakes. The planner warns
  `OFFLINE_TEMPLATE_MEDIA` when a template shows offline media (those pictures render as placeholders).

### UI and agents

- Properties and Effect Controls show `MediaParamPicker` for media params: None (writes `null`), the project's
  media of the accepted kinds, "Missing media" for an unknown id, and a drop target for Project panel items (an item
  of another kind is refused with a hint). Edits are `param.set` commands (one undo step each). Media params are not
  keyframable.
- MCP `list_motion_templates` lists a media param as `media image` (or `media image|video`); the templates guide says
  what it takes and how it is refused.

### Tests

`packages/project/test/template-media.test.ts` (regressions: each integrity path failed before the fix; validation;
snapshot; v8 fixture; fast-check property of the walk), `packages/session/test/template-media-history.test.ts`
(undo / redo), `packages/interchange/test/template-media.test.ts`, `packages/mg-templates/test/media-param.test.ts`,
`packages/motion/test/template-image.test.tsx`, `packages/motion/test/template-image.e2e.test.ts` (`REMOTION_E2E=1`:
a real Chrome still waits for a slow CORS picture; a 404 draws the placeholder),
`packages/compositions/test/template-media-layer.test.tsx` (test-only `avatar-test@1`: params → snapshot →
`mediaUrls` → `TemplateImage` through the sequence composition), `apps/engine/test/template-media-bake.test.ts`
(signed URL, bake key follows the content, offline warning), `apps/web/test/template-media.test.tsx` (picker, None,
drop, delete dialog), `apps/web/test/layer-bake-runtime.test.ts`, `apps/mcp/test/template-media.test.ts`.
The test-only template lives in `packages/mg-templates/test/fixtures/avatar-test-template.ts` and
`packages/motion/test/fixtures/avatar-test-impl.tsx` (not in the catalogue).

### Limitations

- `TemplateImage` draws still pictures. A `kinds: ['video']` param resolves to the medium's URL, but no
  seek-driven template video component exists yet, so templates should declare images (the default).
- Animated images (GIF / animated WebP) are not offered: an `<img>` animates on the wall clock, which renders could
  not reproduce.
- `media.derive {replaceInClips}` (processed versions) rewrites clips' own media only; template params keep the
  original medium.
- Pre-existing, outside this scope: media that only effect params use (e.g. the image of a displacement map) are
  still not counted by Project Manager "Exclude Unused", `item.delete` or `collectOrphans`.

## Properties controls

WP7a (`sc/controls`), design §7.3, §7.5, §7.9. The custom Properties / Effect Controls controls of the
social-comment template and the Randomize actions. Code: `apps/web/src/social-comments/`; registered at start-up by
`registerSocialCommentControls()` (`register.ts`, called from `apps/web/src/commands/mg.ts`). The UX blueprint is
tokcomment's left panel (`research/tokcomment-recon/ref/index.md`), with its bugs fixed.

### Control names (what the template's `ui.params.<name>.control` hints use)

| Control | Params | Layout | What it does |
|---|---|---|---|
| `social-comment-text` | `text` | block (under the label, full width) | marks-aware comment editor |
| `social-count` | `likes`, `replies`, `reposts`, `views` | inline | count field with platform preview and a per-field wand |
| `social-time` | `timeValue` (also edits `timeUnit`) | inline | value + unit in one row with the platform preview |
| `social-avatar` | `avatar` | block | image / generated / default picker and Randomize identity |

`social-count` and `social-time` also put a **Randomize stats** wand in the header of the group they are in. The test
template the tests use (`apps/web/test/social-test-template.ts`) shows the expected hints: the groups of design §7.3,
`visibleWhen: { param: 'variant', in: variantsWithParam(p) }` for params not every variant draws, `multiline` on
`text`, and the four control names. `timeUnit` needs no hint: its row is hidden while the time control is shown.

### Contract additions to C3 (`apps/web/src/extensions/index.ts`, additive)

```ts
type TemplateParamControlProps = {
  clipId; paramName; value; params; disabled;           // unchanged
  onChange(next, opts?: { coalesce?: boolean }): boolean;   // now reports whether the write was applied
  clipIds: readonly string[];                               // every selected clip (clipId first)
  mixed: boolean;                                           // the selected clips hold different values
  onChangeParams(patch: TemplateParamPatchInput, opts?: { label?: string; coalesceKey?: string }): boolean;
};
type TemplateParamPatchInput = Record<string, unknown>
  | ((params, clipId, index) => Record<string, unknown> | null | undefined);   // one patch per clip
registerTemplateParamControl(name, component, options?: {
  alsoEdits?: readonly string[];     // sibling params whose own rows are hidden while this control is shown
  layout?: 'inline' | 'block';       // block: drawn under the label row across the panel
  groupActions?: readonly { id: string; component: ComponentType<TemplateGroupActionProps> }[];
}): () => void
type TemplateGroupActionProps = { clipIds; params; paramNames; onChangeParams; disabled };
```

- `onChangeParams` plans each param through the same `param.set` path as a row edit (a keyframe at the playhead when the
  param is animated, `planTemplateParamPatch` in `panels/properties/lib/template-params.ts`) and applies everything as
  **one** History entry. A function patch is called per selected clip with that clip's params, so Randomize gives every
  clip its own values; a clip whose patch is null is left alone.
- Group actions are drawn once per group header in Properties (`TemplateGroupActions`) and Effect Controls, isolated
  by an error boundary like the controls.
- Object and union template params (the avatar `{mediaId} | {generated} | null`) were mapped to `string` property
  specs, so `param.set` refused every object and no UI or agent could change them. They are now `json` specs validated
  whole by the template schema (`jsonSchemaPropertySpecs`, regression test
  `packages/project/test/template-object-params.test.ts`). Without a custom control such a row shows its JSON value
  read-only instead of a blank editor.

### `social-comment-text`

- **Editor:** a native textarea holding the *visible* text (marks stripped) over a backdrop drawn with the same box
  metrics. The textarea text is transparent; the backdrop shows highlight as a pill, blur blurred, remove dimmed and
  struck through (the card makes it invisible; the editor must keep it findable), @mentions and #hashtags in the
  accent colour (`tokenizeComment` for the clip's variant). Caret, selection, IME, emoji input, spell check and
  screen-reader text are the browser's own. The raw markup is shown only with **Show markup**, where it can be edited
  directly (same limits).
- **Marks survive typing** (`marks-edit.ts` `replaceVisible`): each change of the visible text is diffed against the
  old one (common prefix/suffix, never splitting a surrogate pair); unchanged characters keep their marks; a typed
  non-space joins the mark of the word it is typed into (left neighbour, else the word it reaches on the right, else
  the mark around the insertion, else the mark of the first word it replaced); whitespace runs touching the edit are
  settled like `applyMark` does (inside a phrase with one mark → marked; at its edge → unmarked). Runs elsewhere are
  untouched. The markup is written in `serializeMarks`' canonical form (visible text never changes).
- **Mark buttons:** Highlight, Blur, Remove, Clear Marks act on the selection grown to whole words (`applyMark`); a
  mark button on words that all carry that mark removes it (shown pressed). Buttons don't take the focus, so the
  selection stays. Shortcuts in the editor: **Ctrl+Shift+1 / 2 / 3 / 0** (physical Control on macOS too, ⌃⇧1…;
  ⌘⇧3/4 are macOS screenshots). None of them is in the default keymap or the presets; at every press the editor checks
  the *active* keymap and leaves a chord to the app if the user bound it, and the tooltips then omit it.
- **Undo steps:** a typing burst is one History entry (`coalesce`, the session's 750 ms window); each mark action is
  its own entry labelled "Highlight", "Blur", "Remove" or "Clear Marks"; nothing is written while an IME composition
  is open (the composed text is written at `compositionend`). Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y inside the
  editor run the project's undo/redo, so the field and the document never disagree. An outside change (undo, an agent)
  replaces the editor text and keeps the caret where it can.
- **Limits:** the counter shows grapheme clusters (`Intl.Segmenter`: "👍🏽", "🇪🇸", "👨‍👩‍👧" count as one) against
  the schema's 2000 visible characters; the schema counts UTF-16 code units, so the textarea's `maxLength` and the
  checks use code units and the counter's tooltip says emoji may count twice. Text over 2000 visible characters or
  markup over 4000 is refused with a message; nothing is written.
- **Several clips:** differing texts show an empty editor with a "Multiple values" placeholder; typing replaces every
  selected clip's text (as the default text field does). Mark buttons need a selection, so they stay disabled there.

### `social-count`

- Accepts what people type (`count-input.ts` `parseCountInput`, fast-checked): digits; groups with `,`, `.`, spaces,
  `_` or `'`; K/M/B suffixes in any case with `.` or `,` decimals (`12.3K`, `1,5k`, `3.4M`, `2B`); full-width digits
  (NFKC); a leading `+`. A single separator followed by exactly three digits groups (`1,234` = `1.234` = 1234), also
  before a suffix for a comma (`1,000B`, as the card prints the cap) but not for a dot (`1.234K` = 1234). Suffixed values
  round to the nearest integer; plain fractions, negatives, values over 1e12 and anything else are refused with a
  message under the field (`role="alert"`, `aria-invalid`), the stored value unchanged. Escape restores the stored
  value; ↑/↓ step by 1 (Shift: 10). The card's own text always reads back (property test over every variant).
- Next to the field: the count as the card prints it (`formatCount` for the clip's variant).
- The wand writes one believable value consistent with the others (one undo step): replies, reposts and views follow
  the current likes (`fillSocialParams` ratios: 1–5 %, 10–30 %, 10–50×); likes are drawn so the current replies stay
  1–5 % of them (tokcomment's distribution when there are no replies). A clip whose variant hides the field is left
  alone.

### `social-time`

- Value (0…10000) and unit (Minutes … Years, singular for 1) in one row; the unit is written to `timeUnit`, whose own row
  is hidden (`alsoEdits`). The preview is `formatTime` for the clip's variant ("3h", "3 months ago"). Months stay months
  on every platform (tokcomment printed YouTube months as hours; test "months stay months").
- A wand draws a plausible age for the platform (`randomStats` time). Differing units across selected clips show "–".

### `social-avatar`

- Three sources as a segmented control: **Image** (a project image), **Generated** (`{ generated: seed }`, drawn with
  `generatedAvatar(seed, displayName)` like the template; **Reshuffle** draws a new seed) and **Default** (`null`, the
  platform silhouette). A value the control does not understand is shown as the default and replaced by the next pick.
- Image: WP1's `MediaParamPicker` (still images only, "None" = default, drops on the field) plus a drop zone over the
  whole control for Project panel items (`droppedMediaId`) and desktop image files, and **Import an image…** (the
  tokcomment upload button), which imports the file into the project root bin through the import service and then
  sets it (two History entries: the import and the avatar). Video, animated images and other files are refused with
  "Only still images can be avatars". A media id no longer in the project is flagged ("The image is no longer in the
  project"). The preview shows the engine poster, then the original file. The media part is isolated in
  `AvatarMediaPicker.tsx`.
- **Randomize identity** writes `displayName`, `handle` and `avatar` (`randomIdentity`: a made-up name, matching handle,
  generated avatar) as one History entry "Randomize Identity", with a different identity per selected clip.

### Randomize stats

The group wand fills every stat the clip's variant draws — `timeValue`, `timeUnit`, `likes`, `replies`, and `reposts` /
`views` on X — from `randomStats(variant, seed)` with a fresh seed per selected clip, as one History entry
"Randomize Stats". Stats a variant hides (`VARIANT_CAPABILITIES`) keep their values. Seeds come from
`crypto.getRandomValues`; the document only receives the concrete values, so it stays deterministic.

### Robustness, accessibility, strings

- Every control reads its value and siblings defensively (`params.ts`: unknown variant → `tiktok-reply`, non-integer or
  out-of-range counts → "–", unknown avatar shapes → default) and is tested with garbage values (numbers, objects, NaN,
  wrong shapes); a refused write shows "The change was refused" and restores the stored value. The host's error boundary
  remains the last line.
- Labels: every input, select, toolbar (`role="toolbar"`, `aria-controls`) and icon button has an accessible name; mark
  buttons expose `aria-pressed`; errors are `role="alert"` and linked with `aria-describedby`; the segmented avatar
  source is a radio group. Read-only projects: the editor is `readOnly` (selectable), everything else disabled.
- Strings go through i18n (`pnpm i18n`; Spanish in `es.json`). The mark labels use context keys
  (`Highlight [word mark]` …) because "Highlight" already means Lumetri's highlights in the catalogue.
- Icons (`@jasper/ui` registry, lucide): `text.highlight`, `text.blur`, `text.remove`, `text.clearMarks`,
  `text.markup`, `action.randomize`, `action.reshuffle`, `action.randomIdentity`, `media.avatar`.

### Tests

- `apps/web/test/social-count-input.test.ts`: parser cases and fast-check (never throws; round trip of plain and
  grouped counts; the card's `formatCount` text reads back within its truncation for every variant).
- `apps/web/test/social-marks-edit.test.ts`: typing, deleting, replacing and emoji around marks; fast-check that the
  visible text is always the target and that marks outside the edit are preserved; selection state vs `applyMark`;
  grapheme counts.
- `apps/web/test/social-params.test.ts`: Randomize patches respect capabilities, stay consistent and parse.
- `apps/web/test/social-controls.test.tsx`: the controls in the real Properties and Effect Controls panels (layout,
  hidden time unit, group wand), typing/marks/undo/redo through the session, coalescing, IME composition, limits,
  shortcuts, Show markup, multi-selection (mixed values, per-clip randomization), drops, read-only, garbage values,
  refusals, and the fallback when the controls are not registered.
- `packages/project/test/template-object-params.test.ts`: object/union params are writable and validated (fails
  without the `json` mapping).

### Limitations

- The template itself (`social-comment@1`, WP6a) was not on this branch: the controls were built and exercised against
  the test template above. WP6a's template needs the hints listed above for them to appear.
- The generated-avatar preview passes `displayName` for the initials; if the template draws initials from another
  name (e.g. the handle on Instagram), the small preview can differ from the card.
- The avatar resolution warning of design §7.11 (below 2× the drawn size) is not part of these controls.
- In the markup view the mark buttons are disabled (the markup is edited as text there).
