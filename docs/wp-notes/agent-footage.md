# Agent footage editing (spec 18): work note index

Owner note of [spec 18](../specs/18-agent-footage-editing.md). Each area keeps its behaviour, thresholds with sources,
validation and limits in its own note:

| Area | Requirements | Note |
|---|---|---|
| Safety: local-only FFmpeg inputs, GPL filter guard on generated graphs | AF-SEC-001…004 | [agent-footage-security.md](agent-footage-security.md) |
| Footage digest, takes, transcribe on agent import | AF-DIG-001…004, AF-TAK-001…002 | [agent-footage-digest.md](agent-footage-digest.md) |
| Media / sequence range view (`view_media_range`) | AF-VIEW-001…003 | [agent-footage-view.md](agent-footage-view.md) |
| Rough-cut proposals (`propose_edits`, Review panel rows) | AF-PROP-001…004 | [agent-footage-proposals.md](agent-footage-proposals.md) |
| Export verification, delivery targets and presets | AF-VER-001…005 | [agent-footage-verify.md](agent-footage-verify.md) |
| MCP toolsets, short instructions, guides, routing table, agent skill | AF-CTX-001…005 | [agent-footage-context.md](agent-footage-context.md) |
| Media derivation ops (`derive_media`, Derive Media ▸) | AF-OPS-001…002 | [agent-footage-ops.md](agent-footage-ops.md) |
| GIF and audio-only export | AF-EXP-001…003 | [agent-footage-export.md](agent-footage-export.md) |
| Sequence brief, agent notes (schema v11), Describe your video | AF-BRF-001…006 | [agent-footage-brief.md](agent-footage-brief.md) |
| Agent activity panel, status chip, burst toasts | AF-ACT-001…003 | [agent-footage-activity.md](agent-footage-activity.md) |

Studied sources (ideas and thresholds only, no code): `licenses/ported/video-use.md`,
`licenses/ported/ffmpeg-skill.md`.

## Integration

The ten areas were built on separate branches (`af/<area>`) and merged into `feat/agent-footage-editing`. Integration
changes beyond the branches:

- Every new tool is in exactly one toolset (`apps/mcp/src/toolsets.ts`); the guides of the new tools are per-topic
  guides (`footage`, `derive`, …) served as `jasper://guide/<topic>` and by `get_guide`.
- The derive and range-view runners import `LOCAL_PROTOCOLS` from the shared `apps/engine/src/tools/protocols.ts`
  that AF-SEC introduced (the `Ffmpeg` class also restricts every input itself; the explicit whitelist is kept, and
  `restrictInputs` never doubles it).
- The activity toast leaves out the item count of transactions that change no items (agent notes, briefs), and the
  status chip lists the agents `GET /api/agent/presence` (AF-BRF-005) reports.
