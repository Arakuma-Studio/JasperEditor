# Ported algorithms: earshot audio QA (spec 12 §4, sound design Phase 6)

- **Upstream:** https://github.com/Leonxlnx/earshot (commit `9721326`, v0.2.0)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2026 Leon Lin
- **Ported by:** sound design WP-E1 (Sound Check: new findings), 2026-10-17

| Upstream path | Our path | What |
|---|---|---|
| `skills/real-sound/scripts/qa.py` (`detect_clicks`, `check_clicks`) | `packages/audio-fx/src/analysis/clicks.ts`, `apps/engine/src/sound-design/check-findings.ts` (`edgeFindings`) | Click detector: 14 kHz 4th-order Butterworth high-pass, a burst over 9× its 20 ms and 6× its 4 ms RMS, click when ≥ 80 % of its ±5 ms energy is within 1 ms, 10 ms refractory, channels merged within 1 ms; a click within 2 ms of a placement edge is a cut |
| `skills/real-sound/scripts/qa.py` (`sample_edges`, `judge_edges`, `check_splices`) | `packages/audio-fx/src/analysis/edges.ts`, `apps/engine/src/sound-design/check-findings.ts` | Abrupt entry (source 20 ms before the trim within 20 dB of its peak, fade-in < 5 ms, attack > 10 ms or source within 10 dB), chopped decay (tail and source after over −35 dB, fade-out < 30 ms), chopped music splice (6 dB sustain, 6 dB over the next piece, fade < 100 ms) |
| `skills/real-sound/scripts/qa.py` (`check_harshness`, `centroid`) | `packages/audio-fx/src/analysis/harshness.ts`, `apps/engine/src/sound-design/check-findings.ts` (`harshFindings`) | 2–6 kHz presence band, 5 ms RMS peak against the music's loudest, 6 dB threshold; bright sounds over a 6.5 kHz centroid |
| `skills/real-sound/scripts/qa.py` (`bands`, `read_metrics`, `check_audibility --layers`) | `packages/audio-fx/src/analysis/check-curves.ts` (`thirdOctaveEnergies`, `loudestWindowStart`, `layerAudibility`), `apps/engine/src/sound-design/check-findings.ts` (`layerFindings`) | 1/3-octave band energies (100 Hz–12.6 kHz) of a Tukey(0.25)-windowed 60 ms segment, a layer's addition per band over everything else |
| `skills/real-sound/scripts/qa.py` (`check_loudness` head / tail, `check_coverage`, `sync_issue` end window) | `apps/engine/src/sound-design/check-findings.ts` (`endingFindings`, `coverageFindings`, `arcFindings`), `apps/engine/src/sound-design/check.ts` | Thresholds of the master's head (5 ms peak −40 dBFS) and tail (50 ms RMS −45 dBFS, 10 ms peak −60 dBFS), classes of action sounded in part, the riser end window −250…+30 ms, the loudest moment in the last 15 % |

Notes: Python/NumPy/SciPy → TypeScript; no code was copied, the algorithms and thresholds were reimplemented. Changes:
the click detector streams block by block with bounded memory (earshot works on whole files); the presence meter takes
the mean square over the channels of the band-passed signal (earshot band-passes the channel mean: wide stereo music
read 3 dB low); clip edges are measured on the clip's source media at its speed and attributed to our clip, remix and
transition model; the fixes (fades, crossfades, gains, Mix-lane fades) are ours. Not ported: earshot's model-based
listening (`--listen`, `--realness`), its JSON mix DSL, sync rules for its cue file and the machine-gun density rule.
