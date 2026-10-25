# Social-comment templates

Design: `docs/superpowers/specs/2026-10-25-social-comment-templates-design.md`.

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
