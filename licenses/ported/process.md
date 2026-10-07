# Contributor rules, project-file and crash-recovery docs, layering and asset checks (process workstream)

- **Upstream:** https://github.com/storytold/effectcraft and https://github.com/storytold/filmcraft
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors; Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** process workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| effectcraft `AGENTS.md`, filmcraft `AGENTS.md` | `AGENTS.md` | structure and wording of the never-crash and asset rules, the attribution sidecar format (§1.3) |
| effectcraft `CLAUDE.md`, filmcraft `CLAUDE.md`, filmcraft `docs/agents.md` §6–7 | `CLAUDE.md` | session start, Definition of Done checklist, honest progress reporting, the "ask a human only about" list |
| effectcraft `ATTRIBUTION.md` | `ATTRIBUTION.md` | index layout |
| effectcraft `xtask/src/main.rs` (`layers`, `assets`) | `scripts/check-layers.mjs`, `scripts/check-assets.mjs` | the idea of a declarative layer table and an asset/sidecar check (re-implemented in JavaScript for npm workspaces) |
| effectcraft `docs/gaps.md`, `docs/parity.md`; filmcraft `ROADMAP.md` | `docs/gaps.md`, `docs/parity.md` | structure: two numbers (breadth vs readiness), workstreams with "done when", the evidence rule |
| filmcraft `docs/project-files.md` | `docs/project-files.md` | structure and migration rules ("never edit a shipped migration", bump when an older build would drop data, the first-save schema backup) and the crash-recovery journal design (snapshot ~1 s after an edit, held under a lock, offered on the next start) |

Notes: documentation and design only; no Rust code was translated. The recovery journal here lives in the engine
and uses the editing lease as its lock instead of an OS file lock.
