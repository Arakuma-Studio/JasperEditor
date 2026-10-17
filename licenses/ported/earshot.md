# Ported algorithms: earshot audio QA (spec 12 §4, sound design Phase 6)

- **Upstream:** https://github.com/Leonxlnx/earshot (commit `9721326`, v0.2.0)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2026 Leon Lin
- **Ported by:** sound design WP-E1 (Sound Check: new findings), 2026-10-17; WP-E5 (takes, judge flags), 2026-10-18

| Upstream path | Our path | What |
|---|---|---|
| `skills/real-sound/scripts/qa.py` (`detect_clicks`, `check_clicks`) | `packages/audio-fx/src/analysis/clicks.ts`, `apps/engine/src/sound-design/check-findings.ts` (`edgeFindings`) | Click detector: 14 kHz 4th-order Butterworth high-pass, a burst over 9× its 20 ms and 6× its 4 ms RMS, click when ≥ 80 % of its ±5 ms energy is within 1 ms, 10 ms refractory, channels merged within 1 ms; a click within 2 ms of a placement edge is a cut |
| `skills/real-sound/scripts/qa.py` (`sample_edges`, `judge_edges`, `check_splices`) | `packages/audio-fx/src/analysis/edges.ts`, `apps/engine/src/sound-design/check-findings.ts` | Abrupt entry (source 20 ms before the trim within 20 dB of its peak, fade-in < 5 ms, attack > 10 ms or source within 10 dB), chopped decay (tail and source after over −35 dB, fade-out < 30 ms), chopped music splice (6 dB sustain, 6 dB over the next piece, fade < 100 ms) |
| `skills/real-sound/scripts/qa.py` (`check_harshness`, `centroid`) | `packages/audio-fx/src/analysis/harshness.ts`, `apps/engine/src/sound-design/check-findings.ts` (`harshFindings`) | 2–6 kHz presence band, 5 ms RMS peak against the music's loudest, 6 dB threshold; bright sounds over a 6.5 kHz centroid |
| `skills/real-sound/scripts/qa.py` (`bands`, `read_metrics`, `check_audibility --layers`) | `packages/audio-fx/src/analysis/check-curves.ts` (`thirdOctaveEnergies`, `loudestWindowStart`, `layerAudibility`), `apps/engine/src/sound-design/check-findings.ts` (`layerFindings`) | 1/3-octave band energies (100 Hz–12.6 kHz) of a Tukey(0.25)-windowed 60 ms segment, a layer's addition per band over everything else |
| `skills/real-sound/scripts/qa.py` (`check_loudness` head / tail, `check_coverage`, `sync_issue` end window) | `apps/engine/src/sound-design/check-findings.ts` (`endingFindings`, `coverageFindings`, `arcFindings`), `apps/engine/src/sound-design/check.ts` | Thresholds of the master's head (5 ms peak −40 dBFS) and tail (50 ms RMS −45 dBFS, 10 ms peak −60 dBFS), classes of action sounded in part, the riser end window −250…+30 ms, the loudest moment in the last 15 % |
| `earshot/search.py` (`event_candidates`, `_refine_start`, `_tail_db`, `_head_db`, `_edit_gaps`, `_select`) | `packages/audio-fx/src/analysis/takes.ts` (`findTakes`, `analyzeTakes`) | Takes of a multi-hit recording: a stroke from 5 ms before its refined attack until it has decayed 35 dB under its peak (never under the floor + 4 dB) plus 20 ms, never into the next stroke, at most 2 s; strokes < 0.25 s apart joined (never across ≥ 10 ms of digital silence at −100 dBFS, never led by a stroke 15 dB weaker); head (first 5 ms) and tail (last 10 ms) against the peak, clean = head ≤ −15 dB and tail ≤ −30 dB; round-robin selection over 2 s stretches by prominence |
| `skills/real-sound/scripts/analyze.py` (`noise_floor_dbfs`, `dc`, `rolloff95_hz`, the "foley / SFX" rules of thumb) | `packages/audio-fx/src/analysis/sound-descriptors.ts` (`floorDb`, `dcDb`, `rolloff95Hz`), `packages/audio-fx/src/analysis/sound-judge.ts` (`noisy-floor`, `dc-offset`, `lowpassed`) | Noise floor = 10th percentile of 20 ms RMS, flagged over −55 dBFS between events; DC offset (channel mean) over −40 dBFS; 95 % roll-off and the 12 kHz "not dull / lossy cliff" line |

Notes: Python/NumPy/SciPy → TypeScript; no code was copied, the algorithms and thresholds were reimplemented. Changes:
the click detector streams block by block with bounded memory (earshot works on whole files); the presence meter takes
the mean square over the channels of the band-passed signal (earshot band-passes the channel mean: wide stereo music
read 3 dB low); clip edges are measured on the clip's source media at its speed and attributed to our clip, remix and
transition model; the fixes (fades, crossfades, gains, Mix-lane fades) are ours. Not ported: earshot's model-based
listening (`--listen`, `--realness`), its JSON mix DSL, sync rules for its cue file and the machine-gun density rule.

WP-E5 changes: onsets come from our SuperFlux detector (the descriptors' `onsetCount`), not librosa's; events are pairs
only (earshot also builds longer chains and lets CLAP choose); every take is kept and judged by its descriptors (earshot
scores candidates with CLAP); a take that runs into digital silence from over −30 dB is a tail cut (ours); the floor is
reported only for two or more onsets and when it is 12 dB under the loudest window (a single decaying hit has no
"between"); `lowpassed` reads a band-limit cliff (`cutoffHz`: the 1.5 kHz under an edge broadband, everything above
30 dB down) under 12 kHz instead of the 95 % roll-off itself, which is under 12 kHz for nearly every natural click
(earshot's `analyze.py` measures its roll-off on a 22.05 kHz resample, so its own "> 12 kHz" rule cannot be met there).
