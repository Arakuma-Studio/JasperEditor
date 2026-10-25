# Premiere's Pitch Shifter → JasperEditor's Pitch Shifter

Premiere Pro's built-in audio effect **Pitch Shifter** (Audio Effects ▸ Time and Pitch; Spanish UI "Desfasador de
tono"; `.prproj` `FilterMatchName` `164b4e8a-7105-406b-b23b-1ef2cc4d8957`) is converted to JasperEditor's
**Pitch Shifter** (`jasper.audio.pitch-shifter`, `packages/audio-fx/src/effects/pitch.ts`: semitones −12…12 and
cents −100…100, phase vocoder with identity phase locking). There is no VST hosting: the parameters are mapped.
Code: `packages/interchange/src/premiere-pitch-shifter.ts` (pure, exported from `@jasper/interchange`), wired into
the FCP7 XML importer and exporter (`fcp7.ts`). Tests: `packages/interchange/test/premiere-pitch-shifter.test.ts`.

## 1. Sources

| Id | Source | Used for |
|---|---|---|
| S1 | Adobe, *Audio effects* (Premiere Pro user guide, "Time and Pitch ▸ Pitch Shifter"), read through the Wayback Machine copy of <https://helpx.adobe.com/premiere-pro/using/audio-effects-transitions.html> (helpx returns 403 to scripts) | the controls: Semi-tones (±12 = an octave), Cents −100…100, Ratio 0.5…2.0, Precision Low / Medium / High, Splicing Frequency, Overlapping 0–50 %, Use Appropriate Default Settings |
| S2 | Adobe, *Time and pitch manipulation effects* (Audition user guide), Wayback copy of <https://helpx.adobe.com/audition/desktop/effects-reference/time-pitch-manipulation-effects.html> | the same controls (Audition's dialog is the effect's UI) |
| S3 | *Adobe Audition 3.0 User Guide* (PDF, <https://help.adobe.com/archive/en_US/audition/3/audition_3_help.pdf>), pp. 171–174 | "Pitch Shifter is VST-based"; Splicing Frequency divides audio "into very small chunks"; Overlapping trades "chorus effect" against "choppy sound" — a time-domain splicing algorithm |
| S4 | Adobe Learn, *Audition: Pitch Bender and Pitch Shifter* (<https://www.adobe.com/learn/audition/web/audition-pitch-bender-shifter-cc>) | in automation lanes "the only option is Transpose Ratio … Default ratio is 1 … A 2 to 1 Ratio means you've gone up an octave"; presets "(Default)" and "High Precision" |
| S5 | Public ExtendScript (GitHub `Selgy/Audioimporter`, `src/jsx/importAudio.jsx`, `semitonesToTransposeRatio`) | a table of Premiere's Transpose Ratio values per whole semitone (0 st = 0.33333334, +12 = 1, −12 = 0, −3 = 0.22726428…) and the ExtendScript names `ADBE Pitch Shifter` / `ADBE Pitch Shifter-0001` (Transpose Ratio) |
| S6 | Public Audition sessions (`.sesx`) on GitHub containing the effect (34 files found by code search, e.g. `TheSuperHackers/GeneralsGamePatch …/gdemsela.sesx`, `hex248/Shleep …/Shleep.sesx`, `Toffeepenguin/AudioArcadeGame/PickupCoin.sesx`, `Tam/ld39 …/PushBox.sesx`) | the plug-in's parameter list and English names: `Transpose Ratio`, `Precision`, `Frequency`, `Overlapping`, `Use Default Setting`, `Use Positive Cents`; normalised values of whole-semitone shifts; factory preset "The Dark Lord" (Transpose Ratio 0 = an octave down) |
| S7 | Decoded parameters of the user's Premiere projects (`/tmp/prproj-inspect`, private, not committed): 63 instances in 28 projects | value distribution, the Spanish names, the plug-in state layout (§3) |
| S8 | Steinberg VST 3 SDK documentation, *Parameters and Automation* (<https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical+Documentation/Parameters+Automation/Index.html>) | VST parameters are normalised 0…1 floats; hosts automate (interpolate) the normalised value; discrete parameters are steps of it |

No Adobe software, binaries, presets or artwork were used.

## 2. The mapping

| Premiere parameter (`.prproj` Param Index · English · Spanish · `.sesx`) | Stored | Meaning | JasperEditor |
|---|---|---|---|
| 0 · Bypass · Derivar | switch | effect off | `enabled: false` (also the component's `<Bypass>` / FCP7 `<enabled>FALSE</enabled>`) |
| 1 · Transpose Ratio · Transponer proporción · Transpose Ratio | n ∈ 0…1 | **ratio = 0.5 + 1.5·n** (linear) | cents = 1200·log2(ratio), split into `semitones` + `cents` |
| 2 · Precision · Precisión · Precision | 0, ½, 1 | Low / Medium / High (order **assumed** from S1's listing) | none (one quality); a value other than 1 is reported |
| 3 · Splicing Frequency (Hz) · Lineatura · Frequency | 0…1 | chunk rate of Adobe's splicer (Hz range not documented) | none; reported when Use Appropriate Default Settings is off |
| 4 · Overlapping · Superposición · Overlapping | 0…1 | chunk overlap, 0–50 % (S1) | none; as above |
| 5 · Use Appropriate Default Settings · Usar ajuste predeterminado · Use Default Setting | 0.25 / 0.75 | Splicing Frequency and Overlapping derived from the ratio | — (no counterpart needed) |
| 6 · Use Positive Cents · Utilizar centenas positivas · Use Positive Cents | 0.25 / 0.75 | how the ratio is shown as semitones + cents | chooses the split (below); its keyframes are reported and ignored |
| instance name (Effect Controls ▸ Rename, `<InstanceName>`) | text | e.g. "Voice FX" | `EffectInstance.name` |

**Transpose Ratio is linear in n.** Evidence: S5's measured table and S6's whole-semitone values all satisfy
0.5 + 1.5·n = 2^(st/12) to float32 precision (0.2272643 → 0.840896 = 2^(−3/12); 0.2605991 → 2^(−2/12);
0.1661024 → 2^(−5/12); 0.4594714 → 2^(3/12); 0.5565599 → 2^(5/12); 0.6094757 → 2^(6/12); 0.0408207 → 2^(−10/12));
n = 1/3 is the default ratio 1 (S4, S5); "The Dark Lord" (S6) stores 0 = ratio 0.5, an octave down. A logarithmic
reading (st = 24·n − 12) fits none of these. Shifts are rounded to 0.001 cent (undoing float32 noise, < 0.0002 cent).
Values above 1, or an FCP7 parameter with `valuemax` > 1.5, are read as the displayed ratio 0.5…2 (**assumption**:
what Premiere writes in its FCP7 export of this effect is not documented; ExtendScript and both project formats use
the normalised value, so that is the default).

**Switches** are stored as 0.25 (off) / 0.75 (on) (S6, S7: the centre of each half of 0…1); ≥ 0.5 reads as on.
**Use Positive Cents** has no effect on the sound (**assumption**, consistent with S1/S2: semitones, cents and ratio
are three views of one transposition, and the user's projects keyframe it 0.75 → 0.25 while the ratio stays
constant). With it on the cents are 0…100 (−90 → −1 st +10 c), off they take the shift's sign (−90 → 0 st −90 c);
the sum is exact either way. On export it is written from the sign of the cents, so whole-semitone splits read back
as written.

**Keyframes.** Every Transpose Ratio keyframe keeps its time. Premiere interpolates the normalised value (S8; a
linear key is linear in the ratio), JasperEditor interpolates semitones and cents (linear in cents), so the two
curves differ between keys (up to ≈ 405 cents on a full-range 0 → 1 segment). The importer adds intermediate keys
(bisection, ≤ 8 levels, snapped to frames in FCP7) until the curves agree within **0.1 cent** (`PITCH_TOLERANCE_CENTS`); the
exporter does the reverse for JasperEditor keyframes. Hold keys stay holds; Bezier keys are followed through
JasperEditor's Bezier evaluation of the normalised curve (Premiere's audio-parameter easing handles are not
documented — **assumption**). Keyframes of Bypass and of Use Positive Cents are reported and ignored.

**Missing values.** Premiere stores no value for a parameter at its default (Precision in all 63 user instances);
the plug-in state (`OpaqueData` `prop.map` → `ParamList`: Version 1 lists Transpose Ratio, Precision, Splicing
Frequency, Overlapping, Use Appropriate Default Settings; Version 2 adds Use Positive Cents — the `.sesx` order)
fills them (`premierePluginParamList`). The parameter values win where both exist: in S7 the state is sometimes
stale (one instance's state has Splicing 0.0851 / Overlapping 0.5657 where its parameters say 0.0833 / 0.5574).

## 3. The user's projects (S7)

63 instances in 28 projects, all on audio clips (59 on nested sequences, 4 on media), clip speed 1 everywhere:

| Transpose Ratio n | ratio | shift | uses | Use Positive Cents |
|---|---|---|---|---|
| 0.303227752 | 0.954842 | −80.00 c | 45 | 0.75 |
| 0.310624212 | 0.965936 | −60.00 c | 7 | 0.75 → 0.25 (keyframed) |
| 0.310769320 | 0.966154 | −59.61 c | 2 | 0.75 → 0.25 |
| 0.314429432 | 0.971644 | −49.80 c | 2 | 0.75 → 0.25 |
| 0.318106651 | 0.977160 | −40.00 c | 1 | 0.75 → 0.25 |
| 0.325675994 | 0.988514 | −20.00 c | 3 | 0.75 |
| 0.299546808 | 0.949320 | −90.04 c (−1 st +9.96 c) | 1 | 0.75 → 0.25 |
| 0.414974689 | 1.122462 | +200.00 c (+2 st) | 2 | 0.75 |

61 share one custom instance name (the two +2 st ones are unnamed). None bypassed; Use Appropriate Default Settings 0.75 in all;
Splicing Frequency 0.0833…0.0885 and Overlapping 0.557…0.583 vary with the ratio (the automatic defaults); Precision
has no stored value (plug-in state: 1). Plug-in state present in 31 (22 Version 1, 9 Version 2). So that named
voice preset is a slight *lowering* of the voice (20–90 cents, mostly −80), not a chipmunk shift — whole-semitone values
(the ±12 range) are clearly decoded right by §2's evidence, so this is the user's setting, not a decoding error.
Every user instance converts without a warning.

## 4. What is not reproduced, and why the DSP is unchanged

Adobe's Pitch Shifter is a time-domain splicer (S3: it cuts audio into chunks at the Splicing Frequency and overlaps
them; Precision sets its search quality). JasperEditor's is a phase vocoder. The transposition — what the effect is
for — is reproduced exactly (the ratio, keyframes within 0.1 cent). Precision, Splicing Frequency and Overlapping
only tune the artifacts of Adobe's algorithm (stutter, echo, chorusing, "tinny" sound per S1–S3); they have no
meaning for a phase vocoder, and copying their audible character would need Adobe's undisclosed algorithm. Adobe's
effect has no formant control (S1/S2 list every control), so there is no formant parameter to add. The DSP is
therefore not extended; the import report warns when a document chose a non-default Precision or turned the
automatic splicing settings off (the user's projects never do), so the difference is never silent. Preview and
every export path already render `jasper.audio.pitch-shifter` with the same DSP (AGENTS §4).

## 5. Interchange

- **FCP7 XML import**: an audio `filter` is Premiere's Pitch Shifter when its `effectid` is the match name or
  `ADBE Pitch Shifter`, its name is "Desfasador de tono", or a parameter has a Premiere-only name ("Transpose Ratio",
  "Use Positive Cents", "Lineatura", …, or the ExtendScript ids `ADBE Pitch Shifter-000i`); a filter whose
  `effectid` is JasperEditor's id keeps the old semitones/cents reading. A `<name>` that is not one of the effect's
  names becomes the instance name (**assumption**: where Premiere would put a renamed instance in FCP7 XML is not
  documented).
- **FCP7 XML export** writes Premiere's representation: `effectid` = the match name, "Transpose Ratio"
  (`ADBE Pitch Shifter-0001`, normalised, `valuemin` 0 / `valuemax` 1, keyframes), Precision 1, Use Appropriate
  Default Settings 0.75, Use Positive Cents. Shifts beyond ±12 semitones are clamped (warning); an instance name is
  reported as not carried. Whether Premiere's FCP7 importer applies a filter written this way is untested (no
  Premiere available) — the parameter ids follow ExtendScript's naming (**assumption**).
- **`.prproj`**: no importer yet; `premierePitchShifterToJasper({params, bypass, instanceName, pluginState,
  index-ordered params}, report)` takes the decoded component (keyframe times in flicks) for it.
- AAF / OMF / EDL do not carry audio effects (reported as before); OTIO / FCPXML carry the JasperEditor effect as is.
