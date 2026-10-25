# Social-comment templates — work notes

Design: `docs/superpowers/specs/2026-10-25-social-comment-templates-design.md`. Each work package adds its own
section below.

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
