// Motion-graphic land / exit cues on the REAL fframes templates (spec 12 §2.2; wp-note sound-design "WP2.2 cue
// derivation"): the cue deriver and `resolveCueAnchor` measure the template's rendered motion (`motionSpeed`, from the
// SVG twins), and must agree with where the picture actually settles / starts leaving.
//
// The oracle is independent of the implementation under test (no SVG parsing, no `speedSegments`): it differentiates
// the templates' own animation curves analytically (the eases of core.ts and the closed-form spring, with the
// constants of lower-third.ts / title-card.ts), in continuous time, and calls a quantity MOVING while its rate exceeds
// the motion threshold of the keyframed-clip sampler: MOVE_OFF = 0.03 canvas diagonals per second for geometry
// (≈ 66 px/s on 1920×1080) and 0.12 per second for opacity (MOVE_OFF ÷ K_OPACITY 0.25: about one 8-bit code value
// per frame at 30 fps). Moving spans less than 0.25 s apart are one movement (an overshoot's turnaround is not a
// rest). The picture SETTLES at the end of the first movement and starts LEAVING at the start of the last one. A
// cue frame f summarises the change from f − 1 to f, so the land frame must lie within ±1 frame of settle·fps, and the
// exit frame within −1 … +1.5 frames of leave·fps (an ease-in onset: see the test).
import {
	applyTransaction,
	type CommandContext,
	type CueAnchor,
	createCounterIdSource,
	createEmptyProject,
	createStaticMgRegistry,
	defaultRegistries,
	deriveCues,
	flicksPerFrame,
	MAX_SAMPLES_PER_CLIP,
	type MgTemplateInfo,
	type MgTemplateRegistry,
	type ProjectDocument,
	resolveCueAnchor,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	estimateTextWidth,
	lowerThirdParams,
	mgRegistry,
	svgTemplateSpeed,
	titleCard,
} from '../src/index.ts';

// ---------------------------------------------------------------------------------------------------- the oracle

const DIAG = Math.hypot(1920, 1080);
const PX_MOVING = 0.03 * DIAG; // px per second
const OPACITY_MOVING = 0.03 / 0.25; // opacity per second
const BRIDGE_S = 0.25;

/** A rate in units of "moving" (> 1 = moving). */
type Rate = (t: number) => number;
const inside = (t: number, start: number, dur: number) => (dur > 0 ? (t - start) / dur : -1);
/** A·easeOutCubic((t − start)/dur): A·3(1 − p)²/dur. */
const easeOut =
	(A: number, start: number, dur: number, unit: number): Rate =>
	(t) => {
		const p = inside(t, start, dur);
		return p <= 0 || p >= 1 ? 0 : (A * 3 * (1 - p) ** 2) / dur / unit;
	};
/** A·easeInCubic: A·3p²/dur. */
const easeIn =
	(A: number, start: number, dur: number, unit: number): Rate =>
	(t) => {
		const p = inside(t, start, dur);
		return p <= 0 || p >= 1 ? 0 : (A * 3 * p * p) / dur / unit;
	};
/** A·easeInOutCubic: 12p² below the middle, 3(2 − 2p)² above (per unit p), ÷ dur. */
const easeInOut =
	(A: number, start: number, dur: number, unit: number): Rate =>
	(t) => {
		const p = inside(t, start, dur);
		if (p <= 0 || p >= 1) return 0;
		return (A * (p < 0.5 ? 12 * p * p : 3 * (2 - 2 * p) ** 2)) / dur / unit;
	};
/**
 * A·spring(t − start, k 180, c 20, m 1): the step response of an underdamped oscillator, whose velocity is
 * ω0/√(1 − ζ²) · e^(−ζω0·u) · sin(ωd·u).
 */
const springRate =
	(A: number, start: number, unit: number): Rate =>
	(t) => {
		const u = t - start;
		if (u <= 0) return 0;
		const w0 = Math.sqrt(180);
		const zeta = 20 / (2 * Math.sqrt(180));
		const wd = w0 * Math.sqrt(1 - zeta * zeta);
		return (
			(A * (w0 / Math.sqrt(1 - zeta * zeta)) * Math.exp(-zeta * w0 * u) * Math.abs(Math.sin(wd * u))) / unit
		);
	};

/** Settle (end of the first movement, when it starts within 0.1 s) and leave (start of the last other one), in s. */
function oracle(rates: Rate[], seconds: number): { settle: number | null; leave: number | null } {
	const dt = 1e-4;
	const spans: [number, number][] = [];
	let open: number | null = null;
	for (let t = dt / 2; t < seconds; t += dt) {
		const moving = rates.some((r) => r(t) > 1);
		if (moving && open === null) open = t;
		if (!moving && open !== null) {
			spans.push([open, t]);
			open = null;
		}
	}
	if (open !== null) spans.push([open, seconds]);
	const joined: [number, number][] = [];
	for (const s of spans) {
		const last = joined[joined.length - 1];
		if (last && s[0] - last[1] <= BRIDGE_S) last[1] = s[1];
		else joined.push([...s]);
	}
	const intro = joined[0] && joined[0][0] <= 0.1 ? joined[0] : undefined;
	const last = joined[joined.length - 1];
	return { settle: intro ? intro[1] : null, leave: last && last !== intro ? last[0] : null };
}

/** lower-third.ts, differentiated (content length `seconds`). */
function lowerThirdRates(params: Record<string, unknown>, seconds: number, fps: number): Rate[] {
	const p = lowerThirdParams.parse(params);
	const panelW = Math.max(
		Math.max(estimateTextWidth(p.name, 60, 700), estimateTextWidth(p.title, 34, 400)) + 40 + 48,
		320,
	);
	const outroStart = p.holdUntilFrames > 0 ? p.holdUntilFrames / fps : Math.max(seconds - 0.5, 0);
	return [
		easeOut(150, 0, 0.35, PX_MOVING), // accent bar height
		easeOut(panelW, 0.12, 0.55, PX_MOVING), // panel width (and its clip rect)
		springRate(60, 0.25, PX_MOVING), // name slide
		easeOut(1, 0.25, 0.3, OPACITY_MOVING), // name fade
		springRate(40, 0.4, PX_MOVING), // title slide
		easeOut(1, 0.4, 0.3, OPACITY_MOVING), // title fade
		easeIn(1, outroStart, 0.5, OPACITY_MOVING), // outro fade
		easeIn(40, outroStart, 0.5, PX_MOVING), // outro slide
	];
}

/** title-card.ts, differentiated. */
function titleCardRates(params: Record<string, unknown>, seconds: number, fps: number): Rate[] {
	const p = titleCard.paramsSchema.parse(params);
	const fadeIn = p.fadeInFrames / fps;
	const fadeOut = p.fadeOutFrames / fps;
	return [
		...(p.fadeInFrames > 0 ? [easeInOut(1, 0, fadeIn, OPACITY_MOVING)] : []),
		...(p.fadeOutFrames > 0 ? [easeInOut(1, seconds - fadeOut, fadeOut, OPACITY_MOVING)] : []),
		easeOut(36, 0, 0.7, PX_MOVING), // title rise
		...(p.subtitle.length > 0
			? [easeOut(36, 0.12, 0.7, PX_MOVING), easeOut(0.85, 0.12, 0.5, OPACITY_MOVING)] // subtitle rise, fade
			: []),
		easeOut(160, 0.15, 0.6, PX_MOVING), // underline width
	];
}

// ----------------------------------------------------------------------------------------------- the documents

const RATE_PRESET: Record<string, string> = { '25': '25', '29.97': '29.97', '30': '30', '60': '60' };

function ctxOf(registry: MgTemplateRegistry): CommandContext {
	return {
		ids: createCounterIdSource(9),
		now: () => '2026-10-15T10:00:00.000Z',
		revision: 0,
		registries: defaultRegistries(registry),
	};
}

/** One motion-graphic clip on V1 at `at`, `duration` frames, its content starting `sourceIn` frames in. */
function mgDoc(opts: {
	rate: string;
	template: string;
	params?: Record<string, unknown>;
	at: number;
	duration: number;
	sourceIn?: number;
	registry?: MgTemplateRegistry;
}): { doc: ProjectDocument; seqId: string; clipId: string; fps: number } {
	const registry = opts.registry ?? mgRegistry;
	const ids = createCounterIdSource(1);
	const doc0 = createEmptyProject({
		ids,
		name: 'T',
		preset: `hd-1080p-${RATE_PRESET[opts.rate] ?? opts.rate}`,
	});
	const seqId = Object.keys(doc0.sequences)[0]!;
	const { document, result } = applyTransaction(
		doc0,
		{
			label: 't',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: opts.at,
					duration: opts.duration,
					track: 'V1',
					template: { id: opts.template, version: 1 },
					...(opts.params ? { params: opts.params } : {}),
					ref: '$m',
				},
			],
		},
		ctxOf(registry),
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	const doc = structuredClone(document);
	const seq = doc.sequences[seqId]!;
	const clipId = result.refs.$m!;
	const rate = seq.settings.frameRate;
	if (opts.sourceIn)
		(seq.clips[clipId] as { sourceIn: number }).sourceIn = opts.sourceIn * flicksPerFrame(rate);
	return { doc, seqId, clipId, fps: rate.num / rate.den };
}

function mgCues(d: ReturnType<typeof mgDoc>, registry: MgTemplateRegistry = mgRegistry) {
	const r = deriveCues(d.doc, d.seqId, { sources: ['mg'], density: 'rich', mgTemplates: registry });
	return r.cues.filter((c) => c.from === 'mg');
}

// ------------------------------------------------------------------------------------------------------- tests

type Variant = {
	name: string;
	template: 'lower-third' | 'title-card';
	rate: string;
	duration: number;
	sourceIn?: number;
	params?: Record<string, unknown>;
};

const VARIANTS: Variant[] = [
	{ name: 'lower third, defaults, 30 fps', template: 'lower-third', rate: '30', duration: 90 },
	{ name: 'lower third, defaults, 25 fps', template: 'lower-third', rate: '25', duration: 125 },
	{ name: 'lower third, defaults, 29.97 fps', template: 'lower-third', rate: '29.97', duration: 150 },
	{ name: 'lower third, defaults, 60 fps', template: 'lower-third', rate: '60', duration: 300 },
	{
		name: 'lower third, holdUntilFrames 40, 30 fps',
		template: 'lower-third',
		rate: '30',
		duration: 150,
		params: { holdUntilFrames: 40 },
	},
	{
		name: 'lower third, holdUntilFrames 100, 60 fps',
		template: 'lower-third',
		rate: '60',
		duration: 300,
		params: { holdUntilFrames: 100 },
	},
	{
		name: 'lower third, long name, sourceIn 6, 30 fps',
		template: 'lower-third',
		rate: '30',
		duration: 120,
		sourceIn: 6,
		params: { name: 'Alexandra Montgomery-Okonkwo', title: 'Executive Producer' },
	},
	{ name: 'title card, defaults, 30 fps', template: 'title-card', rate: '30', duration: 120 },
	{ name: 'title card, defaults, 25 fps', template: 'title-card', rate: '25', duration: 100 },
	{ name: 'title card, defaults, 29.97 fps', template: 'title-card', rate: '29.97', duration: 120 },
	{ name: 'title card, defaults, 60 fps', template: 'title-card', rate: '60', duration: 240 },
	{
		name: 'title card, fade in 45 / out 30, 30 fps',
		template: 'title-card',
		rate: '30',
		duration: 150,
		params: { fadeInFrames: 45, fadeOutFrames: 30 },
	},
	{
		name: 'title card, no fades, no subtitle, 30 fps',
		template: 'title-card',
		rate: '30',
		duration: 120,
		params: { fadeInFrames: 0, fadeOutFrames: 0, subtitle: '' },
	},
	{
		name: 'title card, fade in 60, sourceIn 10, 25 fps',
		template: 'title-card',
		rate: '25',
		duration: 100,
		sourceIn: 10,
		params: { fadeInFrames: 60 },
	},
];

describe('mg land / exit cues follow the rendered motion of the fframes templates', () => {
	for (const v of VARIANTS)
		it(v.name, () => {
			const at = 330;
			const d = mgDoc({ ...v, at });
			const s = v.sourceIn ?? 0;
			const totalFrames = s + v.duration;
			const seconds = totalFrames / d.fps;
			const rates =
				v.template === 'lower-third'
					? lowerThirdRates(v.params ?? {}, seconds, d.fps)
					: titleCardRates(v.params ?? {}, seconds, d.fps);
			const truth = oracle(rates, seconds);
			const cues = mgCues(d);
			const land = cues.find((c) => c.kind === 'land');
			const exit = cues.find((c) => c.kind === 'exit');
			// content frame of a cue = sequence frame − clip start + sourceIn
			const content = (frame: number) => frame - at + s;
			expect(truth.settle).not.toBeNull();
			expect(land, 'land cue').toBeDefined();
			expect(Math.abs(content(land!.frame) - truth.settle! * d.fps)).toBeLessThanOrEqual(1);
			// A template without an outro (title card without a fade-out) has no exit.
			expect(exit === undefined).toBe(truth.leave === null);
			// Leaving starts with an ease-in: the change over a frame averages a rate growing like t², so the frame
			// difference crosses the threshold up to ≈ 1.5 frames after the instantaneous rate does (never before − 1).
			const exitLag = exit ? content(exit.frame) - truth.leave! * d.fps : 0;
			expect(exitLag).toBeGreaterThanOrEqual(-1);
			expect(exitLag).toBeLessThanOrEqual(1.5);
			expect(land!.confidence).toBe(0.8);
			if (exit) expect(exit.confidence).toBe(0.6);
			expect(land!.window!.end).toBe(land!.frame);
			expect(land!.window!.start).toBeGreaterThanOrEqual(at);
			// the anchors resolve back to the cue frames
			const seq = d.doc.sequences[d.seqId]!;
			for (const c of cues)
				expect(resolveCueAnchor(d.doc, seq, c.anchor as CueAnchor, { mgTemplates: mgRegistry })).toBe(
					c.frame,
				);
		});

	it('a land before the clip’s first frame (sourceIn past the intro) gives no land cue and a null anchor', () => {
		const d = mgDoc({ template: 'lower-third', rate: '30', at: 100, duration: 90, sourceIn: 30 });
		const cues = mgCues(d);
		expect(cues.map((c) => c.kind)).toEqual(['exit']);
		const seq = d.doc.sequences[d.seqId]!;
		expect(
			resolveCueAnchor(
				d.doc,
				seq,
				{ type: 'mg', clipId: d.clipId, event: 'intro-end' },
				{ mgTemplates: mgRegistry },
			),
		).toBeNull();
	});

	it('the Phase 2 fixture’s lower third (frame 330, 90 frames, 30 fps) lands at 350, not the declared 360', () => {
		const d = mgDoc({ template: 'lower-third', rate: '30', at: 330, duration: 90 });
		expect(mgCues(d).map((c) => [c.kind, c.frame])).toEqual([
			['land', 350],
			['exit', 408],
		]);
	});
});

describe('declared-timing fallback', () => {
	it('anime templates are measured on their motion model (WP6.5b); a registry without it gets the declared timing', () => {
		const info = mgRegistry.get('lower-third-anim', 1)!;
		expect(info.renderer).toBe('anime');
		expect(info.motionSpeed).toBeTypeOf('function');
		const d = mgDoc({ template: 'lower-third-anim', rate: '30', at: 30, duration: 120 });
		const cues = mgCues(d);
		// measured: the words settle at content 27 (the declared intro ends at 30); the outro (declared from content
		// 120 − 21 = 99) visibly leaves one frame later, at 100 (its first tweens ease in)
		expect(cues.map((c) => [c.kind, c.frame, c.confidence])).toEqual([
			['land', 30 + 27, 0.8],
			['exit', 30 + 100, 0.6],
		]);
		const seq = d.doc.sequences[d.seqId]!;
		for (const c of cues)
			expect(resolveCueAnchor(d.doc, seq, c.anchor as CueAnchor, { mgTemplates: mgRegistry })).toBe(c.frame);
		const { motionSpeed: _drop, ...plainInfo } = info;
		const declared = mgCues(d, createStaticMgRegistry([plainInfo as MgTemplateInfo]));
		expect(declared.map((c) => [c.kind, c.frame, c.confidence])).toEqual([
			['land', 30 + info.introFrames, 0.5],
			['exit', 150 - info.outroFrames, 0.4],
		]);
	});

	it('a registry without motionSpeed (createStaticMgRegistry) gives the declared frames for the same template', () => {
		const { motionSpeed: _drop, ...info } = mgRegistry.get('lower-third', 1)!;
		const plain = createStaticMgRegistry([info as MgTemplateInfo]);
		const d = mgDoc({ template: 'lower-third', rate: '30', at: 330, duration: 90 });
		expect(mgCues(d, plain).map((c) => [c.kind, c.frame, c.confidence])).toEqual([
			['land', 360, 0.5],
			['exit', 405, 0.4],
		]);
	});

	it('clips longer than the measuring cap fall back to the declared timing', () => {
		const d = mgDoc({ template: 'lower-third', rate: '60', at: 0, duration: MAX_SAMPLES_PER_CLIP + 60 });
		expect(mgCues(d).map((c) => [c.kind, c.frame, c.confidence])).toEqual([
			['land', 60, 0.5],
			['exit', MAX_SAMPLES_PER_CLIP + 60 - 30, 0.4],
		]);
	});
});

describe('derived mg anchors resolve to their frames (property)', () => {
	it('random templates, clip starts, durations, sourceIn and rates', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('lower-third', 'title-card', 'lower-third-anim', 'title-reveal'),
				fc.constantFrom('23.976', '25', '29.97', '30', '50', '59.94', '60'),
				fc.integer({ min: 0, max: 2000 }),
				fc.integer({ min: 1, max: 400 }),
				fc.integer({ min: 0, max: 60 }),
				fc.integer({ min: 0, max: 200 }),
				(template, rate, at, duration, sourceIn, hold) => {
					const params = template === 'lower-third' && hold > 0 ? { holdUntilFrames: hold } : undefined;
					const d = mgDoc({ template, rate, at, duration, sourceIn, ...(params ? { params } : {}) });
					const seq = d.doc.sequences[d.seqId]!;
					for (const c of mgCues(d)) {
						expect(c.frame).toBeGreaterThan(at);
						expect(c.frame).toBeLessThan(at + duration);
						expect(resolveCueAnchor(d.doc, seq, c.anchor as CueAnchor, { mgTemplates: mgRegistry })).toBe(
							c.frame,
						);
					}
				},
			),
			{ numRuns: 120, seed: 20261015 },
		);
	});
});

describe('svgTemplateSpeed', () => {
	it('is null for hostile timings and params, never throws', () => {
		expect(svgTemplateSpeed(titleCard, {}, { fps: 0, totalFrames: 10 })).toBeNull();
		expect(svgTemplateSpeed(titleCard, {}, { fps: Number.NaN, totalFrames: 10 })).toBeNull();
		expect(svgTemplateSpeed(titleCard, {}, { fps: 30, totalFrames: Number.POSITIVE_INFINITY })).toBeNull();
		expect(svgTemplateSpeed(titleCard, {}, { fps: 30, totalFrames: MAX_SAMPLES_PER_CLIP + 1 })).toBeNull();
		expect(svgTemplateSpeed(titleCard, { fadeInFrames: 'x' }, { fps: 30, totalFrames: 10 })).toBeNull();
		const sp = svgTemplateSpeed(titleCard, {}, { fps: 30, totalFrames: 1 });
		expect(sp).toEqual([0]);
	});

	it('the registry memoises per template, params, rate and length and hands out copies', () => {
		const info = mgRegistry.get('title-card', 1)!;
		const a = info.motionSpeed!({}, { fps: 30, totalFrames: 120 })!;
		a[5] = 99;
		const b = info.motionSpeed!({}, { fps: 30, totalFrames: 120 })!;
		expect(b[5]).not.toBe(99);
		expect(b).toEqual(svgTemplateSpeed(titleCard, {}, { fps: 30, totalFrames: 120 }));
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(info.motionSpeed!(cyclic, { fps: 30, totalFrames: 10 })).toBeNull(); // strict schema refuses it
	});
});

describe('performance', () => {
	it('a 10-minute lower third: cold derive (measures every frame) and warm derive (memoised)', () => {
		const frames = 10 * 60 * 30;
		const d = mgDoc({
			template: 'lower-third',
			rate: '30',
			at: 0,
			duration: frames,
			params: { name: 'Perf Run' },
		});
		const t0 = performance.now();
		const cold = mgCues(d);
		const t1 = performance.now();
		const warm = mgCues(d);
		const t2 = performance.now();
		console.log(
			`mg cues on a 10-min lower third: cold ${(t1 - t0).toFixed(0)} ms, warm ${(t2 - t1).toFixed(1)} ms`,
		);
		expect(cold.map((c) => c.confidence)).toEqual([0.8, 0.6]);
		expect(warm).toEqual(cold);
		// a guard against a blow-up, not a benchmark: 0.7 s measured at load ≈ 30, 3.3 s at load ≈ 80 on the shared host
		expect(t1 - t0).toBeLessThan(10_000);
		expect(t2 - t1).toBeLessThan(100);
	});
});
