// Sound Check (spec 12 §2.6, §2.8, P5-R1; wp-note "Phase 5 → WP5.1"): the `sound-check` job. Measured QA of a
// sequence's sound that the user and an agent can act on.
//
// 1. Render, in ONE pass over the range (`stems.ts`: one export mixer per stem, every clip decoded once), the mix and
//    its stems — sound effects (`isSfxClip`), dialogue, music, ambience (Essential Sound types) and the bed (everything
//    that is not a sound effect) — into 10 ms curves (`CurveMeter`), plus the BS.1770 meter of the mix and, around each
//    placed sound effect's cue, the SFX stem itself.
// 2. Deliver the mix as the export does: with the Mix's loudness normalisation on, `target − integrated` and the
//    look-ahead true-peak limiter (the same parameters as `renderMixdown`) in a second pass over the first pass's file —
//    the final loudness, true peak, curve and the limiter's gain reduction per 10 ms.
// 3. Speech: transcript words plus voice activity of the dialogue stem (10 ms levels over `vadThreshold`, ≥ −50 dBFS).
// 4. Sound effects against the bed with the masking solver's own measurements and definitions (`measureSfxEvents`,
//    `evaluateSfxGains`: the lower sound effects under each one count as the solver counts them, `solveSfxGains`):
//    MASKED, OVERLOAD (peak over the bed) and their gain fixes.
// 5. Sync: each placed sound's file, decoded around its aligned point at its speed, located in the SFX stem by
//    cross-correlation within ±3 frames of its cue (`locateByCorrelation`): OUT_OF_SYNC with the offset in ms.
// 6. The rest from the document and the curves: LOUDNESS, TRUE_PEAK, OVERLOAD (limiter, clipping), MUSIC_OVER_VOICE,
//    SILENCE, DIP, STALE_CUE, NO_PICTURE_EVENT, DENSITY, REPEAT, LICENSE, CREDITS; the per-event table; five listen-here
//    moments; the verdict. Command fixes are dry-run on a copy of the document and only kept when they apply.
//
// Short media never pass trivially: less than 400 ms of audible audio makes the loudness "not measurable" (a warning).
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	SoundCheckEvent,
	SoundCheckFix,
	SoundCheckIssue,
	SoundCheckListen,
	SoundCheckLoudness,
	SoundCheckReport,
	SoundCheckRequest,
	SoundCheckResult,
	SoundEntry,
} from '@jasper/api';
import {
	SOUND_ANALYSIS_SECONDS,
	SOUND_CHECK_LIMITS,
	SoundCheckRequestSchema,
	SoundSearchQuerySchema,
} from '@jasper/api';
import {
	defaultChannelWeights,
	LoudnessMeter,
	type LoudnessSummary,
	TruePeakDetector,
	TruePeakLimiter,
} from '@jasper/audio-dsp';
import {
	BED_CAP_LU,
	CURVE_HOP_SEC,
	CurveMeter,
	evaluateSfxGain,
	evaluateSfxGains,
	LOUDNESS_FLOOR_LUFS,
	locateByCorrelation,
	loudnessCurve,
	maxPool,
	ProfileMeter,
	type SolverEvent,
	type StemCurves,
	sfxOverlapTerms,
	silentCurves,
} from '@jasper/audio-fx';
import {
	type AudioClip,
	applySoundAcknowledgements,
	applyTransaction,
	type ClipSfx,
	type CueKind,
	clipLaneTime,
	createRandomIdSource,
	cueAnchorFrame,
	DELIVERY_DUCK_DB,
	DENSITY_BUDGETS,
	deliveryPreset,
	deriveCues,
	dialogueRegions,
	dialogueSpans,
	duckingDepthBy,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	frameToSample,
	HERO_MIN_SEC,
	insideDialogueRegion,
	isCommercialSafe,
	isSfxClip,
	isShareAlike,
	LIBRARY_PAD_MAX_SECONDS,
	type LibraryInexactReason,
	type LibraryProvenance,
	libraryTrailSilenceSamples,
	licenseClass,
	MASKED_MIN_LIFT_DB,
	type MediaAsset,
	type MgTemplateRegistry,
	mediaDurationFlicks,
	mixFingerprint,
	type ProjectDocument,
	planSoundCheckFixes,
	type Rational,
	REFERENCE_PROFILE_LIMITS,
	type ReferenceProfile,
	type Registries,
	readClipSfx,
	readEssentialSound,
	readLibraryProvenance,
	readSoundCheckTarget,
	requiresAttribution,
	roomToneSpan,
	type Sequence,
	SOUND_CHECK_CAP_TOLERANCE_LU,
	SOUND_CHECK_CATEGORY,
	SOUND_CHECK_CODES,
	SOUND_CHECK_CUSTOM_LABEL,
	SOUND_CHECK_MASKING_TERMS_MAX,
	SOUND_CHECK_THRESHOLDS,
	SOUND_CHECK_UNMEASURED,
	SOUND_DESIGN_LIMITS,
	type SoundCheckCode,
	type SoundCheckLevelGuard,
	type SoundCheckLevelModel,
	type SoundCheckMessage,
	type SoundCheckSeverity,
	type SoundCheckTarget,
	type SoundCue,
	type SoundDelivery,
	SYNC_END_WINDOW_MS,
	SYNC_MIN_CORRELATION,
	SYNC_SEARCH_FRAMES,
	SYNC_TOLERANCE_FRAMES,
	sequenceDuration,
	sequenceTimecode,
	sequenceWords,
	soundCheckFixCandidates,
	soundCheckInputsHash,
	soundCheckMessage,
	soundCredits,
	soundCuesOf,
	soundDesignSettingsOf,
	soundTimingOf,
	trackLabel,
	variationForFill,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { ProposalService, Requester } from '../proposals/service.ts';
import { LOCAL_PROTOCOLS, readPlanar } from '../sounds/decode.ts';
import type { SoundService } from '../sounds/service.ts';
import { vadThreshold } from '../speech/core/vad.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { sec } from '../tools/ffmpeg.ts';
import { HttpError } from '../tools/reply.ts';
import { type AudioWorld, audioWorld, type MeasureCache, measureSfxEvents, VAD_FLOOR_DBFS } from './bed.ts';
import { planRoomTone } from './beds.ts';
import {
	arcFindings,
	CheckProbes,
	coverageFindings,
	EdgeTap,
	edgeFindings,
	endingFindings,
	type FindCtx,
	type FindRow,
	harshFindings,
	layerFindings,
} from './check-findings.ts';
import type { EngineCueSources } from './engine-cues.ts';
import {
	gainReport,
	levelOptions,
	type SfxInfo,
	sfxInfoOf,
	solveAt,
	solvedLevel,
	solverEventOf,
} from './levels.ts';
import { liveDocument, PlanInputError, planSequence } from './plan.ts';
import { looWarning, missingProfileWarning, referenceFindings, sequencePicture } from './profile.ts';
import {
	classifyStems,
	mixLayoutOf,
	renderStems,
	STEM_NAMES,
	type StemName,
	type StemSpec,
} from './stems.ts';
import { voiceServiceFor } from './voice.ts';

export const SOUND_CHECK_LABEL = 'Sound Check Result';
/** Pre-roll rendered before the range (hops of 10 ms): the 3 s short-term window's half and K-weighting warm-up. */
const PRE_HOPS = 200;
/** Post-roll after the range (hops). */
const POST_HOPS = 150;
/** Reference window around a sound's aligned point (s): before / after, by alignment. */
const REF_WINDOW: Record<'peak' | 'start' | 'end', [number, number]> = {
	peak: [0.05, 0.2],
	start: [0, 0.25],
	end: [0.25, 0],
};
/** A clip that ends less than this after its aligned point (s) cuts the sound it is placed for. */
const CUT_MIN_SEC = 0.02;
/** TRUNCATED: a clip ending this much (s) before its sound has faded cuts its tail (a sample is 0.02 ms). */
const TAIL_SLACK_SEC = 0.0005;
/** Reference decodes at once. */
const DECODE_CONCURRENCY = 4;
/** "Audible" for the measurable-loudness rule: a 10 ms hop over BS.1770's absolute gate level (−70 dBFS). */
const AUDIBLE_DBFS = -70;
/** A sound's level model covers its clip and this much after it (s): effect tails (decision; WP6.5b). */
const LEVEL_TAIL_SEC = 0.5;
/** Interface types: patterns (typewriter keys) are not counted against the cue rate and repeat by design. */
const INTERFACE_TYPES: ReadonlySet<string> = new Set(['ui', 'click', 'key', 'tick']);

type Stem = StemName;
const STEMS = STEM_NAMES;

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const finOrNull = (x: number) => (Number.isFinite(x) ? r2(x) : null);
/** A dB / LU value for a message: one decimal, true minus sign. */
const fmt = (x: number) => {
	const v = Math.round(x * 10) / 10;
	return `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
};

export type SoundCheckDeps = {
	agent: () => AgentService | undefined;
	sounds: () => SoundService | undefined;
	ffmpeg: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	registries: Registries;
	mgTemplates: MgTemplateRegistry;
	cache?: MeasureCache;
	/** P6: measured shot changes and picture motion (only what is already analysed) for NO_PICTURE_EVENT. */
	engineCues?: () => EngineCueSources | undefined;
	/** P6-E5: the proposals (a proposal check reads its proposal and stores its summary there). */
	proposals?: () => ProposalService | undefined;
	/** P6-E5: the sequence's kept report (the base a proposal check is compared with when it is current). */
	keptReport?: (
		projectId: string,
		sequenceId: string,
	) => Promise<{ result: SoundCheckResult; jobId: string | null } | null>;
	/** P6-E8: the reference profile library. */
	profiles?: () => { get(id: string): Promise<ReferenceProfile | null> } | undefined;
};

export type CheckEnv = {
	ff: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	registries: Registries;
	mgTemplates: MgTemplateRegistry;
	sounds?: SoundService | undefined;
	cache?: MeasureCache;
	/** P6: footage cues are checked against the measured picture (shot changes, picture motion) when analysed. */
	engineCues?: EngineCueSources | undefined;
	scratchDir: string;
	signal?: AbortSignal;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
	onProgress?(fraction: number, stage: string): void;
	jobId?: string;
	/** P6-E8: the engine's reference profiles (a check compares with the sequence's or the request's). */
	profiles?: { get(id: string): Promise<ReferenceProfile | null> } | undefined;
};

export type CheckOptions = {
	projectId: string;
	revision: number | null;
	preset: SoundDelivery;
	/** A custom target checked instead of the preset's integrated loudness and true-peak ceiling (WP5.2 "Custom…"). */
	target?: SoundCheckTarget | undefined;
	/** Sequence frames; default the whole sequence. */
	range?: { start: number; end: number } | undefined;
	/** P6-E8: compare with this reference profile (default the sequence's `settings.referenceProfile`; null: none). */
	profileId?: string | null | undefined;
};

/** A placed sound effect and what the document says about it. */
type SfxRow = {
	clip: AudioClip & { sfx?: unknown };
	sfx: ClipSfx | null;
	info: SfxInfo;
	cue: SoundCue | null;
	/** Frame it should land on: its cue's, else its aligned point (rounded), else its start. */
	frame: number;
	/** Where its aligned point plays by the document (fractional frame), or null without placement. */
	alignedFrame: number | null;
	licence: string | null;
	types: string[];
	/** The library sound was registered as it is, not as a sample-exact copy (`LibraryProvenance.inexact`). */
	inexact: LibraryInexactReason | null;
	codes: Set<SoundCheckCode>;
	offsetMs: number | null;
	located: 'found' | 'not-found' | 'not-measured';
	correlation: number | null;
	liftDb: number | null;
	targetLiftDb: number | null;
	peakOverBedLu: number | null;
	bedCapLu: number | null;
	speech: boolean;
	/** Momentary peak in the mix (sound peak at 0 dB + gain), for "biggest hero". */
	peakLu: number | null;
	/** The solver's events, gains and this sound's index (MASKED pass), for the HARSH fix's MASKED guard. */
	solver?: FindRow['solver'];
};

/** Where a placed sound ends against its clip (content flicks): the media, the sound's −60 dB end, the clip's end. */
type TailInfo = {
	durF: number;
	reach: number;
	contentEnd: number;
	rate: number;
	prov: LibraryProvenance | null;
	entry: SoundEntry | null;
	/** Whether `reach` is where the sound fades (provenance or library tail), not just the end of its file. */
	known: boolean;
};

/** Longest file `measureTailEnd` decodes (s): sound effects are short; a longer file is judged by its end. */
const TAIL_MEASURE_MAX_SEC = 30;

/**
 * Where a media's sound has faded (content flicks): its last sample within 60 dB of the file's sample peak, any
 * channel; null when it cannot be decoded or is longer than `TAIL_MEASURE_MAX_SEC`.
 */
async function measureTailEnd(env: CheckEnv, world: AudioWorld, mediaId: string): Promise<number | null> {
	const src = world.media(mediaId);
	const stream = src?.streams.find((x) => x.type === 'audio') ?? src?.streams[0];
	if (!src || !stream) return null;
	const channels = Math.max(1, Math.min(32, (stream as { channels?: number }).channels ?? 2));
	const rate = (stream as { sampleRate?: number }).sampleRate ?? 48_000;
	const signal = env.signal ?? new AbortController().signal;
	let child: import('node:child_process').ChildProcess;
	try {
		child = env.ff.spawnRaw(
			[...LOCAL_PROTOCOLS, '-i', src.path, '-map', `0:${stream.index}`, '-vn', '-f', 'f32le', 'pipe:1'],
			{ signal },
		);
	} catch {
		return null;
	}
	env.onSpawn?.(child);
	let planes: Float32Array[];
	try {
		planes = await readPlanar(child, channels, Math.ceil(TAIL_MEASURE_MAX_SEC * rate) + 1, signal);
	} catch {
		if (signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
		return null;
	}
	const n = planes[0]?.length ?? 0;
	if (n === 0 || n > TAIL_MEASURE_MAX_SEC * rate) return null;
	let peak = 0;
	for (const p of planes) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(p[i]!));
	if (!(peak > 0)) return 0;
	const floor = peak / 1000;
	let last = n - 1;
	while (last > 0 && planes.every((p) => Math.abs(p[last]!) < floor)) last--;
	return Math.round(((last + 1) / rate) * FLICKS_PER_SECOND);
}

/** One capture of the SFX stem (mono sum) over absolute samples `[a, a + data.length)`. */
type Capture = { row: SfxRow; a: number; data: Float32Array; ref: RefPlan };
type RefPlan = {
	path: string;
	streamIndex: number;
	/** File seconds of the reference's first sample and its length (file time). */
	fileStart: number;
	fileDur: number;
	/** Decode rate so that the reference plays at the clip's speed when read at the mix rate. */
	decodeRate: number;
	/** Samples (mix rate) of the reference from its start to the aligned point. */
	anchor: number;
	/** Absolute sample where the aligned point should play (the cue). */
	expected: number;
	/** Absolute sample where the document plays it (its own copy among identical sounds in the search window). */
	documented: number;
	toleranceFrames: number;
	align: 'peak' | 'start' | 'end';
	/** Samples searched before / after the expected position (end-aligned sounds: their −250…+30 ms window). */
	searchBefore: number;
	searchAfter: number;
};

class IssueList {
	readonly items: SoundCheckIssue[] = [];
	private readonly ids = new Map<string, number>();
	add(i: Omit<SoundCheckIssue, 'category' | 'id'> & { subject: string }): SoundCheckIssue | null {
		if (this.items.length >= SOUND_CHECK_LIMITS.issues) return null;
		const base = `${i.code}:${i.subject}`;
		const n = this.ids.get(base) ?? 0;
		this.ids.set(base, n + 1);
		const { subject: _s, ...rest } = i;
		const issue: SoundCheckIssue = {
			id: n ? `${base}#${n + 1}` : base,
			category: SOUND_CHECK_CATEGORY[i.code],
			...rest,
		};
		this.items.push(issue);
		return issue;
	}
}

/** Applies commands to a copy (fresh ids): whether they apply to this document. */
function dryRun(
	doc: ProjectDocument,
	seqId: string,
	commands: Record<string, unknown>[],
	registries: Registries,
): { ok: true; doc: ProjectDocument } | { ok: false; message: string } {
	try {
		const { document, result } = applyTransaction(
			doc,
			{ label: 'sound check fix', origin: 'user', sequenceId: seqId, commands: commands as never },
			{
				ids: createRandomIdSource(),
				now: () => new Date().toISOString(),
				revision: 0,
				registries,
				invariants: 'incremental',
			},
		);
		if (!result.ok) return { ok: false, message: result.errors[0]?.message ?? 'refused' };
		return { ok: true, doc: document };
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : String(e) };
	}
}

const commandFix = (
	projectId: string,
	label: SoundCheckMessage,
	commands: Record<string, unknown>[],
	safe: boolean,
	why?: SoundCheckMessage,
): SoundCheckFix => ({
	kind: 'commands',
	label,
	safe,
	...(why ? { why: why.text, whyMessage: why } : {}),
	tool: 'apply_commands',
	args: { projectId, label: label.text.slice(0, 80), commands },
	commands: commands as SoundCheckFix['commands'],
});

/** A fix's `why` as text and as a translatable message. */
const whyOf = (m: SoundCheckMessage): { why: string; whyMessage: SoundCheckMessage } => ({
	why: m.text,
	whyMessage: m,
});

/** Decodes a mono reference (f32 at `rate`) of a file span; null when ffmpeg cannot. */
async function decodeReference(env: CheckEnv, r: RefPlan, sampleRate: number): Promise<Float32Array | null> {
	const signal = env.signal ?? new AbortController().signal;
	let child: import('node:child_process').ChildProcess;
	try {
		child = env.ff.spawnRaw(
			[
				...LOCAL_PROTOCOLS,
				'-ss',
				sec(r.fileStart),
				'-t',
				sec(r.fileDur),
				'-i',
				r.path,
				'-map',
				`0:${r.streamIndex}`,
				'-vn',
				'-af',
				`aresample=${r.decodeRate}`,
				'-ac',
				'1',
				'-f',
				'f32le',
				'pipe:1',
			],
			{ signal },
		);
	} catch {
		return null;
	}
	env.onSpawn?.(child);
	try {
		const [mono] = await readPlanar(child, 1, Math.ceil(r.fileDur * r.decodeRate) + sampleRate, signal);
		return mono ?? null;
	} catch {
		if (signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
		return null;
	}
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) await fn(items[next++]!);
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

/** Contiguous runs of `pred` over `[0, n)`: `[start, end)` index pairs. */
function runs(n: number, pred: (i: number) => boolean): [number, number][] {
	const out: [number, number][] = [];
	let a = -1;
	for (let i = 0; i <= n; i++) {
		const on = i < n && pred(i);
		if (on && a < 0) a = i;
		else if (!on && a >= 0) {
			out.push([a, i]);
			a = -1;
		}
	}
	return out;
}

/** A Volume keyframe segment going down by at least this much (dB) is a deliberate level move (DIP: decision). */
const LEVEL_MOVE_DB = 6;
const VOLUME_CLIP_KINDS: ReadonlySet<string> = new Set(['audio', 'nest-audio', 'synthetic-audio']);

/**
 * Where the mix's level is moved down on purpose (sequence frames `[from, to]`): Volume keyframe segments of audio clips
 * (content time), audio tracks, submixes and the Mix (sequence time) that go down by ≥ {@link LEVEL_MOVE_DB} — music
 * rides, auto-ducking, `audio.volumeDip`, stop-before dips (also one whose cue has moved since). A hold step is the
 * frame of its next key.
 */
function levelMovesDown(seq: Sequence, rate: Rational): [number, number][] {
	const F = flicksPerFrame(rate);
	const out: [number, number][] = [];
	const lane = (anim: unknown, toFrame: (t: number) => number) => {
		const raw = (anim as { keyframes?: unknown } | null | undefined)?.keyframes;
		if (!Array.isArray(raw) || raw.length < 2) return;
		const ks = (raw as { time?: unknown; value?: unknown; interpolation?: unknown }[])
			.filter((k) => fin(k?.time) && fin(k?.value))
			.sort((a, b) => (a.time as number) - (b.time as number));
		for (let j = 1; j < ks.length && out.length < 10_000; j++) {
			const p = ks[j - 1]!;
			const q = ks[j]!;
			const fp = toFrame(p.time as number);
			const fq = toFrame(q.time as number);
			if (!fin(fp) || !fin(fq)) continue;
			// the order the mix plays them in (a reversed clip plays its content keys backwards)
			const [first, second] = fp <= fq ? [p, q] : [q, p];
			if ((first.value as number) - (second.value as number) < LEVEL_MOVE_DB) continue;
			out.push(p.interpolation === 'hold' ? [fq, fq] : [Math.min(fp, fq), Math.max(fp, fq)]);
		}
	};
	for (const c of Object.values(seq.clips)) {
		if (!VOLUME_CLIP_KINDS.has(c.kind)) continue;
		const sp = (c as { speed?: { rate?: number; reverse?: boolean } }).speed;
		const t = clipLaneTime(
			{
				start: c.start,
				duration: c.duration,
				sourceIn: c.sourceIn,
				speed: { rate: sp?.rate || 1, reverse: !!sp?.reverse },
			},
			rate,
		);
		lane((c as { volumeDb?: unknown }).volumeDb, (k) => t.toSeq(k) / F);
	}
	for (const tr of [...seq.audioTracks, ...(seq.submixTracks ?? [])])
		lane((tr as { volumeDb?: unknown }).volumeDb, (k) => k / F);
	lane((seq.master as { volumeDb?: unknown }).volumeDb, (k) => k / F);
	return out;
}

/** Energy mean of LUFS values over the hops `use` marks (−∞ when none / silent). */
function meanLufs(curve: Float32Array, from: number, to: number, use: (i: number) => boolean): number {
	let e = 0;
	let n = 0;
	for (let i = from; i < to; i++) {
		if (!use(i)) continue;
		n++;
		const v = curve[i]!;
		if (v > LOUDNESS_FLOOR_LUFS) e += 10 ** (v / 10);
	}
	return n > 0 && e > 0 ? 10 * Math.log10(e / n) : Number.NEGATIVE_INFINITY;
}

/**
 * Runs the whole check of `seq` in `doc` (see the module docs) and returns the report. Throws `JobError` on abort or
 * when the mix cannot be rendered.
 */
export async function checkSequence(
	doc: ProjectDocument,
	seq: Sequence,
	opts: CheckOptions,
	env: CheckEnv,
): Promise<SoundCheckReport> {
	const t0 = Date.now();
	const timings: Record<string, number> = {};
	const lap = (k: string, since: number) => {
		timings[k] = Date.now() - since;
	};
	const aborted = () => {
		if (env.signal?.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
	};
	const progress = (f: number, s: string) => env.onProgress?.(f, s);
	const warnings: SoundCheckReport['warnings'] = [];
	// the target as `soundCheckStatus` reads it back (0.1 steps), so a stored summary is current at once
	const target = opts.target ? (readSoundCheckTarget(opts.target) ?? undefined) : undefined;
	const preset = target
		? {
				...deliveryPreset(opts.preset),
				label: SOUND_CHECK_CUSTOM_LABEL,
				integratedLufs: target.integratedLufs,
				truePeakDb: target.truePeakDb,
				source: 'Custom target',
			}
		: deliveryPreset(opts.preset);
	const settings = soundDesignSettingsOf(seq);
	const rate = seq.settings.frameRate as Rational;
	const fpsNum = rate.num / rate.den;
	const F = flicksPerFrame(rate);
	const duration = Math.max(0, Math.ceil(sequenceDuration(seq)));
	const range = opts.range
		? { start: Math.min(opts.range.start, duration), end: Math.min(opts.range.end, duration) }
		: { start: 0, end: duration };
	const whole = !opts.range || (range.start === 0 && range.end >= duration);
	const tc = (f: number) => sequenceTimecode(seq, Math.max(0, Math.round(f)));
	const inRangeFrame = (f: number) => f >= range.start && f < range.end;
	const issues = new IssueList();
	const projectId = opts.projectId;

	// ── the world and the stems ─────────────────────────────────────────────────────────────────────────────────────
	progress(0.02, 'Reading the mix');
	const world: AudioWorld = await audioWorld(doc, seq.id, env.registry);
	const snap = world.snapshot;
	const sr = snap.audioMix?.sampleRate ?? snap.settings.sampleRate;
	const hop = Math.max(1, Math.round(sr * CURVE_HOP_SEC));
	const playing = new Set(snap.audioClips.map((c) => c.clipId));
	const stemIds = classifyStems(seq, playing);
	const rangeStart = frameToSample(range.start, rate, sr);
	const rangeEnd = Math.max(rangeStart, frameToSample(range.end, rate, sr));
	const preHops = Math.min(PRE_HOPS, Math.floor(rangeStart / hop));
	const renderStart = rangeStart - preHops * hop;
	// the post-roll also runs past the end of the sequence (silence there): a sound on the last frames is located too
	const renderEnd = rangeEnd + POST_HOPS * hop;
	const rangeSamples = rangeEnd - rangeStart;
	const rangeHops = Math.ceil(rangeSamples / hop);
	const loud = (seq.master as { loudness?: { enabled?: boolean; targetLufs?: number; truePeakDb?: number } })
		.loudness;
	const normalize =
		loud?.enabled && fin(loud.targetLufs) && fin(loud.truePeakDb)
			? { targetLufs: loud.targetLufs, truePeakDb: loud.truePeakDb }
			: null;

	// sound effect rows
	const cues = soundCuesOf(seq);
	const cueById = new Map(cues.map((c) => [c.id, c]));
	const rows: SfxRow[] = [];
	for (const c of Object.values(seq.clips).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))) {
		if (c.kind !== 'audio' || !isSfxClip(c)) continue;
		if (!(c.start < range.end && c.start + c.duration > range.start)) continue;
		if (rows.length >= SOUND_CHECK_LIMITS.events) break;
		const info = sfxInfoOf(doc, seq, c.id, opts.preset);
		if (!info) continue;
		const clip = c as AudioClip & { sfx?: unknown };
		const sfx = clip.sfx !== undefined ? readClipSfx(clip.sfx) : null;
		const own = sfx?.cueId ? cueById.get(sfx.cueId) : undefined;
		const cue = own && (own.placedClipIds ?? []).includes(c.id) ? own : null;
		// where the aligned point plays: a reversed clip plays content `sourceIn + (duration − t)·rate` at local time t
		const into = sfx?.placement ? (sfx.placement.peakFlicks - c.sourceIn) / (c.speed?.rate || 1) / F : 0;
		const aligned = sfx?.placement ? c.start + (c.speed?.reverse ? c.duration - into : into) : null;
		const prov = readLibraryProvenance(
			(doc.media?.[clip.mediaId] as { library?: unknown } | undefined)?.library,
		);
		rows.push({
			clip,
			sfx,
			info,
			cue,
			frame: cue ? cue.frame : aligned !== null ? Math.round(aligned) : c.start,
			alignedFrame: aligned,
			licence: prov?.license ?? null,
			types: prov?.types ?? [],
			inexact: prov?.inexact?.reason ?? null,
			codes: new Set(),
			offsetMs: null,
			located: 'not-measured',
			correlation: null,
			liftDb: null,
			targetLiftDb: null,
			peakOverBedLu: null,
			bedCapLu: null,
			speech: false,
			peakLu: null,
		});
	}

	// ── where each placed sound has faded (fix "SFX tail truncation") ──────────────────────────────────────────────
	// The provenance's −60 dB tail; for copies registered before it was recorded, the library entry's (moved by the
	// copy's lead silence); else the end of the sound in its file (before any trailing silence).
	const entries = new Map<string, SoundEntry | null>();
	if (env.sounds)
		for (const row of rows) {
			const id = row.info.librarySoundId;
			if (id && !entries.has(id)) entries.set(id, await env.sounds.get(id).catch(() => null));
		}
	const tailOf = (row: SfxRow): TailInfo | null => {
		const asset = doc.media?.[row.clip.mediaId] as MediaAsset | undefined;
		const durF = asset ? mediaDurationFlicks(asset) : null;
		if (!asset || !fin(durF) || durF <= 0 || row.clip.speed?.reverse) return null;
		const prov = readLibraryProvenance((asset as { library?: unknown }).library);
		const durSec = durF / FLICKS_PER_SECOND;
		const t = soundTimingOf(prov, { peakSec: 0, onsetSec: 0, headQuietSec: 0, durationSec: durSec });
		let reachSec = Math.min(durSec, t.tailEndSec ?? t.endSec ?? durSec);
		const e = row.info.librarySoundId ? entries.get(row.info.librarySoundId) : null;
		const lead = prov?.leadSilenceSec ?? 0;
		const ed = e?.descriptors;
		if (
			t.tailEndSec === undefined &&
			ed &&
			prov?.descriptors &&
			e.format.durationSec <= SOUND_ANALYSIS_SECONDS &&
			fin(ed.tailSec) &&
			Math.abs(ed.peakSec + lead - prov.descriptors.peakSec) < 0.001
		)
			reachSec = Math.min(reachSec, lead + ed.peakSec + ed.tailSec);
		const known = t.tailEndSec !== undefined || reachSec < Math.min(durSec, t.endSec ?? durSec);
		const measured = measuredTail.get(row.clip.mediaId);
		if (!known && measured !== undefined && measured !== null)
			reachSec = Math.min(reachSec, measured / FLICKS_PER_SECOND);
		const rate = row.clip.speed?.rate || 1;
		return {
			durF,
			reach: Math.round(reachSec * FLICKS_PER_SECOND),
			contentEnd: row.clip.sourceIn + row.clip.duration * F * rate,
			rate,
			prov,
			entry: e ?? null,
			known,
		};
	};
	// Media whose fade is not on record (project audio, old copies of sounds no longer in the library): measured on the
	// file — its last sample within 60 dB of its sample peak — for the clips that end before the file does.
	const measuredTail = new Map<string, number | null>();
	for (const row of rows) {
		if (!row.sfx?.placement || measuredTail.has(row.clip.mediaId)) continue;
		const tl = tailOf(row);
		if (!tl || tl.known || tl.contentEnd >= tl.reach - TAIL_SLACK_SEC * FLICKS_PER_SECOND) continue;
		measuredTail.set(row.clip.mediaId, await measureTailEnd(env, world, row.clip.mediaId));
	}
	/** Whole frames a clip lacks to reach its sound's end. */
	const missingFrames = (tl: TailInfo) =>
		Math.max(1, Math.ceil((tl.reach - tl.contentEnd) / (F * tl.rate) - 1e-6));
	/** A clip's content end after the commands, or null when they do not apply. */
	const endAfter = (commands: Record<string, unknown>[], clipId: string): number | null => {
		const run = dryRun(doc, seq.id, commands, env.registries);
		if (!run.ok) return null;
		const c = run.doc.sequences[seq.id]?.clips[clipId] as AudioClip | undefined;
		return c ? c.sourceIn + c.duration * F * (c.speed?.rate || 1) : null;
	};
	/**
	 * The safe fix of a clip that ends inside its sound, in order: lengthen it inside its media (`clip.trim`); register
	 * its library sound again — a copy made before the tail fix has no trailing silence, the new one does — and swap it
	 * in (`swap_sound` to the same sound: aligned frame, track, role, pan and gain kept), dry-run on a copy of the media
	 * as the engine will write it; else re-plan the clip on its own media (`soundDesign.swap`), which rounds it up to the
	 * end of the sound, under one frame past its media (silence there). Each only when it really reaches the end.
	 */
	const tailFix = (row: SfxRow, tl: TailInfo): { fix?: SoundCheckFix; cause?: string } => {
		const clipId = row.clip.id;
		const reaches = (end: number | null) =>
			end !== null && end >= tl.reach - TAIL_SLACK_SEC * FLICKS_PER_SECOND;
		const frames = missingFrames(tl);
		const trim = { type: 'clip.trim', clipId, edge: 'out', deltaFrames: frames };
		if (reaches(endAfter([trim], clipId)))
			return { fix: commandFix(projectId, soundCheckMessage('fixUncut', frames), [trim], true) };
		const id = row.info.librarySoundId;
		const e = tl.entry;
		const asset = doc.media?.[row.clip.mediaId] as MediaAsset | undefined;
		if (id && e && env.sounds && asset && tl.prov?.descriptors && !(tl.prov.trailSilenceSec ?? 0)) {
			const samples = libraryTrailSilenceSamples(e.descriptors, e.format.sampleRate, {
				analysedSec: SOUND_ANALYSIS_SECONDS,
			});
			if (samples > 0 && e.format.sampleRate > 0) {
				const trail = samples / e.format.sampleRate;
				const trailF = Math.round(trail * FLICKS_PER_SECOND);
				const { id: _id, ...rest } = asset as MediaAsset & { id: string };
				const library: LibraryProvenance = {
					...tl.prov,
					trailSilenceSec: trail,
					descriptors: { ...tl.prov.descriptors, durationSec: tl.prov.descriptors.durationSec + trail },
				};
				const copy = {
					...rest,
					fingerprint: `${asset.fingerprint}#sound-check-tail`,
					probe: { ...asset.probe, durationFlicks: (asset.probe.durationFlicks ?? tl.durF) + trailF },
					library,
				};
				const cmds = [
					{ type: 'media.register', asset: copy, ref: '$tailCopy' },
					{ type: 'soundDesign.swap', clipId, mediaId: '$tailCopy' },
				];
				if (reaches(endAfter(cmds, clipId)))
					return {
						fix: {
							kind: 'swap',
							label: soundCheckMessage('fixRepad', row.info.title),
							safe: true,
							tool: 'swap_sound',
							args: { projectId, clipId, to: id },
							swap: { clipId, soundId: id },
						},
					};
			}
		}
		const same = { type: 'soundDesign.swap', clipId, mediaId: row.clip.mediaId };
		const end = endAfter([same], clipId);
		if (reaches(end)) return { fix: commandFix(projectId, soundCheckMessage('fixRunOut'), [same], true) };
		return {
			cause:
				end === null
					? 'the clip cannot be re-placed where it is (the next clip on its track, or a locked track)'
					: 'the media ends inside the next frame: the clip cannot be longer (whole frames)',
		};
	};

	// sync captures (the SFX stem around each filled cue)
	const captures: Capture[] = [];
	const unmeasured = new Map<SfxRow, string>();
	const cut = new Map<SfxRow, { afterMs: number; trimFrames: number; tail: TailInfo }>();
	for (const row of rows) {
		const sfx = row.sfx;
		if (!row.cue || !sfx?.placement) continue;
		const kind = row.cue.kind as CueKind;
		if (kind === 'silence') continue;
		// the clip ends at (or before) its aligned point while the sound goes on: what the cue is for does not play
		if (row.alignedFrame !== null && sfx.placement.align !== 'end') {
			const tl = tailOf(row);
			const clipEnd = row.clip.start + row.clip.duration;
			const afterSec = (clipEnd - row.alignedFrame) / fpsNum;
			const soundAfterSec = tl ? (tl.reach - sfx.placement.peakFlicks) / FLICKS_PER_SECOND / tl.rate : 0;
			if (tl && afterSec < CUT_MIN_SEC && soundAfterSec > afterSec + CUT_MIN_SEC) {
				cut.set(row, { afterMs: r1(afterSec * 1000), trimFrames: missingFrames(tl), tail: tl });
				continue;
			}
		}
		if (!playing.has(row.clip.id)) {
			unmeasured.set(row, SOUND_CHECK_UNMEASURED.notInMix);
			continue;
		}
		if (row.clip.speed?.reverse) {
			unmeasured.set(row, SOUND_CHECK_UNMEASURED.reversed);
			continue;
		}
		const asset = doc.media?.[row.clip.mediaId] as { fingerprint?: string } | undefined;
		const rc = snap.audioClips.find((x) => x.clipId === row.clip.id);
		const src = world.media(row.clip.mediaId);
		const stream = src?.streams.find((s) => s.index === rc?.channels.streamIndex) ?? src?.streams[0];
		if (!asset || !src || !stream) {
			unmeasured.set(row, SOUND_CHECK_UNMEASURED.offline);
			continue;
		}
		const align = sfx.placement.align;
		const speed = row.clip.speed?.rate || 1;
		const [pre, post] = REF_WINDOW[align];
		const pointSec = sfx.placement.peakFlicks / FLICKS_PER_SECOND;
		// timeline seconds before / after the point that the file can supply
		const before = Math.min(pre, pointSec / speed);
		const fileStart = pointSec - before * speed;
		const fileDur = (before + post) * speed;
		if (fileDur * sr < 64) {
			unmeasured.set(row, SOUND_CHECK_UNMEASURED.short);
			continue;
		}
		const expected = Math.round((row.cue.frame / fpsNum) * sr);
		const search = Math.ceil((SYNC_SEARCH_FRAMES / fpsNum) * sr);
		// end-aligned sounds are judged by a window (P6-E3): search past it on both sides
		const searchBefore =
			align === 'end' ? Math.max(search, Math.ceil(((SYNC_END_WINDOW_MS.early + 50) / 1000) * sr)) : search;
		const searchAfter =
			align === 'end' ? Math.max(search, Math.ceil(((SYNC_END_WINDOW_MS.late + 30) / 1000) * sr)) : search;
		const refLen = Math.ceil((before + post) * sr);
		const a = expected - Math.round(before * sr) - searchBefore - hop;
		const len = refLen + searchBefore + searchAfter + 2 * hop;
		// before sample 0 nothing plays: a capture of a sound on the first frames starts with silence
		if ((a < renderStart && renderStart > 0) || a + len > renderEnd) {
			unmeasured.set(row, SOUND_CHECK_UNMEASURED.edge);
			continue;
		}
		captures.push({
			row,
			a,
			data: new Float32Array(len),
			ref: {
				path: src.path,
				streamIndex: stream.index,
				fileStart,
				fileDur,
				decodeRate: Math.max(1000, Math.round(sr / speed)),
				anchor: Math.round(before * sr),
				expected,
				documented: Math.round(((row.alignedFrame ?? row.cue.frame) / fpsNum) * sr),
				toleranceFrames: SYNC_TOLERANCE_FRAMES[kind] ?? 1,
				align,
				searchBefore,
				searchAfter,
			},
		});
	}

	// ── one pass: every stem's curves, the mix meter (range only), the first-pass file, the SFX captures ─────────────
	aborted();
	progress(0.05, 'Rendering the mix and its stems');
	let t = Date.now();
	// the Mix's own layout (a mono Mix in mono: WP6.5b), as `measureSfxEvents` renders the sounds and the bed
	const { layout, channels } = mixLayoutOf(snap);
	// P6-E8: the reference profile compared with, measured on the delivered mix (the range) as a reference is
	const profileId = opts.profileId === undefined ? (settings.referenceProfile ?? null) : opts.profileId;
	let refProfile: ReferenceProfile | null = null;
	if (profileId) {
		refProfile = (await env.profiles?.get(profileId)) ?? null;
		if (!refProfile) warnings.push(missingProfileWarning(profileId));
	}
	const profileMeter = refProfile
		? new ProfileMeter(sr, channels, { maxSeconds: REFERENCE_PROFILE_LIMITS.maxSec })
		: null;
	const meters: Partial<Record<Stem, CurveMeter>> = {};
	for (const s of STEMS) if (stemIds[s].size > 0) meters[s] = new CurveMeter(sr, channels);
	const mixMeter = new LoudnessMeter(sr, channels, { weights: defaultChannelWeights(channels) });
	const pass1 = normalize ? join(env.scratchDir, 'check-pass1.f32') : null;
	const fh = pass1 ? await open(pass1, 'w') : null;
	// without normalisation the mix is delivered as it is: its true peak per 10 ms hop (from renderStart) bounds what a
	// gain fix may add where a sound plays (`planSoundCheckFixes`)
	const tpDetector = normalize ? null : new TruePeakDetector(sr, channels);
	const tpHop = normalize ? null : new Float32Array(Math.ceil((renderEnd - renderStart) / hop) + 1);
	let audibleHops = 0;
	const stemSpecs: StemSpec[] = STEMS.map((s) => ({ name: s, clipIds: s === 'mix' ? null : stemIds[s] }));
	if (stemIds.mix.size === 0) stemSpecs[0] = { name: 'mix', clipIds: new Set() };
	let decoders = 0;
	// Phase 6 probes (spec 12 §4 P6-E1…E3): clicks per stem, presence of the SFX / music / dialogue stems, and the first
	// 5 ms and last 50 ms of the delivered mix (from this pass without normalisation, else from the delivery pass)
	const probes = new CheckProbes(sr, channels, stemIds);
	const tap = new EdgeTap(sr, channels);
	try {
		if (stemIds.mix.size > 0 && renderEnd > renderStart) {
			const res = await renderStems({
				ff: env.ff,
				snapshot: snap,
				media: world.media,
				startSample: renderStart,
				samples: renderEnd - renderStart,
				outputLayout: layout,
				stems: stemSpecs,
				...(env.signal ? { signal: env.signal } : {}),
				...(env.onSpawn ? { onSpawn: env.onSpawn } : {}),
				onProgress: (f) => progress(0.05 + 0.4 * f, 'Rendering the mix and its stems'),
				onBlock: async (stem, planar, n, at) => {
					const name = STEMS[stem]!;
					meters[name]?.push(planar, n);
					probes.push(name, planar, n);
					if (name === 'sfx')
						for (const c of captures) {
							const a = Math.max(at, c.a);
							const b = Math.min(at + n, c.a + c.data.length);
							for (let i = a; i < b; i++) {
								let v = 0;
								for (const ch of planar) v += ch[i - at]!;
								c.data[i - c.a] = v;
							}
						}
					if (name !== 'mix') return;
					if (tpDetector && tpHop)
						for (let i = 0; i < n; ) {
							const h = Math.floor((at + i - renderStart) / hop);
							const end = Math.min(n, renderStart + (h + 1) * hop - at);
							tpDetector.process(planar, i, end - i);
							const p = tpDetector.takePeak();
							if (h >= 0 && h < tpHop.length && p > tpHop[h]!) tpHop[h] = p;
							i = end;
						}
					// the range only: the export's loudness and the normalisation pass
					const a = Math.max(at, rangeStart);
					const b = Math.min(at + n, rangeEnd);
					if (b <= a) return;
					const off = a - at;
					mixMeter.process(planar, off, b - a);
					if (!fh) {
						const view = planar.map((c) => c.subarray(off, off + (b - a)));
						tap.push(view, b - a);
						profileMeter?.push(view, b - a);
					}
					if (fh) {
						const buf = Buffer.alloc((b - a) * planar.length * 4);
						for (let i = 0; i < b - a; i++)
							for (let ch = 0; ch < planar.length; ch++)
								buf.writeFloatLE(planar[ch]![off + i]!, (i * planar.length + ch) * 4);
						await fh.write(buf);
					}
				},
			});
			decoders = res.decoders;
		}
	} catch (e) {
		await fh?.close();
		if (pass1) await rm(pass1, { force: true });
		if (env.signal?.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
		throw new JobError('RENDER_FAILED', `The mix could not be rendered: ${(e as Error).message}`, true);
	}
	await fh?.close();
	mixMeter.flush();
	lap('stems', t);
	const totalHops = Math.ceil((renderEnd - renderStart) / hop);
	const curves = {} as Record<Stem, StemCurves>;
	for (const s of STEMS) curves[s] = meters[s]?.finish() ?? silentCurves(sr, totalHops);
	const before = mixMeter.summary();

	// ── delivery: loudness normalisation and the limiter, exactly as renderMixdown's second pass ────────────────────
	t = Date.now();
	let final: LoudnessSummary = before;
	let finalCurves: StemCurves = curves.mix;
	let finalOffsetHops = preHops;
	let gainDb: number | null = null;
	const grHop = new Float32Array(rangeHops);
	if (normalize && pass1) {
		aborted();
		progress(0.47, 'Normalising loudness as the export does');
		gainDb = Number.isFinite(before.integrated) ? normalize.targetLufs - before.integrated : 0;
		const g = 10 ** (gainDb / 20);
		const limiter = new TruePeakLimiter(sr, channels, {
			ceilingDb: normalize.truePeakDb,
			lookaheadMs: 5,
			releaseMs: 100,
		});
		const meter2 = new LoudnessMeter(sr, channels, { weights: defaultChannelWeights(channels) });
		const cm = new CurveMeter(sr, channels);
		const src = await open(pass1, 'r');
		try {
			let skip = limiter.latency;
			let written = 0;
			const block = Array.from({ length: channels }, () => new Float32Array(hop));
			const raw = Buffer.alloc(hop * channels * 4);
			const emit = (n: number) => {
				limiter.process(block, 0, n);
				const gr = -limiter.gainReductionDb();
				let from = 0;
				if (skip > 0) {
					from = Math.min(n, skip);
					skip -= from;
				}
				const m = Math.min(n - from, rangeSamples - written);
				if (m <= 0) return;
				const view = block.map((c) => c.subarray(from, from + m));
				meter2.process(view, 0, m);
				cm.push(view, m);
				tap.push(view, m);
				profileMeter?.push(view, m);
				const h = Math.min(rangeHops - 1, Math.floor(written / hop));
				if (h >= 0 && gr > grHop[h]!) grHop[h] = gr;
				written += m;
			};
			for (let done = 0; done < rangeSamples; ) {
				if (env.signal?.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
				const n = Math.min(hop, rangeSamples - done);
				const { bytesRead } = await src.read(raw, 0, n * channels * 4, done * channels * 4);
				const got = Math.floor(bytesRead / (channels * 4));
				for (let i = 0; i < n; i++)
					for (let c = 0; c < channels; c++)
						block[c]![i] = i < got ? raw.readFloatLE((i * channels + c) * 4) * g : 0;
				emit(n);
				done += n;
			}
			for (let left = limiter.latency; left > 0 && written < rangeSamples; ) {
				const n = Math.min(hop, left);
				for (const c of block) c.fill(0, 0, n);
				emit(n);
				left -= n;
			}
		} finally {
			await src.close();
			await rm(pass1, { force: true });
		}
		meter2.flush();
		final = meter2.summary();
		finalCurves = cm.finish();
		finalOffsetHops = 0;
	}
	lap('delivery', t);
	// curves over the range: index 0 = rangeStart
	const crop = (c: Float32Array, off: number) => c.subarray(off, off + rangeHops);
	const mixMomentary = crop(loudnessCurve(finalCurves, 0.4), finalOffsetHops);
	const mixShortTerm = crop(loudnessCurve(finalCurves, 3), finalOffsetHops);
	const mixMsDb = crop(finalCurves.msDb, finalOffsetHops);
	// SILENCE: the loudest channel (a centre-only 5.1 dialogue or a left-only room tone is not silence)
	const mixLoudestDb = crop(finalCurves.loudestDb, finalOffsetHops);
	const mixPeakDb = crop(finalCurves.peakDb, finalOffsetHops);
	const stemOffset = gainDb ?? 0;
	const stemMomentary = (s: Stem) => crop(loudnessCurve(curves[s], 0.4, stemOffset), preHops);
	const hopFrame = (i: number) => range.start + ((i * hop) / sr) * fpsNum;

	// ── speech: transcript words + voice activity of the dialogue stem ─────────────────────────────────────────────
	const speech = new Uint8Array(rangeHops);
	try {
		for (const w of sequenceWords(doc, seq)) {
			if (!fin(w.start) || !fin(w.end)) continue;
			const a = Math.max(0, Math.floor((((w.start / FLICKS_PER_SECOND) * sr - rangeStart) / hop) | 0));
			const b = Math.min(rangeHops, Math.ceil(((w.end / FLICKS_PER_SECOND) * sr - rangeStart) / hop));
			for (let i = a; i < b; i++) speech[i] = 1;
		}
	} catch {
		// an unreadable transcript: voice activity only
	}
	if (stemIds.dialogue.size > 0) {
		const db = crop(curves.dialogue.msDb, preHops);
		const th = Math.max(vadThreshold(db), VAD_FLOOR_DBFS);
		for (let i = 0; i < db.length; i++) if (db[i]! >= th) speech[i] = 1;
	}
	// segments: the project's one dialogue definition (`dialogueSpans`: transcript words, else the voice activity of
	// Essential Sound dialogue clips, else their spans; spec 12 P6-R3), the same stretches cue derivation and the
	// solver's dialogue guard use; the levels are compared over the voiced hops inside them (above)
	const voice = await voiceServiceFor(env.ff, env.registry).forSequence(doc, seq, {
		...(env.signal ? { signal: env.signal } : {}),
	});
	const segments: [number, number][] = [];
	for (const sp of dialogueSpans(doc, seq, { voice: voice.voice })) {
		const a = Math.max(0, Math.floor((frameToSample(sp.start, rate, sr) - rangeStart) / hop));
		const b = Math.min(rangeHops, Math.ceil((frameToSample(sp.end, rate, sr) - rangeStart) / hop));
		if (b > a) segments.push([a, b]);
	}
	const speechSeconds = r2((speech.reduce((n, v) => n + v, 0) * hop) / sr);

	// ── LOUDNESS, TRUE_PEAK, OVERLOAD (limiter, clipping) ──────────────────────────────────────────────────────────
	for (let i = 0; i < rangeHops; i++) if (mixMsDb[i]! > AUDIBLE_DBFS) audibleHops++;
	const audibleSec = (audibleHops * hop) / sr;
	const measurable =
		Number.isFinite(final.integrated) && audibleSec >= SOUND_CHECK_THRESHOLDS.minMeasurableSec;
	const broadcast = !target && (opts.preset === 'broadcast-r128' || opts.preset === 'atsc-a85');
	const loudnessFix = (why: SoundCheckMessage): SoundCheckFix | undefined => {
		const cmd = {
			type: 'mixer.setLoudness',
			sequenceId: seq.id,
			enabled: true,
			targetLufs: preset.integratedLufs,
			truePeakDb: preset.truePeakDb,
		};
		const ok = dryRun(doc, seq.id, [cmd], env.registries);
		if (!ok.ok) return undefined;
		return commandFix(
			projectId,
			soundCheckMessage('fixLoudness', preset.integratedLufs, preset.truePeakDb),
			[cmd],
			true,
			why,
		);
	};
	const settingsMatch =
		!!normalize &&
		normalize.targetLufs === preset.integratedLufs &&
		normalize.truePeakDb <= preset.truePeakDb;
	if (!Number.isFinite(final.integrated) && audibleHops === 0) {
		issues.add({
			subject: 'mix',
			code: 'LOUDNESS',
			severity: 'warning',
			message: soundCheckMessage('loudnessSilent'),
			range: { ...range },
			measured: { audibleSec: r2(audibleSec) },
		});
	} else if (!measurable) {
		issues.add({
			subject: 'mix',
			code: 'LOUDNESS',
			severity: 'warning',
			message: soundCheckMessage('loudnessShort', r2(rangeSamples / sr)),
			range: { ...range },
			measured: { audibleSec: r2(audibleSec), checkedSec: r2(rangeSamples / sr) },
		});
	} else {
		const off = final.integrated - preset.integratedLufs;
		if (Math.abs(off) > SOUND_CHECK_THRESHOLDS.loudnessToleranceLu) {
			const fix = settingsMatch ? undefined : loudnessFix(soundCheckMessage('whyNormalise'));
			issues.add({
				subject: 'mix',
				code: 'LOUDNESS',
				severity: broadcast ? 'error' : 'warning',
				message: soundCheckMessage(
					'loudnessOff',
					fmt(final.integrated),
					fmt(off),
					preset.label,
					preset.integratedLufs,
				),
				range: { ...range },
				measured: { integratedLufs: r2(final.integrated), offLu: r2(off), normalised: !!normalize },
				...(fix ? { fix } : {}),
			});
		}
	}
	if (!whole)
		warnings.push({
			code: 'W_RANGE',
			message: soundCheckMessage('loudnessRange', tc(range.start), tc(range.end)).text,
		});
	if (
		Number.isFinite(final.truePeakDb) &&
		final.truePeakDb > preset.truePeakDb + SOUND_CHECK_THRESHOLDS.truePeakToleranceDb
	) {
		let at = 0;
		for (let i = 1; i < rangeHops; i++) if (mixPeakDb[i]! > mixPeakDb[at]!) at = i;
		const fix = settingsMatch ? undefined : loudnessFix(soundCheckMessage('whyLimiterCeiling'));
		issues.add({
			subject: 'mix',
			code: 'TRUE_PEAK',
			severity: 'error',
			frame: Math.round(hopFrame(at)),
			timecode: tc(hopFrame(at)),
			message: soundCheckMessage('truePeak', fmt(final.truePeakDb), preset.label, preset.truePeakDb),
			measured: { truePeakDb: r2(final.truePeakDb), ceilingDb: preset.truePeakDb },
			...(fix ? { fix } : {}),
		});
	}
	let limiterMax = 0;
	let limiterAt = 0;
	for (let i = 0; i < rangeHops; i++)
		if (grHop[i]! > limiterMax) {
			limiterMax = grHop[i]!;
			limiterAt = i;
		}
	if (normalize && limiterMax > SOUND_CHECK_THRESHOLDS.limiterMaxGrDb) {
		issues.add({
			subject: 'limiter',
			code: 'OVERLOAD',
			severity: 'warning',
			frame: Math.round(hopFrame(limiterAt)),
			timecode: tc(hopFrame(limiterAt)),
			message: soundCheckMessage(
				'overloadLimiter',
				fmt(limiterMax),
				tc(hopFrame(limiterAt)),
				SOUND_CHECK_THRESHOLDS.limiterMaxGrDb,
			),
			measured: { gainReductionDb: r2(limiterMax) },
			fix: {
				kind: 'job',
				label: soundCheckMessage('fixRebalance'),
				safe: false,
				...whyOf(soundCheckMessage('whyRebalance')),
				tool: 'rebalance_sfx',
				args: { projectId, sequenceId: seq.id, mode: 'apply', delivery: opts.preset },
				job: {
					route: 'rebalance',
					body: { projectId, sequenceId: seq.id, mode: 'apply', delivery: opts.preset },
				},
			},
		});
	}
	if (
		!normalize &&
		Number.isFinite(before.samplePeakDb) &&
		before.samplePeakDb >= SOUND_CHECK_THRESHOLDS.clipDbfs
	) {
		let at = 0;
		for (let i = 1; i < rangeHops; i++) if (mixPeakDb[i]! > mixPeakDb[at]!) at = i;
		const fix = loudnessFix(soundCheckMessage('whyLimiterUnder'));
		issues.add({
			subject: 'clip',
			code: 'OVERLOAD',
			severity: 'error',
			frame: Math.round(hopFrame(at)),
			timecode: tc(hopFrame(at)),
			message: soundCheckMessage('overloadClip', fmt(before.samplePeakDb), tc(hopFrame(at))),
			measured: { samplePeakDb: r2(before.samplePeakDb) },
			...(fix ? { fix } : {}),
		});
	}
	progress(0.55, 'Measuring the sound effects against the bed');

	// ── MASKED / OVERLOAD (peak over the bed): the solver's measurements and definitions ───────────────────────────
	aborted();
	t = Date.now();
	const solvable = rows.filter((r) => playing.has(r.clip.id));
	/** Each measured sound effect, linear in its gain: what the safe fixes are judged by together (below). */
	const levels: SoundCheckLevelModel[] = [];
	const tailFrames = Math.ceil(LEVEL_TAIL_SEC * fpsNum);
	/** True peak (dBTP) of the un-normalised mix over sequence frames `[a, b)` (± one hop); null with normalisation. */
	const spanTruePeak = (a: number, b: number): number | null => {
		if (!tpHop) return null;
		const from = Math.max(0, Math.floor((frameToSample(a, rate, sr) - renderStart) / hop) - 1);
		const to = Math.min(tpHop.length, Math.ceil((frameToSample(b, rate, sr) - renderStart) / hop) + 1);
		let m = 0;
		for (let i = from; i < to; i++) if (tpHop[i]! > m) m = tpHop[i]!;
		return m > 0 ? r2(20 * Math.log10(m)) : LOUDNESS_FLOOR_LUFS;
	};
	if (solvable.length) {
		const m = await measureSfxEvents(
			{
				bedDoc: doc,
				sequenceId: seq.id,
				targets: solvable.map((r) => ({ doc, clipId: r.clip.id, weight: r.info.weight })),
			},
			{
				ff: env.ff,
				registry: env.registry,
				...(env.cache ? { cache: env.cache } : {}),
				...(env.signal ? { signal: env.signal } : {}),
				...(env.onSpawn ? { onSpawn: env.onSpawn } : {}),
			},
		);
		const measured = solvable.filter((r) => m.sounds.has(r.clip.id));
		const events: SolverEvent[] = measured.map((r) => solverEventOf(r.info, m.sounds.get(r.clip.id)!));
		const solved = solveAt(events, opts.preset);
		const lo = levelOptions(opts.preset);
		const locked = new Set(seq.audioTracks.filter((tr) => tr.locked).map((tr) => tr.id));
		// the solver's definitions, the lower sound effects under each one included (at the current / solved gains)
		const curAll = evaluateSfxGains(
			events,
			measured.map((row) => row.info.gainDb),
			lo,
		);
		const atAll = evaluateSfxGains(
			events,
			solved.events.map((r) => r.gainDb),
			lo,
		);
		// the overlapping sound effects of each one, re-evaluable for other gains and roles (the joint safe fixes)
		const overlapAll = sfxOverlapTerms(events, lo);
		measured.forEach((row, i) => {
			const ms = m.sounds.get(row.clip.id)!;
			const cur = curAll[i]!;
			row.liftDb = cur.liftDb;
			row.targetLiftDb = cur.targetLiftDb;
			row.peakOverBedLu = cur.peakOverBedLu;
			row.bedCapLu = cur.bedCapLu;
			row.speech = ms.speechOverlap;
			row.peakLu = ms.soundPeakLu === null ? null : ms.soundPeakLu + row.info.gainDb;
			row.solver = { events, gains: measured.map((r) => r.info.gainDb), index: i, lo };
			const res = solved.events[i]!;
			const at = atAll[i]!;
			const at0 = evaluateSfxGain(events[i]!, 0, lo);
			const terms = overlapAll[i];
			if (levels.length < SOUND_CHECK_LIMITS.events)
				levels.push({
					clipId: row.clip.id,
					title: row.info.title,
					gainDb: row.info.gainDb,
					// over the bed and the lower sound effects under it at their checked gains (the solver's masking)
					liftAt0Db: cur.liftDb === null ? null : r2(cur.liftDb - row.info.gainDb),
					peakOverBedAt0Lu: at0.peakOverBedLu,
					truePeakAt0Db: at0.truePeakDb,
					mixTruePeakDb: spanTruePeak(row.clip.start, row.clip.start + row.clip.duration + tailFrames),
					start: row.clip.start,
					end: row.clip.start + row.clip.duration + tailFrames,
					speech: ms.speechOverlap,
					...(terms?.terms.length
						? {
								masking: {
									weight: events[i]!.weight,
									bedDomDb: terms.bedDomDb,
									// the loudest at their checked gains, in canonical order
									terms: terms.terms
										.map((x) => ({
											clipId: measured[x.index]!.clip.id,
											weight: x.weight,
											gainDb: measured[x.index]!.info.gainDb,
											at0Db: x.at0Db,
										}))
										.map((x, k) => ({ x, k }))
										.sort((a, b) => b.x.at0Db + b.x.gainDb - (a.x.at0Db + a.x.gainDb) || a.k - b.k)
										.slice(0, SOUND_CHECK_MASKING_TERMS_MAX)
										.sort((a, b) => a.k - b.k)
										.map((y) => y.x),
								},
							}
						: {}),
				});
			const level = solvedLevel(res, ms, lo.truePeakCeilingDb);
			const gainCmd = {
				type: 'soundDesign.applyGains',
				sequenceId: seq.id,
				gains: { [row.clip.id]: res.gainDb },
				report: { [row.clip.id]: gainReport(level) },
			};
			const userOwned = row.info.owner === 'user';
			const isLocked = locked.has(row.clip.trackId);
			const gainFix = (resolves: boolean): SoundCheckFix | undefined => {
				if (isLocked || Math.abs(res.gainDb - row.info.gainDb) < 0.01) return undefined;
				if (!dryRun(doc, seq.id, [gainCmd], env.registries).ok) return undefined;
				const safe = resolves && !userOwned;
				return commandFix(
					projectId,
					soundCheckMessage('fixGain', fmt(res.gainDb)),
					[gainCmd],
					safe,
					safe
						? undefined
						: userOwned
							? soundCheckMessage('whyUserGain')
							: soundCheckMessage('whySolverGain', level.reason),
				);
			};
			// layers of a cue are judged with the cue's first layer; ambient beds sit under by design (decisions)
			const min =
				row.info.weight === 'ambient' || row.sfx?.role === 'layer'
					? null
					: MASKED_MIN_LIFT_DB[row.info.weight];
			if (min !== null && cur.liftDb !== null && cur.liftDb < min) {
				row.codes.add('MASKED');
				const fix = gainFix(at.liftDb !== null && at.liftDb >= min);
				issues.add({
					subject: row.clip.id,
					code: 'MASKED',
					severity: 'warning',
					frame: row.frame,
					timecode: tc(row.frame),
					clipIds: [row.clip.id],
					...(row.cue ? { cueId: row.cue.id } : {}),
					message: soundCheckMessage(
						row.info.weight === 'hero' ? 'maskedHero' : 'maskedSupport',
						row.info.title,
						tc(row.frame),
						fmt(cur.liftDb),
						cur.dominantBands.join('+') || '—',
						min,
					),
					measured: {
						liftDb: cur.liftDb,
						minLiftDb: min,
						gainDb: row.info.gainDb,
						solvedGainDb: res.gainDb,
						solvedLiftDb: at.liftDb,
						limitedBy: res.limitedBy.join(',') || null,
					},
					...(fix ? { fix } : {}),
				});
			}
			if (cur.peakOverBedLu !== null && cur.peakOverBedLu > cur.bedCapLu + 0.5) {
				row.codes.add('OVERLOAD');
				const fix = gainFix(at.peakOverBedLu !== null && at.peakOverBedLu <= at.bedCapLu + 0.5);
				issues.add({
					subject: row.clip.id,
					code: 'OVERLOAD',
					severity: 'warning',
					frame: row.frame,
					timecode: tc(row.frame),
					clipIds: [row.clip.id],
					...(row.cue ? { cueId: row.cue.id } : {}),
					message: soundCheckMessage(
						'overloadBed',
						row.info.title,
						tc(row.frame),
						fmt(cur.peakOverBedLu),
						cur.bedCapLu,
					),
					measured: { peakOverBedLu: cur.peakOverBedLu, capLu: cur.bedCapLu, solvedGainDb: res.gainDb },
					...(fix ? { fix } : {}),
				});
			}
		});
	}
	lap('levels', t);

	// ── OUT_OF_SYNC: the sound file located in the SFX stem around its cue ───────────────────────────────────────────
	aborted();
	progress(0.7, 'Locating each sound in the mix');
	t = Date.now();
	await pool(captures, DECODE_CONCURRENCY, async (c) => {
		const ref = await decodeReference(env, c.ref, sr);
		if (!ref || ref.length < 64) {
			unmeasured.set(c.row, SOUND_CHECK_UNMEASURED.undecodable);
			return;
		}
		const nominal = c.ref.expected - c.ref.anchor - c.a;
		// the same sound twice near the cue (a repeat, a doubled layer) matches twice: its own copy is where the document
		// plays it, unless that match is much weaker than the best one
		const found = locateByCorrelation(
			ref,
			c.data,
			nominal - c.ref.searchBefore - hop,
			nominal + c.ref.searchAfter + hop,
			{
				prefer: c.ref.documented - c.ref.anchor - c.a,
				separation: Math.round(sr / fpsNum),
			},
		);
		// an end-aligned sound's best match on the edge of its search window is the window's edge, not the sound (the
		// sound plays outside it): not found there
		const lagLo = nominal - c.ref.searchBefore - hop;
		const lagHi = nominal + c.ref.searchAfter + hop;
		const onEdge = !!found && c.ref.align === 'end' && (found.lag <= lagLo + 1 || found.lag >= lagHi - 1);
		if (!found || found.ncc < SYNC_MIN_CORRELATION || onEdge) {
			c.row.located = 'not-found';
			c.row.correlation = found ? r2(found.ncc) : null;
			return;
		}
		c.row.located = 'found';
		c.row.correlation = r2(found.ncc);
		const actual = c.a + found.lag + c.ref.anchor;
		c.row.offsetMs = r1(((actual - c.ref.expected) / sr) * 1000);
	});
	for (const row of rows) {
		if (!row.cue || !row.sfx?.placement) continue;
		const kind = row.cue.kind as CueKind;
		if (kind === 'silence') continue;
		const tol = SYNC_TOLERANCE_FRAMES[kind] ?? 1;
		const tolMs = (tol / fpsNum) * 1000;
		const metaOffMs = row.alignedFrame === null ? null : ((row.alignedFrame - row.cue.frame) / fpsNum) * 1000;
		// end-aligned sounds (risers, reverses): their end may play 250 ms before to 30 ms after the cue (P6-E3)
		const endAligned = row.sfx.placement.align === 'end';
		const offside = (ms: number) =>
			endAligned
				? ms < -SYNC_END_WINDOW_MS.early - 0.5 || ms > SYNC_END_WINDOW_MS.late + 0.5
				: Math.abs(ms) > tolMs + 0.5;
		const offMessage = (ms: number) =>
			endAligned
				? soundCheckMessage(
						ms < 0 ? 'syncEndEarly' : 'syncEndLate',
						row.info.title,
						r1(Math.abs(ms)),
						kind,
						tc(row.cue!.frame),
					)
				: soundCheckMessage(
						ms < 0 ? 'syncEarly' : 'syncLate',
						row.info.title,
						r1(Math.abs(ms)),
						kind,
						tc(row.cue!.frame),
						tol,
					);
		const why = unmeasured.get(row);
		const realign = (): SoundCheckFix | undefined => {
			const cmd = {
				type: 'soundDesign.swap',
				clipId: row.clip.id,
				mediaId: row.clip.mediaId,
				frame: row.cue!.frame,
			};
			const ok = dryRun(doc, seq.id, [cmd], env.registries);
			if (!ok.ok) return undefined;
			return {
				...commandFix(projectId, soundCheckMessage('fixAlign'), [cmd], true),
				tool: 'align_peak',
				args: { projectId, clipId: row.clip.id, to: 'cue', withLayers: false },
			};
		};
		const base = {
			subject: row.clip.id,
			code: 'OUT_OF_SYNC' as const,
			frame: row.cue.frame,
			timecode: tc(row.cue.frame),
			clipIds: [row.clip.id],
			cueId: row.cue.id,
		};
		const c = cut.get(row);
		if (c) {
			row.codes.add('OUT_OF_SYNC');
			const { fix, cause } = tailFix(row, c.tail);
			issues.add({
				...base,
				severity: 'error',
				message: soundCheckMessage(
					'syncCut',
					row.info.title,
					c.afterMs,
					tc(row.clip.start + row.clip.duration),
				),
				measured: {
					afterAlignedMs: c.afterMs,
					missingFrames: c.trimFrames,
					measuredIn: 'document',
					...(cause ? { cause } : {}),
				},
				...(fix ? { fix } : {}),
			});
			continue;
		}
		if (why) {
			// not measurable in the mix: judge by the document
			if (metaOffMs !== null && offside(metaOffMs)) {
				row.codes.add('OUT_OF_SYNC');
				const fix = realign();
				issues.add({
					...base,
					severity: 'error',
					message: offMessage(metaOffMs),
					measured: { offsetMs: r1(metaOffMs), toleranceFrames: tol, measuredIn: 'document' },
					...(fix ? { fix } : {}),
				});
			} else
				issues.add({
					...base,
					severity: 'info',
					message: soundCheckMessage('syncUnmeasurable', row.info.title, why),
				});
			continue;
		}
		if (row.located === 'found' && row.offsetMs !== null) {
			if (!offside(row.offsetMs)) continue;
			row.codes.add('OUT_OF_SYNC');
			const moved = metaOffMs !== null && Math.abs(metaOffMs) > 0.5;
			const fix = moved ? realign() : undefined;
			issues.add({
				...base,
				severity: 'error',
				message: moved
					? offMessage(row.offsetMs)
					: soundCheckMessage('syncMetadataOnly', row.info.title, r1(row.offsetMs), tc(row.cue.frame)),
				measured: {
					offsetMs: row.offsetMs,
					toleranceFrames: tol,
					correlation: row.correlation,
					measuredIn: 'mix',
				},
				...(fix ? { fix } : {}),
			});
		} else if (row.located === 'not-found') {
			if (metaOffMs !== null && offside(metaOffMs)) {
				row.codes.add('OUT_OF_SYNC');
				const fix = realign();
				issues.add({
					...base,
					severity: 'error',
					message: soundCheckMessage('syncNotFound', row.info.title, SYNC_SEARCH_FRAMES, tc(row.cue.frame)),
					measured: {
						offsetMs: r1(metaOffMs),
						toleranceFrames: tol,
						measuredIn: 'document',
						correlation: row.correlation,
					},
					...(fix ? { fix } : {}),
				});
			} else
				issues.add({
					...base,
					severity: 'info',
					message: soundCheckMessage('syncUnmeasurable', row.info.title, SOUND_CHECK_UNMEASURED.covered),
					measured: { correlation: row.correlation },
				});
		}
	}
	// TRUNCATED: a placed sound whose clip ends before the sound has faded (−60 dB) while the clip runs to the last
	// whole frame of its media — the end of the sound cut by the frame grid (a copy registered before the tail fix),
	// not a clip shortened on purpose.
	for (const row of rows) {
		if (!row.sfx?.placement || cut.has(row) || row.cue?.kind === 'silence') continue;
		const tl = tailOf(row);
		if (!tl || tl.contentEnd >= tl.reach - TAIL_SLACK_SEC * FLICKS_PER_SECOND) continue;
		if (tl.contentEnd + F * tl.rate <= tl.durF + 1) continue;
		const clipEnd = row.clip.start + row.clip.duration;
		const missingMs = r1(((tl.reach - tl.contentEnd) / FLICKS_PER_SECOND / tl.rate) * 1000);
		row.codes.add('TRUNCATED');
		const { fix, cause } = tailFix(row, tl);
		issues.add({
			subject: row.clip.id,
			code: 'TRUNCATED',
			severity: 'warning',
			frame: clipEnd,
			timecode: tc(clipEnd),
			clipIds: [row.clip.id],
			...(row.cue ? { cueId: row.cue.id } : {}),
			message: soundCheckMessage('truncated', row.info.title, tc(clipEnd), missingMs),
			measured: {
				missingMs,
				missingFrames: missingFrames(tl),
				measuredIn: 'document',
				...(cause ? { cause } : {}),
			},
			...(fix ? { fix } : {}),
		});
	}
	// INEXACT (information): a placed library sound used as it is, not as a sample-exact copy (too long, its copy too
	// large, or no disk space when it was added): its placement is exact to a frame only. One finding per clip.
	for (const row of rows) {
		if (!row.inexact) continue;
		row.codes.add('INEXACT');
		const at = row.clip.start;
		issues.add({
			subject: row.clip.id,
			code: 'INEXACT',
			severity: 'info',
			frame: at,
			timecode: tc(at),
			clipIds: [row.clip.id],
			...(row.cue ? { cueId: row.cue.id } : {}),
			message:
				row.inexact === 'too-long'
					? soundCheckMessage('inexactTooLong', row.info.title, tc(at), LIBRARY_PAD_MAX_SECONDS / 60)
					: row.inexact === 'too-large'
						? soundCheckMessage('inexactTooLarge', row.info.title, tc(at))
						: soundCheckMessage('inexactDiskSpace', row.info.title, tc(at)),
			measured: { reason: row.inexact, measuredIn: 'document' },
		});
	}
	lap('sync', t);

	// ── MUSIC_OVER_VOICE ─────────────────────────────────────────────────────────────────────────────────────────────
	t = Date.now();
	const hasDialogueClip = Object.values(seq.clips).some(
		(c) =>
			c.kind === 'audio' &&
			c.enabled !== false &&
			readEssentialSound((c as AudioClip).essential)?.type === 'dialogue',
	);
	if (stemIds.music.size > 0 && stemIds.dialogue.size + speechSeconds > 0) {
		const voice = stemMomentary('dialogue');
		const music = stemMomentary('music');
		for (const [a, b] of segments) {
			if (((b - a) * hop) / sr < SOUND_CHECK_THRESHOLDS.minSpeechSec) continue;
			const use = (i: number) => speech[i] === 1;
			const lv = meanLufs(voice, a, b, use);
			const lm = meanLufs(music, a, b, use);
			if (!Number.isFinite(lv) || !Number.isFinite(lm)) continue;
			const under = lv - lm;
			if (under >= SOUND_CHECK_THRESHOLDS.musicUnderVoiceLu) continue;
			const fa = Math.floor(hopFrame(a));
			const fb = Math.ceil(hopFrame(b));
			const musicClips = [...stemIds.music].filter((id) => {
				const c = seq.clips[id]!;
				return c.start < fb && c.start + c.duration > fa;
			});
			const duck = musicClips.map((id) => readEssentialSound((seq.clips[id] as AudioClip).essential));
			const ducked = duck.some((es) => es?.ducking.enabled);
			// ducked: the depth it has; else the depth the delivery job will write (`soundDesign.applyDelivery`: the
			// user's depth, else DELIVERY_DUCK_DB under dialogue) — the least of the clips', which limits the result
			const depths = duck.map((es) =>
				!es
					? 0
					: ducked || duckingDepthBy(es) === 'user' || !hasDialogueClip
						? es.ducking.reduceDb
						: -DELIVERY_DUCK_DB,
			);
			const depth = depths.length ? Math.min(0, ducked ? Math.min(...depths) : Math.max(...depths)) : 0;
			const predicted = under - depth;
			const fix: SoundCheckFix = ducked
				? {
						kind: 'job',
						label: soundCheckMessage('fixDelivery', preset.label),
						safe: false,
						...whyOf(soundCheckMessage('whyDucked')),
						tool: 'apply_delivery',
						args: {
							projectId,
							sequenceId: seq.id,
							delivery: opts.preset,
							mode: 'apply',
							loudness: false,
							rebalance: false,
						},
						job: {
							route: 'delivery',
							body: {
								projectId,
								sequenceId: seq.id,
								delivery: opts.preset,
								mode: 'apply',
								loudness: false,
								rebalance: false,
							},
						},
					}
				: {
						kind: 'job',
						label: soundCheckMessage('fixDuck'),
						safe: predicted >= SOUND_CHECK_THRESHOLDS.musicUnderVoiceLu,
						...(predicted >= SOUND_CHECK_THRESHOLDS.musicUnderVoiceLu
							? {}
							: whyOf(soundCheckMessage('whyDuckDepth', fmt(-depth), fmt(predicted)))),
						tool: 'apply_delivery',
						args: {
							projectId,
							sequenceId: seq.id,
							delivery: opts.preset,
							mode: 'apply',
							loudness: false,
							autoMatch: false,
							rebalance: false,
						},
						job: {
							route: 'delivery',
							body: {
								projectId,
								sequenceId: seq.id,
								delivery: opts.preset,
								mode: 'apply',
								loudness: false,
								autoMatch: false,
								rebalance: false,
							},
						},
					};
			issues.add({
				subject: `${fa}`,
				code: 'MUSIC_OVER_VOICE',
				severity: 'warning',
				frame: fa,
				timecode: tc(fa),
				range: { start: fa, end: fb },
				clipIds: musicClips,
				message: ducked
					? soundCheckMessage(
							'musicOverVoiceDucked',
							tc(fa),
							tc(fb),
							fmt(under),
							SOUND_CHECK_THRESHOLDS.musicUnderVoiceLu,
						)
					: soundCheckMessage(
							'musicOverVoice',
							tc(fa),
							tc(fb),
							fmt(under),
							SOUND_CHECK_THRESHOLDS.musicUnderVoiceLu,
						),
				measured: { underLu: r2(under), voiceLufs: r2(lv), musicLufs: r2(lm), ducked, duckDb: depth },
				fix,
			});
		}
	}

	// ── SILENCE and DIP ──────────────────────────────────────────────────────────────────────────────────────────────
	const silenceCues = cues.filter((c) => c.kind === 'silence' && !c.muted);
	const silenceExplained = (fa: number, fb: number) =>
		silenceCues.some((c) =>
			c.window ? c.window.start < fb && c.window.end > fa : c.frame >= fa - fpsNum * 0.5 && c.frame < fb,
		);
	const minSilentHops = Math.ceil((SOUND_CHECK_THRESHOLDS.silenceMinSec * sr) / hop);
	const silentRuns = runs(rangeHops, (i) => mixLoudestDb[i]! < SOUND_CHECK_THRESHOLDS.silenceDbfs).filter(
		([a, b]) => b - a >= minSilentHops,
	);
	const silenceFix = (fa: number, fb: number): SoundCheckFix | undefined => {
		const cmd = {
			type: 'soundCue.add',
			sequenceId: seq.id,
			cues: [
				{
					frame: fa,
					kind: 'silence',
					weight: 'ambient',
					source: 'user',
					window: { start: fa, end: Math.max(fa, fb) },
					reason: 'Intended silence (Sound Check)',
				},
			],
		};
		if (!dryRun(doc, seq.id, [cmd], env.registries).ok) return undefined;
		return commandFix(
			projectId,
			soundCheckMessage('fixSilenceCue'),
			[cmd],
			false,
			soundCheckMessage('whySilence'),
		);
	};
	// A quiet run that reaches the end of the sequence after sound is how the mix ends (a tail into silence, which
	// ENDING asks for: P6-E3), not a SILENCE finding.
	const endsSequence = range.end >= duration;
	const counted = silentRuns
		.map(([a, b]) => ({ a, b, fa: Math.floor(hopFrame(a)), fb: Math.min(range.end, Math.ceil(hopFrame(b))) }))
		.filter(
			(r) =>
				!silenceExplained(r.fa, r.fb) && !(endsSequence && r.b >= rangeHops && r.a > 0 && audibleHops > 0),
		);
	// P6-E12: a silence inside a dialogue region (dialogue on both sides less than 10 s apart) is a hole in the scene:
	// its fix fills it with room tone (the closest match to the dialogue's noise floor; not safe: the user listens)
	const regions = dialogueRegions(doc, seq, { voice: voice.voice });
	const holes = counted.filter((r) => insideDialogueRegion(regions, r.fa, r.fb));
	let roomTone: Awaited<ReturnType<typeof planRoomTone>> | null = null;
	if (holes.length) {
		progress(0.72, 'Matching room tone to the dialogue');
		try {
			roomTone = await planRoomTone(
				{
					agent: () => undefined,
					proposals: () => undefined,
					sounds: () => env.sounds,
					ffmpeg: env.ff,
					registry: env.registry,
				},
				doc,
				seq,
				projectId,
				{ gaps: holes.map((r) => ({ start: r.fa, end: Math.max(r.fa + 1, r.fb) })) },
				{
					voice: voice.voice,
					...(env.signal ? { signal: env.signal } : {}),
					...(env.onSpawn ? { onSpawn: env.onSpawn } : {}),
				},
			);
		} catch (e) {
			aborted();
			warnings.push({
				code: 'W_ROOM_TONE_UNAVAILABLE',
				message:
					`Room tone could not be matched for the silences in the dialogue: ${(e as Error).message}`.slice(
						0,
						300,
					),
			});
		}
		for (const w of roomTone?.plan.warnings ?? [])
			if (w.code !== 'W_NO_ROOM_TONE' || !roomTone?.plan.chosen)
				warnings.push({ code: w.code, message: w.message });
	}
	const roomToneFix = (fa: number, fb: number): SoundCheckFix | undefined => {
		const chosen = roomTone?.plan.chosen;
		const lay = roomTone?.layBedFor([roomToneSpan({ start: fa, end: Math.max(fa + 1, fb) }, rate)]);
		if (!roomTone || !chosen || !lay) return undefined;
		const cmds = [...roomTone.setup.flatMap((x) => x.commands), lay];
		if (!dryRun(doc, seq.id, cmds, env.registries).ok) return undefined;
		return commandFix(
			projectId,
			soundCheckMessage('fixRoomTone', chosen.sound.title, fmt(chosen.gainDb)),
			cmds,
			false,
			soundCheckMessage(
				'whyRoomTone',
				chosen.sound.title,
				chosen.distanceDb === null ? '—' : `${chosen.distanceDb}`,
			),
		);
	};
	for (const { a, b, fa, fb } of counted) {
		const fix = (holes.some((h) => h.fa === fa) ? roomToneFix(fa, fb) : undefined) ?? silenceFix(fa, fb);
		issues.add({
			subject: `${fa}`,
			code: 'SILENCE',
			severity: 'warning',
			frame: fa,
			timecode: tc(fa),
			range: { start: fa, end: Math.max(fa + 1, fb) },
			message: soundCheckMessage('silence', r2(((b - a) * hop) / sr), tc(fa), tc(fb)),
			measured: { seconds: r2(((b - a) * hop) / sr), floorDbfs: SOUND_CHECK_THRESHOLDS.silenceDbfs },
			...(fix ? { fix } : {}),
		});
	}
	// DIP: short-term loudness falls > 10 LU under its level of the previous 3 s and comes back ≥ 6 LU within 6 s
	{
		const W = 300;
		const R = Math.round(SOUND_CHECK_THRESHOLDS.dipRecoverSec / CURVE_HOP_SEC);
		const st = mixShortTerm;
		const cuts = new Set<number>();
		for (const c of Object.values(seq.clips))
			if (seq.videoTracks.some((v) => v.id === c.trackId)) {
				cuts.add(c.start);
				cuts.add(c.start + c.duration);
			}
		const stopSpans = cues
			.filter((c) => c.stopBefore && !c.muted)
			.map((c) => [c.frame - (c.stopBefore!.seconds + 0.1) * fpsNum, c.frame + 0.1 * fpsNum] as const);
		const moves = levelMovesDown(seq, rate);
		// The foreground falling away (Phase 5 verification): the voice pausing, or a hit's tail, over a bed that holds its
		// level — the bed without the dialogue (music, ambience, other audio; energies add) does not itself drop there.
		// Only a drop of that programme is a DIP (the music cutting out, a hole in the ambience).
		const programme: StemCurves =
			stemIds.dialogue.size > 0
				? {
						...curves.bed,
						kEnergy: curves.bed.kEnergy.map((e, x) => Math.max(0, e - (curves.dialogue.kEnergy[x] ?? 0))),
					}
				: curves.bed;
		const programmeShortTerm = crop(loudnessCurve(programme, 3), preHops);
		const foregroundOnly = (maxAt: number, bottom: number): boolean => {
			let top = Number.NEGATIVE_INFINITY;
			for (let j = Math.max(0, maxAt - 300); j <= maxAt; j++)
				top = Math.max(top, programmeShortTerm[j] ?? -Infinity);
			let low = Number.POSITIVE_INFINITY;
			for (let j = maxAt; j <= bottom; j++) low = Math.min(low, programmeShortTerm[j] ?? Infinity);
			return !(top - low > SOUND_CHECK_THRESHOLDS.dipLu);
		};
		let i = 0;
		while (i < st.length) {
			let prevMax = Number.NEGATIVE_INFINITY;
			let maxAt = i;
			for (let j = Math.max(0, i - W); j < i; j++)
				if (st[j]! > prevMax) {
					prevMax = st[j]!;
					maxAt = j;
				}
			const v = st[i]!;
			if (!(prevMax - v > SOUND_CHECK_THRESHOLDS.dipLu) || v <= LOUDNESS_FLOOR_LUFS || prevMax < -60) {
				i++;
				continue;
			}
			// the bottom of this dip
			let bottom = i;
			let k = i;
			while (k < st.length && prevMax - st[k]! > SOUND_CHECK_THRESHOLDS.dipLu) {
				if (st[k]! < st[bottom]!) bottom = k;
				k++;
			}
			let recovered = false;
			for (let j = bottom; j < Math.min(st.length, bottom + R); j++)
				if (
					st[j]! >= st[bottom]! + SOUND_CHECK_THRESHOLDS.dipRecoverLu &&
					prevMax - st[j]! <= SOUND_CHECK_THRESHOLDS.dipLu
				) {
					recovered = true;
					break;
				}
			const fa = Math.floor(hopFrame(maxAt));
			const fb = Math.ceil(hopFrame(Math.min(st.length, k)));
			const fBottom = Math.round(hopFrame(bottom));
			const explained =
				silenceExplained(fa, fb) ||
				[...cuts].some((f) => f >= fa && f <= fb) ||
				stopSpans.some(([a, b]) => a < fb && b > fa) ||
				moves.some(([a, b]) => a <= fb && b >= fa) ||
				silentRuns.some(([a, b]) => a <= bottom && b >= bottom) ||
				foregroundOnly(maxAt, bottom);
			if (recovered && !explained) {
				const fix = silenceFix(fa, fb);
				issues.add({
					subject: `${fBottom}`,
					code: 'DIP',
					severity: 'warning',
					frame: fBottom,
					timecode: tc(fBottom),
					range: { start: fa, end: Math.max(fa + 1, fb) },
					message: soundCheckMessage('dip', fmt(prevMax - st[bottom]!), tc(fBottom)),
					measured: { dropLu: r2(prevMax - st[bottom]!) },
					...(fix ? { fix } : {}),
				});
			}
			i = Math.max(k, i + 1);
		}
	}
	lap('mix', t);

	// ── Phase 6: CLICK, EDGE, HARSH, LAYER_INAUDIBLE, ENDING, HEAD, ARC (spec 12 §4 P6-E1…E3; check-findings.ts) ────────
	aborted();
	progress(0.74, 'Checking edits, edges and layers');
	t = Date.now();
	const fctx: FindCtx = {
		doc,
		seq,
		projectId,
		sr,
		rate,
		fps: fpsNum,
		F,
		range,
		whole,
		duration,
		renderStart,
		rangeStart,
		rangeEnd,
		hop,
		preHops,
		rangeHops,
		gainDb: gainDb ?? 0,
		world,
		playing,
		stemIds,
		ff: env.ff,
		registry: env.registry,
		registries: env.registries,
		signal: env.signal,
		onSpawn: env.onSpawn,
		tc,
		add: (i) => {
			issues.add(i);
		},
		warn: (code, message) => {
			if (warnings.length < 200) warnings.push({ code, message });
		},
		dryRun: (commands) => dryRun(doc, seq.id, commands, env.registries),
		commandFix: (label, commands, safe, why) => commandFix(projectId, label, commands, safe, why),
	};
	const probed = probes.finish();
	await edgeFindings(fctx, probed.bursts);
	harshFindings(fctx, rows, probed.presence);
	await layerFindings(fctx, rows);
	endingFindings(fctx, tap.result());
	arcFindings(
		fctx,
		mixShortTerm,
		rows
			.filter((r) => r.info.weight === 'hero' && r.peakLu !== null && inRangeFrame(r.frame))
			.sort((a, b) => b.peakLu! - a.peakLu! || a.frame - b.frame)
			.map((r) => ({ frame: r.frame, title: r.info.title })),
		LOUDNESS_FLOOR_LUFS,
	);
	lap('edges', t);

	// ── STALE_CUE, NO_PICTURE_EVENT ─────────────────────────────────────────────────────────────────────────────────
	aborted();
	progress(0.8, 'Checking the cues against the picture');
	t = Date.now();
	const inRange = inRangeFrame;
	// Footage: what the engine already measured of the picture (shot changes, picture motion; never analysed here).
	let measured: Awaited<ReturnType<EngineCueSources['collect']>> | null = null;
	try {
		measured = env.engineCues
			? await env.engineCues.collect(doc, seq, {
					sources: ['scene', 'pixel'],
					range: { start: Math.max(0, range.start - 3), end: range.end + 3 },
					mode: { kind: 'cached' },
				})
			: null;
	} catch {
		measured = null;
	}
	const derived = deriveCues(doc, seq.id, {
		density: 'rich',
		respectDialogue: false,
		mgTemplates: env.mgTemplates,
		range: { start: Math.max(0, range.start - 3), end: range.end + 3 },
		...(measured ? { extraCues: measured.extraCues } : {}),
	});
	const derivedFrames = derived.cues.map((c) => c.frame);
	const motionCurves: { start: number; speed: ArrayLike<number> }[] = [
		...derived.curves,
		...(measured?.pixelCurves ?? []).map((c) => ({ start: c.startFrame, speed: c.speed })),
	];
	const motionAt = (f: number) => {
		let best = 0;
		for (const c of motionCurves) {
			const i = f - c.start;
			for (
				let d = -SOUND_CHECK_THRESHOLDS.pictureEventFrames;
				d <= SOUND_CHECK_THRESHOLDS.pictureEventFrames;
				d++
			) {
				const j = i + d;
				if (j <= 0 || j >= c.speed.length) continue;
				best = Math.max(best, Math.abs(c.speed[j]! - c.speed[j - 1]!));
			}
		}
		return best;
	};
	for (const cue of cues) {
		if (!inRange(cue.frame) || cue.muted || cue.kind === 'silence') continue;
		if (cue.anchor) {
			// where the anchor resolves, plus a beat snap's `anchorOffset`
			const f = cueAnchorFrame(doc, seq, cue, { mgTemplates: env.mgTemplates });
			if (f === null) {
				const cmd = { type: 'soundCue.update', cueId: cue.id, anchor: null };
				const ok = dryRun(doc, seq.id, [cmd], env.registries).ok;
				issues.add({
					subject: cue.id,
					code: 'STALE_CUE',
					severity: 'warning',
					frame: cue.frame,
					timecode: tc(cue.frame),
					cueId: cue.id,
					...(cue.placedClipIds?.length ? { clipIds: [...cue.placedClipIds] } : {}),
					message: soundCheckMessage('staleCueLost', cue.label ?? cue.id, tc(cue.frame)),
					...(ok
						? {
								fix: commandFix(
									projectId,
									soundCheckMessage('fixRemoveCue'),
									[{ type: 'soundCue.remove', cueIds: [cue.id], withClips: true }],
									false,
									soundCheckMessage('whyKeepCue'),
								),
							}
						: {}),
				});
				continue;
			}
			if (f !== cue.frame) {
				const cmd = { type: 'soundCue.resync', sequenceId: seq.id, cueIds: [cue.id] };
				const ok = dryRun(doc, seq.id, [cmd], env.registries);
				issues.add({
					subject: cue.id,
					code: 'STALE_CUE',
					severity: 'warning',
					frame: cue.frame,
					timecode: tc(cue.frame),
					cueId: cue.id,
					...(cue.placedClipIds?.length ? { clipIds: [...cue.placedClipIds] } : {}),
					message: soundCheckMessage('staleCue', cue.label ?? cue.id, tc(cue.frame), tc(f)),
					measured: { anchorFrame: f, movedFrames: f - cue.frame },
					...(ok.ok ? { fix: commandFix(projectId, soundCheckMessage('fixResync'), [cmd], true) } : {}),
				});
				continue;
			}
		}
		if (cue.source !== 'derived' || cue.kind === 'beat') continue;
		if (cue.anchor && cue.anchor.type !== 'beat') continue; // its anchor resolves on the cue: a picture event
		const near = derivedFrames.some(
			(f) => Math.abs(f - cue.frame) <= SOUND_CHECK_THRESHOLDS.pictureEventFrames,
		);
		if (near || motionAt(cue.frame) >= SOUND_CHECK_THRESHOLDS.motionEventSpeed) continue;
		issues.add({
			subject: cue.id,
			code: 'NO_PICTURE_EVENT',
			severity: 'warning',
			frame: cue.frame,
			timecode: tc(cue.frame),
			cueId: cue.id,
			...(cue.placedClipIds?.length ? { clipIds: [...cue.placedClipIds] } : {}),
			message: soundCheckMessage(
				'noPictureEvent',
				cue.label ?? cue.id,
				tc(cue.frame),
				SOUND_CHECK_THRESHOLDS.pictureEventFrames,
			),
			fix: commandFix(
				projectId,
				soundCheckMessage('fixRemoveCue'),
				[{ type: 'soundCue.remove', cueIds: [cue.id], withClips: true }],
				false,
				soundCheckMessage('whyNoPicture'),
			),
		});
	}

	// ── COVERAGE (P6-E3): a class of action sounded only in part (cues under dialogue are silenced by it: excluded) ──
	coverageFindings(
		fctx,
		cues,
		dialogueSpans(doc, seq, { voice: voice.voice }).map((d) => [d.start, d.end] as [number, number]),
	);

	// ── DENSITY ──────────────────────────────────────────────────────────────────────────────────────────────────────
	const budget = DENSITY_BUDGETS[settings.density] ?? DENSITY_BUDGETS.balanced;
	const filled = cues
		.filter((c) => !c.muted && c.kind !== 'silence' && (c.placedClipIds?.length ?? 0) > 0 && inRange(c.frame))
		.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : 1));
	const heroes = filled.filter((c) => c.weight === 'hero');
	for (let i = 1; i < heroes.length; i++) {
		const a = heroes[i - 1]!;
		const b = heroes[i]!;
		const gap = (b.frame - a.frame) / fpsNum;
		if (gap >= budget.heroEverySec && gap >= HERO_MIN_SEC) continue;
		const heroClips = (b.placedClipIds ?? []).filter(
			(id) => readClipSfx((seq.clips[id] as { sfx?: unknown } | undefined)?.sfx)?.role === 'hero',
		);
		const cmds: Record<string, unknown>[] = [{ type: 'soundCue.update', cueId: b.id, weight: 'support' }];
		if (heroClips.length) cmds.push({ type: 'soundDesign.setRole', clipIds: heroClips, role: 'support' });
		const ok = dryRun(doc, seq.id, cmds, env.registries).ok;
		issues.add({
			subject: b.id,
			code: 'DENSITY',
			severity: 'warning',
			frame: b.frame,
			timecode: tc(b.frame),
			range: { start: a.frame, end: b.frame + 1 },
			cueId: b.id,
			...(b.placedClipIds?.length ? { clipIds: [...b.placedClipIds] } : {}),
			message: soundCheckMessage(
				'densityHeroes',
				r2(gap),
				tc(a.frame),
				tc(b.frame),
				budget.heroEverySec,
				settings.density,
			),
			measured: { gapSec: r2(gap), minSec: budget.heroEverySec },
			...(ok ? { fix: commandFix(projectId, soundCheckMessage('fixDemote'), cmds, true) } : {}),
		});
	}
	{
		const counted = filled.filter((c) => !(c.types ?? []).some((x) => INTERFACE_TYPES.has(x)));
		const win = Math.round(fpsNum);
		let lastEnd = -1;
		for (let i = 0; i < counted.length; i++) {
			let j = i;
			while (j + 1 < counted.length && counted[j + 1]!.frame < counted[i]!.frame + win) j++;
			const n = j - i + 1;
			if (n > budget.perSec && counted[i]!.frame >= lastEnd) {
				lastEnd = counted[i]!.frame + win;
				issues.add({
					subject: `${counted[i]!.frame}`,
					code: 'DENSITY',
					severity: 'info',
					frame: counted[i]!.frame,
					timecode: tc(counted[i]!.frame),
					range: { start: counted[i]!.frame, end: counted[i]!.frame + win },
					message: soundCheckMessage(
						'densityRate',
						n,
						tc(counted[i]!.frame),
						budget.perSec,
						settings.density,
					),
					measured: { cues: n, perSec: budget.perSec },
				});
			}
		}
	}

	// ── REPEAT, LICENSE, CREDITS ─────────────────────────────────────────────────────────────────────────────────────
	const sounds = env.sounds;
	const libraryMedia = new Map<string, string>();
	for (const [mid, m] of Object.entries(doc.media ?? {})) {
		const p = readLibraryProvenance((m as { library?: unknown }).library);
		if (!p?.soundId) continue;
		// a copy with trailing silence (registered since the tail fix) over an older one of the same sound
		const had = libraryMedia.get(p.soundId);
		const hadTrail = had
			? (readLibraryProvenance((doc.media[had] as { library?: unknown }).library)?.trailSilenceSec ?? 0) > 0
			: false;
		if (!had || (!hadTrail && (p.trailSilenceSec ?? 0) > 0)) libraryMedia.set(p.soundId, mid);
	}
	const soundOf = (r: SfxRow) => r.info.librarySoundId ?? `media:${r.clip.mediaId}`;
	/**
	 * LICENSE severity of a licence: commercial-safe (or the project's own audio) 0, ShareAlike 0.5 (a warning, P6-E13),
	 * user-provided 1 (warning), else 2.
	 */
	const licenceRank = (l: string | null) =>
		l === null
			? 0
			: isCommercialSafe(l)
				? isShareAlike(l)
					? 0.5
					: 0
				: licenseClass(l) === 'user-provided'
					? 1
					: 2;
	const swapFix = async (
		row: SfxRow,
		exclude: Set<string>,
		need: (licence: string) => boolean,
	): Promise<SoundCheckFix | undefined> => {
		// the agent's / plan's alternatives first (safe: chosen as equivalents), then the library (a judgement)
		const alts = row.sfx?.alternatives ?? [];
		for (const alt of alts) {
			if (exclude.has(alt)) continue;
			let licence: string | null = null;
			let title = alt;
			const mid = libraryMedia.get(alt);
			if (mid) {
				const p = readLibraryProvenance((doc.media[mid] as { library?: unknown }).library);
				licence = p?.license ?? null;
				title = p?.title ?? alt;
			} else if (sounds) {
				try {
					const e = await sounds.get(alt);
					licence = e.license;
					title = e.title;
				} catch {
					continue;
				}
			}
			if (licence === null || !need(licence)) continue;
			if (mid) {
				const cmd = { type: 'soundDesign.swap', clipId: row.clip.id, mediaId: mid };
				if (!dryRun(doc, seq.id, [cmd], env.registries).ok) continue;
				return {
					...commandFix(projectId, soundCheckMessage('fixSwap', title, licence), [cmd], true),
					tool: 'swap_sound',
					args: { projectId, clipId: row.clip.id, to: alt },
				};
			}
			return {
				kind: 'swap',
				label: soundCheckMessage('fixSwap', title, licence),
				safe: true,
				tool: 'swap_sound',
				args: { projectId, clipId: row.clip.id, to: alt },
				swap: { clipId: row.clip.id, soundId: alt },
			};
		}
		if (!sounds || !row.info.librarySoundId) return undefined;
		try {
			const q = SoundSearchQuerySchema.parse({
				similarTo: row.info.librarySoundId,
				license: 'commercial-safe',
				...(row.types[0] ? { types: row.types[0] } : {}),
				limit: '8',
			});
			const res = await sounds.search(q);
			for (const r of res.results) {
				if (exclude.has(r.sound.id) || !need(r.sound.license)) continue;
				return {
					kind: 'swap',
					label: soundCheckMessage('fixSwap', r.sound.title, r.sound.license),
					safe: false,
					...whyOf(soundCheckMessage('whySimilar')),
					tool: 'swap_sound',
					args: { projectId, clipId: row.clip.id, to: r.sound.id },
					swap: { clipId: row.clip.id, soundId: r.sound.id },
				};
			}
		} catch {
			// no library: no fix
		}
		return undefined;
	};
	// REPEAT: consecutive sound events (one per cue: its first layer; unlinked clips each) with the same file
	const eventsInOrder = rows
		.filter((r) => !r.cue || (r.cue.placedClipIds ?? [])[0] === r.clip.id)
		.sort((a, b) => (a.alignedFrame ?? a.frame) - (b.alignedFrame ?? b.frame));
	for (let i = 1; i < eventsInOrder.length; i++) {
		const a = eventsInOrder[i - 1]!;
		const b = eventsInOrder[i]!;
		if (soundOf(a) !== soundOf(b)) continue;
		// P6-E10: a ui / click sound is the sequence's ONE voice, the same sound every time by design (not a repeat)
		if (variationForFill(b.types) === 'voice') continue;
		b.codes.add('REPEAT');
		const next = eventsInOrder[i + 1];
		const exclude = new Set([soundOf(a), ...(next ? [soundOf(next)] : [])]);
		// any alternative whose licence is not worse than the clip's (a REPEAT fix must not make a LICENSE finding)
		const fix = await swapFix(b, exclude, (l) => licenceRank(l) <= licenceRank(b.licence));
		const iface = b.types.some((x) => INTERFACE_TYPES.has(x));
		issues.add({
			subject: b.clip.id,
			code: 'REPEAT',
			severity: iface ? 'info' : 'warning',
			frame: b.frame,
			timecode: tc(b.frame),
			clipIds: [a.clip.id, b.clip.id],
			...(b.cue ? { cueId: b.cue.id } : {}),
			message: soundCheckMessage('repeat', b.info.title, tc(a.frame), tc(b.frame)),
			...(fix ? { fix } : {}),
		});
	}
	// LICENSE: every clip of the range playing a library sound that is not commercial-safe
	for (const c of Object.values(seq.clips).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))) {
		if (c.kind !== 'audio' || !(c.start < range.end && c.start + c.duration > range.start)) continue;
		const p = readLibraryProvenance(
			(doc.media?.[(c as AudioClip).mediaId] as { library?: unknown } | undefined)?.library,
		);
		if (!p) continue;
		if (isCommercialSafe(p.license)) {
			// ShareAlike (P6-E13): allowed, but the video synced with it must be shared alike — a warning, with a
			// commercial-safe alternative that is not ShareAlike
			if (!isShareAlike(p.license)) continue;
			const row = rows.find((r) => r.clip.id === c.id);
			row?.codes.add('LICENSE');
			const fix = row
				? await swapFix(row, new Set([p.soundId]), (l) => isCommercialSafe(l) && !isShareAlike(l))
				: undefined;
			issues.add({
				subject: c.id,
				code: 'LICENSE',
				severity: 'warning',
				frame: Math.max(range.start, c.start),
				timecode: tc(Math.max(range.start, c.start)),
				clipIds: [c.id],
				message: soundCheckMessage('licenseShareAlike', p.title, p.license),
				measured: { license: p.license, class: licenseClass(p.license), variant: 'shareAlike' },
				...(fix ? { fix } : {}),
			});
			continue;
		}
		const cls = licenseClass(p.license);
		const row = rows.find((r) => r.clip.id === c.id);
		row?.codes.add('LICENSE');
		const fix = row ? await swapFix(row, new Set([p.soundId]), (l) => isCommercialSafe(l)) : undefined;
		const key =
			cls === 'nc'
				? 'licenseNc'
				: cls === 'nd'
					? 'licenseNd'
					: cls === 'user-provided'
						? 'licenseUser'
						: 'licenseUnknown';
		issues.add({
			subject: c.id,
			code: 'LICENSE',
			severity: cls === 'user-provided' ? 'warning' : 'error',
			frame: Math.max(range.start, c.start),
			timecode: tc(Math.max(range.start, c.start)),
			clipIds: [c.id],
			message: soundCheckMessage(key, p.title, p.license),
			measured: { license: p.license, class: cls },
			...(fix ? { fix } : {}),
		});
	}
	{
		const cr = soundCredits(doc, seq.id, { attributionOnly: true });
		const need = cr.rows.filter((x) => requiresAttribution(x.license) && isCommercialSafe(x.license));
		if (need.length && !settings.credits) {
			const cmd = { type: 'soundDesign.setSettings', sequenceId: seq.id, credits: 'md' };
			const ok = dryRun(doc, seq.id, [cmd], env.registries).ok;
			issues.add({
				subject: 'credits',
				code: 'CREDITS',
				severity: 'warning',
				clipIds: [...new Set(need.flatMap((x) => x.usedIn))].slice(0, 64),
				message: soundCheckMessage(
					'credits',
					need.length,
					[...new Set(need.map((x) => x.license))].join(', '),
				),
				measured: { sounds: need.length },
				...(ok ? { fix: commandFix(projectId, soundCheckMessage('fixCredits', 'md'), [cmd], true) } : {}),
			});
		}
	}
	lap('document', t);

	// ── REFERENCE (P6-E8): the delivered mix against the reference profile (rows: warnings and infos, never errors) ──
	let reference: SoundCheckReport['reference'];
	if (refProfile && profileMeter) {
		t = Date.now();
		progress(0.9, 'Comparing with the reference profile');
		const measured = profileMeter.finish(sequencePicture(doc, seq, range));
		if (measured.unscorable)
			warnings.push({
				code: 'W_REFERENCE_UNSCORABLE',
				message: `The mix is ${measured.unscorable}: it is not compared with the reference profile`,
			});
		else {
			if (measured.truncated)
				warnings.push({
					code: 'W_REFERENCE_TRUNCATED',
					message: `Only the first ${Math.round(REFERENCE_PROFILE_LIMITS.maxSec / 60)} minutes are compared with the reference profile`,
				});
			reference = referenceFindings({
				measured,
				profile: refProfile,
				source: opts.profileId === undefined ? 'sequence' : 'request',
				seq,
				projectId,
				range,
				wholeSequence: whole,
				add: (i) => issues.add(i),
			});
			const loo = looWarning(reference);
			if (loo) warnings.push(loo);
		}
		lap('reference', t);
	}

	// ── safe fixes judged together (WP6.5b): applied in order on a dry-run copy, each re-validated after the ones
	// before it (two safe fixes of one sound can overload it together; normalisation off, a gain can push the mix's
	// true peak over the ceiling): a fix that is no longer safe is marked so, with why and what it conflicts with
	const levelGuard: SoundCheckLevelGuard & { levels: SoundCheckLevelModel[] } = {
		ceilingDb: preset.truePeakDb,
		eventCeilingDb: levelOptions(opts.preset).truePeakCeilingDb,
		bedCapLu: { hero: BED_CAP_LU.hero, support: BED_CAP_LU.support, ambient: BED_CAP_LU.ambient },
		capToleranceLu: SOUND_CHECK_CAP_TOLERANCE_LU,
		levels,
	};
	// ── acknowledged findings (P6-E4): marked, left out of the verdict, the safe fixes and the per-event status
	const acked = applySoundAcknowledgements(doc, seq.id, issues.items);
	issues.items.splice(0, issues.items.length, ...(acked.issues as SoundCheckIssue[]));
	const openIssues = acked.open as SoundCheckIssue[];
	{
		const joint = planSoundCheckFixes(doc, seq.id, soundCheckFixCandidates(openIssues, { safeOnly: true }), {
			registries: env.registries,
			guard: levelGuard,
		});
		const byId = new Map(issues.items.map((i) => [i.id, i]));
		for (const s of joint.skipped)
			for (const id of s.candidate.issueIds) {
				const i = byId.get(id);
				if (!i?.fix) continue;
				i.fix = {
					...i.fix,
					safe: false,
					why: s.reason.text,
					whyMessage: s.reason,
					...(s.conflictsWith.length ? { conflictsWith: s.conflictsWith } : {}),
				};
			}
	}
	if (layout === 'mono' && !normalize)
		warnings.push({ code: 'W_MONO_MIX', message: soundCheckMessage('monoMix', '3.0').text });

	// ── the per-event table, listen-here, verdict ────────────────────────────────────────────────────────────────────
	const severityOf = new Map<string, SoundCheckSeverity[]>();
	for (const i of openIssues)
		for (const id of i.clipIds ?? []) severityOf.set(id, [...(severityOf.get(id) ?? []), i.severity]);
	const events: SoundCheckEvent[] = rows.map((r) => {
		const sev = severityOf.get(r.clip.id) ?? [];
		const kind = (r.cue?.kind ?? null) as CueKind | null;
		return {
			clipId: r.clip.id,
			cueId: r.cue?.id ?? null,
			title: r.info.title,
			track: trackLabel(seq, r.clip.trackId) ?? r.clip.trackId,
			role: r.sfx?.role ?? null,
			weight: r.info.weight,
			soundId: r.info.librarySoundId,
			license: r.licence,
			frame: r.frame,
			timecode: tc(r.frame),
			cueKind: kind,
			align: r.sfx?.placement?.align ?? null,
			toleranceFrames: kind && kind !== 'silence' ? (SYNC_TOLERANCE_FRAMES[kind] ?? null) : null,
			offsetMs: r.offsetMs,
			located: r.located,
			correlation: r.correlation,
			gainDb: r2(r.info.gainDb),
			liftDb: r.liftDb,
			minLiftDb:
				r.info.weight === 'ambient' || r.sfx?.role === 'layer' ? null : MASKED_MIN_LIFT_DB[r.info.weight],
			targetLiftDb: r.targetLiftDb,
			peakOverBedLu: r.peakOverBedLu,
			bedCapLu: r.bedCapLu,
			speech: r.speech,
			status: sev.includes('error') ? 'fail' : sev.includes('warning') ? 'warn' : 'pass',
			codes: SOUND_CHECK_CODES.filter((c) => r.codes.has(c)),
		};
	});
	const listen: SoundCheckListen[] = [];
	const at = (frame: number) => ({
		frame: Math.max(0, Math.round(frame)),
		timecode: tc(frame),
		seconds: r3(Math.max(0, Math.round(frame)) / fpsNum),
	});
	const rank = { error: 0, warning: 1, info: 2 } as const;
	const order = (c: SoundCheckCode) => SOUND_CHECK_CODES.indexOf(c);
	const worst = [...openIssues]
		.filter((i) => i.frame !== undefined && i.severity !== 'info')
		.sort(
			(a, b) => rank[a.severity] - rank[b.severity] || order(a.code) - order(b.code) || a.frame! - b.frame!,
		)[0];
	if (worst)
		listen.push({
			slot: 'worst',
			...at(worst.frame!),
			why: soundCheckMessage('listenWorst', worst.message.text),
			issueId: worst.id,
			...(worst.clipIds?.[0] ? { clipId: worst.clipIds[0] } : {}),
			...(worst.cueId ? { cueId: worst.cueId } : {}),
		});
	const hero = rows
		.filter((r) => r.info.weight === 'hero' && r.peakLu !== null)
		.sort((a, b) => b.peakLu! - a.peakLu! || a.frame - b.frame)[0];
	if (hero)
		listen.push({
			slot: 'hero',
			...at(hero.frame),
			why: soundCheckMessage(
				'listenHero',
				`${hero.info.title} (${tc(hero.frame)})`,
				fmt(hero.peakLu! + (gainDb ?? 0)),
			),
			clipId: hero.clip.id,
			...(hero.cue ? { cueId: hero.cue.id } : {}),
		});
	{
		let best = -1;
		for (let i = 0; i < rangeHops; i++) if (best < 0 || mixMomentary[i]! > mixMomentary[best]!) best = i;
		if (best >= 0 && mixMomentary[best]! > LOUDNESS_FLOOR_LUFS)
			listen.push({
				slot: 'loudest',
				...at(hopFrame(best)),
				why: soundCheckMessage('listenLoudest', fmt(mixMomentary[best]!)),
			});
	}
	{
		const times = rows.map((r) => r.alignedFrame ?? r.frame).sort((a, b) => a - b);
		let bestN = 0;
		let bestAt = 0;
		for (let i = 0, j = 0; i < times.length; i++) {
			while (times[i]! - times[j]! >= fpsNum) j++;
			if (i - j + 1 > bestN) {
				bestN = i - j + 1;
				bestAt = (times[i]! + times[j]!) / 2;
			}
		}
		if (bestN > 0)
			listen.push({ slot: 'densest', ...at(bestAt), why: soundCheckMessage('listenDensest', bestN) });
	}
	const passing = events
		.filter((e) => e.status === 'pass' && e.cueId)
		.sort((a, b) => (a.weight === 'hero' ? 0 : 1) - (b.weight === 'hero' ? 0 : 1) || a.frame - b.frame)[0];
	if (passing)
		listen.push({
			slot: 'passing',
			...at(passing.frame),
			why: soundCheckMessage('listenPassing', `${passing.title} (${tc(passing.frame)})`),
			clipId: passing.clipId,
			...(passing.cueId ? { cueId: passing.cueId } : {}),
		});

	// ── curves of the report: momentary loudness as delivered, max-pooled ─────────────────────────────────────────
	const pool1 = (c: Float32Array) => maxPool(c, SOUND_CHECK_LIMITS.reportCurvePoints);
	const mixPooled = pool1(mixMomentary);
	const report: SoundCheckReport = {
		version: 1,
		projectId,
		sequenceId: seq.id,
		revision: opts.revision,
		mixHash: mixFingerprint(doc, seq.id),
		inputsHash: soundCheckInputsHash(doc, seq.id, opts.preset, target, profileId),
		preset: {
			id: opts.preset,
			label: preset.label,
			integratedLufs: preset.integratedLufs,
			truePeakDb: preset.truePeakDb,
			source: preset.source,
			...(target ? { custom: true } : {}),
		},
		range: { ...range },
		rangeTimecode: { start: tc(range.start), end: tc(range.end) },
		wholeSequence: whole,
		fps: { num: rate.num, den: rate.den },
		durationSec: r3(rangeSamples / sr),
		verdict: acked.verdict,
		counts: acked.counts,
		issues: issues.items,
		...(acked.acknowledged || acked.unmatched.length
			? {
					acknowledgements: {
						count: acked.acknowledged,
						unmatched: acked.unmatched.slice(0, SOUND_DESIGN_LIMITS.acknowledged),
					},
				}
			: {}),
		events,
		listen,
		loudness: {
			integratedLufs: measurable ? r2(final.integrated) : null,
			truePeakDb: finOrNull(final.truePeakDb),
			samplePeakDb: finOrNull(final.samplePeakDb),
			lra: Number.isFinite(final.lra) ? r2(final.lra) : null,
			maxMomentaryLufs: finOrNull(final.maxMomentary),
			maxShortTermLufs: finOrNull(final.maxShortTerm),
			measurable,
			normalization: {
				enabled: !!normalize,
				targetLufs: normalize?.targetLufs ?? null,
				truePeakDb: normalize?.truePeakDb ?? null,
				gainDb: gainDb === null ? null : r2(gainDb),
			},
			limiterMaxGrDb: normalize ? r2(limiterMax) : null,
			layout,
			before: {
				integratedLufs: finOrNull(before.integrated),
				truePeakDb: finOrNull(before.truePeakDb),
				samplePeakDb: finOrNull(before.samplePeakDb),
			},
		} satisfies SoundCheckLoudness,
		curves: {
			hopSec: r3(mixPooled.factor * CURVE_HOP_SEC),
			startSec: r3(rangeStart / sr),
			points: mixPooled.values.length,
			window: 'momentary',
			mix: mixPooled.values,
			bed: pool1(stemMomentary('bed')).values,
			sfx: pool1(stemMomentary('sfx')).values,
			music: pool1(stemMomentary('music')).values,
			dialogue: pool1(stemMomentary('dialogue')).values,
			ambience: pool1(stemMomentary('ambience')).values,
			limiterGrDb: normalize ? pool1(grHop).values : [],
		},
		speech: {
			seconds: speechSeconds,
			segments: segments.map(([a, b]) => [r3((rangeStart + a * hop) / sr), r3((rangeStart + b * hop) / sr)]),
		},
		stems: Object.fromEntries(STEMS.map((s) => [s, stemIds[s].size])),
		warnings,
		timings: { ...timings, decoders, total: Date.now() - t0 },
		levelGuard,
		...(reference ? { reference } : {}),
	};
	progress(0.97, 'Checked');
	return report;
}

// ── the job ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SoundCheckJobInput = { request: SoundCheckRequest; who: Requester };

/** The job's input, re-validated when read back. */
export function parseInput(raw: unknown): SoundCheckJobInput {
	const r = raw as { request?: unknown; who?: { editor?: unknown; agent?: unknown } } | null;
	const parsed = SoundCheckRequestSchema.safeParse(r?.request);
	if (!parsed.success) throw new JobError('VALIDATION_FAILED', 'The sound check request is invalid', false);
	return {
		request: parsed.data,
		who: {
			editor: r?.who?.editor === true,
			agent: typeof r?.who?.agent === 'string' ? r.who.agent.slice(0, 64) : 'An agent',
		},
	};
}

/** The `sound-check` job runner (a proposal check, `request.proposalId`, is `runProposalCheckJob`). */
export async function runSoundCheck(ctx: JobContext, deps: SoundCheckDeps): Promise<SoundCheckResult> {
	return asJobErrors(() => soundCheckJob(ctx, deps));
}

/** Runs a check, turning HTTP and plan-input errors into job errors. */
export async function asJobErrors<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (e instanceof HttpError) throw new JobError(e.code, e.message, e.status === 503, e.detail);
		if (e instanceof PlanInputError) throw new JobError(e.code, e.message, false);
		throw e;
	}
}

/** The environment a check of this job runs in; `onProgress` maps the check's progress onto the job's. */
export async function checkEnvFor(
	ctx: JobContext,
	deps: SoundCheckDeps,
	onProgress: (fraction: number, stage: string) => void,
): Promise<CheckEnv> {
	return {
		ff: deps.ffmpeg,
		registry: deps.registry,
		registries: deps.registries,
		mgTemplates: deps.mgTemplates,
		sounds: deps.sounds(),
		...(deps.cache ? { cache: deps.cache } : {}),
		engineCues: deps.engineCues?.(),
		scratchDir: await ctx.scratchDir(),
		signal: ctx.signal,
		onSpawn: ctx.trackChild,
		onProgress,
		jobId: ctx.job.id,
		profiles: deps.profiles?.(),
	};
}

async function soundCheckJob(ctx: JobContext, deps: SoundCheckDeps): Promise<SoundCheckResult> {
	const { request: req, who } = parseInput(ctx.input);
	const agent = deps.agent();
	if (!agent) throw new JobError('NOT_AVAILABLE', 'The agent service is not running', true);
	// a proposal's check is its own runner (check-proposal.ts): never a check of the document under its name
	if (req.proposalId)
		throw new JobError('VALIDATION_FAILED', 'A proposal check runs as runProposalCheckJob', false);
	ctx.progress(0.01, { stage: 'Reading the edit' });
	const live = await liveDocument(agent, req.projectId);
	const seq = planSequence(live.doc, req.sequenceId);
	const preset = (req.preset ?? soundDesignSettingsOf(seq).delivery) as SoundDelivery;
	const target = req.target ? (readSoundCheckTarget(req.target) ?? undefined) : undefined;
	const report = await checkSequence(
		live.doc,
		seq,
		{
			projectId: req.projectId,
			revision: live.revision,
			preset,
			target,
			range: req.range,
			...(req.profileId !== undefined ? { profileId: req.profileId } : {}),
		},
		await checkEnvFor(ctx, deps, (f, stage) => ctx.progress(0.02 + 0.9 * f, { stage })),
	);
	ctx.log(
		`sound check ${report.verdict}: ${JSON.stringify(report.counts)} ${JSON.stringify(report.timings)}`,
	);
	if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
	let stored = false;
	let revision: number | null = live.revision;
	if (req.store) {
		ctx.progress(0.95, { stage: 'Storing the summary' });
		const out = await agent.transact(
			req.projectId,
			{
				label: SOUND_CHECK_LABEL,
				origin: { agent: who.agent },
				sequenceId: seq.id,
				commands: [
					{
						type: 'soundDesign.setCheck',
						sequenceId: seq.id,
						summary: {
							mixHash: report.mixHash,
							verdict: report.verdict,
							counts: Object.fromEntries(Object.entries(report.counts).slice(0, 64)),
							at: new Date().toISOString(),
							preset,
							...(target ? { target } : {}),
							inputsHash: report.inputsHash || 'none',
							jobId: ctx.job.id,
							...(report.wholeSequence ? {} : { range: report.range }),
						},
					},
				],
			},
			{ fallbackAgent: who.agent, ...(who.editor ? { preApproved: true, asUser: true } : {}) },
		);
		const r = out.result as { ok: boolean; revision?: number; errors?: { code: string; message: string }[] };
		if (!r.ok)
			throw new JobError(
				r.errors?.[0]?.code ?? 'TRANSACTION_REJECTED',
				`The summary was not stored: ${r.errors?.[0]?.message ?? 'refused'}`,
				false,
			);
		stored = true;
		revision = r.revision ?? null;
	}
	ctx.progress(1, { stage: `Sound Check: ${report.verdict}` });
	return { projectId: req.projectId, sequenceId: seq.id, stored, revision, report };
}
