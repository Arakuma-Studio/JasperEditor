# Social-comment templates — work note

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
TIKTOK_DEFAULT_AVATAR: PlatformGlyph
PLATFORM_DEFAULT_AVATARS: Record<'tiktok'|'instagram'|'youtube'|'x', { kind: 'glyph'; glyph } | { kind: 'remote'; image: { url; sha256; width; height; format } } | { kind: 'none'; reason }>
```

Rendering contract: draw `<svg viewBox>` with one `<path>` per entry in order; a path without `fill` uses
`currentColor`, which the template sets to `defaultColor[theme]` (or the state colour it needs). Paths with a
`fill` keep it (badges, the TikTok default avatar). Only `X_GLYPHS.verifiedGold` has gradients. `Glyph` emits a self-contained SVG image through `VectorImage`,
including `<linearGradient gradientUnits="userSpaceOnUse">` definitions; each image owns its gradient ids.

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

Tests: `packages/motion/test/social-glyphs.test.ts` validates SVG path grammar, colours and gradient references,
and verifies that the licence record contains the remote avatar URLs and hashes. The public card tests verify
that glyph paths keep their caller colour or their own fixed fill.

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
  visibleWhen?: { param, in[] }, control?, options? }> }`. `options` maps an enum param's values to menu labels
  (`{'classic-pop': 'Classic pop'}`); Properties and Effect Controls show the label, the stored value stays the id, a
  value without a label shows its id; the labels join the model-string catalogue.
- `createMgRegistry` validates both and throws on the first problem (like invalid defaults): presets need a name,
  plain-object params naming only params of the template, and `{...defaults, ...params}` must pass `paramsSchema`;
  groups need unique ids and labels and may only list existing params, each param in at most one group; `ui.params`
  may only name existing params; `label` / `description` / `control` are non-empty strings, `multiline` a boolean,
  `options` an object whose keys are valid values of the param and whose labels are non-empty strings;
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
- **Schema v9.** `v8→v9` is a version bump only: v8 builds count a clip's own `mediaId` alone, so their orphan
  collection, item delete, Project Manager and paste would drop media referenced only from template params; they
  open v9 files read-only ([project files](../project-files.md)). Fixture `packages/project/test/fixtures/schema-v9.jasper`.
  (This feature first bumped to v8; the Premiere port shipped its own v8 on `main` meanwhile, so the merge kept that
  v8 step unchanged and moved this bump to v9.)

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
  The media left out are never silent: in the Player each one is reported as `{kind: 'media', mediaId}` (a
  `MissingTemplateAsset`, listed by the Program monitor's template-asset chip as "Picture med_…") and marked with the
  striped banner; in a render a medium that is online but not browser-decodable without a display picture fails the
  render by name ("picture med_… cannot be decoded by the browser and has no display picture"). An offline medium
  renders as the template's fallback with the planner's `OFFLINE_TEMPLATE_MEDIA` warning (the `OFFLINE_MEDIA` policy).
  The layer also provides `TemplateMediaIdsContext` (URL → media id) so `TemplateImage` names what failed.
- **Drawing.** `TemplateImage` (`@jasper/motion/templates`, `packages/motion/src/templates/image.tsx`) is an `<img>`
  (`crossOrigin="anonymous"`) that holds the render with `delayRender` from its first frame until the picture is
  loaded and decoded (`img.decode()`), like `useFxImages`. A load error in a render (`getRemotionEnvironment()
  .isRendering`) fails it with `cancelRender(new TemplateImageError(url, mediaId))` ("Template picture med_… could not
  be loaded from <url without its signature>"); in the Player it releases the render, draws
  `TemplateImagePlaceholder` (a neutral dashed box) or the template's `fallback`, and reports the medium (above).
- **Exports.** Remotion exports sign every snapshot handle (`remotionProps`); layer bakes sign the media
  `referencedMediaIds` finds in the clip source (template params included) and key the bake on each medium's
  fingerprint, size and mtime (`keyMedia`), so a relinked avatar re-bakes. The `imports` extension counts template
  pictures as browser-drawn media, so a still the browser cannot decode (HEIF, EXR, interpreted pixels) gets its
  `display` picture in bakes and Remotion renders like any image clip. The planner warns `OFFLINE_TEMPLATE_MEDIA`
  when a template shows offline media (those pictures render as the template's fallback) and refuses media no
  `<img>` can show — a video, a Lottie animation, a PDF page — with `TEMPLATE_MEDIA_UNDRAWABLE` (409, per-clip
  blockers naming the medium; `templatePictureProblem`, `apps/engine/src/export/planner.ts`).

### UI and agents

- Properties and Effect Controls show `MediaParamPicker` for media params: None (writes `null`), the project's
  media of the accepted kinds, "Missing media" for an unknown id, and a drop target for Project panel items (an item
  of another kind is refused with a hint). Edits are `param.set` commands (one undo step each). Media params are not
  keyframable.
- MCP `list_motion_templates` lists a media param as `media image` (or `media image|video`); the templates guide says
  what it takes and how it is refused.
- Preview stills draw the project's media: the one-clip preview document of `render_motion_graphic_preview` (anime
  templates) and of `add_motion_graphic {dryRun, preview}` gets a `media.register` copy (same id, its bin name, the
  media it derives from first) of every medium the params reference (`previewMediaCommands`,
  `apps/mcp/src/tools/templates.ts`), so the engine resolves the same stored file. `render_motion_graphic_preview`
  takes an optional `projectId` for this; params with a `{mediaId}` and no `projectId` are refused by name
  (E_INVALID_PARAM), a medium the project lacks with E_NOT_FOUND (`apps/mcp/test/add-motion-graphic.test.ts`).

### Tests

`packages/project/test/template-media.test.ts` (regressions: each integrity path failed before the fix; validation;
snapshot; v9 fixture, v7 / v8 → v9 migration; fast-check property of the walk), `packages/session/test/template-media-history.test.ts`
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
  seek-driven template video component exists yet, so templates should declare images (the default); exports of a
  template showing a video are refused (`TEMPLATE_MEDIA_UNDRAWABLE`).
- Animated images (GIF / animated WebP) are not offered: an `<img>` animates on the wall clock, which renders could
  not reproduce.
- `media.derive {replaceInClips}` (processed versions) rewrites clips' own media only; template params keep the
  original medium.
- Pre-existing, outside this scope: media that only effect params use (e.g. the image of a displacement map) are
  still not counted by Project Manager "Exclude Unused", `item.delete` or `collectOrphans`.

## Template implementation

Work package WP6a (`sc/template`): the `social-comment@1` anime template, the framework every variant card is
built on, and the two TikTok cards. Labels as above: **[tok]** tokcomment reference set, **[M]** platform
measurements (WP5), **[E]** estimate or choice.

### Where it lives

| Piece | File |
|---|---|
| Definition, schedule (all timing), text units, layout constants, presets, UI hints | `packages/mg-templates/src/templates/anime/social-comment.ts` |
| Closed-form eases (`jasper.spring`, `jasper.dropBounce`), `easeFunction` | `packages/mg-templates/src/templates/anime/eases.ts` |
| Motion model (`social-comment@1` in `MODELS`) | `packages/mg-templates/src/templates/anime/motion.ts` |
| Implementation (`ANIME_TEMPLATE_IMPLS['social-comment@1']`) | `packages/motion/src/templates/social-comment/` |
| Export blocker for cards not built yet | `apps/engine/src/mg/templates.ts` (`missingTemplates`) |

`packages/motion/src/templates/social-comment/`:
- `index.tsx`: `SocialComment` — parses the params (invalid params fall back to the defaults), builds the schedule's
  timelines, hands the extras' values to the card.
- `build.ts`: the component's timeline builders and tick-progress evaluator. Sound-cue tests observe the public
  rendered component rather than these internal targets.
- `stage.tsx`: `SocialStage` (centring, zoom, fit, entrance transform), `socialFitZoom`.
- `contract.ts`: the variant contract. `parts.tsx`: shared parts. `assets.tsx`: picture and emoji touch points.
- `tiktok.tsx`: the TikTok cards. `variants.ts`: the exhaustive `SOCIAL_VARIANT_IMPLS` card map.

### Adding a variant (WP6b–d)

**The contract** (`packages/motion/src/templates/social-comment/contract.ts`):
- A variant is a `SocialVariantImpl = { Card, growOrigin, bleed? }`.
- `Card(props: SocialCardProps)` draws ONE card at **reference px**: the tokcomment CSS px of its blueprint (copy the
  numbers from `ref/<variant>/styles_*.json`). The card sets its own width: 420, or `width: fit-content` with
  `maxWidth: 305` for the Reels and Shorts cards. Never zoom, centre or position the card; the frame does that.
- `props`:
  - `params`: parsed `SocialCommentParams`;
  - `text`: `{ spans, segments, units }` from `socialCommentSegments`;
  - `anim`: `{ words, likes, heart }`;
  - `assets`: `{ mediaUrls, imageUrls, emojiUrls, emojiPack }`.
- `growOrigin`: the CSS `transform-origin` of the "grow from tail" entrance, in % of the card box. Use the bubble tail's
  corner on bubble cards (TikTok reply `0% 100%`) and the avatar's corner elsewhere (`0% 0%`).
- `bleed`: reference px the card paints outside its box per side (a `box-shadow`), so the fit keeps it on screen.
  The TikTok comment row's `0 25px 50px -12px` shadow gives `{ top: 13, right: 38, bottom: 63, left: 38 }`.

**Entrances and extras need no code in a card.** The frame applies every entrance and the exit to the whole card,
and passes the extras through `anim`:
- `words`: draw the comment with `CommentText`, which applies them;
- `likes`: show `formatCount(variant, anim.likes, 'likes')`; it ticks;
- `heart`: when set, scale the like icon by `heart.s` and cross-fade outline → filled by `heart.f`. See `LikeHeart`
  in `tiktok.tsx`.

Never add timelines, timers or animation inside a card. The output must be a pure function of the props.

**Wiring a variant:**
1. Create `instagram.tsx` / `youtube.tsx` / `x.tsx` next to `tiktok.tsx`, exporting one `SocialVariantImpl` per
   variant.
2. Add its card to the exhaustive `SOCIAL_VARIANT_IMPLS` map in `variants.ts`.
3. In `packages/mg-templates/src/templates/anime/social-comment.ts`:
   - add the variant to `SOCIAL_COMMENT_READY_VARIANTS` (this adds its gallery preset and lifts the export blocker);
   - fill its `SOCIAL_VARIANT_FONTS` entry (family and weights; the font must exist in the bundled catalogue or the
     remote manifest);
   - check its `PRESET_NAMES` entry.
4. Update the preset expectations in `packages/mg-templates/test/social-comment-template.test.ts`; the all-variant
   card loop in `packages/motion/test/social-comment.test.tsx` checks the new card in both themes.

**Theme tokens:** one `const <VARIANT>_THEME = { light: {…}, dark: {…} }` per card in its own file, with hex colours
copied from the reference dumps (`styles_light*.json` / `styles_dark*.json`). Colours that come from the platform
measurements carry an [M] / [M-css] comment.
- Glyph colours: pass the reference colour (or the glyph's `defaultColor[theme]`) to `Glyph`.
- Mentions and hashtags go in `CommentText`'s `colors`.
- These are platform colours, not editor UI, so `scripts/check-tokens.mjs` does not apply to the template's inline
  styles.

**Shared parts** (`parts.tsx`, `assets.tsx`). Use them; don't fork them:
- `SocialAvatar({ avatar, platform, size, name, fontFamily, assets, style })`.
  - Pass the name the card shows as `name`; the generated avatar's initials come from it.
  - The Properties `social-avatar` preview uses `displayName`. Tell the integrator if a handle-only card passes
    `handle`.
- `Glyph({ glyph, size, color, style })`. `size` is a number or `[w, h]`.
- `CommentText(...)`: highlight, blur, remove, mentions, emoji, word reveal.
  - It carries `data-template-param="text"` and `data-template-marks="true"` (C5).
- `TextWithEmoji({ text, fontSize, emoji, assets })` for names. Wrap a name in an element with
  `data-template-param="displayName"` (or `"handle"`) that holds exactly that text (C5; switch to
  `editableParamProps` when WP7b lands).
- `EmojiMetrics`: `{ size: 1.2, shift: -0.22 }` (em) matched TikTok. Re-measure per platform with `tools/yellow.mjs`.
- Formatters from `@jasper/mg-templates`: `formatCount`, `formatTime`, `formatRepliesLabel` (an empty string means
  no replies row), `VARIANT_CAPABILITIES`.

**Tests a variant must pass:**
- `packages/motion/test/mg-cue-timing.test.ts`:
  - The schedule depends only on the entrance, the word units and whether the variant draws likes. The motion model
    also reads the card's `SOCIAL_MOTION_METRICS` row (`@jasper/mg-templates`): its comment font size (a revealed
    word scales by its estimated width), how far its like icon travels per unit of the thump, and whether that icon
    fills. Add the row with the card's constants.
  - Add `SOCIAL_ROWS` rows for it: at least one entrance × {word reveal, like tick} when it draws likes. The test
    renders the card in Chrome through its public component and checks the land and exit cues within ±1 frame of
    where the rendered card (its box, every word, every glyph, the like count and the stars' fill) comes to rest
    and starts leaving.
- `packages/motion/test/social-comment.test.tsx`: add the card's own checks, as for TikTok: header and name
  rules, counts, replies, `showProfile`, verified.
- `packages/motion/test/social-comment-render.e2e.test.ts` (`REMOTION_E2E=1`):
  - add the variant to the parity cases and the fit loop (long text, huge counts, 64-character names, every canvas);

**Regression workflow.** Run the parity and painted-bounds tests with `REMOTION_E2E=1 pnpm exec vitest run
packages/motion/test/social-comment-render.e2e.test.ts packages/motion/test/social-review-render.e2e.test.ts
--maxWorkers=2`. Supply the documented font and emoji directories when checking those assets; otherwise the tests
use their bundled/fallback faces and generated emoji stand-ins. Parity mismatches retain frame PNGs and comparison
data in the logged artifact directory. The calibration pages below record the original visual research; generating
manual screenshot matrices is outside the regression suite.

**Assets and determinism rules** (added with the WP2 wiring):
- **Fonts and images:** don't declare them yourself. `requiredAssets` derives them from `SOCIAL_VARIANT_FONTS`,
  `SOCIAL_COMMENT_READY_VARIANTS`, `SOCIAL_DEFAULT_AVATAR_IMAGES` and `VARIANT_CAPABILITIES`. A raster default avatar
  is `assets.imageUrls[SOCIAL_DEFAULT_AVATAR_IMAGES[platform]]`.
- **Emoji:** draw every emoji through `CommentText`, `TextWithEmoji` or `EmojiGlyph`, which use `EmojiImage`. Never
  render an emoji grapheme as text: it would be a host-font glyph.
- **Animated elements:** style every element you animate per frame (a thumping icon…) with `motionStyle({ s, o })`
  from `parts.tsx`. It adds the transform, opacity and `INK_RING` while moving, and nothing at rest.
- **Vector drawings:** draw icons, badges and shapes with `Glyph` or `VectorImage` (`vector.tsx`), never inline
  `<svg>`. Tests find them as `img[data-vector]`; `vectorMarkupOf(img)` gives their SVG document.
- **No paint traps:** no `overflow: hidden` + `border-radius` clips (round pictures by their own radius), and no CSS
  `filter` on text (see "Paint determinism").
- **Unit tests that render emoji:** stub `NODE_ENV=development` and `HTMLImageElement.complete` like
  `social-comment.test.tsx`. Remotion treats `NODE_ENV=test` as a render, and a missing emoji then cancels it.
- **Render e2e:** emoji without `SOCIAL_EMOJI_DIR` get flat stand-in images automatically. The parity check requires
  byte-identical frames at rest and the project standard while animating (see "Paint determinism").

**Don't touch** (shared; changes go through WP6a or the integrator):
- `index.tsx`, `stage.tsx`, `build.ts`, `contract.ts`, `parts.tsx`, `assets.tsx`;
- the schedule and its constants in `social-comment.ts`;
- `eases.ts` and the `social-comment@1` model in `motion.ts`;
- `tiktok.tsx`.

If a shared part lacks something, add an optional prop instead of changing its behaviour.

### Timing (design §7.6)

One pure schedule, `socialCommentSchedule({ totalMs, introMs, outroMs, entrance, units, tick })`, is built into
anime.js timelines by the implementation and evaluated by the motion model (sound cues). The cue test compares the
cues with the rendered card, not with the model's own values.

| Phase | Tweens (ms at the declared intro) |
|---|---|
| Classic pop | scale 0 → 1.3 (150, `outQuad`) → 1 (120, `inOutQuad`); opacity 0 → 1 (60) |
| Soft spring | scale 0.6 → 1.035 (260, `outCubic`) → 1 (190, `inOutQuad`); opacity (150, `out`) |
| Grow from tail | scale 0 → 1 (420, `outBack`) from `growOrigin`; tilt −8° → 0 (500, `jasper.spring`); opacity (100) |
| Drop & bounce | 60 design px fall with one 14 % bounce (550, `jasper.dropBounce`); opacity (165) |
| Word reveal | each word unit: scale 0.5 → 1 (220, `outBack`), opacity (110); one every 90 ms (at most 2.4 s for all) |
| Like tick | count 0 → likes (900, `outCubic`, formatted every frame); heart scale 1 → 1.3 → 1 and fill (300) |
| Exit | scale 1 → 0.82 and opacity 1 → 0, eased in, over the outro |

- **Declared windows:** the intro is 17 frames at 30 fps (566.7 ms, the longest entrance); the outro is 6 frames
  (200 ms). `animeTemplateTiming` compresses both on short clips, and the entrance tweens scale with the intro.
- **Extras:** they start when the entrance ends and must finish before the exit. When they do not fit, they compress
  proportionally into the time left. A tween is never shorter than 1 ms, and a value's tweens never overlap
  (fast-check). The extras run in the hold after the declared intro; the cues come from the model, so the land cue
  falls where the last word or the heart settles.
- **Rest state = hold state (ANM-009):** every word shown, the final count, the heart filled when it ticked.
- **Soft spring:** it was first a closed-form spring, but its slow tail kept the card moving below the cue threshold,
  and the frame and continuous cue measures disagreed by up to 7 frames. It is now two eased segments with zero speed
  at the turn and at the end. `jasper.spring` remains for the tilt settle.
- **Like tick on variants without likes:** the tick needs a variant that shows likes (`socialLikesTick`). On the
  TikTok reply bubble it is ignored.

### Presets, Properties hints, avatar and fill

- **Presets:** `socialCommentPresets(SOCIAL_COMMENT_READY_VARIANTS)` gives one preset per variant with a card, id =
  variant, named "TikTok · Comment reply" and "TikTok · Comment". Its params are the variant's tokcomment defaults
  (`socialDefaults`) that differ from the schema's. Agents use `"social-comment:tiktok-reply"`.
- **Groups:** Look (variant, theme, emojiStyle), Author (displayName, handle, avatar, showProfile, verified), Stats
  (timeValue, timeUnit, likes, replies, reposts, views, showReposts, showViews), Text (text) and Animation (entrance,
  wordReveal, likeTick).
- **Visibility:** every param a variant may not draw has `visibleWhen: { param: 'variant', in: variantsWithParam(p) }`.
- **Custom controls (WP7):**
  - `text`: multiline, control `social-comment-text`;
  - likes, replies, reposts and views: `social-count`;
  - `timeValue`: `social-time` (the control draws value and unit in one row and hides the `timeUnit` row);
  - `avatar`: `social-avatar`.

  Until they are registered, Properties shows the standard editors.
- **Avatar:** it keeps the `{ mediaId } | { generated } | null` union. The union carries `mediaParam()`'s metadata
  (`x-jasper-kind: "media"`, kinds `["image"]`), so `paramsPropertySpecs` offers the media picker (verified), commands
  check that a `{ mediaId }` names an image, and every integrity path counts it. The picker shows "None" for a
  generated avatar; `social-avatar` adds the generated choice.
- **Fill hook:** `fill = fillSocialCommentParams`, which wraps `fillSocialParams`. It returns the given params plus the
  filled ones and the filled names, never throws, and returns `{ ok: false }` on bad input. The MCP `TEMPLATES_GUIDE`
  has a social-comments paragraph and a three-comment batch example.

### Text, marks and emoji

- **Units:** `socialCommentSegments(text, variant)` gives the `tokenizeComment` spans and the Intl.Segmenter word
  segments.
  - A highlighted run across words (`==any comment==`) is one unit with one pill, as tokcomment merges adjacent
    highlighted words. Separate highlights stay separate units.
  - The model and the renderer count the same units.
- **Highlight:** tokcomment's `#FFE500` pill, black text, 6 px radius, padding `.05em .35em`, `box-decoration-break:
  clone`.
- **Blur:** the look of tokcomment's `blur(4px)` at reference size, drawn as a text shadow of the same Gaussian
  (`0 0 8px currentColor`; a shadow's blur radius is twice the standard deviation) under transparent glyphs
  (`-webkit-text-fill-color: transparent`). The card's zoom scales it with the card: 7.2 design px on 9:16.
  - Why not `filter`: a CSS `filter` on the words made Chrome composite them, and a frame painted after an entrance
    then differed from the same frame painted alone by up to 10/255 (renderFrames ≠ renderStill).
  - The calibration page matches tokcomment's blur captures.
  - An emoji inside a blurred word keeps `filter: blur(4px)` (an image has no text shadow).
- **Remove:** `opacity: 0`, so the gap is kept.
- **Mentions and hashtags:** TikTok's info colour, tux `--ui-text-info`: #2B5DB9 light, #60B3FF dark [M-css]. They
  are coloured on both TikTok cards [E]; a highlight's text stays black.
- **Emoji:** images of the clip's pack (`resolveEmojiStyle`), drawn by `EmojiImage` (contract C2).
  - The render waits for each image's decode. A grapheme the pack does not deliver is a visible `MissingAssetMarker`
    in preview, reported to the editor; in a render it fails the render, and the export planner blocks such exports
    before they start.
  - Emoji detection is the shared `splitEmoji` / `emojiGraphemes` / `isEmojiGrapheme` of @jasper/mg-templates
    everywhere: in `requiredAssets` and in the cards. Text-presentation characters without VS16 (`❤`, `☺`, `✔`)
    stay text, as UTS #51 says.
  - Size 1.2 em, centred on the text's middle (shift −0.22 em), with a 0.03 em side bearing so adjacent emoji keep a
    hairline gap.
  - Calibrated against the tokcomment captures: 30 vs 29 px ink at 2×, centre within 0.5 px.
- **Word reveal:** units become inline-block so they can scale; whitespace stays text, so lines break as without the
  reveal.

### Declared assets (`requiredAssets`)

`socialCommentRequiredAssets(params)` declares what a clip draws, for the render snapshot (preview and bake), the
export planner and the bake key:
- **Fonts:** the variant's faces from `SOCIAL_VARIANT_FONTS`: TikTok Sans 600 and 700 (reply), 500 and 600 (comment),
  from the bundled catalogue; Chirp 400 and 700 (X), from the remote manifest.
- **Emoji:** the graphemes of the visible comment (marks stripped) and of the names the variant shows
  (`VARIANT_CAPABILITIES`), in the clip's pack.
- **Images:** the platform's raster default avatar (`SOCIAL_DEFAULT_AVATAR_IMAGES`: X, YouTube) when the avatar is
  shown and is the default. `SocialAvatar` draws `assets.imageUrls[id]`, else a silhouette.
- **Unbuilt variants:** a variant not in `SOCIAL_COMMENT_READY_VARIANTS` declares nothing; it draws only its "not
  available" card, and exports refuse it.

### Paint determinism

A frame must be the same bytes whether Chrome paints it alone (`renderStill`) or after other frames (`renderFrames`,
the Player). `social-comment-render.e2e.test.ts` checks 9 cases (every variant, entrance and extra) at 13 frames each.
These fixes are in the shared framework:
- **Vector drawings are SVG images (`vector.tsx`, `VectorImage`).** This covers glyphs, badges, default avatars and the
  bubble tail.
  - Root cause: Chrome anti-aliases small inline SVG paths inside a scaled card depending on the scales it drew them at
    before, through its path coverage cache. In `comment-light-spring`, icon edges differed by 1–2/255 on up to 11
    pixels during the entrance, in 17 of 20 targeted runs. Neither `shape-rendering` nor anything else in the page
    changed that.
  - Drawn as an `<img>` of its SVG document, each drawing is rasterized whole at its painted size: 0 differences in
    13 targeted runs.
  - The render waits for each image's decode, as `EmojiImage` does.
- **The un-animated DOM at rest (`motionStyle`).** An element animated per frame gets its transform, opacity and
  `INK_RING` only while it moves; at rest it has no such style (S11:ANM-009). That covers the card wrapper, word units
  and like hearts. A transform left over from the entrance, such as `rotate(-0.003deg)`, can't then decide what the
  rest frames look like.
- **Ink ring (`INK_RING`)** while moving: Chrome repaints a transformed element within its ink rect, so the ring
  includes the anti-aliased edges.
- **No rounded `overflow: hidden` clips:** every avatar is round by itself.
- **Text-shadow blur** instead of `filter`, as above.
- **Residual (Chrome, not the template):** the two icons right of the ticking count (YouTube comment) can be painted
  1/64 px off in one renderer tab while the like count ticks.
  - Size: ≤ 51 px, ≤ 43/255, in ≈ 15 % of runs.
  - Evidence: frame-by-frame dumps of a failing run show it only in frames 21–45, alternating with the other tab, and
    never at rest. Stills are always the reference rendering, and a plain Chrome page visiting the same frames in any
    order never shows it. Reserving the count's width, a separate image URL at rest and an opaque background didn't
    remove it.
- **Rare capture glitch (Remotion):** once in ≈ 1,100 compared frames, a capture showed a partly re-rastered frame.
  Remotion's own code notes a ≈ 0.1 % frame drop of `captureBeyondViewport` screenshots; it is not template output.
- **Tolerance policy** (`packages/motion/test/social-parity.ts`, shared by `social-comment-render` and `social-review-render`): frames at rest — from the end of the entrance and every extra to the start of the
  exit — must be byte-identical. Frames while the card animates (entrance, word reveal, like tick, thump, exit) must
  meet the project's parity standard for Chrome-painted layers: ≥ 99 % of the pixels within 3/255, as in the
  layer-bake and determinism tests.
- **Measurements** (old policy: 1/255 on ≤ 64 px before the entrance ends, byte-identical after):
  - Before the fix: 10 full runs: 4 fail the old policy, 1 the new (the capture glitch). Targeted
    `comment-light-spring`: icon differences in 17 of 20 runs, 3 over 1/255.
  - After: 8 full runs: 3 fail the old policy, 0 the new. Targeted `comment-light-spring`: 0 differences in 13 runs.
    Targeted `youtube-comment-dark`: the like-tick residual in 1 to 3 of 10, all within the standard.
  - The per-frame data of every run is appended to `SOCIAL_PARITY_LOG=<file>` when set.

### Placement and fit

- **Zoom:** the card is drawn at reference px and zoomed with CSS `zoom` by `socialCardScale`. That is 1.8 on 9:16
  (a 420 px card is 756 px, 70 % of the width), 1.7 on 1:1 and 1.6 on 16:9. It is centred on the design stage.
- **Why `zoom`:** the zoomed box is the drawn size, so the entrance wrapper's `transform-origin` lands on the real
  corner (the tail tip) and flex centring sees the real size.
- **Fit:** a long comment shrinks the whole card to ≤ 88 % of the design height and ≤ 96 % of its width, the shadow
  bleed included.
  - It is measured in a layout effect with layout boxes (`offsetWidth` / `offsetHeight`), after fonts load; at most
    three passes per layout.
  - The fit is applied before paint, so the Player, `renderStill` and exports agree (checked below).
- **Counts:** they never overflow. The formatters keep them short ("987.6B", "View 4.8M replies"), the stats group
  never shrinks, and the left group clips.

### TikTok cards: calibration

- **Blueprint:** tokcomment's computed-style dumps (`ref/tiktok-reply`, `ref/tiktok-video`), copied in CSS px.
  - Reply bubble: 420 wide, padding 18/18/22, radius 10 10 10 0, avatar 50 at +20, gap 14, header 600, comment 700
    at −0.025 em, line height 1.2, bubble #FFF / #1E1E1E, header #5A5A5A / #C0C0C0.
  - Comment row: 420 wide, padding 12/10/5, radius 2, 1 px black/5 % border, 0 25 50 −12 black/25 % shadow, avatar 38,
    name 13/500, text 14/500 at 1.25, meta 11–12 px, icons #A2A2A2, rule 23 × 1, plus its dark colours.
- **Bubble tail:** tokcomment draws it with three skewed CSS squares. It was traced from the 2× captures into one
  path, 25.5 wide and 21 tall, with a 4 px rounded tip.
- **Evidence:** a side-by-side page per variant and theme, with long text, huge counts, marks, emoji, uploaded vs
  generated avatar and animation filmstrips, is at
  `/var/lib/orquester/workspaces/jaspersito/research/calibration/tiktok/index.html`. It sits outside the repository:
  the tokcomment captures are third-party screenshots. Its stills come from Remotion `renderStill` at 2× reference
  px.
- **Measured matches:**
  - comment card height 228 px against tokcomment's 229 (2×);
  - the comment row's text line within 2 %;
  - the highlight pill's position and size within 2 px.

**Deliberate differences from tokcomment:**
- **Font:** TikTok Sans (TikTok's current UI font, OFL) instead of Proxima Nova (reply) or the capture host's
  Liberation Sans fallback (comment).
  - TikTok Sans has a 5–7 % taller cap height, so the reply sizes are scaled to keep the reference's cap heights:
    header 18.5 px instead of 20, comment 29.5 px instead of 31.
  - It is also ≈ 9 % wider, so lines hold fewer characters: the default comment wraps onto 3 lines on the reply and a
    long comment takes one more line on the comment row.
- **Glyphs:** TikTok's real glyphs (`TIKTOK_GLYPHS`) replace lucide and react-icons: verified badge, heart outline
  and liked heart, dislike (derived), chevron. The heart's stroke is thinner and the chevron filled, as on TikTok.
  - Sizes are set to the reference's visual sizes: heart box 20 (lucide 15.55 at 83 % fill vs TikTok 65 %), dislike
    17, chevron 12, badges 18 and 10.
- **Default avatar:** TikTok's own (`TIKTOK_DEFAULT_AVATAR`) instead of the hot-linked Twitter default.
- **Emoji:** Apple images instead of the capture host's Noto font.
- **tokcomment bugs fixed:**
  - "Reply to␣username␣'s": flex gaps put the space before the apostrophe; the header is now one sentence that wraps
    naturally for long names.
  - Counts render verbatim ("1234567"); they are now formatted per platform.
  - "View 0 replies": 0 replies now hides the row.
  - Huge counts overflow the card; they now stay short.
- **Liked state:** with the like tick, the heart ends filled in TikTok's liked colour (#FE2C55 / #FF3B5C [M-css]).

### Instagram cards: calibration

Work package WP6b (`sc/v-instagram`): `instagram-post` and `instagram-reel-reply` in
`packages/motion/src/templates/social-comment/instagram.tsx`. Labels as above, plus **[M-css]** Instagram's own CSS
variables (instagram.com, 2026-10-25) and **[HIG]** Apple's Human Interface Guidelines.

- **Blueprint:** tokcomment's computed-style dumps (`ref/instagram-post`, `ref/instagram-reels`), copied in CSS px.
  - Post comment: 420 wide, padding 16/14/6, radius 2, 1 px black/5 % (dark white/5 %) border, no shadow; avatar 36,
    gap 13; header 12/18 with the badge 10.5 and the time 3 px after it; comment 14 px at 1.3, margins 3 / 5.25; "Reply"
    row 12/18 3 px below; replies row 10 px below with a 25 × 1 rule (#B5B5B5 / #383838) and 5 + 6 px before the label;
    like column 25.6 wide (8 px left padding), heart 16 px slot, count 11.04/16.56 6 px under it. Card #FFF / #222328,
    comment #0F0F0F / #FFF, secondary #888 / #A3A9AF.
  - Reel reply: `width: fit-content`, at most **255** px (the size tokcomment draws it at on a desktop viewport; its
    mobile layout is wider with 18 px text, the guide's 305 does not appear in the dumps), padding 16, radius 6,
    `0 1px 2px` black/5 % shadow (`bleed` 1/2/3/2), a 1 px white/5 % border only in dark; avatar 36, gap 11; comment
    15 px at 1.375, 3 px above "Replying to username" 13/19.5 (truncated with an ellipsis). Card #FFF / #222328,
    comment #000 / #FFF, "Replying to" #888 / #A8A8A8.
- **Font:** SF Pro Text (remote manifest `sf-pro-text-400/600`; `SOCIAL_VARIANT_FONTS`: 400 + 600 on the post, 400 on
  the Reel card). The iPhone app's system font [M-web, S-3p], the Text cut because every size is below 20 pt.
  - tokcomment's sizes are kept: SF Pro's cap height is within 1 px of the capture's (2×: "W" 20 vs 19 px, "u" 13 vs
    13), so no size scaling was needed.
  - Tracking per size from Apple's SF Pro table [HIG]: 11 px +0.06, 12 px 0, 13 px −0.08, 14 px −0.15, 15 px −0.23
    (iOS applies it to the system font).
  - Weights are Instagram's [M], not tokcomment's 500 (which its fallback font drew as 400): username, "Reply" and the
    replies line 600; comment, time and count 400.
- **Glyphs:** `INSTAGRAM_GLYPHS` heart outline / filled and verified badge. The heart is drawn 15.5 px in the 16 px
  slot and the column moves 1.5 px down, so its ink box and centre match tokcomment's lucide heart (30 × 26 px at 2×).
  While the like tick thumps it, the heart carries `INK_RING`.
- **Colours added:** mentions and hashtags in `--ig-link` #00376B / #E0F1FF [M-css]; liked heart `--ig-badge` #FF3040
  [M-css].
- **Default avatar** (`avatar: null`): Instagram has no stable public source (WP5), and the only unsigned image of its
  web bundle (`/images/instagram/xig/anonymousUser.jpg`) is the pre-2018 blue-grey bust. The card draws the current
  look as a vector: a #C7C7C7 disc with a white head (r 8.4 at 24/18.6 in a 48 box) and shoulders (a radius-17 dome
  whose foot follows the disc) [E: Instagram's grey `#C7C7C7` and the figure's proportions are chosen to match the
  platform's default, not measured from it]. `INSTAGRAM_DEFAULT_AVATAR` exports the colours and paths.
  - The disc is SVG geometry, not a CSS `border-radius` clip over a background: that first version made `renderStill`
    and `renderFrames` differ on a few edge pixels in 3 of 6 runs (Chrome rasterised the clipped edge differently); the
    SVG version was identical in 12 of 12.
  - Generated avatars take their initials from the handle (the name the card shows); pictures and generated avatars
    go through the shared `SocialAvatar`.
- **Editing on the Program monitor:** the handle (name on the post, "Replying to" on the Reel card) carries
  `editableParamProps('handle')`; the comment is `CommentText`'s (`text`, marks).
- **Emoji:** Apple images at 1.2 em, shift −0.22 em (TikTok's metrics): 31 px tall at 2× against the capture's 29 px
  Noto glyph, centre within 2 px of it on the post, 0.5 px on the Reel card.
- **Evidence:** `/var/lib/orquester/workspaces/jaspersito/research/calibration/instagram/index.html` (outside the
  repository), one row per tokcomment capture of both cards, light and dark, plus long names, 0 likes and replies,
  huge counts, the liked heart, mentions, generated avatar, no profile, and filmstrips of grow-from-tail with word
  reveal and like tick. The retained render suite checks parity and painted bounds with the same optional font
  and emoji sources:
  - every case starts from its variant's `socialDefaults`, as the captures do (unchanged for TikTok, whose defaults
    are the schema's);
  - `SOCIAL_SF_PRO_DIR` loads SF Pro Text 400/600; without it the Instagram cases render in the host's fallback font;
  - each case's page loads only its variant's font family (as `requiredAssets` does). With every family on every page,
    the TikTok `comment-light-spring` parity case failed 2 of 2 runs (an icon edge 2/255 off at frames 6 and 146) and
    passed without SF Pro; with per-variant fonts the whole parity test passes;
- **Measured matches (2× px):** post card 235 px high against 238, Reel card 191 against 192 (dark, with its border:
  193 against 196); the rest is the 1 px border, which Chrome snaps to whole device pixels under the card's zoom; comment and "Reply" baselines within
  1 px; "View 5 more replies" within 1 px; heart ink box 30 × 26 at the same place; Reel card 509 px wide against 510.

**Deliberate differences from tokcomment:**
- **Font:** SF Pro Text instead of Liberation Sans. SF Pro is ≈ 3 % wider: the default comment ends 17 px (2×) further
  right, and a comment that only just fits on tokcomment wraps one word earlier (the highlighted default text wraps
  its emoji).
- **Weights, tracking, glyphs, link and liked colours:** Instagram's, as listed above.
- **Default avatar:** Instagram's grey silhouette look instead of the hot-linked Twitter default; emoji are Apple
  images instead of the host's Noto font.
- **tokcomment bugs fixed:**
  - the dark-mode username is white (tokcomment's `text-black` overrides its `text-[#ffffff]`, drawing it black);
  - counts are formatted per Instagram ("1,234", "12.3K", "987.6B"; tokcomment prints "1234567" verbatim);
  - 0 replies hides the replies row, 1 reply reads "View 1 more reply";
  - 0 likes shows no number under the heart, as on Instagram;
  - the like column keeps its width: a long count stays centred under the heart (spilling into the gap and the card's
    padding) instead of squeezing the comment or pushing the heart.
- **Like tick:** the count ticks up, then the heart thumps and fills in #FF3040; the Reel card has no likes, so its
  like tick is ignored (`socialLikesTick`).
- **Grow from tail:** both cards grow from the avatar corner (`0% 0%`).

**Verification (WP6b, `--maxWorkers=2`):**
- `packages/motion/test/social-comment.test.tsx`: both cards in both themes; handle, time per unit ("now" … "56w"),
  badge only when verified, counts and the singular / hidden replies row, no count at 0 likes, huge counts with a fixed
  like column, the dark username and `--ig-link` mentions, the default / generated / uploaded avatar, `showProfile`,
  the like tick ending on the red filled heart, the Reel card (no stats or badge, ≤ 255 px), the grow corner.
- `packages/motion/test/mg-cue-timing.test.ts`: Instagram rows (classic pop and grow from tail × word reveal + like
  tick on both cards, a short 1.5 s clip at 25 fps): the model equals anime.js frame by frame, cues within ±1 frame.
- `packages/mg-templates/test/social-comment-template.test.ts`: the Instagram presets and their params, the export
  blocker lifted, the font entries, and `requiredAssets` (SF Pro Text faces, the comment's emoji, no image).
- `REMOTION_E2E=1 social-comment-render.e2e.test.ts` (Chrome 156, SF Pro and Apple emoji loaded): `renderStill` =
  `renderFrames` byte for byte for an Instagram post (1:1, dark, verified, classic pop, word reveal, like tick) and a
  Reel card (9:16, word reveal); the fit loop keeps both cards inside every canvas with a 1,400-character marked
  comment, 1e12 counts and 64-character handles.

### YouTube cards

WP6c (`sc/v-youtube`): `youtube-comment` and `youtube-shorts-reply`, in
`packages/motion/src/templates/social-comment/youtube.tsx` (`YOUTUBE_COMMENT`, `YOUTUBE_SHORTS_REPLY`). Font: Roboto
400/500 (bundled, `SOCIAL_VARIANT_FONTS`). Glyphs: `YOUTUBE_GLYPHS`. Emoji: Noto (`emojiStyle: auto`).

- **Blueprint [tok]:** `ref/youtube-video` and `ref/youtube-shorts`, copied in CSS px.
  - Comment: 420 wide, padding 12/12/5, radius 6, 1 px border black/white 5 %, bg #FFF / #0F0F0F. Header: `@handle`
    13/500, badge, a 3 px dot, time 12 px #606060 / #AAA, kebab on the right. Comment 15/21 with 19 px right padding.
    Actions 9 px below: thumb up + count (12 px), thumb down, reply bubble in a 37 px button. "N replies" + chevron
    22 px lower, in a 14/500 button pulled 12 px left. Thread line from 8 px under the avatar to just above the replies
    text, with a quarter-circle corner.
  - Shorts card: `fit-content`, at most 305 wide, padding 8/20/12, radius 16, avatar 34 at +8, gap 12. Header
    "Comment from @handle" (one line, ellipsis); comment 17/500, line height 1.3, −0.025 em.
- **youtube.com 2026 over tokcomment [M]** (`research/platform-measurements`, YouTube):
  - avatar 36 instead of 34 (gap 12, so the text column stays at tokcomment's x = 61);
  - "N replies" #0F0F0F / #F1F1F1 (tokcomment #606060 / #FFF); dark handle #F1F1F1 (tokcomment #AAA); dark count
    #AAAAAA (tokcomment #FFF); icons #0F0F0F / #F1F1F1;
  - thread line 1 px #E5E5E5 / #3F3F3F (tokcomment 2 px #0000001A / #363636); chevron pointing down.
  - The mobile-app layout of tokcomment (the dot, the reply bubble instead of desktop's "Reply" text) is kept.
- **Shorts header:** the captures' header is 155.5 px wide with an 8.5 px cap height whose top sits 17 px into the
  card. That is 12 px tracked 0.025 em, on the baseline of tokcomment's 16 px / 24 px line; the card draws it at 12 px
  and moves it down 1.4 px (Roboto's ascent/descent) so it can end in an ellipsis.
- **Thumbs:** YouTube's 18-unit thumbs at 17 px match the ink of tokcomment's 16 px lucide thumbs (14 px wide); −0.5 px
  margins keep tokcomment's 16 px slots. Kebab 15 px (dots 2.5 px, as tokcomment's), badge 13 px (a 12 px disc),
  reply bubble 16 px, chevron 20 px.
- **Like tick:** the outline thumb cross-fades to YouTube's filled thumb (same colour) and thumps. While the count
  ticks, the widest count it passes through (the final one and the all-nines value of each smaller order of magnitude)
  reserves its width, so the dislike and reply buttons never move. Without it the moving glyphs were anti-aliased
  differently depending on the frames painted before (`renderStill` ≠ `renderFrames` on ≈ 50 px, 1 run in 3; 0 in 4
  after).
- **Mentions and hashtags:** YouTube's link blue #065FD4 / #3EA6FF [E]: the value of YouTube's
  `--yt-spec-call-to-action`; no comment with a mention was captured.
- **Emoji:** Noto images at 1.2 em, shifted −0.29 em (comment) and −0.25 em (Shorts). Measured on the 2× captures:
  31–32 px boxes as tokcomment's Noto glyphs, tops within 1 px (comment) and 2 px (Shorts).
- **Avatars (`SocialAvatar`):** the generated avatar takes its initials from `avatarNameFor(variant, params)`: the
  handle on YouTube (it does not show the display name), as the Properties preview. The default avatar is YouTube's `default-user` picture, the manifest image
  `SOCIAL_DEFAULT_AVATAR_IMAGES.youtube` (`youtube-default-avatar`), declared by the template's `requiredAssets` and
  read from `assets.imageUrls`; until it is delivered the card shows the neutral silhouette, the layer reports it and
  the planner blocks exports.
- **Paint rules:** the thumping like thumb carries `INK_RING`; no rounded `overflow: hidden` clip (the Shorts card's
  16 px corners are its background's own radius); the blur mark is `CommentText`'s text shadow.
- **Grow from tail:** neither card has a tail; both grow from the avatar corner (`0% 0%`).
- **Fit:** the handle truncates (comment) or ends in an ellipsis (Shorts); counts stay short (`formatCount`: "987B",
  "4.8M replies"), the actions and the time never shrink.
- **Evidence:** `/var/lib/orquester/workspaces/jaspersito/research/calibration/youtube/index.html` (outside the
  repo): every tokcomment capture side by side with our `renderStill` at 2× and a difference overlay, plus long
  names, huge counts, no replies, one reply, liked, no profile, mentions, generated avatar and entrance filmstrips.
- **Measured matches (2×):** comment card 297 × 840 px (tokcomment 299; the 0.5 px edge rows of a 149.5 px card fall
  outside the opaque crop), header, comment and action rows within 1 px, thread end within 2 px; Shorts card 609 × 175
  (610 × 176), header cap within 0 px, comment lines within 1 px.

- **Tests:** `packages/motion/test/social-comment.test.tsx` "YouTube cards" (header, badge, time, counts, replies and
  thread line rules, months stay months, 0 replies, huge counts, showProfile, default / raster / picture / generated
  avatars, link colours, Noto emoji, like tick, Shorts card); `mg-cue-timing.test.ts` rows (each entrance
  with both extras, the tick alone at 25 fps, the Shorts card with reveal and an ignored tick);
  `social-comment-template.test.ts` (presets, fonts, required images); `social-comment-layer.test.tsx` (layer path:
  Roboto faces, Noto emoji image, the default avatar image resolved or missing); `social-comment-render.e2e.test.ts` (parity and painted-bounds checks);
  `e2e/social-youtube.spec.ts` (`pnpm e2e`: gallery insert of both presets, the card in the Program in Roboto with the
  downloaded default avatar, in-place edit of the handle and a highlight, variant switch).
- **Render e2e results (`REMOTION_E2E=1`, Chrome 156, this host):** the YouTube parity cases (1:1 dark comment with
  grow-from-tail, word reveal, like tick and badge; 9:16 Shorts card with classic pop and word reveal) passed 4 of 4
  single runs and three full runs; the fit loop keeps both cards inside every canvas (1,400-character marked comment,
  1e12 counts, 64-character handles, 10,000 months). One framework case, the TikTok comment `comment-light-spring`,
  exceeded its 1/255 entrance tolerance (max 2/255, frame 12) in 2 of 9 runs on this branch and 0 of 4 at the
  integration base; it is independent of the render harness change (also seen with the base `entry.tsx`).
**Deliberate differences from tokcomment:**
- **Font:** Roboto, as tokcomment specifies but its capture host never loaded (Liberation Sans in the captures).
  Widths are within 1 % at the same sizes, so no size was scaled. The Shorts comment is 500 as specified; the capture
  fell back to a 400 face.
- **Glyphs:** YouTube's own instead of lucide / react-icons; the chevron points down.
- **The [M] values above,** and `@handle` instead of the bare "Username".
- **Default avatar:** YouTube's own instead of the hot-linked Twitter default. **Emoji:** Noto images.
- **tokcomment bugs fixed:** months printed as hours; raw counts ("1234567"); "View 0 replies" (0 hides the row and the
  thread line); huge counts overflowing.

### X card

WP6d (`sc/v-x`): `x-post` in `packages/motion/src/templates/social-comment/x.tsx` (`X_POST`). Font: Chirp 400/700
from the remote manifest (`SOCIAL_VARIANT_FONTS['x-post']`; the card draws no 500 or 800). Glyphs: `X_GLYPHS`. Emoji:
Apple (`emojiStyle: auto`). Preset "X · Post" (`social-comment:x-post`).

- **Blueprint [tok]:** `ref/x-post`, copied in CSS px. 420 wide, padding 10/16/8, radius 1, 1 px border black/white
  5 %, the comment row's `0 25px 50px -12px` shadow (same `bleed` as the TikTok comment), bg #FFF / #000. Avatar 52,
  gap 12. Header row 21 px high, gap 4, 2 px below: name 14/700, badge, `@handle` 14/400, a 2 px dot with 2 px margins,
  time 14/400, then (pushed right) the Grok mark and "More", 8 px apart. Post 16/20, 3 px above the action row. Action
  row 30 px high: icon, count 8 px after it; bookmark and share 12 px apart at the right.
- **x.com 2026 over tokcomment [M]** (`research/platform-measurements`, X):
  - name and post #000 / #FFF (tokcomment #0F0F0F, dark name #DADADA);
  - handle, time, dot, icons and counts rgba(0,0,0,.6) / rgba(255,255,255,.6) (`--x-fg-secondary`; tokcomment
    #737479 / #71767B / #767779);
  - counts 13 px / 400 with tabular figures (tokcomment 12.96 / 500);
  - Grok and More in the primary colour (dark: white; tokcomment's dark ellipsis #71767B);
  - mentions and hashtags #1D9BF0 in both themes;
  - **action bar: four equal columns** (x.com's `flex-1` engagement columns) for replies, reposts, likes and views,
    then bookmark and share. Each column clips its count, so no count can push bookmark and share out of the card
    (tokcomment's space-between row overflows with raw counts, `07_…_BUG-share-icon-overflows`). Icons keep their
    places whatever the counts; with tokcomment's default counts they sit up to 7 px from its space-between positions.
  - **a 0 count is not shown** (x.com shows the icon alone) [E: x.com behaviour; the measured post had no zero count].
- **`showReposts` / `showViews`** hide the count and keep the icon (the params' contract, "the icon stays"), so the
  columns never move.
- **Grok mark:** included. x.com puts the Grok "Explain this post" ghost button (`icon-logo-grok`) left of "More" for
  signed-in viewers when the post allows Grok analysis (bundle code; not rendered logged out [M]); the reference layout
  shows it, and a screenshot of a post is usually taken signed in. It is X's real mark (`X_GLYPHS.grok`), not
  tokcomment's imitation. There is no param to hide it (the schema is shared; not added in WP6d).
- **Verified badge:** X's blue badge with the cut-out tick (`X_GLYPHS.verifiedBlue`), 14 px = 1 em of the name as on
  x.com. Gold (organisations) and grey (government) exist in `X_GLYPHS` but `verified` is a boolean, so only blue is
  drawn; a colour choice would need a schema field (proposed, not added).
- **Sizes against the captures' ink (2×):** action icons 15 px (X's 24-unit glyphs: 24–26 px ink, as tokcomment's 14 px
  lucide icons with their strokes), Grok 15, More 15, badge 14 (24 px ink, same as tokcomment's).
- **Text:** Chirp keeps the captures' cap heights at tokcomment's sizes (2×: name "D" 20 vs 19 px, post "W" 22 vs 22 px),
  so no size was scaled. It sits about 1 px higher in its line box, so the header text moves 1 px down
  (`HEADER_SHIFT`). Chirp is ≈ 3 % wider than the captures' Liberation Sans (post line 622 vs 605 px), so a long
  post can wrap one word earlier.
- **Emoji:** Apple images at 1.2 em, shift −0.22 em: 34 × 34 px box against the capture's 34 × 32 glyph, top within 1 px.
- **Like tick:** the outline heart cross-fades to X's filled heart in #F91880 (`--x-magenta-500` [M-css]) and thumps;
  the count's colour moves from the secondary colour to #F91880 with the fill, as x.com colours a liked count. The count
  starts hidden (0) and appears as it ticks up.
- **Avatars:** a picture (`mediaUrls`), a generated one (initials from `displayName`, as the Properties preview), or
  X's default profile picture (`null`): the manifest image `REMOTE_IMAGE_IDS.xDefaultAvatar` from
  `assets.imageUrls` when the engine resolved it, else its vector twin (a #CCD6DD field, a #657786 head and shoulders,
  measured on the 400 px file sha256 6d34bedb…), so the card never shows a wrong platform's silhouette.
- **Fit:** the name and the handle truncate with an ellipsis; the badge, dot, time, Grok and More never shrink; counts
  stay short ("999.9B", "1,000B" at the 1e12 cap) and clip inside their columns.
- **Grow from tail:** no tail; the card grows from the avatar corner (`0% 0%`).
- **Inline editing (C5):** `displayName` (the name span), `handle` (a span inside `@…`, without the "@") and `text`
  (marks) carry `editableParamProps`.
- **Evidence:** `/var/lib/orquester/workspaces/jaspersito/research/calibration/x/index.html` (outside the repo): all 18
  tokcomment captures side by side with our `renderStill` at 2× and a difference overlay, plus generated avatar, huge
  and zero counts, hidden reposts / views, liked (light, dark), no profile, long names, mentions and entrance / extras
  filmstrips. The retained render suite accepts Chirp, emoji and remote-image directories for parity checks.
- **Measured matches (2×):** card 840 × 230 opaque px for the 840 × 232 capture (the half-covered edge rows fall
  outside the opaque crop); header, post and action rows within 1 px vertically; name width 183 vs 181 px; badge,
  time and More within 2 px horizontally.

**Deliberate differences from tokcomment:**
- **Font:** Chirp instead of the capture host's Liberation Sans (tokcomment asks for Roboto, which never loaded).
- **Glyphs:** X's own reply, repost, like / liked, views, bookmark, share, More, blue badge and Grok mark instead of
  lucide and a Grok imitation.
- **The [M] values above,** the equal-column action bar and hidden zero counts.
- **Emoji:** Apple images (x.com shows the viewer's OS emoji since 2026; tokcomment's capture host drew Noto).
- **tokcomment bugs fixed:** raw counts ("1234567" → "1.2M") and the share icon pushed out of the card.

### Verification

- **Commands run** (`--maxWorkers=2`):
  - `pnpm exec vitest run packages/mg-templates` (12 files): the schedule (entrance shapes, rest and exit values,
    reveal stagger and cap, tick, compression, no overlapping tweens by fast-check), text units (fast-check coverage),
    eases.
  - `packages/motion/test/mg-cue-timing.test.ts`: the land and exit cues sit within ±1 frame of the card rendered in
    Chrome (public component, measured with the documented cue rule) for every entrance × {none, word reveal, like
    tick, both}, every variant, at 6 rates, on short clips (1.5 s, 0.6 s), with sourceIn and a long marked comment:
    54 rows. (Before the merge of upstream's test cleanup the test compared the model with anime.js values; the
    rendered comparison found the model's nominal 20 px heart and 24 px word, and a heart fill on store cards that
    draw none, which put store-review lands up to 7 frames late; `SOCIAL_MOTION_METRICS` fixed it.)
  - `packages/motion/test/social-comment.test.tsx`: cards per variant × theme, header, counts and replies rules,
    showProfile, invalid params, entrance rest and exit, word reveal and like tick values per frame, seek-order
    independence (fast-check), avatars, glyphs, marks, mentions, emoji, emoji split, fit zoom.
  - `packages/compositions/test/social-comment-layer.test.tsx`: the real layer path through the render snapshot with
    the template assets resolved (`templateAssetOptions`). It checks the declared TikTok Sans faces, the emoji images
    from `emojiUrls`, the avatar from a project medium (`mediaUrls` → `TemplateImage`), the offline-avatar placeholder,
    the default avatar and the X card.
  - `apps/engine/test/anime-templates.test.ts`: a card style not built yet blocks the plan.
- **`REMOTION_E2E=1 packages/motion/test/social-comment-render.e2e.test.ts`** (Chrome 156):
  - `renderStill` equals `renderFrames` (concurrency 2) at 13 frames for 5 cases: every entrance, the extras, marks,
    emoji, a generated avatar, the X card. Byte for byte at rest; see "Paint determinism" for the entrance;
  - the painted card stays inside every canvas for a 1,400-character marked comment, 1e12 counts and a 64-character
    name;
- **`REMOTION_E2E=1 determinism-render.e2e.test.ts`:** passes with `social-comment@1` in the parity document (6/6).
  The parity scene now resolves the declared template assets: TikTok Sans as data URLs of the bundled files, and the
  emoji as a generated image.
- **`REMOTION_E2E=1 apps/engine/test/social-comment-bake.e2e.test.ts`:** the real template through the engine.
  - Setup: TikTok comment, drop & bounce, word reveal, like tick, highlight, blur and 😊.
  - Assets: TikTok Sans from the bundled catalogue (not a fallback); the emoji downloaded by the remote-asset service
    from a local fixture pack (`JASPER_REMOTE_MANIFEST`, never the real CDNs).
  - Result: the hybrid export (layer baked) and the full Remotion export agree within 3/255 on 99.7–100 % of the
    pixels at 7 frames. They draw the pack's image, and a still equals its export frame.

### Limits

- **Variants:** every variant has its card ("Instagram cards: calibration", "YouTube cards", "X card" above). See
  `docs/gaps.md` "social-comment".
- **Unverified:**
  - The reply sticker's mention colour [E].
  - TikTok's in-app sticker uses a variable TikTok Sans with optical sizes; the bundled static faces are the opsz-14
    cut, so display text is slightly looser than the app's.

## Placement & agent API

Design §7.9 ("insertion never overwrites") and §7.10 (agent UX). Generic: nothing here is specific to social
comments; every motion-graphic template (and the other generator clips) gets it.

### First-free placement (`@jasper/project`)

- `placement: 'overwrite' | 'first-free'` on the placement target of `clip.addText`, `clip.addSolid`,
  `clip.addMotionGraphic`, `clip.addComposition` and `clip.addShape` (`PlacementModeSchema`,
  `packages/project/src/commands/schemas/clip.ts`). Absent = `overwrite`, today's behaviour.
- `first-free` (`firstFreeTrack`, `packages/project/src/commands/placement.ts`): `track` is the lowest track tried.
  The clip goes on the lowest **unlocked** track of the same kind at or above it with no clip overlapping
  `[at, at + duration)` (a clip ending exactly at `at` does not overlap). When every such track is locked or busy, a
  new track of that kind is appended on top in the same transaction (one undo step). A label above the existing
  tracks (`"V5"` with three) adds the missing tracks, as an overwrite to that label does.
- Locked tracks are skipped, never refused. Wrong kind (`"A1"` for a graphic) → `E_TRACK_KIND`; an unknown track id →
  `E_NOT_FOUND`; the transaction is refused and nothing changes.
- Nothing else moves: the range is empty, so no clip is trimmed, split or shifted, markers stay, and sync-locked
  tracks are untouched (sync lock only matters for insert/ripple edits, which first-free never performs).
- Deterministic: tracks are tried in index order over the transaction's current draft, so commands later in the
  same transaction see the clips placed before them — a batch never collides with itself.
- Disabled clips and clips on tracks with output off still occupy their track. Hidden (output-off) tracks are not
  skipped (only locked ones are) — assumption: hiding a track is a view choice, locking is the "don't touch" one.
- Transitions are not considered separately: they live inside their clips' ranges.

### Template fill hook

- `MgTemplateDefinition.fill?(partial, seed)` (`packages/mg-templates/src/types.ts`), mirrored as
  `MgTemplateInfo.fill?` (`packages/project/src/registry/mg.ts`; the registry passes it through) →
  `{ok: true, params, filled} | {ok: false, error, issues?}` (`MgTemplateFillResult`). `seed` is a uint32.
- `clip.addMotionGraphic {fill: {seed}}` runs it on the given params; the given values always win over what it
  returns, then the template defaults are merged under and the params schema (and the template media-param checks:
  missing medium `E_NOT_FOUND`, wrong kind `E_INVALID_PARAM`) validates the result.
- Layering with presets: defaults → preset → fill → caller params, with one rule for every new instance —
  `mgInstanceParams(template, base, given)` (`packages/project/src/registry/mg-params.ts`): presets set the look, so
  the per-instance params the template re-randomizes (`ui.addAnother.reroll`: social-comment's identity and stats)
  never come from the preset; the caller gives them or the fill hook picks them. MCP `add_motion_graphic` sends
  `mgInstanceParams(entry, preset.params, params).params` as the given params; the bulk import (web dialog and MCP,
  `planMgImport`) starts every row from the same; `clip.duplicateMotionGraphic` applies it to the copied clip's
  params. The gallery / `mg.insert` never asks for a fill (humans get the preset as shown on its card, or the
  defaults). A refusal, a throw or a
  non-object result → `E_INVALID_PARAM` (the issues' messages joined into the message). Templates without a hook:
  defaults only, `filled: []`.
- The command result is `{clipId, sequenceId, trackId, track ("V3"), createdTrack?, start, duration, params,
  filled?, seed?}` with the fully resolved params, also in dry runs.

### MCP `add_motion_graphic` (`apps/mcp/src/tools/add-motion-graphic.ts`)

- One item (`template`, `params`, `at`, `duration`, `track`, `placement`) or `items: [...]` (1–200, zod), never both.
  All items are one transaction (one undo step, all or nothing).
- Default placement: first-free from `V2` (V1 usually holds the footage; for an empty `V2` range this is where the
  tool always put graphics). An explicit `track` keeps the old semantics — overwrite on exactly that track — unless
  `placement: "first-free"` (then the search starts there).
- Template references are parsed by the one `resolveTemplateRef` (`tools/templates.ts`, WP3a: `"id"`, `"id@v"`,
  `"id:preset"`, `"id@v:preset"`); bad references of all items (malformed `E_INVALID_PARAM`, unknown template or
  preset `E_NOT_FOUND`) are reported together (`details.items[]`) before anything is sent. Items with a preset
  report `preset` in the result.
- Seeds: the call's `seed` (default: random uint32, returned) is item 0's; item i uses its own `seed` or
  `(seed + i·0x9E3779B9) mod 2³²`. Same call + same seed = same params.
- Result per item: `index`, `clipId`, `template`, `sequenceId`, `track`, `trackId`, `createdTrack?`, `start`, `end`,
  `duration`, `startTimecode`, `endTimecode`, `params` (fully resolved), `filled`, `seed`.
- `dryRun: true`: the engine's dry-run transaction — same result, nothing stored (clip ids are placeholders).
  `preview: true` (needs `dryRun`, ≤ 10 items): one still per item through the `render_motion_graphic_preview` path
  (`templatePreview` in `tools/templates.ts`): anime templates at the middle of the hold of a one-clip document at the
  sequence's aspect fitted in 960×960 and its rate rounded to whole fps; fframes templates the native renderer's
  poster (its middle frame). A failed preview is reported on its item (`preview.error`), the dry run still succeeds.
- Errors are MCP error results; a refused transaction names the item (`items[1] (lower-third): …`) and
  `details.items[] = {index, template, code, message}`.
- HTTP (`/api/agent/tx`) and the CLI reach the same command: `jasper call add_motion_graphic template=… at=00:02`
  and `jasper call add_motion_graphic '{"items": [...]}'` were run against a dev engine (single item, a 3-item
  batch with a created track, a dry run with a preview PNG written by `--out`).

### Friendly times (`apps/mcp/src/arguments.ts`)

- `TimeArgSchema` = the command forms (`TimeInputSchema`: frames, `{frames}`, `{seconds}`, timecode) ∪ friendly
  strings, which parse to `{seconds}` so the command layer only ever sees its own forms. Every `timeArg` and the
  former direct `TimeInputSchema` arguments of the tools use it; `frameOf`, `edit-ux`'s resolver, still captures
  and the CLI's `--at` accept the same strings (`normalizeTimeArg`, `parseFriendlyTime`).
- Grammar, decided by shape (so `HH:MM:SS:FF` stays unambiguous): `<n>s` / `<n>ms` (decimal, no exponent, no
  leading dot), one `:` = `M:SS` (minutes 1–4 digits), two `:` = `H:MM:SS` (hours 1–3 digits, minutes and seconds
  00–59), three separators = timecode. Clocks take no fraction because `1:02:03.5` is timecode `H:MM:SS.FF`. A
  leading `-` is allowed as in timecode. Bare numeric strings (`"90"`) are refused — frames are numbers.
- Raw commands (`apply_commands`, `/api/agent/tx`) do not take the friendly strings: commands may be stored
  (proposals) and an older build must still read them.

### Tests

- `packages/project/test/first-free-placement.test.ts`: placement rules, locked tracks, created tracks, floor
  labels/ids, batches, refusals, overwrite unchanged, other generator kinds, a fast-check property (random clips,
  locks and batches: no overlap, existing clips untouched, invariants hold), the fill hook (determinism, given
  values win, failures).
- `packages/mg-templates/test/registry.test.ts`: the registry passes `fill` to the command layer.
- `apps/web/test/motion-templates.test.tsx`: stacked inserts, undo/redo through the session, targeted floor and
  locked tracks, an explicit track still overwrites.
- `apps/mcp/test/add-motion-graphic.test.ts`: single/batch, fill + seeds, all-or-nothing errors with item indexes,
  unknown templates, shape validation and the 200 cap, dry run, preview, friendly times, the advertised schema.
- `apps/mcp/test/time-args.test.ts`: fast-check — never throws, finite or null, round trips, timecode/friendly
  disjointness.
- `e2e/mg-insert-placement.spec.ts` (`pnpm e2e e2e/mg-insert-placement.spec.ts`): two gallery double-clicks at one
  playhead land on V1 and V2 in the built app; Ctrl+Z removes the second.

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
  old one (common prefix/suffix, never splitting a surrogate pair; in repeated text such as "aa|a", where several
  splits are valid, the caret after the edit picks the one the person made — found by the fuzz test); unchanged characters keep their marks; a typed
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
  `generatedAvatar(seed, avatarNameFor(variant, params))`; **Reshuffle** draws a new seed) and **Default** (`null`, the
  platform silhouette). `avatarNameFor` (`@jasper/mg-templates` social core, `variants.ts`, with `shownNameParam`) is
  the name the card shows first — TikTok and X the display name, Instagram and YouTube the handle — so the initials
  match the card's; the cards should take their generated-avatar name from it too (TikTok and X pass `displayName`
  today, which is the same). A value the control does not understand is shown as the default and replaced by the next pick.
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

## Add another & bulk import

WP7c (`sc/bulk`), design §7.9 ("Add another", "Bulk import") and §7.10. Generic over motion-graphic templates;
social comments are the main user.

### Template hints (`MgTemplateUi`, `@jasper/project` `registry/mg.ts`)

```ts
ui.addAnother?: { reroll: readonly string[] }      // params "Add another" re-randomizes through the fill hook
ui.import?: {
  aliases?: Record<string, string | { byParam: string; map: Record<string, string>; otherwise: string }>;
  ignored?: Record<string, string>;                 // column name → reason shown in the preview
  trimPrefix?: Record<string, string>;              // param → prefix removed from its cells ("@")
  age?: { value: string; unit: string; columns?: readonly string[] }; // "3h" in one cell → count + unit params
}
```

- `createMgRegistry` validates both: param names must exist; `addAnother` needs a `fill` hook; alias targets,
  `byParam`, `map` values and `trimPrefix` keys must be params; reasons non-empty. Both travel in the catalogue JSON
  (`@jasper/api` `MgTemplateUiSchema`) to MCP.
- `social-comment@1` sets `addAnother: SOCIAL_ADD_ANOTHER` and `import: SOCIAL_IMPORT_HINTS`
  (`packages/mg-templates/src/social/bulk.ts`).
  - **Re-randomized** (`SOCIAL_REROLL_PARAMS`): `displayName`, `handle`, `avatar`, `timeValue`, `timeUnit`, `likes`,
    `replies`, `reposts`, `views`. That is a different person and new stats.
  - **Kept** (`SOCIAL_KEEP_PARAMS`): `variant`, `theme`, `emojiStyle`, `showProfile`, `verified`, `showReposts`,
    `showViews`, `text`, `entrance`, `wordReveal`, `likeTick`.
  - **Choice:** the text is kept, not cleared. The user edits the new card's text in place, and an empty card would
    show the placeholder. `verified` is kept as a look toggle, as on tokcomment's panel.
  - **Aliases:**
    - `User` is the name the variant shows: `displayName` on TikTok and X, `handle` on Instagram and YouTube.
    - `Username` / `User name` is the handle where the card draws one; on TikTok it is the nickname.
    - Fixed aliases: `Name`, `Nickname`, `Author` → `displayName`; `Account` → `handle`; `Message`, `Body`,
      `Content`, `Comment text` → `text`; `Like count`, `Hearts` → `likes`; `Reply count` → `replies`; `Retweets` →
      `reposts`; `View count` → `views`; `Type` → `variant`; `Ago` → `timeValue`; `Time unit` → `timeUnit`;
      `Blue check`, `Badge` → `verified`.
    - **Age in one cell** (`age: {value: 'timeValue', unit: 'timeUnit', columns: ['Time', 'Age', 'Time ago',
      'Posted ago', 'When']}`): those columns, the `Posted` label and the `Ago` alias read "3h", "2 weeks", "10mo",
      "1y", "5 min", "3 hours ago", "an hour ago", "yesterday", "just now" (see "Age cells" below).
    - Param names and Properties labels (`Comment`, `Display Name`, `Style`, `Verified`…) match without aliases.
  - **Image columns** (`Image URL`, `Avatar URL`, `Profile picture`, `Photo`, …) are ignored with a visible reason:
    remote images are not imported in v1. No existing import path takes a URL. An `avatar` column takes JSON
    (`{"mediaId": "…"}` or `{"generated": 7}`).

### Add another — `clip.duplicateMotionGraphic {clipId, seed, at?, track?, params?, ref?}`

- **Copy:** the whole clip (transform, effects, masks, keyframes, name, label, canvas). Children get new ids; links
  and groups are not copied.
- **Placement:** the copy starts at `at` (default: the end of the source's chain, below) with the same duration. It
  goes on the first free unlocked video track from `track` (default: the source's track) up, or on a new top track.
  It never overwrites (`firstFreeTrack`).
- **Chain (sc/polish, App QA N2):** without `at`, the start is the source's end moved past every motion graphic of
  the same template that starts exactly there on the floor track or above, repeatedly (`chainEnd` in
  `handlers/mg-another.ts`). So Add another twice from the same clip (the clip menu targets the clicked clip, not the
  newest copy) puts the second copy after the first instead of at the same time on the track above, where it hid the
  first. A gap, another template or another clip kind ends the chain. Copies that went up a track still extend it, so
  the next copy can come back down to the source's track. MCP `count` copies chain through refs and give the same
  layout as `count` separate calls on the source.
- **Params:** the source's params minus `reroll`, then `params` on top. The fill hook fills the omitted ones from
  `seed`. A rerolled param the hook does not fill takes the template default.
- **Validation:** the params schema and the template media checks run on the result (`validateTemplateParams`).
- **Keyframes:** those of rerolled and given params are dropped (keys would override the new value). The others
  are kept.
- **Templates without the hint or a fill hook:** a plain copy after the clip.
- **Refusals:**
  - unknown clip: `E_NOT_FOUND`;
  - not a motion graphic, template not installed, params the schema rejects, a refused fill, start < 0:
    `E_INVALID_PARAM`;
  - an audio `track`: `E_TRACK_KIND`;
  - a seed outside uint32: `E_SCHEMA`.
- **Result:** `{clipId, sourceClipId, sequenceId, trackId, track, createdTrack?, start, duration, params, rerolled,
  seed}`. Refs chain copies in one transaction (`$a` → `$b`).
- **UI** (`apps/web/src/panels/motionTemplates/add-another.ts`, one transaction, label "Add Another"):
  - the UI command `mg.addAnother` (palette; agent-exposed with `{clipIds?, seed?}`);
  - the timeline clip menu of motion-graphic clips;
  - Properties ▸ Template;
  - the Motion Templates panel button;
  - Graphics ▸ Add Another.

  Several selected motion graphics each get one copy (seeds `mgItemSeed(seed, i)`). The copies are selected
  afterwards.
- **No shortcut:** the free chord Ctrl+Alt+D is Cmd+Opt+D on macOS, which toggles the Dock.

### Bulk import

**Parser** (`packages/project/src/bulk/table.ts`, `parseTable`, `detectDelimiter`, `formatTable`):
- RFC 4180 plus what spreadsheets write: quotes, `""`, CRLF / LF / CR, a BOM, line breaks inside quoted cells
  (normalised to LF), ragged rows, a quote inside an unquoted cell kept literally.
- Text after a closing quote is kept and reported. An unclosed quote takes the rest of the text and is reported on
  its line.
- Blank records are skipped.
- **Delimiter:**
  - tab when the first record has a tab outside quotes (pasted cells);
  - else `;` when it has more semicolons than commas;
  - else `,`.
- **Caps** (AGENTS §0):
  - 2 MiB of text (`TABLE_MAX_CHARS`; the dialog refuses larger files before reading them);
  - 500 data rows (more refuses the table and stops parsing early);
  - 64 columns (the rest are dropped, with an issue);
  - 10 000 characters per cell (cut; that row is then an error).
- **Speed:** 500 rows of 4 KB (≈ 2 MB) parse in well under a second (test).

**Planner** (`packages/project/src/bulk/mg-import.ts`): `planMgImport(table, template, {preset?, rate})`.
- **Column matching:** header names are compared ignoring case, spaces, `_ - . :` and a leading `@`/`#`, in this
  order:
  1. param name;
  2. Properties label (`ui.params[name].label`);
  3. template alias;
  4. timing columns: `start` / `at` / `start time` / `in` / `clip start`, and `duration` / `length` / `dur` /
     `clip duration`;
  5. template-ignored column;
  6. anything else: ignored, "Not a parameter of …".

  A second column for the same param is ignored. A direct column wins over an alias on a row (with a warning).
- **Cell coercion** follows the param's JSON Schema:
  - Numbers: `1,234`, `1.2K`, `3.5M`, `2B`; integers must be whole; min / max are checked.
  - Booleans: yes / no / true / false / 1 / 0 / y / n / on / off / ✓ / ✗ / sí.
  - Enums: case and punctuation ignored (`TikTok Comment` → `tiktok-comment`).
  - Strings: outer whitespace trimmed; length and pattern checked.
  - Object / array params: JSON.
- **Age cells** (`ui.import.age`, `parseAgeCell` in `packages/project/src/bulk/age.ts`; sc/polish, App QA N4 —
  tokcomment-style sheets have one "Time" column):
  - a count and a unit, any case, optional space, trailing "ago" and dot: `s/sec/second(s)`, `m/min(s)/minute(s)`,
    `h/hr(s)/hour(s)`, `d/day(s)`, `w/wk(s)/week(s)`, `mo/mos/mon/mth(s)/month(s)`, `y/yr(s)/year(s)`; "a" / "an" /
    "one" = 1; "yesterday", "last week / month / year"; "now", "just now", "moments ago" = count 0 (any unit, the
    row's unit column or the fill decides). "m" is minutes (TikTok's "5m"); months are "mo".
  - the count goes to `value` (its schema checks it: whole number, 0…9999 on social cards), the unit to the enum
    value of `unit` named like it (`hour` / `hours`); a unit the template does not offer (seconds on social cards)
    is a row error naming the units it offers.
  - a bare number is the count alone, so the separate `Ago` + `Time unit` columns still work; when the row also sets
    the unit param in its own column, that column wins and the row gets a warning.
  - English unit words only (they are what the platforms print); "1.5h", "3h 20m" and dates are not ages.
  - `createMgRegistry` checks both params exist and differ and the column names are non-empty; the catalogue JSON
    (`@jasper/api` `MgTemplateUiSchema`) carries the hint to MCP, so the dialog and `import_motion_graphics_csv` read
    the same cells the same way.
- **Empty cells** are "not given": the preset, then the fill hook, then the defaults decide. A row cannot set an
  empty text; the preview shows what the row gets.
- **Time cells** (frames at the sequence rate): `3` and `1.5` are seconds; also `3s`, `250ms`, `90f`, `M:SS`,
  `H:MM:SS` and timecode. Starts are capped at 100 h, lengths at 1 h; a length must be ≥ 1 frame.
- **Presets:** every row starts from the preset's params except the ones the template re-randomizes
  (`ui.addAnother.reroll`), through `mgInstanceParams` — the rule `add_motion_graphic` and Add another follow too.
  Rows are new instances: with the TikTok comment preset each row still gets its own identity and stats (the
  preset's are tokcomment's placeholders).
- **Messages** are codes with values (`MG_IMPORT_TEXT`, `mgImportText` for English). The web app translates the
  templates; `pnpm i18n` lists them in the model strings, with the template-ignored reasons.
- **Placement:** `scheduleMgImport` places included rows one after another from the start (a row's `start` resets
  the cursor). `mgImportCommand` builds `clip.addMotionGraphic {placement: 'first-free', fill: {seed:
  mgItemSeed(seed, rowIndex)}}`. The seed is per data row, so leaving a row out does not change the others.
- **Preview = insert:** `resolveMgTemplateParams(info, given, {seed, media})`
  (`packages/project/src/registry/mg-params.ts`) is the one resolution `clip.addMotionGraphic` uses too. The dialog
  shows exactly what will be stored and catches schema and fill errors per row.

**Dialog** (`BulkImportDialog.tsx` / `bulk-import.ts`, `mg.bulkImport`):
- **Entry points:**
  - File ▸ Import Motion Graphics from Spreadsheet…;
  - Graphics ▸ the same;
  - the Motion Templates panel button;
  - a gallery card's context menu ▸ Import Spreadsheet as This… (template + preset);
  - Properties ▸ Template ▸ Import Spreadsheet…;
  - the palette.
- **Inputs:** template / preset select (default: the given one, else the selected clip's, else the first with
  presets), delimiter (Detect / Tab / Comma / Semicolon), a paste area, and Choose CSV File….
- **Preview:**
  - column chips: param, timing, per-row alias, or ignored with its reason;
  - the table: row, start, length, and the imported and filled params in the template's order, with Properties
    labels;
  - values the template filled are dim, italic and titled "Random value";
  - rows with errors are shaded and list their errors ("Left out: …"); they are excluded, never blocking;
  - row warnings are listed under the table.
- **New Random Values** picks another seed.
- **Insert N:** one transaction labelled "Import N Motion Graphics" (one undo step) from the playhead at dialog
  open. The first-free floor is the targeted video track. The new clips are selected.
- Props are zod-validated and the body is inside a `PanelErrorBoundary`.

### Agents (MCP, `apps/mcp/src/tools/bulk-motion-graphics.ts`)

- **`duplicate_motion_graphic`** `{projectId, clipId, count? 1–50, seed?, at?, track?, params?, dryRun?,
  sequenceId?}`:
  - `count` chained `clip.duplicateMotionGraphic` commands in one transaction;
  - copy i uses `mgItemSeed(seed, i)`;
  - the result lists each copy's clip, track, times, resolved params, `rerolled` and seed.
- **`import_motion_graphics_csv`** `{projectId, csv, template ("id", "id:preset", …), delimiter?, startAt?
  (default 0: MCP has no playhead), track? (default V2), seed?, skipInvalid?, dryRun?, sequenceId?}`:
  - runs the same parser, planner and command builder against the engine catalogue entry;
  - row errors refuse the call with every bad row in `details.rows`, or are skipped (and listed in `skipped`) with
    `skipInvalid`;
  - MCP has no zod schemas or fill hooks (it does not depend on `@jasper/mg-templates`), so the JSON Schema checks run
    first and the engine's `clip.addMotionGraphic` — the same `resolveMgTemplateParams` checks the dialog previews
    with: zod refinements, the fill hook, template media that is not in the project — checks the rest. A command
    refusal of a row (`E_INVALID_PARAM`, or `E_NOT_FOUND` / `E_SCHEMA` on `params…`) is that row's error: the call
    runs one transaction on the happy path; after a refusal, dry runs of the rows after the refused one find the
    next (k refused rows: k + 1 runs, each shorter). Without `skipInvalid` the valid rows are only dry-run so every
    bad row — coercion and command refusals — is reported together and nothing is imported;
  - any other refusal (a locked track, a stale revision…) names its CSV row and line and imports nothing.
- `TEMPLATES_GUIDE` and the server instructions mention both tools.

### Tests

- `packages/project/test/bulk-table.test.ts`: parser rules, caps, a 2 MB timing. fast-check: no throw on arbitrary
  strings, `parse(format(records))` round trip for CSV / TSV / `;`, increasing record lines.
- `packages/project/test/bulk-age.test.ts`: age spellings, non-ages, fast-check (never throws; every spelling round
  trips), age columns in the plan (Time / Age / Ago / Posted / param name), the separate-columns form, unit column
  precedence, errors, broken hints ignored, fast-check planner on arbitrary age cells.
- `packages/project/test/mg-import.test.ts`: mapping, aliases per variant, coercion errors, times, preset reroll
  exclusion, schedule, preview = inserted params. fast-check: coercion and the planner never throw.
- `packages/project/test/mg-duplicate.test.ts`: placement, reroll / keep, determinism, copy fidelity, first-free and
  locked tracks, given params, keyframes, ref chains, refusals, dry run. fast-check: no overlap, invariants.
- `packages/mg-templates/test/social-bulk.test.ts`: registry validation of the hints, catalogue JSON, social alias
  mapping per variant, import and Add another through a social-shaped fixture
  (`test/fixtures/social-bulk-template.ts`), and the real `social-comment@1` hints.
- `apps/web/test/mg-add-another-bulk.test.tsx` (happy-dom):
  - `mg.addAnother`: undo / redo, labels;
  - clip menu, Properties, panel button, card context menu;
  - dialog: preview marks, left-out rows, insert as one undo step, preview = stored, reroll, CSV file, size cap,
    parse error, counter presets, read-only, hostile text.
- `apps/mcp/test/bulk-motion-graphics.test.ts`: both tools, refusals, `skipInvalid`, row mapping of a refused
  transaction, caps, advertised schemas.
- `e2e/mg-add-another-bulk.spec.ts` (`pnpm e2e`, built app, Chrome), with screenshots in
  `test-results/e2e-mg-add-another-bulk/`:
  - Add Another from the clip menu and the panel (counter);
  - bulk import of counter rows with a bad row;
  - the real `social-comment` TikTok comment preset: Add Another keeps look and text and changes the identity and
    likes (Program still checked by eye); a TSV with User / Comment / Likes / Verified / Image URL becomes 2 cards
    plus 1 left-out row; one undo removes them.

### Limitations

- Remote image URLs are not imported (the column is reported as ignored).
- XLSX is not read (design non-goal); the user copies cells or exports CSV.
- MCP checks rows before the transaction only against the JSON Schema; template-level refusals (e.g. a handle the
  fill rejects) fail the transaction at the first such row.
- Empty cells cannot express "empty string"; they mean "not given".
- Add another has no keyboard shortcut (see above).

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
  content, size cap) records its SHA-256 in the index. The SVG check (`svgHasActiveContent`, `fetcher.ts`) reads the
  markup with character references decoded (numeric with or without `;`, the named ones that spell schemes, twice
  for `&amp;#…`) and refuses script / foreignObject / handler / iframe / embed / object elements under any prefix,
  event-handler attributes (also `<svg/onload=…>`), `javascript:` / `vbscript:` with whitespace or control characters
  inside, `href` / `xlink:href` / `src` that are not `#id`, `url(…)` that is not `url(#id)`, `@import`,
  `<?xml-stylesheet` and `<!ENTITY`. Later downloads (cache deleted) must match, else
  `ASSET_HASH_MISMATCH` — a changed upstream needs a pack version bump in the override, which starts a new
  directory and a new bake key. `fe0f: try-both` tries the full sequence, then the one without U+FE0F (only a 404
  moves on).
- Limits: per-host concurrency 4, per attempt timeout 30 s (fonts) / 15 s (emoji), size caps 16 MB / 1 MB (declared
  `content-length` and while streaming), 2 retries with 300 ms doubling backoff for network errors, timeouts, 5xx,
  408 and 429 only. Concurrent requests for one file share one download. Prefetch runs ≤ 8 emoji at a time.
- Prefetch fetches at most `REMOTE_PREFETCH_MAX_EMOJI` (4,096, `@jasper/api`) different emoji per pack per call — a
  render's whole document (the planner calls the service directly) or the editor's check (the HTTP route's schema
  takes the same number). Unicode's fully-qualified emoji with every skin-tone and ZWJ form number ≈3,800 (basis:
  `emoji-test.txt` of Unicode 15.1–16.0), so a real project never reaches it; any emoji over it is reported missing
  by name (`PREFETCH_LIMIT`, not retryable), which blocks the export through `TEMPLATE_ASSETS_UNAVAILABLE`. Before,
  the 513th and later emoji of a pack were neither fetched nor reported.
- Errors are `{code, message, detail?, retryable}`: `REMOTE_ASSET_UNKNOWN` (404), `REMOTE_ASSETS_OFF` (409),
  `DOWNLOAD_NOT_FOUND` (404), `DOWNLOAD_FAILED` / `DOWNLOAD_TIMEOUT` (502 / 504, retryable), `DOWNLOAD_TOO_LARGE`,
  `PREFETCH_LIMIT` (a prefetch's emoji cap, above),
  `ASSET_HASH_MISMATCH`, `ASSET_BAD_CONTENT` (502), `ASSET_CACHE_WRITE` (500, retryable). Failures are never cached
  (`no-store`).
- `JASPER_REMOTE_MANIFEST=<file>` replaces the shipped base manifest (tests use an empty one so they never reach the
  real CDNs; an air-gapped install can point at its own mirror); a missing or invalid file gives an empty base and a
  log line. The override still applies on top.
- The manifest override is re-read when its size or mtime changes; an invalid or oversized (> 4 MB) override is
  ignored and reported (`GET /api/remote-assets` → `manifest.override`), never fatal.
- Every emoji and remote image file is served with `Content-Security-Policy: sandbox; default-src 'none';
  style-src 'unsafe-inline'; img-src data:` (`REMOTE_IMAGE_CSP`) and `X-Content-Type-Options: nosniff`, so an SVG
  opened from the engine origin can neither run scripts nor load anything, even one cached before the check above
  was hardened.
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

- The shipped manifest holds WP5's real Chirp, SF Pro and pack entries (see "Platform assets & sources") and the two
  remote default avatars (`images`: `x-default-avatar`, `youtube-default-avatar`, re-downloaded and hash-verified on
  2026-10-25; ids as `REMOTE_IMAGE_IDS` in `@jasper/mg-templates`, checked against `PLATFORM_DEFAULT_AVATARS` by
  `packages/motion/test/default-avatar-images.test.ts`). Tests use a local fixture server, never the network.
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

## Program monitor editing

WP7b `canvas-edit` (branch `sc/canvas-edit`), design §7.5 and §7.9 "Program monitor". A generic mechanism: any anime
template can let the user edit its text params in place on the Program monitor; the social-comment template is one
consumer. Composition clips keep their own editor (`mg-bundles/CanvasTextEditor.tsx`); this one is for anime templates.

### Template contract

- **Marking.** A template puts `data-template-param="<paramName>"` on the element that draws a string param, plus
  `data-template-marks="true"` when the value is word-marks markup (`==highlight==`, `||blur||`, `~~remove~~`,
  core § Word marks). Spread `editableParamProps(name, { marks? })` from `@jasper/motion/templates`
  (`packages/motion/src/templates/editable.ts`) instead of writing the attributes by hand.
- **Shared names.** The attribute names (`TEMPLATE_PARAM_ATTR`, `TEMPLATE_MARKS_ATTR`), the name schema
  (`templateParamNameSchema`: an identifier of at most 64 characters) and `readEditableParam(el)` live in
  `@jasper/mg-templates` (`packages/mg-templates/src/editable.ts`).
- **The element.** It must be a box that wraps exactly that text: block, inline-block or inline (an inline box is
  edited on one line), with no other param's text inside it.
- **Copies.** A param may be marked more than once (e.g. a name shown twice); the copy that was double-clicked is
  edited and every copy is hidden while the editor is open.
- **Other params.** A mark on a param that is not a string is ignored, and the double-click goes to other handlers.
- **Line breaks.** Multi-line editing follows `ui.params.<name>.multiline` (C3). No extra definition hint was needed:
  discovery is by the rendered DOM, so the proposed `ui.params[name].canvasEdit` was not added.
- **Shipped templates.** The anime templates mark their text with the helper (attributes only, pixels unchanged, no
  `renderVersion` bump): Title Reveal `title` / `subtitle`, Lower Third (Animated) `name` / `role`, Callout `label`,
  Counter `label`, and social-comment `displayName` (TikTok reply header and comment row) and `text` (with marks).

### Double-click → target

The Program's `TransformOverlay` passes a double-click to the `layerDoubleClickHandlers` registry. Additive changes
to that registry:

- the context now carries `scene`, `viewScale` and `surface`;
- a handler registered with `anyPoint: true` also runs where no unlocked layer is under the pointer (`clip: null`);
  the composition handler checks `clip` for null.

`template-text` (order 50, before the composition editor's 100) runs `pickTemplateParam` (`apps/web/src/template-edit/hit.ts`)
over the layers drawn at the playhead, from the top down:

- **Anime-template layers** are hit on their marked text boxes, with 4 screen px of slack; the innermost box wins.
  They block the layers below only on their painted boxes (backgrounds, pictures, SVG) and are transparent elsewhere.
  A layer that cannot be measured is transparent.
- **Any other layer** whose drawn geometry is under the point blocks everything below it (the same test as Program
  clicks, `hitsLayerGeometry`). Layers that are hidden (opacity 0) or have no Motion are skipped.
- **3D template layers** are not edited in place.
- **Which hit wins.** The topmost hit, except that a hit on a selected clip beats unselected ones, so a card under
  another card can be reached by selecting it in the Timeline.
- **Locked tracks.** When the topmost hit is on a locked track it is chosen whatever is selected, and refused with
  "The clip's track is locked". The first click of a double-click selects the unlocked layer under a locked one, so
  without this rule the hidden card below would have been edited.
- **Read-only projects** are refused with "The project is read-only".

Both refusals show the monitor's text bubble (`template-text-message`). On success the clip is selected and the editor
opens.

### Measuring the rendered text (`apps/web/src/template-edit/measure.ts`)

The Program draws templates as DOM in the Remotion Player, so the editor measures the browser's own layout. That
covers font metrics, wrapping, the design-stage fit, CSS `zoom` (social-comment scales its card with `zoom`) and the
template's own transforms.

1. **Layer box coordinates.** `templateLayerRoot` finds the clip's `LayerBox` root (`data-clip-id`, holding
   `data-mg-renderer="anime"`). Its transform (Motion, corner pin) is set to `none` for the measurement and restored
   in the same task, so nothing is painted in between. With the transform off, `getBoundingClientRect` differs from
   layer px by one uniform scale (Program zoom × Player scale), which is divided out.
2. **Element scale and font size.** A hidden 100 px × 1 em probe is appended inside the element and removed again. It
   gives the element's scale (layer px per element px) and its font size in its own px, whatever `zoom` does to the
   computed values. Other lengths (line height, letter and word spacing, padding) are converted through the
   computed-to-probe font-size ratio.
3. **Background.** The nearest opaque ancestor background inside the layer becomes the editor's background, so the
   editor sits on the card seamlessly.
4. **Limits.** At most 4000 elements per layer are inspected. A malformed attribute is ignored.

### Rest frame while editing

`setTemplateEditHold(clipId)` (`packages/compositions/src/layers/template-edit-hold.ts`, exported from
`@jasper/compositions`) makes `MotionGraphicLayer` draw that clip at `animeTemplateRestMs(timing)` in previews only:

- **The rest frame** is the last frame before the outro, or the end of the intro when intro and outro fill the clip.
- **Why that frame.** Every entrance tween and the extras that run after it (word reveal, like count-up) have settled
  there, and the exit has not begun.
- **Nothing else moves.** The playhead stays put and the other layers stay at the playhead.
- **Renders never see it** (`options.isPreview` only), so exports are unaffected.
- **Graded previews.** A held clip that has one (colour effects, layer bake) is drawn live while held, so its DOM can
  be measured.
- **The DOM attribute.** The layer's wrapper carries `data-template-hold="true"` while held. The editor measures two
  frames after it appears, once the template's layout effects (fit passes) have settled.

Seeking the playhead to the hold instead was rejected: it changes the user's frame and every other layer, and it
needs restoring afterwards.

### The editor (`apps/web/src/template-edit/TemplateTextEditor.tsx`)

**Placement.** It is a Program overlay (`template-text-editor`) with the same mapping chain as the layer: view →
layer CSS (`matrixToCss` / `mat3ToCss`) → the measured box → `scale(element scale)`. Rotation, scale, corner pin,
Program zoom and both 9:16 and 16:9 sequences follow. The editor copies the element's typography:

- font family, size, weight and style;
- line height, letter and word spacing, padding;
- alignment, transform, wrapping and direction;
- colour.

The original text is hidden by a scoped `<style>` while the editor is open.

**Keys.** The double-clicked word is selected, through the caret position under the pointer mapped into the rest
layout.

- **Enter** or a click elsewhere (blur) applies the edit.
- **Shift+Enter** inserts a line break when the param is multi-line. In a single-line param, line breaks typed or
  pasted become spaces.
- **Esc** cancels what was typed since the last applied step.
- **Ctrl/Cmd+Z** and **Ctrl/Cmd+Shift+Z** (or **Y**) first undo and redo typing inside the editor, then the History
  steps.

The keymap never sees these keys: editable targets consume them first.

**History.** Applying is one `param.set` on `['clip', id, 'params', name]`, labelled "Edit Text". The value is checked
against the template schema first, so an invalid value shows "Not valid for this template: …" and the editor stays
open with the text. A refused command keeps the editor open with the reason (`E_TRACK_LOCKED` → "The clip's track is
locked").

**Word marks.** Marks params are edited as their visible text, with the marks drawn as editor-only styled runs:
highlight is tinted, blur has a wavy underline and remove is struck through. Each input is mapped back onto the markup
with `replaceVisible` (`apps/web/src/social-comments/marks-edit.ts`, given the caret so repeated text is anchored at
the edit), so marks stay on their words:

- a character typed inside or at the end of a word takes that word's mark;
- whitespace joins a mark only between two words that carry the same mark;
- unchanged characters keep theirs.

That module is WP7a's marks editing model (§ Properties controls), shared by the Properties text control and this
editor.

**The marks toolbar.** A non-empty selection in a marks param shows a floating **Highlight / Blur / Remove / Clear**
toolbar above it. The buttons do not take focus, and the pressed state shows when every selected word already carries
that mark.

- Each button is `applyMark` (C4, whole words) over the draft and one History step: "Highlight Words", "Blur Words",
  "Remove Words" or "Clear Word Marks".
- Text typed since the last step goes into the same step.
- The editor stays open, re-measured on the new layout.
- The toolbar labels use catalogue keys with a `[word mark]` context, because "Highlight" and "Blur" already mean
  colour-grading terms in the Spanish catalogue.

Selecting words "in the rendered card when not editing" is done by the double-click itself: it opens the editor with
the clicked word selected, so the toolbar is one gesture away. A separate word-selection mode on the bare card would
have collided with the overlay's move and marquee gestures.

**Closing without losing text.**

- **Playback starts:** the text is applied first. If it is refused, playback stops and the editor stays open.
- **The playhead leaves the clip** (or another sequence opens): the editor stays where it was, applies and closes, or
  stays open with the reason.
- **The clip is deleted:** the editor closes, since there is nothing to apply to.
- **The document changes under the editor** (undo, an agent): the editor follows it while nothing is typed.

**Robustness.**

- An error boundary around the editor turns a render failure into a message, releases the hold and leaves the monitor
  untouched.
- A measurement failure becomes the message "This text is not drawn on the monitor here — edit it in Properties."
- The double-click handler treats a layer that fails to measure as transparent.
- IME composition is not interrupted: the DOM is rebuilt only after `compositionend`.

**i18n.** UI strings are in `en.json`; the Spanish is in `es.json`.

### Tests and checks

| What | Where |
|---|---|
| Hit-testing (topmost, painted boxes block, other layers block, selected wins, locked topmost, rotation and scale with slack, nested boxes, fast-check never throws) | `apps/web/test/template-canvas-edit.test.tsx` |
| DOM measurement (layer transform off and restored, probes removed, scale, font, background, malformed names) | same file |
| Editor: open on the clicked word, hold, hidden original, typing keeps marks, Enter → one "Edit Text" step and undo / redo, Esc, Shift+Enter, blur, single-line breaks → spaces, toolbar (four buttons, one step each, typing folded in, undo / redo from inside), local undo, schema refusal keeps the text, playback and leaving the clip apply | same file |
| Refusals: locked track (also with an unlocked card selected below), read-only, a double-click off every text, text not drawn after the hold, crash isolation | same file |
| Test-only template with a multi-line marks `text` and a single-line `name` | `apps/web/test/fixtures/canvas-edit-template.ts` |
| Rest time (table and fast-check); hold in previews only and only for the held clip; graded preview replaced by the live layer while held | `packages/compositions/test/template-edit-hold.test.tsx` (fixtures `hold-test-template.ts` / `hold-test-impl.tsx`) |
| Contract: `editableParamProps`, `readEditableParam` (fast-check); every shipped template marks its text params | `packages/motion/test/editable-params.test.tsx`, `packages/mg-templates/test/editable.test.ts` |
| Real Player in Chrome: mid-intro double-click opens on the rest layout, editor box within 3 px of the text, Enter and Esc, undo; rotated 12° and 140 % scale at 200 % zoom; topmost of two overlapping cards; locked track message; 9:16 sequence | `e2e/template-canvas-edit.spec.ts` (screenshots in `test-results/e2e-template-canvas-edit/`) |
| Real social-comment@1 from its gallery presets (9:16, mid-entrance): TikTok comment — text box within 2 px, Blur from the toolbar, typing and Shift+Enter keep the marks, Enter, the name, undo of both steps; TikTok reply — the name inside "Reply to …'s comment", Highlight, Esc | same spec |

### Limitations

- **Rotation inside a template.** A rotation in the template's own markup is measured as the bounding box of the
  rotated text. The shipped templates have none at rest; the layer's Motion rotation is exact.
- **Inline elements** are edited on one line, even when the template lets them wrap.
- **Emoji** that a template draws as pictures (social-comment) show as system emoji glyphs in the editor while typing.
- **Templates inside nested sequences**, and 3D template layers, are edited in Properties, not on the canvas.
- **Other Players** showing the same clip (the comparison view) also show the rest frame while the editor is open.
- **A graded (colour-effected) template** shows ungraded while it is being edited.

## App QA (sc/app-qa)

Hands-on QA of the built app (engine + web + Remotion bundle + MCP CLI from the branch, real CDNs, Chrome 156 under
Xvfb driven by Playwright) after the TikTok, Instagram, X and YouTube cards landed. Screenshots, frames, exports and
the findings index are outside the repository (third-party look-alikes): `research/app-qa/index.md`.

### Changed

- **Gallery assets.** The Motion Templates gallery passes `catalogAssetResolver` (the engine's font catalogue) to
  `MgTemplatePreview`, so posters and hover previews draw the declared fonts, emoji and images instead of
  "not available" markers. `useFontCatalog` is shared by the Program monitor and the gallery
  (`apps/web/src/remote-assets/font-catalog.ts`).
- **Enum labels.** `ui.params.<name>.options` (§ Presets & UI hints): Style shows the preset names, Theme
  Light / Dark, Emoji Platform / Apple / Twemoji / Noto, Entrance Classic pop / Soft spring / Grow from tail /
  Drop & bounce. Stored values (and what agents pass) are unchanged.
- **Transparent background export** (design §7.11): Export mode ▸ Format ProRes ▸ Background **Transparent (ProRes
  4444 with alpha, no audio)**, remembered per sequence, and the MCP preset `overlay-prores-4444-alpha`. Both send
  `video {codec: prores, proresProfile: '4444', alpha: true}`, `container: mov`, `videoOnly: true`; Auto routes it to
  the Remotion path. Before, only the engine API (interchange pre-renders) could ask for it.
- **CLI.** `jasper call … --out f.png` writes every image of a result (`f-0.png`, `f-1.png`…), so a dry-run batch
  keeps one preview per item.

### Measured

Export vs Program monitor at 100 % zoom (848×431 centre region, whole-pixel Player box, best alignment ±2 px; YouTube
comment and TikTok comment intro / hold / outro, overlapping cards, Shorts reply hold and outro; 9 frames):
- straight-alpha ProRes 4444 over black vs the Program with the footage disabled: SSIM 0.978–0.995, 94.6–99.0 % of
  pixels within 3/255;
- H.264 MP4 with the footage: SSIM 0.88–0.91 while the footage plays (the footage is decoded by the Player's
  `<video>` and by ffmpeg, then 4:2:0 encoded), 0.991–0.993 and ≥ 97.9 % within 3/255 once it ends.
The residue is glyph and icon edge anti-aliasing (headed vs headless Chrome); no layout, colour or timing difference
was found. A 2160×3840 sequence renders the card sharp at 4K; a 1080×1920 sequence exported at 2160×3840 is the
1080 render scaled up.

### Open findings (not changed here)

- A gallery drop onto an occupied timeline track overwrites the clip there (documented placement rule), which cuts
  footage when a comment is dropped on V1.
- Comments that overlap in time are drawn at the same centred place, so the top one hides the others. (Add Another
  twice from the same source stacking the second copy: fixed in sc/polish.)
- Fixed in sc/polish (§ Polish below): compound ages in one column, clip names, the X count spacing, small cards
  in the gallery thumbnails, the missing-font banner at the canvas corner.
- Remotion-path ProRes 4444: opaque pixels decode with alpha 1020/1023 (also for text clips; README § Export).

## Store reviews

WP6e (`sc/store-reviews`), design §11. Three more variants of `social-comment@1` (extended in place; the template is
unreleased): `play-store-review`, `app-store-review` (web / Mac card) and `app-store-review-ios` (iPhone App Store
"Ratings & Reviews"). Labels: **[ref]** the requester's screenshots (outside the repo:
`research/store-reviews-ref/`), **[M]** live measurements of play.google.com and apps.apple.com, **[M-archive]**
archived apps.apple.com pages (web.archive.org, 2021–2025), **[S]** a cited source, **[E]** estimate or choice.
Measurements, scripts and screenshots: `/var/lib/orquester/workspaces/jaspersito/research/platform-measurements/store-reviews/index.md`
(outside the repo; third-party screenshots are not committed).

### Core (`packages/mg-templates/src/social/`)

- **Variants and platforms:** `SOCIAL_VARIANTS` gains the three ids; `VARIANT_PLATFORM` maps them to the new
  platforms `play-store` and `app-store`; `SOCIAL_REVIEW_VARIANTS`, `isReviewVariant(v)`.
- **New params** (every one `.describe()`d with the variants that draw it):

  | Param | Schema | Default | Drawn by |
  |---|---|---|---|
  | `rating` | integer 1–5 | 4 | all three |
  | `date` | `z.iso.date()` + year 1970–2099 (a real calendar date; JSON Schema `format: "date"`) | `2025-09-24` | Play, App Store web |
  | `edited` | boolean | false | iPhone |
  | `iosAgeStyle` | `'weekday'` \| `'relative'` | `'weekday'` | iPhone |
  | `title` | single line, ≤ 120 characters, `''` hides it | `Review title` | App Store web, iPhone |
  | `truncate` | boolean | true (iPhone: false) | all three |

  The iPhone card shows `timeValue` / `timeUnit` as its age. Store cards draw `displayName` (the Google account name /
  App Store nickname, free text); Play also `avatar` / `showProfile`; the App Store cards have no avatar.
  `shownNameParam` / `avatarNameFor` give `displayName` for all three: the App Store "username" is a free-text
  nickname ("Laura buck", "Xyz123abc789!*" in the screenshots), which the `handle` schema refuses, so it lives in
  `displayName`; the Play avatar's initials come from `avatarNameFor`. Existing
  variants' capabilities are unchanged (tested). `likeTick` is offered on the store cards (it fills the stars).
- **Defaults:** neutral placeholders like tokcomment's ("Display Name", "Review title", "Write any review and see what
  happens 😊"), 4 stars as the Play screenshot, the iPhone age "1y ago" as its first card. The iPhone default is
  `truncate: false`: its screenshot is the "See All" list, which shows whole reviews.
- **Formats** (`review.ts`, `format.ts`; no `Intl`, no clock): `parseReviewDate`, `formatReviewDate('play-store' |
  'app-store', iso)` → Play `M/D/YY` ("11/6/18") [ref], App Store web `MM/DD/YYYY` ("09/24/2021") [ref]
  [M-archive: always numeric]. `formatTime` for App Store variants and `formatReviewAge(value, unit, edited)` give the
  iPhone age from the App Store frameworks' strings of iOS 15–26 [S: applelocalization.com `TIME_AGO_*` keys, raw
  responses saved with the measurements]: "Just now" (value 0, or minutes: there is no minutes string), "5h ago",
  "2d ago", "3w ago", "4mo ago", "1y ago"; edited: "edited 1y ago", "edited just now" (`TIME_AGO_EDITED_TIME`,
  `TIME_AGO_EDITED_JUST_NOW`). Values are printed in the unit given (no rollover) [E].
  **Weekday ages (default):** the requester's screenshot (iOS 14-era App Store) prints recent reviews as a weekday
  ("Sun") and old ones relatively ("edited 1y ago"); the iPhone card follows it: an age under 7 days
  (`reviewAgeDays`: minutes and hours 0, days, weeks × 7, months × 30, years × 365) prints the weekday of
  `SOCIAL_REVIEW_DATE_ANCHOR` (2026-10-25, a Sunday) minus the age (`weekdayBeforeAnchor`, `IOS_WEEKDAYS`: "Sun"…
  "Sat"), older ages the relative form. The exact iOS 14 thresholds are not documented [E: under a week, as the
  screenshot's "Sun" beside "1y ago"]. Because iOS 15–26 ship the relative strings above, the iPhone card has a
  setting, `iosAgeStyle: 'weekday' | 'relative'` ("Recent Dates" in Properties; default `weekday`), and
  `formatReviewAge(value, unit, edited, style)` implements both. Day arithmetic uses `Date.UTC`
  (`dayNumber`, `dateOfDayNumber`, `weekday`).
- **Plain text:** the stores do not link `@mentions` or `#hashtags`; `tokenizeComment` leaves them plain on store
  platforms. `formatRepliesLabel` is empty, `formatCount` comma-groups (no store card draws counts).
- **Emoji:** `auto` = Noto on Play (Android), Apple on the App Store (`PLATFORM_EMOJI_PACK`).
- **Randomizer** (`random.ts`; deterministic, separate review stream so the comment stats of a seed are unchanged):
  `randomRating(seed)` with `SOCIAL_RATING_WEIGHTS` 1★ 13 / 2★ 5 / 3★ 8 / 4★ 18 / 5★ 56 — the J-shaped distribution of
  online ratings [S: Hu, Pavlou & Zhang, CACM 52(10), 2009], high average like popular apps [E];
  `randomReviewDate(seed)` = `SOCIAL_REVIEW_DATE_ANCHOR` (2026-10-25, fixed: no wall clock) minus `⌊730·u²⌋` days
  (recent likelier; half within six months); `reviewAge(daysAgo)` → the iPhone units (hours on the day, days < 7,
  weeks < 30, months < 365, years); `randomReviewTitle(rating, seed)` from made-up short titles per star count.
  `randomStats` adds `rating` and `date` for every variant and gives store cards the age of their date.
  `fillSocialParams`: a given date sets the age and a given age the date (they agree), the title suits the rating.
- **Add another / bulk import / presets** (`bulk.ts`): `rating`, `date`, `title` and `edited` are in
  `SOCIAL_REROLL_PARAMS` (re-randomized: a new review; the fill draws `edited` for ≈ 12 % of reviews [E]);
  aliases `Stars`, `Star rating`, `Score` → rating; `Review title`, `Headline` → title; `Review date`, `Date posted`,
  `Posted on` → date; `Review`, `Review text` → text; `Was edited` → edited (`Rating`, `Title`, `Date`, `Edited`,
  `Truncate` match as param names). Date cells (generic, any param with `format: "date"`, `cellIsoDate` in
  `packages/project/src/bulk/mg-import.ts`): year first with `-`, `/` or `.` and an optional time
  ("2025/9/4 10:30" → `2025-09-04`); month-first and day-first forms are refused ("is not a date (year-month-day…)"),
  as they are ambiguous.

### Template (`social-comment.ts`, `packages/motion/src/templates/social-comment/store.tsx`)

- Ready variants, presets **Play Store · Review**, **App Store · Review**, **App Store · Review (iPhone app)**; fonts
  Roboto 400/500 (bundled) for Play [M: play.google.com renders all card text in Roboto; Google Sans only on the
  helpful buttons, which the card leaves out], SF Pro Text 400/600 (remote manifest) for the App Store cards.
  `requiredAssets` also declares the emoji of `title`.
- **UI hints:** Stats group `rating` (`social-rating`), `date` (`social-date`), `edited`; Text group `title`, `text`,
  `truncate` ("Truncate Long Text"); `avatar` / `showProfile` hidden on the App Store cards; `likeTick` relabelled
  "Likes Tick Up / Stars Fill" with a tooltip.
- **Stars and the extra.** `socialStarFill(rating, p)`: star *i* fills while `p · rating` runs from *i* to *i* + 1;
  the card draws the filled glyph over the empty one clipped to the fill (left to right, as the stores draw partial
  stars). The frame passes the tick progress as `anim.tick` (optional, additive field of `SocialCardAnim`; 1 at rest)
  and the thump as `anim.heart.s`, which pulses the row by a quarter of the heart's scale. The schedule and the
  motion model are unchanged; the model's `textAt` is `socialTickText` (the count, or "2.63/4 stars"), and the
  cue-timing test covers every entrance × both extras on the three cards plus a 1-star short clip and 59.94 fps.
  Animated stars carry `INK_RING`.
- **Clamp** (`ClampBox`): the text sits in a clip box of `lines × lineHeight`; a layout effect measures with layout
  boxes (`offset*`, unaffected by the entrance transform, word-reveal scales and the zoom; as fractions of the box)
  whether the text overflows and where the last visible line's words end; the result is applied before paint (≤ 3
  passes), so Player, still and export agree. Play: 3 lines, the last fading from 29.8 dp before its text end to 2.6 dp
  after it [ref, pixel profile]. App Store web: 4 lines, the archived mask (last line hidden under "more" for 32.8 px,
  fading in over 36 px) and "more" #0070C9 [M-archive]. iPhone: 5 lines, the current card's mask scaled to the 15 pt
  "more" (44 / 80 pt) and "more" in tint blue [M, scaled E].
- **Blueprints and units:**
  - Play [ref]: dp = screenshot px ÷ 3.525 (Roboto 14 sp name 500 / 14 sp body / 12 sp date fit its text widths at that
    scale; the card is a 411 dp phone minus 16 dp margins): card 380 wide, 1 px #E1E1E1 border, 4 dp radius, 16 dp
    padding, 32 dp avatar + 16 dp gap, kebab 21 dp, stars 11.63 × 11.06 dp ink on a 13.76 dp pitch, body line 22.27 dp.
    Glyphs: Play's star path and its Material Icons Extended `more_vert` [M]. Light colours from the screenshot
    (stars #479B5F / #BABABA, text #616161, name #212121); dark = Play's dark tokens (#202124, #E8EAED, #9AA0A6,
    stars #00A173 / #3C4043) [M-css].
  - App Store web [M-archive]: CSS px of the legacy `.we-customer-review`: 314 wide, #F8F8F8, radius 6, padding
    13/16/16, min-height 184, sprite stars 24 × 25 per star (stretched, filled #FF9500 / empty #BFBFBF), byline 12/16 600
    #636366, title 13/18 600 −0.005em #1D1D1F, body 13/18. Dark (the legacy site had none; the Mac App Store has one):
    current apps.apple.com dark tokens [M-css] and an estimated empty-star grey #5A5A5E [E].
  - iPhone [ref]: pt = screenshot px ÷ 0.769 (a 390 pt iPhone; SF Pro Text 15 pt fits its text widths): card 350
    wide, radius 8, padding 15.1/22/20, title 15/20 600, age and name 15 secondary, stars 13 pt on a 15 pt pitch,
    body 15/20. Stars are the current apps.apple.com filled / outline glyphs (the same layout) [M]. Colours: iOS
    system colours (systemGray6 card, label, secondaryLabel, systemOrange, tint) [E: the screenshot is too small to
    read colours].
- **Glyph provenance:** `PLAY_STORE_GLYPHS` (`star`, `more`), `APP_STORE_GLYPHS` (`star`, `starOutline`,
  `legacyStar`, `legacyStarEmpty`) in `glyphs.ts`; new origin `archived` for the legacy sprite; rows in
  `licenses/platform-assets.md`. `PLATFORM_DEFAULT_AVATARS` for both stores is `none` (Play: the grey silhouette).

### Controls (`apps/web/src/social-comments/`)

- `social-rating` (`SocialRatingControl.tsx`): five stars over visually hidden native radio inputs in a `fieldset`
  (legend "Rating", one name); click or arrows / Home / End / digits 1–5; each pick one History entry (arrow presses
  coalesce); hover preview; read-only disables; a refused write says so; mixed ratings show "–".
- `social-date` (`SocialDateControl.tsx`): native date input (min 1970-01-01, max 2099-12-31) writing only real dates
  (typing coalesces into one entry; an incomplete date on blur shows an error; Esc restores), the store's printed form
  next to it, and a wand (`randomReviewDate`).
- Both bring the **Randomize Stats** wand to the Stats group; `statsPatch` now also writes `rating` and `date` where the
  variant draws them (iPhone: rating and the age).
- Icon `rating.star` (lucide Star, filled with `fill-current`).

### Agents

`TEMPLATES_GUIDE` has a store-review paragraph with an example; the import paragraph lists the store columns. The
three presets reach MCP through the catalogue. `@jasper/mg-templates` became a test-only dependency of `apps/mcp`
(`scripts/check-layers.mjs` `testDeps`) so `apps/mcp/test/social-review.test.ts` drives the tools against the real
catalogue entry.

### Calibration

Side-by-side page: `/var/lib/orquester/workspaces/jaspersito/research/calibration/store-reviews/index.html` (screenshot
crop | renderStill at the screenshot's scale | difference; every variant × theme, long reviews, marks, long names;
star-fill frames).
Measured: Play name, stars, date, body lines and kebab within 1–2 screenshot px (≈ 0.5 dp) and the same line breaks and
fade; App Store web rows within 1 CSS px, same wrapping, mask and "more"; iPhone title, stars, name and body rows
within 1 pt, same line breaks.

**Deliberate differences:**
- iPhone ages: the screenshot's weekday rule by default; `iosAgeStyle: 'relative'` gives today's iOS ("2d ago").
- Play: the helpful footer is left out (requested); the avatar default is the neutral silhouette; dark theme from
  today's Play web tokens (the 2018 app had none). Live Play web differs from the screenshot (no card chrome, 12 px
  stars, long dates, no clamp) — the screenshot is the blueprint.
- App Store web: SF Pro Text v16 from the manifest instead of the archived web v2 files (≈ 1.5 % wider); dark theme
  added (Mac App Store).
- Emoji are images of the clip's pack (Noto on Play, Apple on the App Store).

### Tests

`packages/mg-templates/test/social-review.test.ts` (dates incl. leap years and fast-check round trips, store formats,
ratings distribution, randomizer and fill consistency, plain text, star fill fast-check, bulk aliases and date
cells, Add another on a review), `social-params.test.ts` (capabilities, defaults, schema caps, date validity
property), `social-comment-template.test.ts` (presets), `packages/motion/test/social-review.test.tsx` (cards, glyphs,
colours, ages, star fill per frame, pulse, seek-order fast-check, clamp with stubbed layout), `social-glyphs.test.ts`
(new sets and provenance rows), `mg-cue-timing.test.ts` (store rows), `packages/motion/test/social-review-render.e2e.test.ts`
(`REMOTION_E2E=1`: renderStill = renderFrames during entrance, word reveal and star fill on the three cards; clamp
on / off; fit on every canvas with 64-character names, 120-character titles and long reviews),
`apps/web/test/social-review-controls.test.tsx` (rows per variant, stars and date with undo / redo, keyboard,
multi-selection, wand, Randomize Stats, Effect Controls, read-only, garbage values, refusals),
`apps/mcp/test/social-review.test.ts`, `e2e/social-store-reviews.spec.ts` (built app: gallery insert of the three
presets, Roboto / SF Pro cards, stars and date edited in Properties with undo, App Store title edited on the Program,
"more" on a long review, edited age, stars mid-fill; screenshots in `test-results/e2e-social-store-reviews/`).

### Limits

- The iPhone card's thresholds between units (weekday under a week, then weeks, months, years) are not documented
  by Apple [E]; ages print in the unit given, and weekdays count back from the fixed anchor date.
- The iPhone card geometry comes from a low-resolution marketing screenshot (0.77 px/pt): ±1 pt.
- App Store web and Play dark themes are derived, not captured (neither screenshot nor the legacy site has one).
- Bulk-import dates must be year first.
## Polish (sc/polish)

Fixes of the App QA findings above (`research/app-qa/index.md` N2, N4–N8). Screenshots of the running app are
outside the repository (`research/polish/`).

### Add another builds a sequence (N2)

See § Add another & bulk import ▸ Chain: without `at`, a copy goes after the last consecutive copy of the source's
chain, so the clip menu's Add Another on the same clip twice gives three cards one after another on one track.

### Ages in one cell (N4)

See § Bulk import ▸ Age cells (`ui.import.age`, `parseAgeCell`).

### Clip names (N5)

- Templates may name their clips from the content: `clipName?(params)` on the template definition
  (`@jasper/mg-templates` `types.ts`) and on `MgTemplateInfo` (`@jasper/project`). `mgClipName(info, params)`
  (`registry/mg-params.ts`) calls it without letting it throw, collapses whitespace and control characters, cuts
  to 80 characters with "…" and falls back to the template name.
- `social-comment@1`: `socialClipName` (`packages/mg-templates/src/social/clip-name.ts`) = `VARIANT_LABELS[variant]
  · <the name the card shows>` (`shownNameParam`: display name on TikTok and X, `@handle` on Instagram and YouTube;
  32 characters at most), e.g. "X post · Luna Park", "Instagram post comment · @luna.makes"; the label alone when
  the name is empty.
- Applied by `clip.addMotionGraphic` (gallery insert and drop, `add_motion_graphic`, bulk import rows; an explicit
  `name` wins) and `clip.duplicateMotionGraphic` (Add another: the copy is named after its new identity).
- **Follows the content while automatic.** A clip whose name is automatic — the template name (clips made before
  content names) or `mgClipName` of its current params (`isMgAutoClipName`) — is renamed by a `clip.update` that
  changes its params (Properties, the Program text editor, `set_motion_graphic_params`), and Add another names its
  copy anew. A name the user typed is never replaced (a patch that sets `name` and `params` keeps the given name).
  Why: names are what the asset chip and the export blockers list; a name left at "X post · Display Name" after the
  user typed the real name would identify the wrong card. Keyframed params do not rename (the static value counts).

### X action bar spacing (N6)

- The four engagement columns still share the bar equally (x.com's `flex-1`), but each has a minimum width
  (`xActionLayout` in `x.tsx`): icon 15 + icon → count 8 + the count + `X_COUNT_GAP` (6 px) before the next icon.
  The count's width is bounded by `xCountEm`: digits 0.64em, punctuation 0.32em, K/B0.70em and M0.88em.
  These conservative bounds include Chirp and the DejaVu Sans generic fallback.
- The bar is 280 px with the avatar (420 − 2 border − 32 padding − 64 avatar column − 42 bookmark / share). One
  six-character count ("321.3K", "999.9M") in any column keeps x.com's 13 px counts and 8 px inset; when all four are
  long the inset tightens to 4 px, then the counts shrink uniformly (≥ 10 px).
- The likes column is sized for the widest count its tick passes ("999.9M" on the way to "1,000B"), so the bar does
  not move while the count ticks; every frame stays a pure function of params and time.
- Tests: `packages/motion/test/social-x-fit.test.tsx` measures the laid-out card in Chrome (when a Chrome is found):
  longest counts per column, all four at once and the reported QA card, every count unclipped and ≥ 6 px before
  the next icon (0.5 px measurement tolerance), with the fallback face and
  with Chirp when `SOCIAL_CHIRP_DIR` holds its Regular woff2. The test fails on the previous layout (3.9 px
  between "999.9M" replies and the repost icon in the fallback face).

The real-browser regression also caught an underestimated generic fallback advance. Chromium 156.0.8078.47 on
Linux selected DejaVu Sans: digits 0.636234375em, punctuation 0.317875em and B 0.686046875em (100px samples,
tabular numerals; CDP confirmed the font). With 999.9B replies the old bounds left 5.346073px before the repost icon;
the corrected bounds leave 6.462882px, with no clipping. The existing ≥6px contract and 0.5px measurement tolerance
are unchanged. A real paused Player and Remotion still at frame 100 were pixel-identical before and after the fix;
inspected frames and action-bar crops are under ignored `test-results/test-audit/x-count-gap/`.

`social-comment.renderVersion` is 2 so cached layer bakes do not reuse the older drawing. The bake key includes this
version and the Remotion bundle id; the bundle source hash also includes motion/template sources
(`apps/engine/src/layer-bake/key.ts`, `apps/engine/src/remotion/service.ts`). No stored project data changes.

### Gallery previews frame the card (N7)

- Generic template hint `ui.preview: {canvas: {width, height}}` (`MgTemplateUi`, validated by `createMgRegistry`:
  whole pixels 1…8192; carried in the catalogue JSON). `MgTemplatePreview` (`@jasper/compositions`, the poster
  `<Thumbnail>` and the hover `<Player>` of the Motion Templates panel) draws the template on that canvas and scales
  it to cover the 16:9 thumbnail, centred (`mgPreviewFraming`); the overflow is clipped.
- `social-comment@1`: `preview: {canvas: {width: 1080, height: 1920}}`, the 9:16 canvas the cards are designed for:
  the card spans about 80 % of the thumbnail width instead of about 35 %, at the same layout as in a 9:16 project.
- Only previews read the hint: clips, the Program monitor and exports draw on the clip's canvas as before.
- Limitation: the 16:9 crop of a 9:16 canvas shows its middle 32 %; a preset whose card were taller than that would
  be cut at the top and bottom of the thumbnail (no preset is).

### Missing-asset banners on the card (N8)

- The striped "Font … is not available" / "Image … is not available" banners of a template (Program monitor and
  other previews; renders never draw them) are anchored inside the top-left corner of what the template drew,
  not the canvas corner: `templateContentBox(host, skip)` (`@jasper/compositions`, `MotionGraphicLayer.tsx`) takes
  the union of the outermost elements smaller than the layer (full-size wrappers — the template's `AbsoluteFill`,
  the social stage — are looked through), in the layer's unscaled px. Measured in a layout effect after every
  render, so the banners follow an animated card; the state only changes when the box moves.
- Banner text size: `min(canvas height / 40, card width / 40)` (≥ 10 px) on a card; `canvas height / 40` at the
  canvas corner when there is no layout or no smaller element (a template that fills the canvas).
- Generic: no template contract change; any card-like template gets it.
- So at Program zoom ≥ 100 % the banner is where the card is (before: off screen at the canvas corner).
- Tests: `packages/compositions/test/template-marker-anchor.test.tsx` (box measurement with scale, no-layout
  fallback); `packages/compositions/test/fx-gl.test.ts` renders the gallery card in Chromium and verifies its
  width relative to the poster and that the warning’s bounds stay inside the visible card.

