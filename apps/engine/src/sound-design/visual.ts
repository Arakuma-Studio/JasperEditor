// Sound Check visual data (spec 12 §2.6 "Visual data comes from the engine", §2.8 `POST /api/sound-design/visual`, P5-R2;
// wp-note "Phase 5 → WP5.1"): over a bounded range (≤ 120 s) the 10 ms momentary and short-term loudness of the mix and
// of each stem (bed, sound effects, music, dialogue, ambience), the mix's 10 ms sample peaks, the cue ticks, the sound
// effect clips with their aligned points, the 10 ms sample peaks of the sound-effects stem and the bed, speech, the
// picture's motion curve (the fastest keyframed layer per frame, from `deriveCues`), the MEASURED picture motion where
// the range was already analysed (`motion-analysis` cache; never started here) and — given a finished `sound-check`
// job — its findings over the range. MCP draws it into PNGs
// (`view_sound_timeline`, `sound_check` images); the web panel draws the same data on a canvas.
//
// As delivered: when the Mix normalises and its stored loudness analysis is current (`mixHash` = `mixFingerprint`), the
// normalisation gain is added to every curve (the limiter is not applied here: `sound_check` measures it); otherwise
// the curves are as mixed and `normalization.reason` says why.
import type { EngineJob, SoundVisualRequest, SoundVisualResponse } from '@jasper/api';
import { SoundCheckResultSchema } from '@jasper/api';
import {
	CURVE_HOP_SEC,
	CurveMeter,
	LISTEN_EVENTS,
	LOUDNESS_FLOOR_LUFS,
	loudnessCurve,
	SpectrogramMeter,
	silentCurves,
} from '@jasper/audio-fx';
import {
	type AudioClip,
	type ClipSfx,
	deriveCues,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	frameToSample,
	isSfxClip,
	type MgTemplateRegistry,
	mixFingerprint,
	type ProjectDocument,
	type Rational,
	readClipSfx,
	readLibraryProvenance,
	type Sequence,
	sequenceDuration,
	sequenceTimecode,
	sequenceWords,
	soundCuesOf,
} from '@jasper/project';
import type { MediaRegistry } from '../media/registry.ts';
import { vadThreshold } from '../speech/core/vad.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { audioWorld, VAD_FLOOR_DBFS } from './bed.ts';
import { classifyStems, mixLayoutOf, renderStems, STEM_NAMES, type StemName } from './stems.ts';

/** Longest range (seconds). */
export const VISUAL_MAX_SEC = 120;
const PRE_HOPS = 150;
const POST_HOPS = 150;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export class VisualInputError extends Error {
	constructor(
		readonly code: 'RANGE_TOO_LONG' | 'RANGE_EMPTY',
		message: string,
	) {
		super(message);
	}
}

export type VisualEnv = {
	ff: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	mgTemplates: MgTemplateRegistry;
	/** The check job named by `checkJobId` (null: unknown / not finished). */
	checkJob?: EngineJob | null;
	/** The measured picture-motion curves already cached over the range (`MotionService.cachedCurves`; never analyses). */
	pixelCurves?: (range: { start: number; end: number }) => Promise<{ startFrame: number; speed: number[] }[]>;
	signal?: AbortSignal;
};

/** The frames a request covers (clamped to the sequence), or a typed error. */
export function visualRange(
	seq: Sequence,
	req: Pick<SoundVisualRequest, 'range'>,
): { start: number; end: number } {
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.num / rate.den;
	const duration = Math.max(0, Math.ceil(sequenceDuration(seq)));
	const start = Math.min(req.range.start, duration);
	const end = Math.min(req.range.end, duration);
	if (end <= start)
		throw new VisualInputError('RANGE_EMPTY', `The range is outside the sequence (0–${duration} frames)`);
	if ((end - start) / fps > VISUAL_MAX_SEC + 1e-9)
		throw new VisualInputError('RANGE_TOO_LONG', `At most ${VISUAL_MAX_SEC} s per request`);
	return { start, end };
}

/** The report of a finished `sound-check` job of `sequenceId` (null: none, not finished, another sequence). */
export function checkReportOf(job: EngineJob | null | undefined, sequenceId: string) {
	if (job?.kind !== 'sound-check' || job.state !== 'succeeded') return null;
	const r = SoundCheckResultSchema.safeParse(job.result);
	return r.success && r.data.sequenceId === sequenceId ? r.data.report : null;
}

/**
 * The gain that makes the mix "as delivered" (see the module docs): the Mix's loudness normalisation measured by a
 * check of this mix, else its stored analysis when current; 0 with the reason otherwise.
 */
export function deliveredGain(
	doc: ProjectDocument,
	seq: Sequence,
	fromJob: ReturnType<typeof checkReportOf>,
): { applied: boolean; gainDb: number; reason?: string } {
	const loud = (seq.master as { loudness?: Record<string, unknown> }).loudness;
	const analysis = loud?.analysis as { integratedLufs?: unknown; mixHash?: unknown } | null | undefined;
	const mixHash = mixFingerprint(doc, seq.id);
	if (!loud?.enabled)
		return { applied: false, gainDb: 0, reason: 'Loudness normalisation is off: the curves are the mix as it is' };
	if (
		fromJob &&
		fromJob.mixHash === mixHash &&
		fromJob.wholeSequence &&
		fromJob.loudness.normalization.gainDb !== null
	)
		// the check measured this mix: its normalisation gain is the export's
		return { applied: true, gainDb: fromJob.loudness.normalization.gainDb };
	if (
		!analysis ||
		typeof analysis.integratedLufs !== 'number' ||
		!Number.isFinite(analysis.integratedLufs) ||
		analysis.mixHash !== mixHash
	)
		return {
			applied: false,
			gainDb: 0,
			reason:
				'The Mix normalises, but its loudness analysis is missing or out of date: the curves are before normalisation',
		};
	const gain = (loud.targetLufs as number) - analysis.integratedLufs;
	return Number.isFinite(gain) ? { applied: true, gainDb: gain } : { applied: false, gainDb: 0 };
}

/** Builds the visual data of `seq` over `req.range` (see the module docs). */
export async function soundVisual(
	doc: ProjectDocument,
	seq: Sequence,
	req: SoundVisualRequest,
	env: VisualEnv,
): Promise<SoundVisualResponse> {
	const range = visualRange(seq, req);
	const rate = seq.settings.frameRate as Rational;
	const F = flicksPerFrame(rate);
	const tc = (f: number) => sequenceTimecode(seq, Math.max(0, Math.round(f)));
	const world = await audioWorld(doc, seq.id, env.registry);
	const snap = world.snapshot;
	const sr = snap.audioMix?.sampleRate ?? snap.settings.sampleRate;
	const hop = Math.max(1, Math.round(sr * CURVE_HOP_SEC));
	const stems = classifyStems(
		seq,
		snap.audioClips.map((c) => c.clipId),
	);
	const rangeStart = frameToSample(range.start, rate, sr);
	const rangeEnd = frameToSample(range.end, rate, sr);
	const rangeHops = Math.ceil((rangeEnd - rangeStart) / hop);
	const preHops = Math.min(PRE_HOPS, Math.floor(rangeStart / hop));
	const renderStart = rangeStart - preHops * hop;
	const renderEnd = rangeEnd + POST_HOPS * hop;
	const { channels } = mixLayoutOf(snap);
	const meters: Partial<Record<StemName, CurveMeter>> = {};
	for (const s of STEM_NAMES) if (stems[s].size > 0) meters[s] = new CurveMeter(sr, channels);
	// normalisation as delivered (the check job's, else the stored analysis, when current)
	const fromJob = checkReportOf(env.checkJob, seq.id);
	const norm = deliveredGain(doc, seq, fromJob);
	const gain = norm.gainDb;
	const applied = norm.applied;
	const reason = norm.reason;
	// the mix's spectrogram (P6-E7), as delivered
	const spec = req.spectrogram ? new SpectrogramMeter(sr, channels, gain) : null;
	if (stems.mix.size > 0)
		await renderStems({
			ff: env.ff,
			snapshot: snap,
			media: world.media,
			startSample: renderStart,
			samples: renderEnd - renderStart,
			stems: STEM_NAMES.map((s) => ({ name: s, clipIds: s === 'mix' ? null : stems[s] })),
			...(env.signal ? { signal: env.signal } : {}),
			onBlock: (i, planar, n) => {
				meters[STEM_NAMES[i]!]?.push(planar, n);
				if (i === 0) spec?.push(planar, n);
			},
		});
	const total = Math.ceil((renderEnd - renderStart) / hop);
	const crop = (c: Float32Array) => Array.from(c.subarray(preHops, preHops + rangeHops), (v) => r2(v));
	const curveOf = (s: StemName) => {
		const c = meters[s]?.finish() ?? silentCurves(sr, total);
		return { c, momentary: crop(loudnessCurve(c, 0.4, gain)), shortTerm: crop(loudnessCurve(c, 3, gain)) };
	};
	const all = Object.fromEntries(STEM_NAMES.map((s) => [s, curveOf(s)])) as Record<
		StemName,
		ReturnType<typeof curveOf>
	>;
	const peaksOf = (s: StemName) =>
		Array.from(all[s].c.peakDb.subarray(preHops, preHops + rangeHops), (v) =>
			r2(v > LOUDNESS_FLOOR_LUFS ? Math.max(LOUDNESS_FLOOR_LUFS, v + gain) : LOUDNESS_FLOOR_LUFS),
		);
	const waveformPeakDb = peaksOf('mix');
	// the sync strip draws the sound effects over the bed (Phase 5 verification): their own peaks, as delivered
	const stemPeakDb = { sfx: peaksOf('sfx'), bed: peaksOf('bed') };
	// speech
	const speech: [number, number][] = [];
	const mark = new Uint8Array(rangeHops);
	try {
		for (const w of sequenceWords(doc, seq)) {
			const a = Math.max(0, Math.floor(((w.start / FLICKS_PER_SECOND) * sr - rangeStart) / hop));
			const b = Math.min(rangeHops, Math.ceil(((w.end / FLICKS_PER_SECOND) * sr - rangeStart) / hop));
			for (let i = a; i < b; i++) mark[i] = 1;
		}
	} catch {
		// voice activity only
	}
	if (stems.dialogue.size > 0) {
		const db = all.dialogue.c.msDb.subarray(preHops, preHops + rangeHops);
		const th = Math.max(vadThreshold(db), VAD_FLOOR_DBFS);
		for (let i = 0; i < db.length; i++) if (db[i]! >= th) mark[i] = 1;
	}
	// voiced runs, gaps under 0.3 s bridged (pauses between syllables), as the check does
	const runs: [number, number][] = [];
	for (let i = 0, a = -1; i <= rangeHops; i++) {
		const on = i < rangeHops && mark[i] === 1;
		if (on && a < 0) a = i;
		else if (!on && a >= 0) {
			const last = runs[runs.length - 1];
			if (last && a - last[1] <= 30) last[1] = i;
			else runs.push([a, i]);
			a = -1;
		}
	}
	for (const [a, b] of runs) speech.push([r3((rangeStart + a * hop) / sr), r3((rangeStart + b * hop) / sr)]);
	// motion: the fastest keyframed layer per frame
	const derived = deriveCues(doc, seq.id, {
		density: 'rich',
		respectDialogue: false,
		mgTemplates: env.mgTemplates,
		range: { start: range.start, end: range.end },
	});
	const speed = new Array<number>(range.end - range.start).fill(0);
	for (const c of derived.curves)
		for (let i = 0; i < c.speed.length; i++) {
			const f = c.start + i - range.start;
			if (f >= 0 && f < speed.length && c.speed[i]! > speed[f]!) speed[f] = c.speed[i]!;
		}
	// the measured picture motion, where the range was already analysed (null per frame elsewhere)
	let pixelMotion: SoundVisualResponse['pixelMotion'] = null;
	const measured = env.pixelCurves ? await env.pixelCurves(range).catch(() => []) : [];
	if (measured.length) {
		const px = new Array<number | null>(range.end - range.start).fill(null);
		let covered = 0;
		for (const c of measured)
			for (let i = 0; i < c.speed.length; i++) {
				const f = c.startFrame + i - range.start;
				const v = c.speed[i]!;
				if (f < 0 || f >= px.length || !Number.isFinite(v)) continue;
				if (px[f] === null) covered++;
				px[f] = Math.max(px[f] ?? 0, v);
			}
		if (covered) pixelMotion = { startFrame: range.start, speed: px.map((v) => (v === null ? null : r3(v))) };
	}
	// cues and sound effect clips
	const cues = soundCuesOf(seq)
		.filter((c) => c.frame >= range.start && c.frame < range.end)
		.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : 1))
		.map((c) => ({
			cueId: c.id,
			frame: c.frame,
			timecode: tc(c.frame),
			kind: c.kind,
			weight: c.weight,
			filled: (c.placedClipIds?.length ?? 0) > 0,
			muted: c.muted === true,
			label: c.label ?? null,
		}));
	const clips = Object.values(seq.clips)
		.filter(
			(c) => c.kind === 'audio' && isSfxClip(c) && c.start < range.end && c.start + c.duration > range.start,
		)
		.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))
		.map((c) => {
			const a = c as AudioClip & { sfx?: unknown };
			const sfx: ClipSfx | null = a.sfx !== undefined ? readClipSfx(a.sfx) : null;
			const aligned = sfx?.placement
				? (a.start * F + (sfx.placement.peakFlicks - a.sourceIn) / (a.speed?.rate || 1)) / F
				: null;
			const prov = readLibraryProvenance(
				(doc.media?.[a.mediaId] as { library?: unknown } | undefined)?.library,
			);
			return {
				clipId: c.id,
				start: c.start,
				end: c.start + c.duration,
				alignedFrame: aligned === null ? null : r3(aligned),
				title: (prov?.title || a.name || c.id).slice(0, 200),
			};
		});
	// findings of a check job over the range
	const issues: SoundVisualResponse['issues'] = [];
	if (fromJob) {
		for (const i of fromJob.issues) {
			const s = i.range?.start ?? i.frame;
			const e = i.range?.end ?? (i.frame !== undefined ? i.frame + 1 : undefined);
			if (s === undefined || e === undefined || s >= range.end || e <= range.start) continue;
			issues.push({
				id: i.id,
				code: i.code,
				severity: i.severity,
				...(i.frame !== undefined ? { frame: i.frame } : {}),
				...(i.range ? { range: i.range } : {}),
				text: i.message.text,
			});
		}
	}
	return {
		projectId: req.projectId,
		sequenceId: seq.id,
		range,
		rangeTimecode: { start: tc(range.start), end: tc(range.end) },
		fps: { num: rate.num, den: rate.den },
		hopSec: CURVE_HOP_SEC,
		startSec: r3(rangeStart / sr),
		points: rangeHops,
		normalization: { applied, gainDb: r2(gain), ...(reason ? { reason } : {}) },
		curves: {
			mix: { momentary: all.mix.momentary, shortTerm: all.mix.shortTerm },
			bed: { momentary: all.bed.momentary, shortTerm: all.bed.shortTerm },
			sfx: { momentary: all.sfx.momentary, shortTerm: all.sfx.shortTerm },
			music: { momentary: all.music.momentary, shortTerm: all.music.shortTerm },
			dialogue: { momentary: all.dialogue.momentary, shortTerm: all.dialogue.shortTerm },
			ambience: { momentary: all.ambience.momentary, shortTerm: all.ambience.shortTerm },
		},
		waveformPeakDb,
		stemPeakDb,
		motion: { startFrame: range.start, speed: speed.map(r3) },
		pixelMotion,
		cues,
		clips,
		speech,
		...(req.spectrogram ? { spectrogram: spectrogramOf(spec, total, preHops, rangeHops) } : {}),
		issues,
	};
}

/** The spectrogram columns of the range (silence where nothing was rendered), base64. */
function spectrogramOf(
	spec: SpectrogramMeter | null,
	total: number,
	preHops: number,
	rangeHops: number,
): NonNullable<SoundVisualResponse['spectrogram']> {
	const s = spec?.finish() ?? null;
	const bands = s?.bands ?? LISTEN_EVENTS.bands;
	const out = new Uint8Array(rangeHops * bands);
	if (s)
		for (let i = 0; i < rangeHops; i++) {
			const k = preHops + i;
			if (k < 0 || k >= s.frames || k >= total) continue;
			out.set(s.data.subarray(k * bands, (k + 1) * bands), i * bands);
		}
	return {
		hopSec: CURVE_HOP_SEC,
		bands,
		frames: rangeHops,
		fMinHz: s?.fMinHz ?? LISTEN_EVENTS.fMinHz,
		fMaxHz: s?.fMaxHz ?? LISTEN_EVENTS.fMaxHz,
		floorDb: s?.floorDb ?? LISTEN_EVENTS.floorDb,
		data: Buffer.from(out).toString('base64'),
	};
}
