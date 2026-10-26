# Apple emoji file names (Emojipedia set 419)

- **Upstream:** https://github.com/dherault/react-apple-emojis (version 3.0.0, `master` on 2026-10-25)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2021-2025 David Hérault
- **Ported by:** WP5 platform-glyphs (social-comment templates), 2026-10-25

| Upstream path | Our path | What |
|---|---|---|
| `src/data.json` (`baseUrl`, `emojis`) | `apps/engine/src/remote-assets/manifest.json` (`emojiPacks[id=apple]`: `urlTemplate`, `names`) | the Emojipedia CDN base URL and the 4240 image file names, re-keyed by code points |

Notes: only data was taken, no code. Each file name's code-point part (for example `1f44d-1f3fd` in
`thumbs-up_medium-skin-tone_1f44d-1f3fd_1f3fd.png`) became the key, without U+FE0F; the bare
`variation-selector-16_fe0f.png` entry was dropped. The React component is not used. The images themselves are
Apple's and are downloaded at runtime (`licenses/platform-assets.md`).
