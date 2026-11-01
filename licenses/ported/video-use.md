# Packed phrase transcript format and phrase / silence thresholds (ideas only)

- **Upstream:** https://github.com/browser-use/video-use
- **Licence:** MIT
- **Copyright:** Copyright (c) 2026 Browser Use
- **Ported by:** spec 18 AF-DIG / AF-TAK (agent footage editing), 2026-10-31

| Upstream path | Our path | What |
|---|---|---|
| `README.md`, `SKILL.md` (the `takes_packed.md` sample and the editing rules) | `packages/project/src/footage/digest.ts`, `packages/project/src/footage/phrases.ts` | the idea of a packed phrase transcript an agent reads instead of watching (`[002.52-005.36] S0 text`, zero-padded seconds, speaker labels) and the 0.5 s phrase split |
| `README.md`, `SKILL.md` (the composite range image) | spec 18 AF-VIEW (`view_media_range`) | the 0.4 s silence band threshold |

Notes: no code was copied or translated; the format and thresholds were adapted from the project's documentation and
re-implemented in TypeScript over JasperEditor's own transcripts (flicks, `breakBefore` caption breaks, a 12 s phrase
cap, `~` low-confidence marks, a character budget and take grouping with the transcript cleanup lists, none of which
come from upstream). See `docs/wp-notes/agent-footage-digest.md`.
