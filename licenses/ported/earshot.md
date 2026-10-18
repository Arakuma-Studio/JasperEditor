# Ported algorithms: earshot audio QA (spec 12 §4, sound design Phase 6)

- **Upstream:** https://github.com/Leonxlnx/earshot (commit `9721326`, v0.2.0)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2026 Leon Lin
- **Ported by:** sound design WP-E1 (Sound Check: new findings), 2026-10-17; WP-E5 (takes, judge flags), 2026-10-18;
  WP-E6 (cue grammar, variation policy, personality, palette coherence), 2026-10-18; WP-E7 (music to picture),
  2026-10-18; WP-E4 (reference profiles), 2026-10-18

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

## Music to picture (sound design WP-E7, 2026-10-18)

| Upstream path | Our path | What |
|---|---|---|
| `skills/real-sound/scripts/arrange.py` (`transient_phase`, the beat grid "moved onto the measured attacks") | `packages/audio-fx/src/analysis/remix.ts` (`beatAttacks`, `analyzeMusic`, `JOINT_LEAD_S`) | The idea that a beat tracker's grid lags the attacks (20–50 ms by earshot's measurement) and that a splice on a lagging grid chops the downbeat: every joint now sits 5 ms before its beat's MEASURED attack (our existing 5 ms-RMS rise refinement per beat; earshot folds a 2.9 ms flux at the period and shifts the whole grid) |
| `skills/real-sound/scripts/arrange.py` (`drop_score`, `drop_cands`: "a loud bar (within 3 dB of the loud sections) that stays loud for 4 bars, lifted over the 4 bars before it" + novelty) | `packages/audio-fx/src/analysis/remix.ts` (`findDrops`) | Bar levels relative to the 90th percentile; a candidate is within 3 dB of it and its 4 bars average over −4 dB; score = lift / 3 + 2 × novelty (distance of unit chroma and unit timbre vectors from the previous bar); without loud bars the bars over the 75th percentile; top 6 |
| `skills/real-sound/scripts/arrange.py` (hard anchors: `--drop-film-bar` = `--drop` source bar; edits at bar lines) | `packages/audio-fx/src/analysis/remix.ts` (`planAnchoredRemix`) | Landing the drop on a chosen moment with joints only at bar lines (earshot: a DP over film bars against an arc; ours: the existing remix's similarity-ranked jumps restricted to bar lines, a head trim under a bar, the outro kept, exact to 1 ms) |
| `docs/launch-video-sound.md` (stop-downs "0.15–1.5 s", riser → stop-down 0.1–0.5 s → impact) | `packages/project/src/sound/mix.ts` (`STOP_ON_BAR_WINDOW_SEC`, `STOP_ON_BAR_MIN_SEC`, `stopOnBar`) | The 0.1–0.5 s window in which a stop-before's ramp is moved onto the music's downbeat (earshot norm, n = 7 launch films measured by one person; a default the cue's own `stopBefore.seconds` replaces) |

Notes: Python/librosa → TypeScript; no code was copied. Changes: our beat grid is per beat (each beat on its own
measured attack) rather than one fitted line with a phase shift; the drop's lift is taken over the median of the 4 bars
before AND the bar right before (earshot's median alone scored the bar after a drop almost as high: 8.2 vs 8.8 on our
generated track, measured); bar numbers count from the start of the analysed range; key finding (Krumhansl–Schmuckler,
`packages/audio-fx/src/analysis/key.ts`) and tuning (`packages/project/src/sound/tuning.ts`) are ours (earshot's
`analyze.py` reports a key with librosa; nothing of it is used). Not ported: the arc DP over film bars, `--phase`
overrides, local phase disagreements, Rubber Band stretching (GPL; we never stretch).

## Reference profiles (sound design WP-E4, 2026-10-18)

| Upstream path | Our path | What |
|---|---|---|
| `earshot/profile.py` (`film_metrics`, `_audio_pass`, `salient_hits`, `stopdowns`, `_edge`, `_arc`, `_final_hit_tail`, `near_frac`) | `packages/audio-fx/src/analysis/profile-metrics.ts` (`ProfileMeter`) | The metric set and definitions: integrated / true peak / LRA / crest (loudest 3 s − integrated); the 11-point arc (energy-mean momentary loudness around 0 %…100 %, window max(1.5 s, 5 %)), opening / closing level (first / last max(10 %, 0.5 s)), position of the loudest 3 s, first sound (first 100 ms block within 20 LU, refined on 2 ms levels within 20 dB of the loudest of the next 150 ms), longest gap (100 ms level 30 LU under), dead air (last block within 30 LU, refined), fade (last momentary within 6 LU to the end of sound, − 0.2 s), final moment (loudest momentary of the last 3 s of sound), final-hit ring-out (strongest onset of the last 4 s in the top quarter); salient hits (100 ms level jumping ≥ 6 dB within 80 ms over the minimum of the 200 ms before, to within 8 LU of integrated, one per run); stop-downs (≥ 10 dB under the median of the preceding 2 s for 0.15–1.5 s, back within 3 dB in 0.3 s); onsets per second; picture events per second and the share with an onset within ±100 ms and ±1 frame; six band shares (sub 20–60, low 60–250, low-mid 250–1k, mid 1–4k, presence 4–8k, air 8–16k Hz) and the median magnitude-weighted centroid; side / mid energy (mono −40 dB) and L/R correlation; files under 3 s or silent unscorable, under 10 s no loudness-shape metrics |
| `earshot/profile.py` (`_stats`, `aggregate`, `profile`) | `packages/project/src/sound/profile.ts` (`metricStats`, `aggregateReferences`, `buildReferenceProfile`), `apps/engine/src/sound-design/profile.ts` (`runSoundProfileJob`) | Per metric median, p10–p90 (NumPy linear percentiles), min–max and n; the arc's median / p10 / p90 per point; references that are missing, without audio, under 3 s or silent are skipped with a reason; fewer than 3 references warned |
| `earshot/critique.py` (`SPEC` weights, tolerances and sides; `_window`; `_status`; `scorecard`; `reference_match`; `leave_one_out`; `_actions`, `BAND_FIX`) | `packages/project/src/sound/profile.ts` (`REFERENCE_METRICS`, `referenceWindow`, `compareWithProfile`, `referenceMatch`, `referenceAdvice`), `apps/engine/src/sound-design/profile.ts` (`referenceFindings`) | The scorecard: the window = the references' min–max widened by the metric's tolerance, one-sided where earshot judges one side, a density window reaching 0 floored at half the sparsest reference; statuses ok / low / high / n.a.; weights major / minor / info; leave-one-out against the other references (at least two); what to do per metric and direction (our wording), with timecodes |

Notes: Python/NumPy/librosa → TypeScript; no code was copied, and earshot's bundled 7-film launch profile is NOT used or
shipped (users build their own; the reason is in the wp-note). Changes: streaming in blocks with bounded memory (≈ 10 MB
an hour); onsets are our `ListenMeter`'s (P6-E6) rising ≥ 3 dB over their bed (earshot: librosa spectral flux); a
salient hit is timed at the most prominent of those onsets; curves at 10 ms steps; edges refined ±100 ms around the
block (a centred block straddling the edge missed it by half its length in our known-answer test); a gap's length adds
back the 100 ms window (a 1 s hole reads 1 s); the chance of a sync share is the exact measure of the union of the
tolerance windows over the piece (earshot: 16 fixed circular shifts of the picture events); picture events come from our
scene detector (`sceneSignature` / `detectSceneCuts`, the flash test streamed) or, for a sequence, its edit's cuts and
transitions (earshot: a frame-difference detector); speech share from our model-free Auto Tag classifier per 5 s window
(earshot: AudioSet "Speech" ≥ 0.5). Integrated loudness and true peak are shown for context only (Sound Check's LOUDNESS
/ TRUE_PEAK follow the delivery preset; earshot judges them against a web window). Leave-one-out also by identity (a
sequence reference of the checked sequence) and, by measurements, on level-independent metrics only, all of them within
tolerance (earshot: 3 of loudness, true peak, brightness and the mid share — similar generated films matched). Rows are
Sound Check findings of severity warning (major) or info (minor), never errors. Not ported: realness, the AudioSet music
share, tempo, the beat-grid share, the verdict score, the bundled profile.
