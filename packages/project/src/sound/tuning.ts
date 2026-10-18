// Tune tonal sounds to the music's key (spec 12 P6-E11 "Tune to the key"; wp-note "Phase 6 → WP-E7"). A chime,
// shimmer or any clearly pitched sound (YIN `pitchConfidence` ≥ 0.8) placed over a music clip whose key is clear
// (Krumhansl–Schmuckler confidence ≥ 0.6, `@jasper/audio-fx` `estimateKey`, measured by the engine's beat analysis)
// is moved by varispeed to the nearest note of the key's scale (natural minor for minor keys), within ±2 st. The reason
// reads "tuned +1 st to A minor". A run (P6-E10 runs climb) is tuned as one: its first step to the nearest scale note,
// each later step to the next note of the scale above the previous one (a scale run instead of semitones, so every
// step is in key), up to four steps above. Pure; never throws.
import { isSoundTypeId, type SoundTypeId } from './taxonomy.ts';

export type KeyMode = 'major' | 'minor';

/** The key of a music clip, as the engine's beat analysis reports it (`BeatsResult.key`). */
export type MusicKeyRef = {
	tonic: number;
	mode: KeyMode;
	confidence: number;
	name?: string;
};

/** A key this clear (0…1) is tuned to (spec 12 P6-E11). */
export const TUNE_MIN_KEY_CONFIDENCE = 0.6;
/** A sound pitched this clearly (YIN, 0…1) is tuned whatever its type. */
export const TUNE_MIN_PITCH_CONFIDENCE = 0.8;
/** The largest tuning shift (semitones). The nearest scale note is never more than 1 st away; ±2 is the spec's bound. */
export const TUNE_MAX_ST = 2;
/** A sound within this many semitones of a scale note is already in key (no shift). */
export const TUNE_IN_KEY_ST = 0.1;
/** Types tuned by their nature (with a measured pitch). */
export const TUNE_TONAL_TYPES: readonly SoundTypeId[] = ['chime', 'shimmer'];
/** Scale steps a tuned run climbs at most (P6-E10's +4 cap, counted in steps of the scale). */
export const TUNE_RUN_MAX_STEPS = 4;

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
/** Krumhansl–Kessler stabilities (major / minor; index = semitones over the tonic): the tie-break between two notes. */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const mod12 = (x: number) => ((Math.round(x) % 12) + 12) % 12;

/** A usable key (a tonic 0…11 and a mode), else null. */
export function readMusicKey(raw: unknown): MusicKeyRef | null {
	const k = raw as MusicKeyRef | null;
	if (!k || typeof k !== 'object') return null;
	if (!Number.isInteger(k.tonic) || k.tonic < 0 || k.tonic > 11) return null;
	if (k.mode !== 'major' && k.mode !== 'minor') return null;
	const confidence = fin(k.confidence) ? Math.max(0, Math.min(1, k.confidence)) : 0;
	return { tonic: k.tonic, mode: k.mode, confidence, name: musicKeyName(k.tonic, k.mode) };
}

export const musicKeyName = (tonic: number, mode: KeyMode): string => `${NAMES[mod12(tonic)]} ${mode}`;

/** "A4", "B♭3": the note name of a MIDI number (rounded). */
export function midiNoteName(midi: number): string {
	const m = Math.round(midi);
	return `${NAMES[mod12(m)]}${Math.floor(m / 12) - 1}`;
}

/** Whether a MIDI note (rounded) is in the key's scale. */
export function inKey(midi: number, key: Pick<MusicKeyRef, 'tonic' | 'mode'>): boolean {
	const scale = key.mode === 'minor' ? MINOR : MAJOR;
	return scale.includes(mod12(Math.round(midi) - key.tonic));
}

/** Whether a sound is tuned to the music: a tonal type, or a clear pitch (`pitchConfidence` ≥ 0.8); it needs a pitch. */
export function isTunable(
	types: readonly unknown[] | null | undefined,
	d: { pitchMidi?: number | null; pitchConfidence?: number | null } | null | undefined,
): boolean {
	if (!d || !fin(d.pitchMidi)) return false;
	const tonal = (Array.isArray(types) ? types : []).some(
		(t) => isSoundTypeId(t) && TUNE_TONAL_TYPES.includes(t),
	);
	return tonal || (fin(d.pitchConfidence) && d.pitchConfidence >= TUNE_MIN_PITCH_CONFIDENCE);
}

export type Tuning = {
	/** The shift (semitones; the clip's varispeed pitch). 0 when the sound is already in key. */
	st: number;
	/** The note it lands on (MIDI, whole). */
	targetMidi: number;
	note: string;
	key: string;
};

/**
 * The nearest note of the key's scale to `pitchMidi` within ±`maxSt` (default 2; the nearest is ≤ 1 st away in a
 * diatonic scale). Ties (a note exactly between two scale notes) go to the more stable one (Krumhansl–Kessler), then
 * down. Null without a pitch or key.
 */
export function tuneToKey(
	pitchMidi: number,
	key: Pick<MusicKeyRef, 'tonic' | 'mode'>,
	maxSt = TUNE_MAX_ST,
): Tuning | null {
	if (!fin(pitchMidi) || pitchMidi < 0 || pitchMidi > 140) return null;
	if (!Number.isInteger(key?.tonic) || (key.mode !== 'major' && key.mode !== 'minor')) return null;
	const kk = key.mode === 'minor' ? KK_MINOR : KK_MAJOR;
	let best: { m: number; d: number; w: number } | null = null;
	for (let m = Math.floor(pitchMidi - maxSt); m <= Math.ceil(pitchMidi + maxSt); m++) {
		if (!inKey(m, key)) continue;
		const d = Math.abs(m - pitchMidi);
		if (d > maxSt + 1e-9) continue;
		const w = kk[mod12(m - key.tonic)]!;
		if (
			!best ||
			d < best.d - 1e-9 ||
			(Math.abs(d - best.d) <= 1e-9 && (w > best.w || (w === best.w && m < best.m)))
		)
			best = { m, d, w };
	}
	if (!best) return null;
	const raw = best.m - pitchMidi;
	const st = Math.abs(raw) <= TUNE_IN_KEY_ST ? 0 : Math.round(raw * 1000) / 1000;
	return { st, targetMidi: best.m, note: midiNoteName(best.m), key: musicKeyName(key.tonic, key.mode) };
}

/**
 * The shifts of a run's steps tuned as one (`runSt[i]` = the semitones the grammar gives step i: 0, +1, +2 …): step 0
 * goes to the nearest scale note, each later step that climbs goes to the next scale note above the previous step
 * (at most `TUNE_RUN_MAX_STEPS` steps above the first); a step that does not climb keeps the previous note. Returns the
 * TOTAL shift of each step from the source pitch (semitones), or null without a pitch or key.
 */
export function tuneRun(
	pitchMidi: number,
	runSt: readonly number[],
	key: Pick<MusicKeyRef, 'tonic' | 'mode'>,
): number[] | null {
	const first = tuneToKey(pitchMidi, key);
	if (!first || !runSt.length) return null;
	const out: number[] = [];
	let note = first.targetMidi;
	let steps = 0;
	for (let i = 0; i < runSt.length; i++) {
		const climbs = i > 0 && fin(runSt[i]) && fin(runSt[i - 1]) && runSt[i]! > runSt[i - 1]!;
		if (climbs && steps < TUNE_RUN_MAX_STEPS) {
			let n = note + 1;
			while (!inKey(n, key)) n++;
			note = n;
			steps++;
		}
		const st = note - pitchMidi;
		out.push(Math.abs(st) <= TUNE_IN_KEY_ST ? 0 : Math.round(st * 1000) / 1000);
	}
	return out;
}

/** "tuned +1 st to A minor" (the plan's and the guide's wording; ±0.01 st precision). */
export function tuningReason(st: number, key: string): string {
	if (!st) return `already in ${key}`;
	const v = Math.round(st * 100) / 100;
	return `tuned ${v > 0 ? '+' : ''}${v} st to ${key}`;
}
