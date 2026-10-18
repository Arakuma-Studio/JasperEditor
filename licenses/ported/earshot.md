# Ported algorithms: earshot audio QA (spec 12 §4, sound design Phase 6)

- **Upstream:** https://github.com/Leonxlnx/earshot (commit `9721326`, v0.2.0)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2026 Leon Lin
- **Ported by:** sound design WP-E1 (Sound Check: new findings), 2026-10-17; WP-E5 (takes, judge flags), 2026-10-18;
  WP-E6 (cue grammar, variation policy, personality, palette coherence), 2026-10-18

| Upstream path | Our path | What |
|---|---|---|
| `skills/real-sound/scripts/qa.py` (`detect_clicks`, `check_clicks`) | `packages/audio-fx/src/analysis/clicks.ts`, `apps/engine/src/sound-design/check-findings.ts` (`edgeFindings`) | Click detector: 14 kHz 4th-order Butterworth high-pass, a burst over 9× its 20 ms and 6× its 4 ms RMS, click when ≥ 80 % of its ±5 ms energy is within 1 ms, 10 ms refractory, channels merged within 1 ms; a click within 2 ms of a placement edge is a cut |
| `skills/real-sound/scripts/qa.py` (`sample_edges`, `judge_edges`, `check_splices`) | `packages/audio-fx/src/analysis/edges.ts`, `apps/engine/src/sound-design/check-findings.ts` | Abrupt entry (source 20 ms before the trim within 20 dB of its peak, fade-in < 5 ms, attack > 10 ms or source within 10 dB), chopped decay (tail and source after over −35 dB, fade-out < 30 ms), chopped music splice (6 dB sustain, 6 dB over the next piece, fade < 100 ms) |
| `skills/real-sound/scripts/qa.py` (`check_harshness`, `centroid`) | `packages/audio-fx/src/analysis/harshness.ts`, `apps/engine/src/sound-design/check-findings.ts` (`harshFindings`) | 2–6 kHz presence band, 5 ms RMS peak against the music's loudest, 6 dB threshold; bright sounds over a 6.5 kHz centroid |
| `skills/real-sound/scripts/qa.py` (`bands`, `read_metrics`, `check_audibility --layers`) | `packages/audio-fx/src/analysis/check-curves.ts` (`thirdOctaveEnergies`, `loudestWindowStart`, `layerAudibility`), `apps/engine/src/sound-design/check-findings.ts` (`layerFindings`) | 1/3-octave band energies (100 Hz–12.6 kHz) of a Tukey(0.25)-windowed 60 ms segment, a layer's addition per band over everything else |
| `skills/real-sound/scripts/qa.py` (`check_loudness` head / tail, `check_coverage`, `sync_issue` end window) | `apps/engine/src/sound-design/check-findings.ts` (`endingFindings`, `coverageFindings`, `arcFindings`), `apps/engine/src/sound-design/check.ts` | Thresholds of the master's head (5 ms peak −40 dBFS) and tail (50 ms RMS −45 dBFS, 10 ms peak −60 dBFS), classes of action sounded in part, the riser end window −250…+30 ms, the loudest moment in the last 15 % |
| `earshot/search.py` (`event_candidates`, `_refine_start`, `_tail_db`, `_head_db`, `_edit_gaps`, `_select`) | `packages/audio-fx/src/analysis/takes.ts` (`findTakes`, `analyzeTakes`) | Takes of a multi-hit recording: a stroke from 5 ms before its refined attack until it has decayed 35 dB under its peak (never under the floor + 4 dB) plus 20 ms, never into the next stroke, at most 2 s; strokes < 0.25 s apart joined (never across ≥ 10 ms of digital silence at −100 dBFS); head (first 5 ms) and tail (last 10 ms) against the peak, clean = head ≤ −15 dB and tail ≤ −30 dB; round-robin selection over 2 s stretches by prominence |
| `skills/real-sound/scripts/analyze.py` (`noise_floor_dbfs`, `dc`, `rolloff95_hz`, the "foley / SFX" rules of thumb) | `packages/audio-fx/src/analysis/sound-descriptors.ts` (`floorDb`, `dcDb`, `rolloff95Hz`), `packages/audio-fx/src/analysis/sound-judge.ts` (`noisy-floor`, `dc-offset`, `lowpassed`) | Noise floor = 10th percentile of 20 ms RMS, flagged over −55 dBFS between events; DC offset (channel mean) over −40 dBFS; 95 % roll-off and the 12 kHz "not dull / lossy cliff" line |
| `skills/real-sound/references/sound-design.md` §2 "Launch-video grammar", §6 "Variation without randomness"; `skills/real-sound/scripts/mix.py` (rule `mode: cycle`, `jitter_db`, `pitch`, `pitch_ramp`) | `packages/project/src/sound/grammar.ts` (`variationOfType`, `voiceFor`, `findRuns`, `rateOfSemitones`), `packages/project/src/sound/variant.ts` (`variationOf` policies), `packages/project/src/sound/taxonomy.ts` (`variation`), `apps/engine/src/sound-design/plan.ts` | One click voice at one level (no pitch or gain variation); keys vary the take with ±1 dB, never the pitch; a run of pops / ticks climbs in pitch across its members (earshot: a linear `pitch_ramp` between two semitone values over the matched events; ours: +1 st per step capped at +4, ≥ 3 cues ≤ 0.6 s apart) |
| `skills/real-sound/references/sound-design.md` §2 (typing row: "at most ~12 keys/s; above ~25 chars/s one key per word or silence", "music dips 6-10 dB under the run"; hard-cuts row: "about 85 % of cuts in pro films have no sound of their own") | `packages/project/src/sound/grammar.ts` (`typingChoice`, `TYPING_WORDS_ABOVE_PER_SEC`, `MUSIC_CUT_CONFIDENCE_FACTOR`, `musicPlaysAt`), `packages/project/src/sound/cues/{text,derive}.ts`, `packages/project/src/sound/text-events.ts` (`wordStartUnits`), `apps/engine/src/sound-design/plan.ts` (`TYPING_DUCK`) | One key per word start above 25 typed units/s; an optional 6 dB music dip under a typing run; a cut inside music at half confidence |
| `skills/real-sound/references/sound-design.md` §1 "One palette" ("one material family per film"), §3 "Match the brand's personality" (calm / fast / bright / precise / mechanical / warm) | `packages/project/src/sound/grammar.ts` (`paletteMaterials`, `materialBonusOf`, `SOUND_PERSONALITY_PROFILES`, `personalityScore`, `styleCueTypes`), `packages/project/src/sound/rank.ts` | A ranking bonus for the dominant material of the family's placed sounds; six personalities as ranking preferences, type boosts and exclusions, materials and a default density (earshot describes them as music and source choices in prose; the table is ours) |

Notes: Python/NumPy/SciPy → TypeScript; no code was copied, the algorithms and thresholds were reimplemented. Changes:
the click detector streams block by block with bounded memory (earshot works on whole files); the presence meter takes
the mean square over the channels of the band-passed signal (earshot band-passes the channel mean: wide stereo music
read 3 dB low); clip edges are measured on the clip's source media at its speed and attributed to our clip, remix and
transition model; the fixes (fades, crossfades, gains, Mix-lane fades) are ours. Not ported: earshot's model-based
listening (`--listen`, `--realness`), its JSON mix DSL, sync rules for its cue file and the machine-gun density rule.

WP-E5 changes: onsets come from our SuperFlux detector (the descriptors' `onsetCount`), not librosa's; events are pairs
only (earshot also builds longer chains and lets CLAP choose), joined only when the first stroke is the louder one by
1 dB (earshot only refuses a lead 15 dB weaker: a take's peak is where we align it, so it must be the press); every take is kept and judged by its descriptors (earshot
scores candidates with CLAP); a take that runs into digital silence from over −30 dB is a tail cut (ours); the floor is
reported only for two or more onsets and when it is 12 dB under the loudest window (a single decaying hit has no
"between"); `lowpassed` reads a band-limit cliff (`cutoffHz`: the 1.5 kHz under an edge broadband, everything above
30 dB down) under 12 kHz instead of the 95 % roll-off itself, which is under 12 kHz for nearly every natural click
(earshot's `analyze.py` measures its roll-off on a 22.05 kHz resample, so its own "> 12 kHz" rule cannot be met there).

WP-E6 changes: earshot's grammar is prose plus a JSON mix DSL (rules matching cue kinds with pools, modes and ramps);
ours is one pure policy module every path calls (the plan job, cue derivation, MCP picks, the search route, variation
cycling). earshot varies keys by ±0.3–0.5 st at most; we never varispeed keys, ticks or taps (spec 12 P6-E10). Runs are
detected from the cue spacing and the fill type, not named by the cue file; a run is also budgeted as one unit when cues
are derived. The music-carries-the-cuts rule halves a derived cut's confidence instead of muting it, so the density
decides (balanced drops it, rich keeps it). The personality table, the material bonus (+0.08) and the personality
weight (±0.15) are our decisions (wp-note "Phase 6 → WP-E6").

## Listening transcript and sound sheet (sound design WP-E3, 2026-10-18)

| Upstream path | Our path | What |
|---|---|---|
| `earshot/timeline.py` (`onset_curve`, `log_mel`, `_robust_z`, `_attack`, `_band_envs`, `_length_ms`, `_kw_env_db`, `detect_events`) | `packages/audio-fx/src/analysis/events.ts` (`ListenMeter`, `LogBandStft`) | Superflux onset curve at 5 ms frames (mean positive log-band increase over the maximum of the neighbouring bands two frames before), peak-picked over ±25 ms with a robust z ≥ 3 over ±1 s (floor 2 % of the 99th percentile); attack on 1 ms max-abs envelopes of the full signal, < 200 Hz and > 2 kHz (4th-order Butterworth): the band standing out most, walking back from the peak to the first millisecond within 20 dB of it over the bed, full-band timing when it rises 12 dB there; length to −20 dB or 3 dB over the bed for 30 ms (≤ 2 s); 3 dB minimum contrast, onsets within 30 ms merged; prominence of the K-weighted 10 ms level (1 ms steps) over the median of the 20–300 ms before (floor −80) |
| `earshot/timeline.py` (`level_envs`, `_swells`) | `packages/audio-fx/src/analysis/events.ts` (`ListenMeter` swells) | 10 ms RMS of the signal and its highs smoothed over 90 ms; rises ≥ 8 dB over 0.25–2 s, ≥ 60 % rising steps, then a 4 dB fall; timed at the peak |
| `earshot/timeline.py` (`_silences`) | `packages/audio-fx/src/analysis/events.ts` (`ListenMeter` silences) | Fast (100 ms) loudness 20 LU under the integrated loudness (or under −60 / −70 LUFS) for ≥ 0.25 s, closed over 7 hops; digital silence / near silence / drop |
| `earshot/timeline.py` (`_strong`, `_accents`, `_answer`, `_chance`, `sync`) | `packages/audio-fx/src/analysis/events.ts` (`strongThreshold`, `accentThreshold`, `answerPictureEvent`, `syncChance`, `syncStats`), `apps/engine/src/sound-design/listen.ts` | Strong onsets (prominence ≥ min(6 dB, 40th percentile)), accents (top 20 % and ≥ 6 dB), the answer ladder (OK within a frame, near ≤ 100 ms strong first, swell ≤ 300 ms, a strong onset ≤ 250 ms named for an unanswered one), the chance of each share (random times within the tolerance of an event over the picture events' span ± 1 s), on-beat share within 50 ms |
| `earshot/timeline.py` (`transcript`, `_event_line`, `_unanswered_line`) | `apps/engine/src/sound-design/listen.ts` (the lines) | A chronological transcript: summary and sync lines with chance, section, event, silence and "no sound" lines (our wording; every event names the clip and cue behind it, which earshot cannot) |
| `earshot/sheet.py` (lanes) | `apps/mcp/src/sound-timeline.ts` (`drawSoundTimeline` picture, spectrogram, sections and sync lanes) | The idea of the annotated sheet's lanes (frames, spectrogram, sections, cue markers by sync); the drawing, geometry (`cells`) and shapes are ours |

Notes: Python/NumPy/SciPy → TypeScript; no code was copied. Changes (all deterministic): the analysis streams in 30 s
chunks with 2.5 s of context and bounded memory; log-spaced triangular bands (96, 30 Hz–16 kHz) instead of mel and an
absolute −100 dB floor instead of "80 dB under the file's maximum"; the MAD is taken around each candidate's own median
and the z floor and the bed fallback are local to the chunk; the prominence window ends with the event (earshot: 80 ms
always, so a bed flicker just before a hit borrowed the hit's level); onsets within 30 ms merge into one event starting at
the first attack (earshot keeps the stronger one's time); a swell is dropped for an onset at its peak only when that onset
explains half its rise; only events rising ≥ 3 dB answer a picture event and count for chance (earshot counts any onset);
an event's peak is the centre of its loudest 2 ms of mean power (the sound descriptors' `peakSec`, the point placement
aligns) and a sound answers at its attack or its peak (earshot: its attack, then a level-peak fallback);
the chance is the exact measure of the union of the tolerance windows (earshot samples a 5 ms grid). Ours only: lanes of
non-overlapping clips render each clip's own events, a mix event is attributed to the clip whose own onset explains it
(timed by the earlier of the two attacks), and a clip's own onset is looked at in the mix where the onset curve hides it
(kept when the mix rises ≥ 3 dB there). Not ported: CLAP / AST tags, sections by Foote novelty and genre, the beat
tracker, the level-peak fallback for unanswered cuts.
