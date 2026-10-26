// Stingers planner (spec 15 EA-026, EA-030; off by default, assistive): a short burst of TV static after a shouted
// punchline — measured on the user's projects (FINDINGS §3): 15 × 29 frames (0.48 s at 59.94 fps) replacing the
// picture, with noise audio at −18 dB. The picture is generated, never a file: a mid-grey colour matte (a synthetic
// generator, `clip.addSolid`) under the Noise effect at 100 % monochrome, which draws new uniform noise every frame;
// the sound is Jasper Synth's "TV static" through the sound-design cue / placement system (or library sounds of a
// type). A punchline is a peak of the momentary loudness at least `thresholdLu` (6 LU) over the local median, a "!"
// phrase (transcript or subtitles), both (default) or either; the stinger starts where it ends, on a cut within
// `snapSeconds` after it, lasts `frames` (29), never overlaps another and keeps `maxPerMinute` / `minGapSeconds`
// (the loudest punchlines first). Pure: the engine measures the loudness.
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import {
	AutomationInputError,
	adjustmentTrackFor,
	automationSequence,
	type FrameGeometry,
	fpsValue,
	frameGeometry,
	timecodeOf,
} from './common.ts';
import { AUTOMATION_DEFAULTS, type AutomationSfx, StingerParamsSchema } from './params.ts';
import { itemSeed } from './rng.ts';
import { exclamationPhrases, frameWords, type LoudnessCurve, loudPeaks, pictureCutList } from './signals.ts';

export const STINGERS_PASS = 'stingers' as const;
/** The Jasper Synth recipe of the generated noise sound (`@jasper/audio-fx`). */
export const STINGER_SYNTH_RECIPE = 'synth.static';
/** The noise picture: a mid-grey matte under Noise 100 % monochrome = uniform grey noise, new every frame. */
export const STINGER_MATTE: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
export const STINGER_NOISE = {
	effectId: 'jasper.noise',
	params: { amount: 100, colorNoise: false, clip: true },
} as const;

export type StingerTrigger = {
	/** Where the punchline ends (the stinger's earliest start). */
	frame: number;
	source: 'loudness' | 'exclamation' | 'both';
	/** LU over the local median (0 for a "!" without a measured peak). */
	excessLu: number;
	text: string | null;
};

export type StingerPlacement = {
	/** Proposal item id: `sting:<frame>`. */
	id: string;
	frame: number;
	end: number;
	timecode: string;
	seed: number;
	trigger: StingerTrigger;
	cut: { trackId: string; frame: number } | null;
};

export type ResolvedStingerParams = {
	match: 'both' | 'either' | 'loudness' | 'exclamation';
	thresholdLu: number;
	windowSec: number;
	frames: number;
	snapFrames: number;
	maxPerMinute: number;
	minGapFrames: number;
	gainDb: number;
	sound: 'generated' | 'library' | 'none';
	sfx?: AutomationSfx;
	seed: number;
	track?: string;
	stingerTrack?: string;
	range?: { start: number; end: number };
};

export type StingerPlan = {
	pass: typeof STINGERS_PASS;
	sequenceId: string;
	seed: number;
	stingers: StingerPlacement[];
	/** Punchlines found (after the match rule and range). */
	considered: number;
	skipped: { frame: number; timecode: string; code: string; reason: string }[];
	stingerTrack: { trackId: string; label: string; create: false } | { create: true; name: string };
	frames: number;
	gainDb: number;
	sound: ResolvedStingerParams['sound'];
	sfx?: AutomationSfx;
	/** Whether a loudness curve was given (the match rule needs one unless it is `exclamation`). */
	measured: boolean;
	warnings: { code: string; message: string }[];
};

export type StingerContext = { loudness?: LoudnessCurve | null };

export function resolveStingerParams(raw: unknown, geo: Pick<FrameGeometry, 'fps'>): ResolvedStingerParams {
	const parsed = StingerParamsSchema.safeParse(raw ?? {});
	if (!parsed.success)
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
		);
	const p = parsed.data;
	const fps = fpsValue(geo.fps);
	const D = AUTOMATION_DEFAULTS;
	return {
		match: p.match ?? 'both',
		thresholdLu: p.thresholdLu ?? D.stingerThresholdLu,
		windowSec: p.medianWindowSeconds ?? D.stingerMedianWindowSeconds,
		frames: p.frames ?? D.stingerFrames,
		snapFrames: Math.round((p.snapSeconds ?? D.stingerSnapSeconds) * fps),
		maxPerMinute: p.maxPerMinute ?? D.stingerMaxPerMinute,
		minGapFrames: Math.round((p.minGapSeconds ?? D.stingerMinGapSeconds) * fps),
		gainDb: p.gainDb ?? D.stingerGainDb,
		sound: p.sound ?? 'generated',
		...(p.sfx ? { sfx: p.sfx } : {}),
		seed: p.seed ?? D.seed,
		...(p.track !== undefined ? { track: p.track } : {}),
		...(p.stingerTrack !== undefined ? { stingerTrack: p.stingerTrack } : {}),
		...(p.range ? { range: p.range } : {}),
	};
}

/** The punchlines of a sequence by the match rule (sorted by frame; duplicates within a second merged). */
export function punchlines(
	doc: ProjectDocument,
	seq: Sequence,
	p: ResolvedStingerParams,
	curve: LoudnessCurve | null | undefined,
): StingerTrigger[] {
	const fps = fpsValue(frameGeometry(seq).fps);
	const near = Math.round(0.5 * fps);
	const peaks = curve ? loudPeaks(curve, fps, { thresholdLu: p.thresholdLu, windowSec: p.windowSec }) : [];
	const excl = p.match === 'loudness' ? [] : exclamationPhrases(doc, seq, frameWords(doc, seq));
	const out: StingerTrigger[] = [];
	const usedPeaks = new Set<number>();
	const usedExcl = new Set<number>();
	if (p.match === 'both' || p.match === 'either')
		excl.forEach((e, ei) => {
			let best = -1;
			peaks.forEach((k, ki) => {
				if (
					k.peak >= e.frame - near &&
					k.peak <= e.end + near &&
					(best < 0 || k.excessLu > peaks[best]!.excessLu)
				)
					best = ki;
			});
			if (best < 0) return;
			usedPeaks.add(best);
			usedExcl.add(ei);
			out.push({
				frame: Math.max(peaks[best]!.end, e.end),
				source: 'both',
				excessLu: peaks[best]!.excessLu,
				text: e.text,
			});
		});
	if (p.match === 'loudness' || p.match === 'either')
		peaks.forEach((k, ki) => {
			if (!usedPeaks.has(ki))
				out.push({ frame: k.end, source: 'loudness', excessLu: k.excessLu, text: null });
		});
	if (p.match === 'exclamation' || p.match === 'either')
		excl.forEach((e, ei) => {
			if (!usedExcl.has(ei)) out.push({ frame: e.end, source: 'exclamation', excessLu: 0, text: e.text });
		});
	out.sort((a, b) => a.frame - b.frame || b.excessLu - a.excessLu);
	const merged: StingerTrigger[] = [];
	for (const t of out) {
		const last = merged[merged.length - 1];
		if (last && t.frame - last.frame <= fps) {
			if (t.excessLu > last.excessLu || (t.source === 'both' && last.source !== 'both'))
				merged[merged.length - 1] = t;
			continue;
		}
		merged.push(t);
	}
	return p.range ? merged.filter((t) => t.frame >= p.range!.start && t.frame < p.range!.end) : merged;
}

function rateOk(starts: readonly number[], start: number, cap: number, minute: number): boolean {
	if (cap <= 0) return false;
	const all = [...starts, start].sort((a, b) => a - b);
	const k = Math.floor(cap);
	if (k < 1) return false;
	for (let i = 0; i + k < all.length; i++) if (all[i + k]! - all[i]! < minute) return false;
	return true;
}

/** Plans the stingers of a sequence (see the file comment). */
export function planStingers(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	ctx: StingerContext = {},
): StingerPlan {
	const seq = automationSequence(doc, sequenceId);
	const geo = frameGeometry(seq);
	const p = resolveStingerParams(rawParams, geo);
	const warnings: { code: string; message: string }[] = [];
	const measured = !!ctx.loudness;
	if (!measured && p.match !== 'exclamation')
		warnings.push({
			code: 'W_NO_LOUDNESS',
			message:
				p.match === 'either'
					? 'Loudness peaks are measured when the proposal is made: only "!" phrases are counted here'
					: 'Loudness peaks are measured when the proposal is made: this count leaves them out',
		});
	if (p.match !== 'loudness' && !frameWords(doc, seq).length && !exclamationPhrases(doc, seq, []).length)
		warnings.push({
			code: 'W_NO_WORDS',
			message:
				'No transcript words or subtitles: "!" phrases cannot mark punchlines (transcribe the sequence)',
		});
	const triggers = punchlines(doc, seq, p, ctx.loudness);
	const cuts = pictureCutList(doc, seq, p.track);
	const end = Math.min(p.range?.end ?? geo.duration, geo.duration);
	const minute = Math.round(60 * fpsValue(geo.fps));
	const skipped: StingerPlan['skipped'] = [];
	const skip = (frame: number, code: string, reason: string) =>
		skipped.push({ frame, timecode: timecodeOf(seq, frame), code, reason });
	const ranked = [...triggers].sort((a, b) => b.excessLu - a.excessLu || a.frame - b.frame);
	const accepted: StingerPlacement[] = [];
	for (const t of ranked) {
		let cut: { frame: number; trackId: string } | null = null;
		for (const c of cuts) {
			if (c.frame < t.frame) continue;
			if (c.frame > t.frame + p.snapFrames) break;
			cut = c;
			break;
		}
		const start = cut?.frame ?? t.frame;
		const stop = start + p.frames;
		if (stop > end) {
			skip(t.frame, 'edge', 'too close to the end of the sequence or range');
			continue;
		}
		if (accepted.some((a) => start < a.end + p.minGapFrames && a.frame < stop + p.minGapFrames)) {
			skip(t.frame, 'spacing', 'too close to a louder punchline’s stinger');
			continue;
		}
		if (
			!rateOk(
				accepted.map((a) => a.frame),
				start,
				p.maxPerMinute,
				minute,
			)
		) {
			skip(t.frame, 'rate', `over ${p.maxPerMinute} stingers in a minute`);
			continue;
		}
		accepted.push({
			id: `sting:${start}`,
			frame: start,
			end: stop,
			timecode: timecodeOf(seq, start),
			seed: itemSeed(p.seed, STINGERS_PASS, start),
			trigger: t,
			cut: cut ? { trackId: cut.trackId, frame: cut.frame } : null,
		});
	}
	accepted.sort((a, b) => a.frame - b.frame);
	const r = adjustmentTrackFor(
		seq,
		accepted.map((a) => [a.frame, a.end] as [number, number]),
		{ name: 'Stingers', ...(p.stingerTrack !== undefined ? { ref: p.stingerTrack } : {}) },
	);
	return {
		pass: STINGERS_PASS,
		sequenceId: seq.id,
		seed: p.seed,
		stingers: accepted,
		considered: triggers.length,
		skipped: skipped.sort((a, b) => a.frame - b.frame),
		stingerTrack: r.create ? { create: true, name: r.name } : r,
		frames: p.frames,
		gainDb: p.gainDb,
		sound: p.sound,
		...(p.sfx ? { sfx: p.sfx } : {}),
		measured,
		warnings,
	};
}

/**
 * Re-plans single stingers (Refresh): the pass runs again on the current document (with the engine's fresh loudness);
 * each target takes the planned stinger whose punchline is nearest its own (within 2 s, the same text when it had one).
 */
export function replanStingers(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	targets: readonly { itemId: string; seed: number; frame: number; text: string | null }[],
	ctx: StingerContext = {},
): (
	| { itemId: string; ok: true; stinger: StingerPlacement }
	| { itemId: string; ok: false; reason: string }
)[] {
	const plan = planStingers(doc, sequenceId, rawParams, ctx);
	const seq = automationSequence(doc, sequenceId);
	const within = Math.round(2 * fpsValue(frameGeometry(seq).fps));
	const taken = new Set<string>();
	return targets.map((t) => {
		const best = plan.stingers
			.filter(
				(s) =>
					!taken.has(s.id) && Math.abs(s.frame - t.frame) <= within && (!t.text || s.trigger.text === t.text),
			)
			.sort((a, b) => Math.abs(a.frame - t.frame) - Math.abs(b.frame - t.frame))[0];
		if (!best)
			return { itemId: t.itemId, ok: false as const, reason: 'no shouted punchline is near it any more' };
		taken.add(best.id);
		return { itemId: t.itemId, ok: true as const, stinger: { ...best, id: t.itemId, seed: t.seed } };
	});
}
