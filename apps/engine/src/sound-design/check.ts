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
//    `evaluateSfxGain`, `solveSfxGains`): MASKED, OVERLOAD (peak over the bed) and their gain fixes.
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
} from '@jasper/api';
import { SOUND_CHECK_LIMITS, SoundCheckRequestSchema, SoundSearchQuerySchema } from '@jasper/api';
import {
	defaultChannelWeights,
	LoudnessMeter,
	type LoudnessSummary,
	TruePeakLimiter,
} from '@jasper/audio-dsp';
import {
	CURVE_HOP_SEC,
	CurveMeter,
	evaluateSfxGain,
	LOUDNESS_FLOOR_LUFS,
	locateByCorrelation,
	loudnessCurve,
	maxPool,
	type SolverEvent,
	type StemCurves,
	silentCurves,
} from '@jasper/audio-fx';
import {
	type AudioClip,
	applyTransaction,
	type ClipSfx,
	type CueKind,
	createRandomIdSource,
	DENSITY_BUDGETS,
	deliveryPreset,
	deriveCues,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	frameToSample,
	HERO_MIN_SEC,
	isCommercialSafe,
	isSfxClip,
	licenseClass,
	MASKED_MIN_LIFT_DB,
	type MgTemplateRegistry,
	mixFingerprint,
	type ProjectDocument,
	type Rational,
	type Registries,
	readClipSfx,
	readEssentialSound,
	readLibraryProvenance,
	requiresAttribution,
	resolveCueAnchor,
	type Sequence,
	SOUND_CHECK_CATEGORY,
	SOUND_CHECK_CODES,
	SOUND_CHECK_THRESHOLDS,
	type SoundCheckCode,
	type SoundCheckMessage,
	type SoundCheckSeverity,
	type SoundCue,
	type SoundDelivery,
	SYNC_MIN_CORRELATION,
	SYNC_SEARCH_FRAMES,
	SYNC_TOLERANCE_FRAMES,
	sequenceDuration,
	sequenceTimecode,
	sequenceWords,
	soundCheckCounts,
	soundCheckInputsHash,
	soundCheckMessage,
	soundCheckVerdict,
	soundCredits,
	soundCuesOf,
	soundDesignSettingsOf,
	trackLabel,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { Requester } from '../proposals/service.ts';
import { LOCAL_PROTOCOLS, readPlanar } from '../sounds/decode.ts';
import type { SoundService } from '../sounds/service.ts';
import { vadThreshold } from '../speech/core/vad.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { sec } from '../tools/ffmpeg.ts';
import { HttpError } from '../tools/reply.ts';
import { type AudioWorld, audioWorld, type MeasureCache, measureSfxEvents, VAD_FLOOR_DBFS } from './bed.ts';
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
import { classifyStems, renderStems, STEM_NAMES, type StemName, type StemSpec } from './stems.ts';

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
/** Reference decodes at once. */
const DECODE_CONCURRENCY = 4;
/** "Audible" for the measurable-loudness rule: a 10 ms hop over BS.1770's absolute gate level (−70 dBFS). */
const AUDIBLE_DBFS = -70;
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
};

export type CheckEnv = {
	ff: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	registries: Registries;
	mgTemplates: MgTemplateRegistry;
	sounds?: SoundService | undefined;
	cache?: MeasureCache;
	scratchDir: string;
	signal?: AbortSignal;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
	onProgress?(fraction: number, stage: string): void;
	jobId?: string;
};

export type CheckOptions = {
	projectId: string;
	revision: number | null;
	preset: SoundDelivery;
	/** Sequence frames; default the whole sequence. */
	range?: { start: number; end: number } | undefined;
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
};

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
	toleranceFrames: number;
	align: 'peak' | 'start' | 'end';
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
	why?: string,
): SoundCheckFix => ({
	kind: 'commands',
	label,
	safe,
	...(why ? { why } : {}),
	tool: 'apply_commands',
	args: { projectId, label: label.text.slice(0, 200), commands },
	commands: commands as SoundCheckFix['commands'],
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
	const preset = deliveryPreset(opts.preset);
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
	const seqEnd = frameToSample(duration, rate, sr);
	const preHops = Math.min(PRE_HOPS, Math.floor(rangeStart / hop));
	const renderStart = rangeStart - preHops * hop;
	const renderEnd = Math.min(Math.max(rangeEnd, seqEnd), rangeEnd + POST_HOPS * hop);
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
		const aligned = sfx?.placement
			? (c.start * F + (sfx.placement.peakFlicks - c.sourceIn) / (c.speed?.rate || 1)) / F
			: null;
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

	// sync captures (the SFX stem around each filled cue)
	const captures: Capture[] = [];
	const unmeasured = new Map<SfxRow, string>();
	for (const row of rows) {
		const sfx = row.sfx;
		if (!row.cue || !sfx?.placement) continue;
		const kind = row.cue.kind as CueKind;
		if (kind === 'silence') continue;
		if (!playing.has(row.clip.id)) {
			unmeasured.set(row, 'it is not in the mix (disabled, muted track or offline media)');
			continue;
		}
		if (row.clip.speed?.reverse) {
			unmeasured.set(row, 'it plays reversed');
			continue;
		}
		const asset = doc.media?.[row.clip.mediaId] as { fingerprint?: string } | undefined;
		const rc = snap.audioClips.find((x) => x.clipId === row.clip.id);
		const src = world.media(row.clip.mediaId);
		const stream = src?.streams.find((s) => s.index === rc?.channels.streamIndex) ?? src?.streams[0];
		if (!asset || !src || !stream) {
			unmeasured.set(row, 'its media is offline');
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
			unmeasured.set(row, 'its sound is too short around its aligned point');
			continue;
		}
		const expected = Math.round((row.cue.frame / fpsNum) * sr);
		const search = Math.ceil((SYNC_SEARCH_FRAMES / fpsNum) * sr);
		const refLen = Math.ceil((before + post) * sr);
		const a = expected - Math.round(before * sr) - search - hop;
		const len = refLen + 2 * search + 2 * hop;
		if (a < renderStart || a + len > renderEnd) {
			unmeasured.set(row, 'its cue is at the edge of the checked range');
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
				toleranceFrames: SYNC_TOLERANCE_FRAMES[kind] ?? 1,
				align,
			},
		});
	}

	// ── one pass: every stem's curves, the mix meter (range only), the first-pass file, the SFX captures ─────────────
	aborted();
	progress(0.05, 'Rendering the mix and its stems');
	let t = Date.now();
	const channels = snap.audioMix?.masterFormat === '5.1' ? 6 : 2;
	const meters: Partial<Record<Stem, CurveMeter>> = {};
	for (const s of STEMS) if (stemIds[s].size > 0) meters[s] = new CurveMeter(sr, channels);
	const mixMeter = new LoudnessMeter(sr, channels, { weights: defaultChannelWeights(channels) });
	const pass1 = normalize ? join(env.scratchDir, 'check-pass1.f32') : null;
	const fh = pass1 ? await open(pass1, 'w') : null;
	let audibleHops = 0;
	const stemSpecs: StemSpec[] = STEMS.map((s) => ({ name: s, clipIds: s === 'mix' ? null : stemIds[s] }));
	if (stemIds.mix.size === 0) stemSpecs[0] = { name: 'mix', clipIds: new Set() };
	let decoders = 0;
	try {
		if (stemIds.mix.size > 0 && renderEnd > renderStart) {
			const res = await renderStems({
				ff: env.ff,
				snapshot: snap,
				media: world.media,
				startSample: renderStart,
				samples: renderEnd - renderStart,
				stems: stemSpecs,
				...(env.signal ? { signal: env.signal } : {}),
				...(env.onSpawn ? { onSpawn: env.onSpawn } : {}),
				onProgress: (f) => progress(0.05 + 0.4 * f, 'Rendering the mix and its stems'),
				onBlock: async (stem, planar, n, at) => {
					const name = STEMS[stem]!;
					meters[name]?.push(planar, n);
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
					// the range only: the export's loudness and the normalisation pass
					const a = Math.max(at, rangeStart);
					const b = Math.min(at + n, rangeEnd);
					if (b <= a) return;
					const off = a - at;
					mixMeter.process(planar, off, b - a);
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
	// bridge gaps under 0.3 s (pauses between syllables and words)
	const bridged = runs(rangeHops, (i) => speech[i] === 1);
	const segments: [number, number][] = [];
	for (const [a, b] of bridged) {
		const last = segments[segments.length - 1];
		if (last && a - last[1] <= 30) last[1] = b;
		else segments.push([a, b]);
	}
	const speechSeconds = r2((speech.reduce((n, v) => n + v, 0) * hop) / sr);

	// ── LOUDNESS, TRUE_PEAK, OVERLOAD (limiter, clipping) ──────────────────────────────────────────────────────────
	for (let i = 0; i < rangeHops; i++) if (mixMsDb[i]! > AUDIBLE_DBFS) audibleHops++;
	const audibleSec = (audibleHops * hop) / sr;
	const measurable =
		Number.isFinite(final.integrated) && audibleSec >= SOUND_CHECK_THRESHOLDS.minMeasurableSec;
	const broadcast = opts.preset === 'broadcast-r128' || opts.preset === 'atsc-a85';
	const loudnessFix = (why: string): SoundCheckFix | undefined => {
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
			const fix = settingsMatch ? undefined : loudnessFix('The export then normalises to the target');
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
		const fix = settingsMatch ? undefined : loudnessFix('The export limiter then holds the ceiling');
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
				why: 'Solving the sound effects against the bed and the true-peak ceiling lowers the loudest hits; listen to the result',
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
		const fix = loudnessFix('The export limiter then keeps the mix under its ceiling');
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
		measured.forEach((row, i) => {
			const ev = events[i]!;
			const ms = m.sounds.get(row.clip.id)!;
			const cur = evaluateSfxGain(ev, row.info.gainDb, lo);
			row.liftDb = cur.liftDb;
			row.targetLiftDb = cur.targetLiftDb;
			row.peakOverBedLu = cur.peakOverBedLu;
			row.bedCapLu = cur.bedCapLu;
			row.speech = ms.speechOverlap;
			row.peakLu = ms.soundPeakLu === null ? null : ms.soundPeakLu + row.info.gainDb;
			const res = solved.events[i]!;
			const at = evaluateSfxGain(ev, res.gainDb, lo);
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
							? 'Its gain was set by hand'
							: `The solver's gain does not resolve it: ${level.reason}`,
				);
			};
			const min = row.info.weight === 'ambient' ? null : MASKED_MIN_LIFT_DB[row.info.weight];
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
			unmeasured.set(c.row, 'its file could not be decoded');
			return;
		}
		const search = Math.ceil((SYNC_SEARCH_FRAMES / fpsNum) * sr);
		const nominal = c.ref.expected - c.ref.anchor - c.a;
		const found = locateByCorrelation(ref, c.data, nominal - search - hop, nominal + search + hop);
		if (!found || found.ncc < SYNC_MIN_CORRELATION) {
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
		if (why) {
			// not measurable in the mix: judge by the document
			if (metaOffMs !== null && Math.abs(metaOffMs) > tolMs + 0.5) {
				row.codes.add('OUT_OF_SYNC');
				const fix = realign();
				issues.add({
					...base,
					severity: 'error',
					message: soundCheckMessage(
						metaOffMs < 0 ? 'syncEarly' : 'syncLate',
						row.info.title,
						r1(Math.abs(metaOffMs)),
						kind,
						tc(row.cue.frame),
						tol,
					),
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
			if (Math.abs(row.offsetMs) <= tolMs + 0.5) continue;
			row.codes.add('OUT_OF_SYNC');
			const moved = metaOffMs !== null && Math.abs(metaOffMs) > 0.5;
			const fix = moved ? realign() : undefined;
			issues.add({
				...base,
				severity: 'error',
				message: moved
					? soundCheckMessage(
							row.offsetMs < 0 ? 'syncEarly' : 'syncLate',
							row.info.title,
							r1(Math.abs(row.offsetMs)),
							kind,
							tc(row.cue.frame),
							tol,
						)
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
			if (metaOffMs !== null && Math.abs(metaOffMs) > tolMs + 0.5) {
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
					message: soundCheckMessage(
						'syncUnmeasurable',
						row.info.title,
						'other sounds cover it in the sound-effects mix',
					),
					measured: { correlation: row.correlation },
				});
		}
	}
	lap('sync', t);

	// ── MUSIC_OVER_VOICE ─────────────────────────────────────────────────────────────────────────────────────────────
	t = Date.now();
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
			const depth = Math.min(0, ...duck.map((es) => es?.ducking.reduceDb ?? -15));
			const predicted = under - depth;
			const fix: SoundCheckFix = ducked
				? {
						kind: 'job',
						label: soundCheckMessage('fixDelivery', preset.label),
						safe: false,
						why: 'The music is ducked already: Auto-Match levels the dialogue and music clips by type (it changes their gains)',
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
							: {
									why: `Ducking by ${fmt(-depth)} dB leaves the music ${fmt(predicted)} LU under the voice`,
								}),
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
	const silentRuns = runs(rangeHops, (i) => mixMsDb[i]! < SOUND_CHECK_THRESHOLDS.silenceDbfs).filter(
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
			'Only if the silence is intended',
		);
	};
	for (const [a, b] of silentRuns) {
		const fa = Math.floor(hopFrame(a));
		const fb = Math.min(range.end, Math.ceil(hopFrame(b)));
		if (silenceExplained(fa, fb)) continue;
		const fix = silenceFix(fa, fb);
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
				silentRuns.some(([a, b]) => a <= bottom && b >= bottom);
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

	// ── STALE_CUE, NO_PICTURE_EVENT ─────────────────────────────────────────────────────────────────────────────────
	aborted();
	progress(0.8, 'Checking the cues against the picture');
	t = Date.now();
	const inRange = (f: number) => f >= range.start && f < range.end;
	const derived = deriveCues(doc, seq.id, {
		density: 'rich',
		respectDialogue: false,
		mgTemplates: env.mgTemplates,
		range: { start: Math.max(0, range.start - 3), end: range.end + 3 },
	});
	const derivedFrames = derived.cues.map((c) => c.frame);
	const motionAt = (f: number) => {
		let best = 0;
		for (const c of derived.curves) {
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
			const f = resolveCueAnchor(doc, seq, cue.anchor, { mgTemplates: env.mgTemplates });
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
									'Or keep it where it is: it no longer follows the picture',
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
				'Only if nothing on screen calls for it',
			),
		});
	}

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
		if (p?.soundId && !libraryMedia.has(p.soundId)) libraryMedia.set(p.soundId, mid);
	}
	const soundOf = (r: SfxRow) => r.info.librarySoundId ?? `media:${r.clip.mediaId}`;
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
					why: 'A different sound found by similarity: listen before keeping it',
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
		b.codes.add('REPEAT');
		const next = eventsInOrder[i + 1];
		const exclude = new Set([soundOf(a), ...(next ? [soundOf(next)] : [])]);
		const fix = await swapFix(b, exclude, () => true);
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
		if (!p || isCommercialSafe(p.license)) continue;
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

	// ── the per-event table, listen-here, verdict ────────────────────────────────────────────────────────────────────
	const severityOf = new Map<string, SoundCheckSeverity[]>();
	for (const i of issues.items)
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
			minLiftDb: r.info.weight === 'ambient' ? null : MASKED_MIN_LIFT_DB[r.info.weight],
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
	const worst = [...issues.items]
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
		inputsHash: soundCheckInputsHash(doc, seq.id, opts.preset),
		preset: {
			id: opts.preset,
			label: preset.label,
			integratedLufs: preset.integratedLufs,
			truePeakDb: preset.truePeakDb,
			source: preset.source,
		},
		range: { ...range },
		rangeTimecode: { start: tc(range.start), end: tc(range.end) },
		wholeSequence: whole,
		fps: { num: rate.num, den: rate.den },
		durationSec: r3(rangeSamples / sr),
		verdict: soundCheckVerdict(issues.items),
		counts: soundCheckCounts(issues.items),
		issues: issues.items,
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
	};
	progress(0.97, 'Checked');
	return report;
}

// ── the job ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type SoundCheckJobInput = { request: SoundCheckRequest; who: Requester };

function parseInput(raw: unknown): SoundCheckJobInput {
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

/** The `sound-check` job runner. */
export async function runSoundCheck(ctx: JobContext, deps: SoundCheckDeps): Promise<SoundCheckResult> {
	try {
		return await soundCheckJob(ctx, deps);
	} catch (e) {
		if (e instanceof HttpError) throw new JobError(e.code, e.message, e.status === 503, e.detail);
		if (e instanceof PlanInputError) throw new JobError(e.code, e.message, false);
		throw e;
	}
}

async function soundCheckJob(ctx: JobContext, deps: SoundCheckDeps): Promise<SoundCheckResult> {
	const { request: req, who } = parseInput(ctx.input);
	const agent = deps.agent();
	if (!agent) throw new JobError('NOT_AVAILABLE', 'The agent service is not running', true);
	ctx.progress(0.01, { stage: 'Reading the edit' });
	const live = await liveDocument(agent, req.projectId);
	const seq = planSequence(live.doc, req.sequenceId);
	const preset = (req.preset ?? soundDesignSettingsOf(seq).delivery) as SoundDelivery;
	const report = await checkSequence(
		live.doc,
		seq,
		{ projectId: req.projectId, revision: live.revision, preset, range: req.range },
		{
			ff: deps.ffmpeg,
			registry: deps.registry,
			registries: deps.registries,
			mgTemplates: deps.mgTemplates,
			sounds: deps.sounds(),
			...(deps.cache ? { cache: deps.cache } : {}),
			scratchDir: await ctx.scratchDir(),
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (f, stage) => ctx.progress(0.02 + 0.9 * f, { stage }),
			jobId: ctx.job.id,
		},
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
