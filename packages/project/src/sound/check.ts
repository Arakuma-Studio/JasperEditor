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
	DEFAULT_SOUND_DESIGN_SETTINGS,
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
	'TRUNCATED',
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
	TRUNCATED: 'sync',
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
 * normalisation settings (not its analysis), the delivery preset checked, the credits setting and the cue density (when
 * not the default). Picture edits, the licences of the media and transcripts are not in it (a moved anchor makes a cue
 * stale: the next check reports it). Never throws ('' for an unknown sequence).
 */
export function soundCheckInputsHash(
	doc: ProjectDocument,
	sequenceId: string,
	preset: SoundDelivery,
	target?: SoundCheckTarget | null,
): string {
	try {
		const seq = doc.sequences?.[sequenceId] as Sequence | undefined;
		if (!seq) return '';
		const sd = readSoundDesign((seq as { soundDesign?: unknown }).soundDesign);
		const loud = (seq.master as { loudness?: unknown } | undefined)?.loudness;
		const { analysis: _a, ...loudness } = (isRecord(loud) ? loud : {}) as Record<string, unknown>;
		const settings = soundDesignSettingsOf(seq);
		return fnv1a64(
			stable({
				cues: sd ? Object.values(sd.cues).sort((a, b) => (a.id < b.id ? -1 : 1)) : [],
				loudness,
				preset,
				credits: settings.credits ?? null,
				// DENSITY judges the hero spacing and the cue rate by the density (absent at the default: hashes stored
				// before it was hashed stay valid)
				...(settings.density !== DEFAULT_SOUND_DESIGN_SETTINGS.density ? { density: settings.density } : {}),
				// a custom target is part of what was checked (absent for a preset: hashes stored before stay valid)
				...(target ? { target: { lufs: target.integratedLufs, tp: target.truePeakDb } } : {}),
			}),
		);
	} catch {
		return '';
	}
}

/**
 * A custom delivery target a check can be run against instead of a preset's numbers (the Sound Check panel's
 * "Custom…", MCP `sound_check {target}`; wp-note "Phase 5 → WP5.2"): integrated loudness and true-peak ceiling.
 */
export type SoundCheckTarget = { integratedLufs: number; truePeakDb: number };
/** Bounds of a custom target (LUFS / dBTP): the range `mixer.setLoudness` takes, minus the inaudible extremes. */
export const SOUND_CHECK_TARGET_LIMITS = {
	integratedLufs: { min: -40, max: -5 },
	truePeakDb: { min: -12, max: 0 },
} as const;
/** The preset label a check against a custom target reports (a model string). */
export const SOUND_CHECK_CUSTOM_LABEL = 'Custom target';

/** A custom target read from untrusted data (numbers in range, rounded to 0.1), else null. Never throws. */
export function readSoundCheckTarget(v: unknown): SoundCheckTarget | null {
	if (!isRecord(v)) return null;
	const { integratedLufs: l, truePeakDb: p } = v;
	const L = SOUND_CHECK_TARGET_LIMITS;
	if (typeof l !== 'number' || !Number.isFinite(l) || l < L.integratedLufs.min || l > L.integratedLufs.max)
		return null;
	if (typeof p !== 'number' || !Number.isFinite(p) || p < L.truePeakDb.min || p > L.truePeakDb.max)
		return null;
	return { integratedLufs: Math.round(l * 10) / 10, truePeakDb: Math.round(p * 10) / 10 };
}

/**
 * Listen-here verdicts (spec 12 §2.7 "Listen-here list: Sounds right / Flag + note, stored as `comment` markers"): the
 * Sound Check panel writes a user-authored `comment` sequence marker at the listened frame with one of these names
 * (fixed English: they are data an agent reads back, like History labels) and the user's note as its comment. MCP
 * `sound_check` returns them as `humanVerdicts`.
 *
 * Phase 5 verification: a verdict attaches to the moment it judged, not just to a frame. `soundDesign.setVerdict` writes
 * the marker with a structured `soundCheck` field (`SoundCheckVerdictMeta`): the listen slot, the clip or cue listened
 * to (and where it was), the `mixFingerprint` of the whole mix and `soundCheckMomentHash` of what plays in the listened
 * window (±2 s). A verdict is stale when that window sounds different now (a clip in it edited, moved in or out), or
 * its clip / cue moved or is gone; two moments on the same frame about different clips keep separate verdicts. Markers
 * written before (name only) read as unbound verdicts whose staleness is unknown.
 */
export const SOUND_CHECK_VERDICT_MARKER = {
	ok: 'Sound Check: sounds right',
	flag: 'Sound Check: flagged',
} as const;
/** Seconds either side of a listen-here moment the panel plays (4 s in all): the window a verdict judged. */
export const SOUND_CHECK_LISTEN_HALF_SEC = 2;
/** Listen-here slots (spec 12 §2.6 listen[5]). */
export const SOUND_CHECK_LISTEN_SLOT_IDS = ['worst', 'hero', 'loudest', 'densest', 'passing'] as const;
export type SoundCheckListenSlot = (typeof SOUND_CHECK_LISTEN_SLOT_IDS)[number];

/** What a verdict listened to: a clip (at its start frame then) or a cue (at its frame then). */
export type SoundCheckVerdictSubject =
	| { kind: 'clip'; id: string; start: number }
	| { kind: 'cue'; id: string; frame: number };

/** The structured part of a verdict marker (`marker.soundCheck`), written by `soundDesign.setVerdict`. */
export type SoundCheckVerdictMeta = {
	v: 1;
	verdict: keyof typeof SOUND_CHECK_VERDICT_MARKER;
	slot: SoundCheckListenSlot | null;
	subject: SoundCheckVerdictSubject | null;
	/** `mixFingerprint` of the sequence when the verdict was given. */
	mixHash: string;
	/** `soundCheckMomentHash` of the listened window when the verdict was given. */
	momentHash: string;
	/** The `mixHash` of the Sound Check report the moment came from, when known. */
	reportMixHash: string | null;
};

const shortStr = (v: unknown, max = 256): v is string =>
	typeof v === 'string' && v.length > 0 && v.length <= max;
const frameNum = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A verdict marker's `soundCheck` field read from untrusted data, else null. Never throws. */
export function readSoundCheckVerdictMeta(v: unknown): SoundCheckVerdictMeta | null {
	if (!isRecord(v) || v.v !== 1) return null;
	if (v.verdict !== 'ok' && v.verdict !== 'flag') return null;
	if (!shortStr(v.mixHash) || !shortStr(v.momentHash)) return null;
	const slot =
		v.slot === undefined || v.slot === null
			? null
			: (SOUND_CHECK_LISTEN_SLOT_IDS as readonly unknown[]).includes(v.slot)
				? (v.slot as SoundCheckListenSlot)
				: undefined;
	if (slot === undefined) return null;
	let subject: SoundCheckVerdictSubject | null = null;
	if (v.subject !== undefined && v.subject !== null) {
		const sj = v.subject;
		if (!isRecord(sj) || !shortStr(sj.id, 128)) return null;
		if (sj.kind === 'clip' && frameNum(sj.start)) subject = { kind: 'clip', id: sj.id, start: sj.start };
		else if (sj.kind === 'cue' && frameNum(sj.frame)) subject = { kind: 'cue', id: sj.id, frame: sj.frame };
		else return null;
	}
	const reportMixHash =
		v.reportMixHash === undefined || v.reportMixHash === null
			? null
			: shortStr(v.reportMixHash)
				? v.reportMixHash
				: undefined;
	if (reportMixHash === undefined) return null;
	return {
		v: 1,
		verdict: v.verdict,
		slot,
		subject,
		mixHash: v.mixHash,
		momentHash: v.momentHash,
		reportMixHash,
	};
}

/**
 * Hash of what plays in a listen-here window (`frame` ± `SOUND_CHECK_LISTEN_HALF_SEC`): the mix fingerprint of the
 * sequence with only the audio clips that overlap the window (so an edit elsewhere leaves it alone, while an edit of a
 * clip in it, a clip moved in or out, a track, submix or Mix change does not), plus the window. Never throws ('' for an
 * unknown sequence).
 */
export function soundCheckMomentHash(doc: ProjectDocument, sequenceId: string, frame: number): string {
	try {
		const seq = doc.sequences?.[sequenceId] as Sequence | undefined;
		if (!seq) return '';
		const r = seq.settings.frameRate;
		const fps = r && r.num > 0 && r.den > 0 ? r.num / r.den : 30;
		const half = Math.max(1, Math.ceil(SOUND_CHECK_LISTEN_HALF_SEC * fps));
		const f = Number.isFinite(frame) ? Math.max(0, Math.round(frame)) : 0;
		const a = f - half;
		const b = f + half + 1;
		const clips: Record<string, (typeof seq.clips)[string]> = {};
		for (const [id, c] of Object.entries(seq.clips ?? {}))
			if (c && c.start < b && c.start + c.duration > a) clips[id] = c;
		const pruned = { ...seq, clips } as Sequence;
		const window = { ...doc, sequences: { ...doc.sequences, [sequenceId]: pruned } } as ProjectDocument;
		return fnv1a64(`${mixFingerprint(window, sequenceId)}|${a}|${b}`);
	} catch {
		return '';
	}
}

export type SoundCheckHumanVerdict = {
	markerId: string;
	frame: number;
	verdict: keyof typeof SOUND_CHECK_VERDICT_MARKER;
	/** The user's note (the marker's comment), null when empty. */
	note: string | null;
	/** The listen slot and the clip / cue the verdict judged (null: an unbound verdict, written before they were kept). */
	slot: SoundCheckListenSlot | null;
	clipId: string | null;
	cueId: string | null;
	/** Whether the marker carries the structured verdict (`soundDesign.setVerdict`). */
	bound: boolean;
	/**
	 * With a document (`soundCheckHumanVerdicts(seq, {doc})`): whether the verdict still describes what plays there now —
	 * null when it cannot be told (an unbound verdict) — and why not: `moment` (what plays in the listened window changed),
	 * `moved` (its clip / cue is somewhere else now), `gone` (its clip / cue no longer exists).
	 */
	stale?: boolean | null;
	staleReasons?: ('moment' | 'moved' | 'gone')[];
	/** With a document: whether the mix changed anywhere since the verdict (null: unbound). */
	mixChanged?: boolean | null;
};

/** The marker name of a verdict. */
export function soundCheckVerdictMarkerName(verdict: keyof typeof SOUND_CHECK_VERDICT_MARKER): string {
	return SOUND_CHECK_VERDICT_MARKER[verdict];
}

/** Whether a verdict's subject is where it was (`moved`) or gone, in `seq`. */
function subjectState(seq: Sequence, s: SoundCheckVerdictSubject): 'here' | 'moved' | 'gone' {
	if (s.kind === 'clip') {
		const c = (seq.clips as Record<string, { start: number } | undefined>)[s.id];
		if (!c || !Object.hasOwn(seq.clips, s.id)) return 'gone';
		return c.start === s.start ? 'here' : 'moved';
	}
	const sd = readSoundDesign((seq as { soundDesign?: unknown }).soundDesign);
	const cue = sd && Object.hasOwn(sd.cues, s.id) ? sd.cues[s.id] : undefined;
	if (!cue) return 'gone';
	return cue.frame === s.frame ? 'here' : 'moved';
}

/**
 * The listen-here verdicts stored in a sequence's markers (user-authored `comment` markers named as
 * `SOUND_CHECK_VERDICT_MARKER`), in frame order. With `doc` (the document `seq` belongs to) each says whether it is
 * stale (see `SoundCheckHumanVerdict`). Never throws; anything malformed is skipped (a malformed `soundCheck` field reads
 * as an unbound verdict).
 */
export function soundCheckHumanVerdicts(
	seq: unknown,
	opts: { doc?: ProjectDocument } = {},
): SoundCheckHumanVerdict[] {
	const markers = isRecord(seq) ? (seq as { markers?: unknown }).markers : undefined;
	// sequence markers are a list (a record is read too: hostile or older data never throws)
	const list = Array.isArray(markers) ? markers : isRecord(markers) ? Object.values(markers) : [];
	const out: SoundCheckHumanVerdict[] = [];
	const doc = opts.doc;
	const seqId = isRecord(seq) && typeof seq.id === 'string' ? seq.id : null;
	let mixNow: string | null = null;
	const moments = new Map<number, string>();
	for (const m of list.slice(0, 100_000)) {
		if (!isRecord(m) || m.type !== 'comment' || m.author !== 'user') continue;
		const verdict =
			m.name === SOUND_CHECK_VERDICT_MARKER.ok
				? 'ok'
				: m.name === SOUND_CHECK_VERDICT_MARKER.flag
					? 'flag'
					: null;
		if (!verdict || typeof m.id !== 'string') continue;
		if (typeof m.frame !== 'number' || !Number.isInteger(m.frame) || m.frame < 0) continue;
		const note = typeof m.comment === 'string' && m.comment.trim() ? m.comment.trim().slice(0, 2000) : null;
		const meta = readSoundCheckVerdictMeta(m.soundCheck);
		const v: SoundCheckHumanVerdict = {
			markerId: m.id,
			frame: m.frame,
			verdict,
			note,
			slot: meta?.slot ?? null,
			clipId: meta?.subject?.kind === 'clip' ? meta.subject.id : null,
			cueId: meta?.subject?.kind === 'cue' ? meta.subject.id : null,
			bound: !!meta,
		};
		if (doc && seqId) {
			if (!meta) {
				v.stale = null;
				v.staleReasons = [];
				v.mixChanged = null;
			} else {
				try {
					mixNow ??= mixFingerprint(doc, seqId);
					let moment = moments.get(m.frame);
					if (moment === undefined) {
						moment = soundCheckMomentHash(doc, seqId, m.frame);
						moments.set(m.frame, moment);
					}
					const reasons: ('moment' | 'moved' | 'gone')[] = [];
					if (moment !== meta.momentHash) reasons.push('moment');
					const where = meta.subject ? subjectState(seq as Sequence, meta.subject) : 'here';
					if (where !== 'here') reasons.push(where);
					v.stale = reasons.length > 0;
					v.staleReasons = reasons;
					v.mixChanged = mixNow !== meta.mixHash;
				} catch {
					v.stale = null;
					v.staleReasons = [];
					v.mixChanged = null;
				}
			}
		}
		out.push(v);
	}
	return out.sort((a, b) => a.frame - b.frame || (a.markerId < b.markerId ? -1 : 1));
}

/**
 * The verdict a listen-here moment shows: the last one at its frame about the same clip / cue (an unbound verdict, or
 * one about no clip / cue in particular, counts for any moment at the frame). `null` when there is none.
 */
export function soundCheckVerdictFor<
	V extends Pick<SoundCheckHumanVerdict, 'frame' | 'clipId' | 'cueId' | 'bound'>,
>(
	verdicts: readonly V[],
	moment: { frame: number; clipId?: string | null; cueId?: string | null },
): V | null {
	const clipId = moment.clipId ?? null;
	const cueId = clipId ? null : (moment.cueId ?? null);
	// an unbound verdict, or one about no clip / cue in particular, covers every moment at its frame
	const at = verdicts.filter(
		(v) =>
			v.frame === moment.frame &&
			(!v.bound || (v.clipId === null && v.cueId === null) || (v.clipId === clipId && v.cueId === cueId)),
	);
	return at.at(-1) ?? null;
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
		summary.inputsHash !== soundCheckInputsHash(doc, sequenceId, preset, readSoundCheckTarget(summary.target))
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
	syncCut:
		'{0} is cut {1} ms after its aligned point by the end of its clip at {2}: the sound it is placed for does not play',
	truncated: '{0} is cut by the end of its clip at {1}, {2} ms before the sound has faded (−60 dB)',
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
	fixUncut: 'Lengthen the clip by {0} frames so the whole sound plays',
	fixRepad: 'Register "{0}" again (its copy ends in silence now) and swap it in, so the whole sound plays',
	fixRunOut: 'Let the clip play to the end of its sound (past the end of its media)',
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
	// why a fix needs the user's judgement (`fix.whyMessage`; Phase 5 verification: translated like the rest)
	whyNormalise: 'The export then normalises to the target',
	whyLimiterCeiling: 'The export limiter then holds the ceiling',
	whyLimiterUnder: 'The export limiter then keeps the mix under its ceiling',
	whyRebalance:
		'Solving the sound effects against the bed and the true-peak ceiling lowers the loudest hits; listen to the result',
	whyUserGain: 'Its gain was set by hand',
	whySolverGain: "The solver's gain does not resolve it: {0}",
	whyDucked:
		'The music is ducked already: Auto-Match levels the dialogue and music clips by type (it changes their gains)',
	whyDuckDepth: 'Ducking by {0} dB leaves the music {1} LU under the voice',
	whySilence: 'Only if the silence is intended',
	whyKeepCue: 'Or keep it where it is: it no longer follows the picture',
	whyNoPicture: 'Only if nothing on screen calls for it',
	whySimilar: 'A different sound found by similarity: listen before keeping it',
} as const;
export type SoundCheckMessageKey = keyof typeof SOUND_CHECK_MESSAGES;

/**
 * Why a placed sound's timing cannot be measured (the second parameter of `syncUnmeasurable`): fixed English fragments,
 * translated by the editor (model strings).
 */
export const SOUND_CHECK_UNMEASURED = {
	notInMix: 'it is not in the mix (disabled, muted track or offline media)',
	reversed: 'it plays reversed',
	offline: 'its media is offline',
	short: 'its sound is too short around its aligned point',
	edge: 'its cue is at the edge of the checked range',
	undecodable: 'its file could not be decoded',
	covered: 'other sounds cover it in the sound-effects mix',
} as const;

/** Every Sound Check template (the editor's model strings). */
export const SOUND_CHECK_MODEL_STRINGS: readonly string[] = [
	...Object.values(SOUND_CHECK_MESSAGES),
	...Object.values(SOUND_CHECK_UNMEASURED),
	SOUND_CHECK_CUSTOM_LABEL,
];

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
