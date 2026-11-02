# Platform assets of the social-comment templates

The social-comment templates replicate TikTok, Instagram, YouTube and X comment UIs and Google Play / App Store
review cards. They use those platforms'
own icons, badges, logos, fonts and emoji artwork under the platform-template exception of
AGENTS.md §3 item 1 ("Templates that replicate a platform's UI may use that platform's names,
logos, icons and fonts"). This record gives the provenance of every such asset.

- **Licence of every platform glyph below:** proprietary; used under AGENTS.md §3 item 1 platform-template
  exception. The marks belong to their owners: TikTok (ByteDance Ltd.), Instagram (Meta Platforms, Inc.),
  YouTube and Google Play (Google LLC), X and Grok (X Corp. / xAI), App Store (Apple Inc.). JasperEditor is not affiliated with or endorsed by them.
- **Committed:** only vector path data, in `packages/motion/src/templates/social/glyphs.ts` (export names below).
- **Not committed:** fonts, emoji images and raster avatars. The app downloads them at runtime from the URLs in
  `apps/engine/src/remote-assets/manifest.json` (sha256-pinned where the file is fixed) and never redistributes them.
- **Capture:** 2026-10-25, logged out, public pages only, desktop Chrome 141 user agent, en-US. Method per glyph:
  `live-dom` = inline SVG the page rendered; `live-bundle` = icon component in the page's own JavaScript bundle (a
  state a logged-out page does not render); `live-cdn` = the platform's icon CDN file, identical to the rendered
  path; `archived` = the platform's own asset file from an archived copy of its page on web.archive.org (a design the
  live site no longer serves); `derived` = transformed from a live glyph.
- **Fallbacks:** none. No tokcomment or lucide stand-in is used; every glyph comes from the platform itself.

## TikTok — `TIKTOK_GLYPHS`, `TIKTOK_DEFAULT_AVATAR`

Page: https://www.tiktok.com/@ianthioo/video/7697839909842767111 (comments panel). Bundle: TikTok web
`cache.tux.1abe1f5f.js` (TikTok's "tux" design-system icons), loaded by that page.

| Export | Source | Method |
|---|---|---|
| `heartOutline` | comment-row like button, rendered | live-dom |
| `heartFilled` | tux heart icon, filled contour of `heartOutline` | live-bundle |
| `dislike` | tux thumbs-up (`live-bundle`) rotated 180° about (24, 24); the comment dislike exists only in the app | derived |
| `verified` | `Icon_Color-Verified_Badge` after a commenter's name | live-dom |
| `more` | comment ellipsis | live-dom |
| `chevronDown` | "View N replies" chevron | live-dom |
| `creatorLiked` | `Icon_Color-Like_Circle` on the creator's mini avatar ("liked by creator") | live-dom |
| `TIKTOK_DEFAULT_AVATAR` | `Icon_Color-Default_Avatar` | live-bundle |

## Instagram — `INSTAGRAM_GLYPHS`

Page: https://www.instagram.com/p/BsOGulcndj-/ (public post with comments). Bundle modules of that page:
`IGDSHeartPanoOutlineIcon.react`, `IGDSHeartPanoFilledIcon.react`, `IGDSVerifiedIcon.react`.

| Export | Source | Method |
|---|---|---|
| `heartOutline` | `IGDSHeartPanoOutlineIcon` (the path the post's "Like" button renders) | live-dom |
| `heartFilled` | `IGDSHeartPanoFilledIcon` (liked state) | live-bundle |
| `verified` | "Verified" badge after a username, fill rgb(0, 149, 246) | live-dom |
| `more` | "More options" (three circles, converted to path arcs) | live-dom |

Default avatar: none. Instagram serves its anonymous avatar only through signed, expiring fbcdn URLs
(`PLATFORM_DEFAULT_AVATARS.instagram` is `kind: 'none'`).

## YouTube — `YOUTUBE_GLYPHS`

Pages: https://www.youtube.com/watch?v=dQw4w9WgXcQ and https://www.youtube.com/watch?v=RE3_PGwDwhw (comments,
pinned comment, creator heart). Icon CDN: `https://fonts.gstatic.com/s/i/<set>/<name>/v<n>/<size>px.svg`.

| Export | Source | Method |
|---|---|---|
| `thumbUp` | comment like button; = `youtube_outline_experimental/thumb_up/v24/18px.svg` | live-dom |
| `thumbUpFilled` | `youtube_fill_experimental/thumb_up/v24/18px.svg` | live-cdn |
| `thumbDown` | comment dislike button; = `youtube_outline_experimental/thumb_down/v25/18px.svg` | live-dom |
| `thumbDownFilled` | `youtube_fill_experimental/thumb_down/v25/18px.svg` | live-cdn |
| `reply` | `youtube_outline_experimental/text_bubble/v4/24px.svg` | live-cdn |
| `replyFilled` | `youtube_fill_experimental/text_bubble/v4/24px.svg` | live-cdn |
| `verified` | author badge check; = `youtube_fill_experimental/check_circle/v10/24px.svg` | live-dom |
| `more` | comment action menu; = `youtube_outline_experimental/overflow_vertical/v13/24px.svg` | live-dom |
| `chevronDown` | "N replies" chevron; = `youtube_outline_experimental/chevron_down/v9/24px.svg` | live-dom |
| `creatorHeart` | creator heart, red heart; = `youtube_fill_experimental/heart/v19/24px.svg` | live-dom |
| `creatorHeartBorder` | creator heart, white border; = `youtube_outline_experimental/heart/v19/24px.svg` | live-dom |
| `pin` | "Pinned by @…" icon; = `youtube_outline_experimental/pin/v7/24px.svg` | live-dom |

Default avatar (raster, not committed): `https://yt3.ggpht.com/a/default-user=s240-c-k-c0x00ffffff-no-rj`
(JPEG 240×240, sha256 `9929d44d4db47289e3be5904d05a3bcbd9d6af581b04d6e6f272f7f7317adca4`).

## X — `X_GLYPHS`

Pages: https://x.com/NASA/status/2113776971603689874 and https://x.com/NASA. The rendered action-bar and badge
icons are `<symbol>`s of the page's inline sprite (`icon-*` ids below). Bundles: `icon-heart-QK04GNvN.js` (filled
heart), `startup-DfleHLPI.js` (`icon-logo-grok`); the Grok header button is the `grok_analysis_button` branch of
`retweet-AyOi75d_.js` ("Explain this post", left of "More", shown when the post enables Grok analysis for a
signed-in viewer).

| Export | Source | Method |
|---|---|---|
| `reply` | `icon-reply-stroke` | live-dom |
| `repost` | `icon-retweet-stroke` | live-dom |
| `like` | `icon-heart-stroke` | live-dom |
| `likeFilled` | `icon-heart` (filled; liked state) | live-bundle |
| `views` | `icon-bar-chart` | live-dom |
| `bookmark` | `icon-bookmark-stroke` | live-dom |
| `share` | `icon-outgoing` | live-dom |
| `more` | `icon-more` | live-dom |
| `verifiedBlue` | `icon-verified-premium-color` | live-dom |
| `verifiedGold` | `icon-verified-business-color` (two linear gradients) | live-dom |
| `verifiedGrey` | `icon-verified-government-color` | live-dom |
| `grok` | `icon-logo-grok` | live-bundle |

Default avatar (raster, not committed):
`https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png` (PNG 400×400, sha256
`6d34bedb72ec3f2dc15085747d365fbb3f34319d5b549a8776438b92853344b6`).

## Google Play — `PLAY_STORE_GLYPHS`

Page: https://play.google.com/store/apps/details?id=com.spotify.music&hl=en_US&gl=US (review cards, captured
2026-10-25, logged out). Icon font: Material Icons Extended v154,
`https://fonts.gstatic.com/s/materialiconsextended/v154/kJEjBvgX7BgnkSrUwT8UnLVc38YydejYY-oE_LvJ.woff2` (sha256
`7f80c4c91054b3d6c80721939242c2d4f68f15e41f251e12641f695d78eb2f35`), loaded by that page.

| Export | Source | Method |
|---|---|---|
| `star` | review rating star, inline SVG (filled and empty stars share the path) | live-dom |
| `more` | "More review actions" button: the `more_vert` ligature glyph outline of the icon font above, scaled from 512 font units to 24 | live-cdn |

Default avatar: none (`PLATFORM_DEFAULT_AVATARS['play-store']` is `kind: 'none'`): Play shows each reviewer's
Google account picture; there is no single public default image.

## App Store — `APP_STORE_GLYPHS`

Pages: https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580 and its `?see-all=reviews` view
(current review cards, captured 2026-10-25). Legacy design (2019–2025 web review card, the requester's reference):
the star sprite `https://apps.apple.com/assets/images/stars-lg-bc4f4bfdd931e007ab096dd1c209c689.svg` as archived at
https://web.archive.org/web/20210107152751id_/https://apps.apple.com/assets/images/stars-lg-bc4f4bfdd931e007ab096dd1c209c689.svg
(sha256 of the gunzipped file `03b3a7317370504145583eb221372d6c19c060f84f10cf391459e7441e95c381`), loaded by the
archived page https://web.archive.org/web/20210107151857if_/https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580.

| Export | Source | Method |
|---|---|---|
| `star` | review card rating star, filled | live-dom |
| `starOutline` | review card rating star, empty (outline contour), see-all view | live-dom |
| `legacyStar` | top half of the legacy `stars-lg` sprite (filled, #FF9500) | archived |
| `legacyStarEmpty` | bottom half of the same sprite (empty, #BFBFBF); its `translate(0 -.15)` and the 14-unit offset folded into the path coordinates | archived |

App Store review cards show no avatar (`PLATFORM_DEFAULT_AVATARS['app-store']` is `kind: 'none'`).

## Fonts downloaded at runtime (`manifest.json` → `fonts`)

| Ids | Family | Source | Licence |
|---|---|---|---|
| `chirp-400`, `chirp-500`, `chirp-700`, `chirp-800` | Chirp | `https://abs.twimg.com/fonts/subset/Chirp-{Regular,Medium,Bold,Heavy}.<hash>.latin.woff2`, the files x.com's stylesheet loads (latin subset) | proprietary (Grilli Type for X Corp.); not redistributed |
| `sf-pro-text-{400,600,700}`, `sf-pro-display-{400,600,700}` | SF Pro Text / SF Pro Display | https://github.com/sahibjotsaggu/San-Francisco-Pro-Fonts at commit `8bfea09aa6f1139479f80358b2e1e5c6dc991a58` via jsDelivr (Apple's developer.apple.com/fonts files, version 16.0d18e1) | proprietary (Apple Inc.; licensed for Apple-platform UI mock-ups); not redistributed |

TikTok Sans (OFL-1.1) and Roboto (OFL-1.1/Apache-2.0) are bundled through the font catalog and are not listed here.

## Emoji packs downloaded at runtime (`manifest.json` → `emojiPacks`)

| Id | Version | Source | Licence / attribution |
|---|---|---|---|
| `apple` | `emojipedia-419` | Emojipedia CDN `https://em-content.zobj.net/source/apple/419/<file>` (the set react-apple-emojis 3.0.0 uses; Emoji 16.0, 160×160 PNG). File names from react-apple-emojis `src/data.json` (MIT, Copyright (c) 2021-2025 David Hérault), keyed by code points | Apple Color Emoji artwork, proprietary (Apple Inc.); not redistributed |
| `twemoji` | `17.0.3` | `https://cdn.jsdelivr.net/gh/jdecked/twemoji@v17.0.3/assets/svg/<cp>.svg` | Twemoji graphics Copyright 2019 Twitter, Inc. and other contributors (jdecked/twemoji), licensed under CC-BY 4.0: https://creativecommons.org/licenses/by/4.0/ |
| `noto` | `17.0` | Google's Noto emoji CDN `https://fonts.gstatic.com/s/e/notoemoji/17.0/<cp>/512.png` (512×512 PNG) | Noto Emoji images Copyright Google LLC, licensed under the Apache License 2.0 (github.com/googlefonts/noto-emoji); flag images public domain |
