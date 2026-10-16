// Sound Check (spec 12 §2.6, P5-R1; wp-note "Phase 5 → WP5.1"): the codes, severities, thresholds and verdict of the
// engine's `sound-check` job, the translatable message templates of its findings, and whether a stored summary
// (`soundDesign.lastCheck`, written by `soundDesign.setCheck`) is still current. Pure.
//
// Message templates follow the model-string convention (`messages.ts`): English text with `{0}`… placeholders for
// numbers, timecodes and names (never translated); the editor translates a template it lists in its model strings.
// Every finding carries `{key: template, params, text}` so an agent reads `text` and the UI translates `key`.
import { mixFingerprint } from '../audio/fingerprint.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import {
	type CueKind,
	readSoundDesign,
	type SoundCheckSummary,
	type SoundDelivery,
	soundDesignSettingsOf,
} from '../schema/sound.ts';
import { fnv1a64 } from '../structure/nest.ts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

export const SOUND_CHECK_CODES = [
	'LOUDNESS',
	'TRUE_PEAK',
	'OUT_OF_SYNC',
	'MASKED',
	'OVERLOAD',
	'MUSIC_OVER_VOICE',
	'SILENCE',
	'DIP',
	'STALE_CUE',
	'NO_PICTURE_EVENT',
	'DENSITY',
	'REPEAT',
	'LICENSE',
	'CREDITS',
] as const;
export type SoundCheckCode = (typeof SOUND_CHECK_CODES)[number];
export const SOUND_CHECK_SEVERITIES = ['error', 'warning', 'info'] as const;
export type SoundCheckSeverity = (typeof SOUND_CHECK_SEVERITIES)[number];
export const SOUND_CHECK_VERDICTS = ['pass', 'warn', 'fail'] as const;
export type SoundCheckVerdict = (typeof SOUND_CHECK_VERDICTS)[number];
/** Groups of the Sound Check panel (spec 12 §2.7 "issues grouped by category"). */
export const SOUND_CHECK_CATEGORY: Readonly<
	Record<SoundCheckCode, 'loudness' | 'sync' | 'mix' | 'cues' | 'licence'>
> = {
	LOUDNESS: 'loudness',
	TRUE_PEAK: 'loudness',
	OUT_OF_SYNC: 'sync',
	MASKED: 'mix',
	OVERLOAD: 'mix',
	MUSIC_OVER_VOICE: 'mix',
	SILENCE: 'mix',
	DIP: 'mix',
	STALE_CUE: 'cues',
	NO_PICTURE_EVENT: 'cues',
	DENSITY: 'cues',
	REPEAT: 'cues',
	LICENSE: 'licence',
	CREDITS: 'licence',
};

/**
 * Sync tolerance by cue kind (frames either side): spec 12 §2.6 gives cut ±1, land ±2, move ±3, appear (start) ±1; the
 * others are decisions (wp-note): transitions, emphasis and reveals ride a visual span like a land (±2), exits, beats
 * and manual cues are points like a cut (±1). Silence cues have no sound.
 */
export const SYNC_TOLERANCE_FRAMES: Readonly<Record<CueKind, number>> = {
	cut: 1,
	land: 2,
	move: 3,
	appear: 1,
	transition: 2,
	exit: 1,
	emphasis: 2,
	reveal: 2,
	beat: 1,
	manual: 1,
	silence: 0,
};
/** The SFX stem is searched this far either side of the cue (spec 12 §2.6: "around the cue ±3 frames"). */
export const SYNC_SEARCH_FRAMES = 3;
/** Least normalised correlation that counts as "found" (the sound is in the stem there). */
export const SYNC_MIN_CORRELATION = 0.3;
/** MASKED: the dominant-band lift (solver definition) a placed sound needs (spec 12 §2.6). Ambient beds are not checked. */
export const MASKED_MIN_LIFT_DB = { hero: 3, support: 1.5 } as const;

export const SOUND_CHECK_THRESHOLDS = {
	/** LOUDNESS: integrated loudness within the preset's target ±1 LU (spec 12 §2.6; `DELIVERY_TOLERANCE_LU`). */
	loudnessToleranceLu: 1,
	/** TRUE_PEAK: over the preset's ceiling by more than this (dB; the limiter's guarantee is +0.05). */
	truePeakToleranceDb: 0.1,
	/** Integrated loudness needs at least one 400 ms gating block of audible audio (BS.1770-4). */
	minMeasurableSec: 0.4,
	/** SILENCE: under −60 dBFS (10 ms RMS, loudest channel) for ≥ 0.5 s outside silence cues. */
	silenceDbfs: -60,
	silenceMinSec: 0.5,
	/** DIP: the short-term loudness falls more than 10 LU and comes back (at least 6 LU) within 6 s. */
	dipLu: 10,
	dipRecoverLu: 6,
	dipRecoverSec: 6,
	/** MUSIC_OVER_VOICE: music at least 8 LU under the voice during speech (spec 12 §2.4 relative target). */
	musicUnderVoiceLu: 8,
	/** Speech segments shorter than this are not judged (s). */
	minSpeechSec: 0.5,
	/** OVERLOAD: the export's true-peak limiter reducing more than 3 dB. */
	limiterMaxGrDb: 3,
	/** OVERLOAD: without loudness normalisation, a sample peak at or over full scale clips the fixed-point export. */
	clipDbfs: 0,
	/** NO_PICTURE_EVENT: a picture event within ±2 frames of a derived cue (the cue merge distance). */
	pictureEventFrames: 2,
	/** NO_PICTURE_EVENT: a motion speed change of at least this (screen diagonals / s) counts as an event. */
	motionEventSpeed: 0.05,
	/** Longest range one check renders (s): 4 h. */
	maxRangeSec: 4 * 3600,
} as const;

/** Verdict of a set of findings: fail with an error, warn with a warning, else pass (info never fails). */
export function soundCheckVerdict(issues: readonly { severity: SoundCheckSeverity }[]): SoundCheckVerdict {
	let warn = false;
	for (const i of issues) {
		if (i.severity === 'error') return 'fail';
		if (i.severity === 'warning') warn = true;
	}
	return warn ? 'warn' : 'pass';
}

/** Counts per code and per severity (`{OUT_OF_SYNC: 2, error: 2, …}`; zero counts left out). */
export function soundCheckCounts(
	issues: readonly { code: SoundCheckCode; severity: SoundCheckSeverity }[],
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const i of issues) {
		out[i.code] = (out[i.code] ?? 0) + 1;
		out[i.severity] = (out[i.severity] ?? 0) + 1;
	}
	return out;
}

function stable(v: unknown): string {
	if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
	if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
	const keys = Object.keys(v as object).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * Hash of what a Sound Check depends on besides the mix (`mixFingerprint`): the sequence's cues, the Mix's loudness
 * normalisation settings (not its analysis), the delivery preset checked and the credits setting. Picture edits are not
 * in it (a moved anchor makes a cue stale: the next check reports it). Never throws ('' for an unknown sequence).
 */
export function soundCheckInputsHash(
	doc: ProjectDocument,
	sequenceId: string,
	preset: SoundDelivery,
): string {
	try {
		const seq = doc.sequences?.[sequenceId] as Sequence | undefined;
		if (!seq) return '';
		const sd = readSoundDesign((seq as { soundDesign?: unknown }).soundDesign);
		const loud = (seq.master as { loudness?: unknown } | undefined)?.loudness;
		const { analysis: _a, ...loudness } = (isRecord(loud) ? loud : {}) as Record<string, unknown>;
		return fnv1a64(
			stable({
				cues: sd ? Object.values(sd.cues).sort((a, b) => (a.id < b.id ? -1 : 1)) : [],
				loudness,
				preset,
				credits: soundDesignSettingsOf(seq).credits ?? null,
			}),
		);
	} catch {
		return '';
	}
}

export type SoundCheckStatus = {
	/** `none`: never checked; `current`: the summary describes this mix; `stale`: something it measured changed. */
	state: 'none' | 'current' | 'stale';
	summary: SoundCheckSummary | null;
	/** What changed since: the mix (`mixFingerprint`), the cues / loudness settings / credits, the delivery preset. */
	reasons: ('mix' | 'inputs' | 'preset')[];
	/** The sequence's current mix fingerprint. */
	mixHash: string;
};

/**
 * Whether the stored Sound Check summary of a sequence still describes it (spec 12 §2.6 staleness): stale when the mix
 * fingerprint, the other inputs (`soundCheckInputsHash` at the summary's preset) or the sequence's delivery preset
 * differ. Never throws.
 */
export function soundCheckStatus(doc: ProjectDocument, sequenceId: string): SoundCheckStatus {
	const seq = doc?.sequences?.[sequenceId] as Sequence | undefined;
	if (!seq) return { state: 'none', summary: null, reasons: [], mixHash: '' };
	const mixHash = mixFingerprint(doc, sequenceId);
	const sd = readSoundDesign((seq as { soundDesign?: unknown }).soundDesign);
	const summary = sd?.lastCheck ?? null;
	if (!summary) return { state: 'none', summary: null, reasons: [], mixHash };
	const reasons: SoundCheckStatus['reasons'] = [];
	if (summary.mixHash !== mixHash) reasons.push('mix');
	const preset = (summary.preset ?? soundDesignSettingsOf(seq).delivery) as SoundDelivery;
	if (
		summary.inputsHash !== undefined &&
		summary.inputsHash !== soundCheckInputsHash(doc, sequenceId, preset)
	)
		reasons.push('inputs');
	if (summary.preset !== undefined && summary.preset !== soundDesignSettingsOf(seq).delivery)
		reasons.push('preset');
	return { state: reasons.length ? 'stale' : 'current', summary, reasons, mixHash };
}

/**
 * Message templates of Sound Check findings, fixes and listen-here reasons (`{n}` = numbers, timecodes, names). The
 * engine fills them (`soundCheckMessage`); the editor translates by the template.
 */
export const SOUND_CHECK_MESSAGES = {
	loudnessOff: 'Integrated loudness {0} LUFS is {1} LU off the {2} target ({3} LUFS ±1 LU)',
	loudnessShort: 'Integrated loudness cannot be measured: less than 400 ms of audible audio ({0} s checked)',
	loudnessSilent: 'The mix is silent: there is no loudness to measure',
	loudnessRange: 'Loudness of the checked range only ({0} to {1}), not of the whole sequence',
	truePeak: 'True peak {0} dBTP is over the {1} ceiling of {2} dBTP',
	syncEarly: '{0} plays {1} ms early on its {2} cue at {3} (tolerance ±{4} frames)',
	syncLate: '{0} plays {1} ms late on its {2} cue at {3} (tolerance ±{4} frames)',
	syncNotFound: '{0} was not found in the sound-effects mix within ±{1} frames of its cue at {2}',
	syncMetadataOnly:
		'{0} plays {1} ms off its cue at {2} though it is placed on it (the mix renders it there)',
	syncUnmeasurable: '{0}: its timing cannot be measured ({1})',
	maskedHero:
		'Hero sound {0} at {1} clears the bed by only {2} dB in its dominant band ({3} Hz; at least {4} dB)',
	maskedSupport:
		'Support sound {0} at {1} clears the bed by only {2} dB in its dominant band ({3} Hz; at least {4} dB)',
	overloadBed: '{0} at {1} peaks {2} LU over the bed (at most {3} LU)',
	overloadLimiter:
		'The export limiter pulls the mix down by {0} dB at {1} (more than {2} dB flattens the hits)',
	overloadClip: 'The mix reaches {0} dBFS at {1} and loudness normalisation is off: the export clips',
	musicOverVoice:
		'From {0} to {1} the music is only {2} LU under the voice (at least {3} LU); its ducking is off',
	musicOverVoiceDucked:
		'From {0} to {1} the music is only {2} LU under the voice (at least {3} LU) although it is ducked',
	silence: 'Silence under −60 dBFS for {0} s from {1} to {2}',
	dip: 'The mix drops {0} LU at {1} (short-term loudness) with no stop-before, cut or silence cue to explain it',
	staleCue: 'Cue {0} at {1} is out of date: what it follows is now at {2}',
	staleCueLost: 'Cue {0} at {1} follows something that no longer exists',
	noPictureEvent:
		'Cue {0} at {1}: no picture event within ±{2} frames (no cut, transition, motion, text or graphic)',
	densityHeroes:
		'Two heroes {0} s apart at {1} and {2} (at most one per {3} s at {4} density, never within 0.5 s)',
	densityRate: '{0} sound cues within one second at {1} (at most {2} per second at {3} density)',
	repeat: 'The same sound "{0}" plays twice in a row, at {1} and at {2}',
	licenseNc: '"{0}" is licensed {1}: non-commercial use only',
	licenseNd: '"{0}" is licensed {1}: no derivatives (it may not be edited or mixed)',
	licenseUnknown: '"{0}" has no known licence ({1})',
	licenseUser: '"{0}" comes from a sound folder whose licence was not declared',
	credits: '{0} sounds need a credit ({1}) and the exports of this sequence carry no credits file',
	listenWorst: 'Worst finding: {0}',
	listenHero: 'Biggest hero: {0} ({1} LUFS momentary)',
	listenLoudest: 'Loudest moment of the mix: {0} LUFS momentary',
	listenDensest: 'Busiest moment: {0} sound effects within one second',
	listenPassing: 'A cue that passes every check: {0}',
	fixAlign: 'Align its peak to the cue',
	fixGain: 'Set its gain to {0} dB (masking solver)',
	fixRebalance: 'Rebalance the sound effects against the bed (masking solver)',
	fixLoudness: 'Normalise the mix to {0} LUFS / {1} dBTP',
	fixDuck: 'Duck the music under the voice',
	fixDelivery: 'Apply the {0} delivery (Auto-Match and ducking)',
	fixSilenceCue: 'Mark it as intended silence (a silence cue)',
	fixResync: 'Move the cue and its sounds to what it follows',
	fixRemoveCue: 'Remove the cue and its sounds',
	fixDemote: 'Make the later hero a support sound',
	fixSwap: 'Swap to "{0}" ({1})',
	fixCredits: 'Export the credits with the sequence ({0} file)',
} as const;
export type SoundCheckMessageKey = keyof typeof SOUND_CHECK_MESSAGES;

/** Every Sound Check template (the editor's model strings). */
export const SOUND_CHECK_MODEL_STRINGS: readonly string[] = Object.values(SOUND_CHECK_MESSAGES);

export type SoundCheckMessage = { key: string; params: (string | number)[]; text: string };

/** A finding's message: the template (the translation key), its parameters and the English text. */
export function soundCheckMessage(
	key: SoundCheckMessageKey,
	...params: readonly (string | number)[]
): SoundCheckMessage {
	const template: string = SOUND_CHECK_MESSAGES[key];
	const text = template.replace(/\{(\d+)\}/g, (m, i: string) =>
		Number(i) < params.length ? String(params[Number(i)]) : m,
	);
	return { key: template, params: [...params], text };
}
