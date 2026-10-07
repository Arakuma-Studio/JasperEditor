# Ported source code records

Code or algorithms ported into JasperEditor from another project need one record here
([AGENTS.md](../../AGENTS.md) §3.4, [ARCHITECTURE](../../docs/ARCHITECTURE.md) D-36). Only permissive licences
(MIT, Apache-2.0, BSD, ISC, Zlib…) may be ported. Never port anything from `.reference/` or `editor-starter.zip`.

`pnpm notices` copies every record in this folder (all `*.md` files except this README) into
`THIRD_PARTY_NOTICES.md`, which ships with the app and is shown in Help ▸ About ▸ Licenses ▸ Ported source code,
together with the licence texts in [`licenses/texts/`](../texts/). `pnpm notices --check` (run by the unit tests
and by packaging) fails when a record is missing from the generated file, out of date or incomplete. After
adding or changing a record, run `pnpm notices` and commit `THIRD_PARTY_NOTICES.md` with it.

## Format

One file per workstream or port, named `<name>.md` (lower case, `-` between words). The script needs three
lines, in this form:

```markdown
# <What was ported, in a few words>

- **Upstream:** https://github.com/storytold/effectcraft (commit `<sha>` or tag, when known)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** <workstream or contributor>, <YYYY-MM-DD>

| Upstream path | Our path | What |
|---|---|---|
| `crates/effects/src/blur.rs` | `packages/project/src/registry/fx/blur.ts` | box blur kernel, ported to TypeScript |
| `crates/render/src/shaders/blur.wgsl` | `packages/compositions/src/fx/shaders/blur.ts` | WGSL → GLSL ES 3.00 |

Notes: what changed in the port (language, behaviour, fixes), anything not ported.
```

- **Upstream** is the repository URL (the first `http(s)://` URL in the record).
- **Licence** is an SPDX expression (`MIT`, `Apache-2.0`, `MIT OR Apache-2.0`, `BSD-3-Clause`…). Each licence id
  needs its text in `licenses/texts/<id>.txt` (MIT and Apache-2.0 are there).
- **Copyright** is the upstream copyright line, exactly as in its licence file. For EffectCraft and FilmCraft:
  `Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors` / `… and the FilmCraft contributors`.
- The path table maps every upstream file you ported from to the file it went into. Keep it current when files move.

Brand assets (logos, app icons, `docs/brand`) are never ported; they are not code and not openly licensed.
