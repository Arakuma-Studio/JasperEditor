// Premiere port: audio crossfade curves (Constant Gain / Constant Power / Exponential Fade / Custom Fade with fade
// shape, fade value and crossfade symmetry) and the Custom Start cut position (docs/wp-notes/audio-crossfades.md).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	audioFadeGain,
	audioTransitionCurves,
	CONSTANT_GAIN,
	CONSTANT_POWER,
	CUSTOM_FADE,
	checkInvariants,
	customFadeParamsFor,
	cutOffsetOf,
	cutPositionFor,
	EXPONENTIAL_FADE,
	fadeCurve,
	fadeShapeGain,
	type ProjectDocument,
	repairDocument,
	resolveAudioTransitions,
	type Transition,
	transitionSpan,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const xs = Array.from({ length: 101 }, (_, i) => i / 100);
const shapeArb = fc.record({
	type: fc.constantFrom('linear' as const, 'cosine' as const),
	value: fc.double({ min: -100, max: 100, noNaN: true }),
});

describe('fade curves', () => {
	it('every curve is 0 at the silent end and 1 at full level, monotone in between', () => {
		fc.assert(
			fc.property(
				shapeArb,
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				(s, a, b) => {
					expect(fadeShapeGain(s, 0)).toBe(0);
					expect(fadeShapeGain(s, 1)).toBe(1);
					const [lo, hi] = a <= b ? [a, b] : [b, a];
					const g0 = fadeShapeGain(s, lo);
					const g1 = fadeShapeGain(s, hi);
					expect(g0).toBeGreaterThanOrEqual(0);
					expect(g1).toBeLessThanOrEqual(1);
					expect(g1).toBeGreaterThanOrEqual(g0);
				},
			),
		);
		for (const curve of ['linear', 'equal-power', 'exponential'] as const) {
			expect(fadeCurve(curve, 0)).toBe(0);
			expect(fadeCurve(curve, 1)).toBeCloseTo(1, 15);
			for (let i = 1; i < xs.length; i++)
				expect(fadeCurve(curve, xs[i]!)).toBeGreaterThan(fadeCurve(curve, xs[i - 1]!));
		}
	});

	it('Linear @ 0 is Constant Gain, Cosine @ 19 is Constant Power (Premiere stores Constant Power as Cosine @ 19)', () => {
		for (const x of xs) {
			expect(fadeShapeGain({ type: 'linear', value: 0 }, x)).toBeCloseTo(x, 14);
			expect(fadeShapeGain({ type: 'cosine', value: 19 }, x)).toBeCloseTo(Math.sin((Math.PI * x) / 2), 14);
			// Cosine @ 0 is Audition's S-curve
			expect(fadeShapeGain({ type: 'cosine', value: 0 }, x)).toBeCloseTo((1 - Math.cos(Math.PI * x)) / 2, 14);
		}
	});

	it('a symmetrical crossfade sums amplitudes to 1 at value 0 and powers to 1 at value 19, for both shapes', () => {
		for (const type of ['linear', 'cosine'] as const)
			for (const x of xs) {
				const amp = (v: number) =>
					fadeShapeGain({ type, value: v }, x) + fadeShapeGain({ type, value: v }, 1 - x);
				const pow = (v: number) =>
					fadeShapeGain({ type, value: v }, x) ** 2 + fadeShapeGain({ type, value: v }, 1 - x) ** 2;
				expect(amp(0)).toBeCloseTo(1, 12);
				expect(pow(19)).toBeCloseTo(1, 12);
			}
	});

	it('positive values rise earlier, negative later (fade in)', () => {
		for (const type of ['linear', 'cosine'] as const)
			for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) {
				const at = (v: number) => fadeShapeGain({ type, value: v }, x);
				expect(at(30)).toBeGreaterThan(at(12));
				expect(at(12)).toBeGreaterThan(at(0));
				expect(at(0)).toBeGreaterThan(at(-40));
			}
	});

	it('never returns NaN: nonfinite progress, values and zero-length fades are guarded', () => {
		expect(fadeShapeGain({ type: 'cosine', value: Number.NaN }, 0.5)).toBeCloseTo(0.5, 12);
		expect(fadeShapeGain({ type: 'linear', value: Number.POSITIVE_INFINITY }, 0.5)).toBe(0.5);

		expect(fadeCurve('shape', Number.NaN, { type: 'cosine', value: 19 })).toBe(0);
		expect(audioFadeGain([{ type: 'in', start: 10, frames: 0, curve: 'linear' }], 10)).toBe(1);
		fc.assert(
			fc.property(fc.double(), fc.double(), fc.double(), (frame, start, frames) => {
				const g = audioFadeGain(
					[{ type: 'out', start, frames, curve: 'shape', shape: { type: 'cosine', value: 30 } }],
					frame,
				);
				expect(Number.isFinite(g)).toBe(true);
				expect(g).toBeGreaterThanOrEqual(0);
				expect(g).toBeLessThanOrEqual(1);
			}),
		);
	});
});

describe('audioTransitionCurves', () => {
	const t = (effectId: string, params: Record<string, unknown> = {}) =>
		({
			effectId,
			params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { value: v, keyframes: [] }])),
		}) as Pick<Transition, 'effectId' | 'params'>;
	it('maps the fixed transitions and the Custom Fade params (defaults: Cosine @ 19, symmetrical)', () => {
		expect(audioTransitionCurves(t(CONSTANT_GAIN))).toEqual({
			in: { curve: 'linear' },
			out: { curve: 'linear' },
		});
		expect(audioTransitionCurves(t(CONSTANT_POWER)).in).toEqual({ curve: 'equal-power' });
		expect(audioTransitionCurves(t(EXPONENTIAL_FADE)).out).toEqual({ curve: 'exponential' });
		const def = { curve: 'shape', shape: { type: 'cosine', value: 19 } };
		expect(audioTransitionCurves(t(CUSTOM_FADE))).toEqual({ in: def, out: def });
		const sym = audioTransitionCurves(
			t(CUSTOM_FADE, { fadeShape: 'linear', fadeValue: 12, outFadeValue: -50 }),
		);
		expect(sym.out).toEqual({ curve: 'shape', shape: { type: 'linear', value: 12 } });
		const asym = audioTransitionCurves(
			t(CUSTOM_FADE, { fadeValue: 30, symmetry: 'asymmetric', outFadeShape: 'linear', outFadeValue: -50 }),
		);
		expect(asym).toEqual({
			in: { curve: 'shape', shape: { type: 'cosine', value: 30 } },
			out: { curve: 'shape', shape: { type: 'linear', value: -50 } },
		});
		// malformed values read leniently
		expect(audioTransitionCurves(t(CUSTOM_FADE, { fadeShape: 7, fadeValue: 'x' })).in).toEqual({
			curve: 'shape',
			shape: { type: 'cosine', value: 0 },
		});
	});
	it('a Custom Fade made from a fixed transition sounds the same (Exponential Fade within 0.5 dB at its midpoint)', () => {
		for (const id of [CONSTANT_GAIN, CONSTANT_POWER]) {
			const p = customFadeParamsFor(id);
			const custom = audioTransitionCurves(t(CUSTOM_FADE, p)).in;
			for (const x of xs)
				expect(fadeCurve(custom.curve, x, custom.shape)).toBeCloseTo(
					id === CONSTANT_GAIN ? x : Math.sin((Math.PI * x) / 2),
					12,
				);
		}
		const p = customFadeParamsFor(EXPONENTIAL_FADE);
		const db = (g: number) => 20 * Math.log10(g);
		expect(
			Math.abs(db(fadeShapeGain({ type: p.fadeShape, value: p.fadeValue }, 0.5)) - -30.270418442161),
		).toBeLessThan(0.5);
	});
});

describe('Custom Start cut position', () => {
	it('cutOffsetOf / transitionSpan / cutPositionFor', () => {
		expect(cutOffsetOf(21, 'center')).toBe(10);
		expect(cutOffsetOf(21, 'start-at-cut')).toBe(0);
		expect(cutOffsetOf(21, 'end-at-cut')).toBe(21);
		expect(cutOffsetOf(20, 'center', 0.25)).toBe(5);
		expect(cutOffsetOf(20, 'center', Number.NaN)).toBe(10);
		expect(cutOffsetOf(20, 'center', 7)).toBe(20);
		expect(transitionSpan(100, 20, 'center', 0.25)).toEqual({ start: 95, end: 115 });
		expect(cutPositionFor(5, 20)).toEqual({ alignment: 'center', cutPosition: 0.25 });
		expect(cutPositionFor(0, 20)).toEqual({ alignment: 'start-at-cut' });
		expect(cutPositionFor(20, 20)).toEqual({ alignment: 'end-at-cut' });
		expect(cutPositionFor(10, 20)).toEqual({ alignment: 'center' });
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 600 }), fc.integer({ min: 0, max: 600 }), (d, o0) => {
				const o = Math.min(o0, d);
				const r = cutPositionFor(o, d);
				expect(cutOffsetOf(d, r.alignment, r.cutPosition)).toBe(o);
			}),
		);
	});
});

/** Two audio clips on A1 cut at frame 100, media handles 30 frames before B / 100 after A. */
function twoClips() {
	const h = new Harness();
	const a = h.registerVideo({ kind: 'audio' });
	const b = h.registerVideo({ kind: 'audio' });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
			ref: '$a',
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 100,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
			ref: '$b',
		},
	]);
	return { h, a: r.refs.$a!, b: r.refs.$b!, trackId: h.seq.audioTracks[0]!.id };
}

const only = (h: Harness) => Object.values(h.seq.transitions)[0] as Transition;

describe('transition.add / update with Custom Fade and Custom Start', () => {
	it('adds an off-centre asymmetrical Custom Fade: span, handles and both sides’ curves', () => {
		const { h, a, b, trackId } = twoClips();
		const r = h.ok([
			{
				type: 'transition.add',
				trackId,
				at: 100,
				effectId: CUSTOM_FADE,
				duration: 20,
				cutOffset: 5,
				params: {
					fadeShape: 'cosine',
					fadeValue: 30,
					symmetry: 'asymmetric',
					outFadeShape: 'linear',
					outFadeValue: 12,
				},
			},
		]);
		expect(r.results[0]).toMatchObject({ duration: 20, alignment: 'center', cutOffset: 5 });
		expect(only(h).cutPosition).toBe(0.25);
		expect(checkInvariants(h.doc)).toEqual([]);
		const res = resolveAudioTransitions(h.doc, h.seq);
		expect(res.clips.get(a)).toMatchObject({
			tailHandle: 15,
			fades: [{ type: 'out', start: 95, frames: 20, curve: 'shape', shape: { type: 'linear', value: 12 } }],
		});
		expect(res.clips.get(b)).toMatchObject({
			headHandle: 5,
			fades: [{ type: 'in', start: 95, frames: 20, curve: 'shape', shape: { type: 'cosine', value: 30 } }],
		});
	});

	it('update: a duration change keeps the fraction, an alignment drops it, cutOffset sets it; the type change resets params', () => {
		const { h, trackId } = twoClips();
		const r = h.ok([
			{ type: 'transition.add', trackId, at: 100, effectId: CONSTANT_POWER, duration: 20, cutOffset: 15 },
		]);
		const id = (r.results[0] as { transitionId: string }).transitionId;
		h.ok([{ type: 'transition.update', transitionId: id, duration: 12 }]);
		expect(only(h)).toMatchObject({ duration: 12, cutPosition: 0.75 });
		expect(transitionSpan(100, 12, only(h).alignment, only(h).cutPosition)).toEqual({ start: 91, end: 103 });
		const u = h.ok([{ type: 'transition.update', transitionId: id, alignment: 'end-at-cut' }]);
		expect(u.results[0]).toEqual({
			transitionId: id,
			effectId: CONSTANT_POWER,
			duration: 12,
			alignment: 'end-at-cut',
		});
		expect(only(h).cutPosition).toBeUndefined();
		h.ok([{ type: 'transition.update', transitionId: id, cutOffset: 4 }]);
		expect(only(h)).toMatchObject({ alignment: 'center', cutPosition: 4 / 12 });
		h.ok([
			{
				type: 'transition.update',
				transitionId: id,
				effectId: CUSTOM_FADE,
				params: { fadeShape: 'linear', fadeValue: 13 },
			},
		]);
		expect(only(h)).toMatchObject({ effectId: CUSTOM_FADE, cutPosition: 4 / 12 });
		expect(only(h).params).toEqual({
			fadeShape: { value: 'linear', keyframes: [] },
			fadeValue: { value: 13, keyframes: [] },
		});
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('refusals: cutOffset on a fade, past the span, against an alignment; bad shape; value clamped with a warning', () => {
		const { h, a, trackId } = twoClips();
		const before = h.doc;
		const fail = (cmd: unknown) => {
			const r = h.tx([cmd]);
			expect(r.ok).toBe(false);
			expect(h.doc).toBe(before);
			return r.ok ? '' : r.errors[0]!.code;
		};
		expect(fail({ type: 'transition.add', clipId: a, edge: 'in', effectId: CUSTOM_FADE, cutOffset: 2 })).toBe(
			'E_INVALID_PARAM',
		);
		expect(
			fail({ type: 'transition.add', trackId, at: 0, effectId: CUSTOM_FADE, duration: 10, cutOffset: 2 }),
		).toBe('E_INVALID_PARAM');
		expect(
			fail({ type: 'transition.add', trackId, at: 100, effectId: CUSTOM_FADE, duration: 10, cutOffset: 11 }),
		).toBe('E_INVALID_PARAM');
		expect(
			fail({
				type: 'transition.add',
				trackId,
				at: 100,
				effectId: CUSTOM_FADE,
				duration: 10,
				cutOffset: 2,
				alignment: 'end-at-cut',
			}),
		).toBe('E_INVALID_PARAM');
		expect(
			fail({ type: 'transition.add', trackId, at: 100, effectId: CUSTOM_FADE, params: { fadeShape: 'log' } }),
		).toBe('E_INVALID_PARAM');
		expect(
			fail({ type: 'transition.add', trackId, at: 100, effectId: CUSTOM_FADE, params: { curvature: 3 } }),
		).toBe('E_INVALID_PARAM');
		// a crossfade needing more than the incoming clip's 30 frames of head handle is shortened, keeping its fraction
		const short = h.ok([
			{ type: 'transition.add', trackId, at: 100, effectId: CUSTOM_FADE, duration: 40, cutOffset: 35 },
		]);
		expect(short.results[0]).toMatchObject({ duration: 34, cutOffset: 30 });
		expect(short.warnings.map((w) => w.code)).toContain('W_TRANSITION_SHORTENED');
		const ok = h.ok([
			{ type: 'transition.add', trackId, at: 100, effectId: CUSTOM_FADE, params: { fadeValue: 250 } },
		]);
		expect(ok.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');
		expect(only(h).params.fadeValue?.value).toBe(100);
		const fade = h.ok([{ type: 'transition.add', clipId: a, edge: 'in', effectId: CUSTOM_FADE }]);
		const fid = (fade.results[0] as { transitionId: string }).transitionId;
		const b2 = h.doc;
		const r = h.tx([{ type: 'transition.update', transitionId: fid, cutOffset: 1 }]);
		expect(r.ok === false && r.errors[0]!.code).toBe('E_INVALID_PARAM');
		expect(h.doc).toBe(b2);
	});

	it('invariants report a bad cut position and unreadable Custom Fade params; repair drops / resets them', () => {
		const { h, a, trackId } = twoClips();
		h.ok([{ type: 'transition.add', trackId, at: 100, effectId: CUSTOM_FADE, duration: 20, cutOffset: 5 }]);
		h.ok([{ type: 'transition.add', clipId: a, edge: 'in', effectId: CONSTANT_GAIN, duration: 10 }]);
		const doc = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
		const seq = Object.values(doc.sequences)[0]!;
		const [cross, fade] = Object.values(seq.transitions).sort((x, y) =>
			x.incomingClipId === a ? 1 : y.incomingClipId === a ? -1 : 0,
		);
		(cross as { cutPosition?: unknown }).cutPosition = 'half';
		cross!.params.fadeShape = { value: 'parabola', keyframes: [] };
		cross!.params.fadeValue = { value: Number.NaN, keyframes: [] } as never;
		cross!.params.symmetry = { value: 'asymmetric', keyframes: [] };
		(fade as { cutPosition?: unknown }).cutPosition = 0.5;
		const issues = checkInvariants(doc);
		expect(issues.map(({ invariant, path }) => [invariant, path?.at(-1)]).sort()).toEqual(
			[
				['INV-010', cross!.id],
				['INV-010', cross!.id],
				['INV-010', cross!.id],
				['INV-010', fade!.id],
			].sort(),
		);
		const { document, report } = repairDocument(doc, h.ids);
		expect(checkInvariants(document)).toEqual([]);
		const fixed = Object.values(Object.values(document.sequences)[0]!.transitions);
		expect(fixed.every((t) => t.cutPosition === undefined)).toBe(true);
		const c2 = fixed.find((t) => t.effectId === CUSTOM_FADE)!;
		expect(Object.keys(c2.params).sort()).toEqual(['symmetry']);
		expect(report.map((r) => r.action)).toEqual(
			expect.arrayContaining(['drop-cut-position', 'reset-transition-param']),
		);
		// idempotent
		expect(repairDocument(document, h.ids).report).toEqual([]);
	});
});
