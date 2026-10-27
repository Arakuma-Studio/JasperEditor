// Motion-graphic land / exit (spec 12 §2.2): `mgCuePhases` measures the template's picture speed when the registry
// exposes it (`MgTemplateInfo.motionSpeed`) and falls back to the declared intro / outro otherwise. The deriver and
// `resolveCueAnchor` share it. The real fframes templates are tested in @jasper/mg-templates (motion-cues.test.ts);
// here synthetic speed curves pin the rules.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type CueAnchor,
	createStaticMgRegistry,
	defaultRegistries,
	deriveCues,
	FLICKS_PER_SECOND,
	type MgTemplateInfo,
	type MgTemplateMotionTiming,
	mgCuePhases,
	resolveCueAnchor,
} from '../src/index.ts';
import { Harness } from './helpers.ts';
import { newHarness } from './sound-cues-fixtures.ts';

const schema = z.record(z.string(), z.unknown());

/**
 * Synthetic picture speed: moving (0.5 diagonals/s) over the frame ranges `params.moves` (seconds, [from, to)),
 * default an intro over [0, 0.4) s and an outro over the last 0.3 s. `params.mode` breaks it on purpose.
 */
function synthSpeed(params: Record<string, unknown>, t: MgTemplateMotionTiming): number[] | null {
	const n = t.totalFrames;
	const mode = params.mode;
	if (mode === 'throw') throw new Error('boom');
	if (mode === 'null') return null;
	if (mode === 'short') return new Array(Math.max(0, n - 1)).fill(0);
	const moves = (params.moves as [number, number][] | undefined) ?? [
		[0, 0.4],
		[n / t.fps - 0.3, n / t.fps],
	];
	const out = new Array<number>(n).fill(0);
	for (const [a, b] of moves)
		for (let i = Math.max(1, Math.round(a * t.fps) + 1); i <= Math.min(n - 1, Math.round(b * t.fps)); i++)
			out[i] = mode === 'nan' && i % 2 ? Number.NaN : 0.5;
	return out;
}

function info(motionSpeed?: MgTemplateInfo['motionSpeed']): MgTemplateInfo {
	return {
		id: 'synth',
		version: 1,
		name: 'Synth',
		category: 'Titles',
		paramsSchema: schema,
		defaults: {},
		introFrames: 15,
		outroFrames: 30,
		canvasDefault: 'sequence',
		...(motionSpeed ? { motionSpeed } : {}),
	};
}

const measuredRegistry = createStaticMgRegistry([info(synthSpeed)]);
const declaredRegistry = createStaticMgRegistry([info()]);

const F30 = FLICKS_PER_SECOND / 30;
const clip = (duration: number, params: Record<string, unknown> = {}, sourceIn = 0) => ({
	duration,
	params,
	sourceIn: sourceIn * F30,
});

describe('mgCuePhases', () => {
	it('measured: the intro lands on its last moving frame, the outro leaves on its first', () => {
		const ph = mgCuePhases(info(synthSpeed), clip(90), 30, F30);
		// intro frames 1…12 move (0.4 s), the outro moves over frames 82…89
		expect(ph).toMatchObject({ measured: true, land: 12, landFrom: 1, exit: 82, total: 90, sourceIn: 0 });
		// the declared lengths are still reported (reasons, fallback)
		expect([ph.intro, ph.outro]).toEqual([15, 30]);
	});

	it('pauses up to 0.25 s are one movement; an intro must start within 0.1 s', () => {
		const joined = mgCuePhases(
			info(synthSpeed),
			clip(90, {
				moves: [
					[0, 0.3],
					[0.5, 0.7],
				],
			}),
			30,
			F30,
		);
		expect(joined).toMatchObject({ land: 21, exit: null });
		const split = mgCuePhases(
			info(synthSpeed),
			clip(90, {
				moves: [
					[0, 0.3],
					[1, 1.2],
				],
			}),
			30,
			F30,
		);
		expect(split).toMatchObject({ land: 9, exit: 31 });
		const late = mgCuePhases(info(synthSpeed), clip(90, { moves: [[0.5, 0.8]] }), 30, F30);
		expect(late).toMatchObject({ measured: true, land: null, exit: 16 });
	});

	it('a picture still moving on its last frame never lands; a still template has neither cue', () => {
		expect(mgCuePhases(info(synthSpeed), clip(30, { moves: [[0, 5]] }), 30, F30)).toMatchObject({
			measured: true,
			land: null,
			exit: null,
		});
		expect(mgCuePhases(info(synthSpeed), clip(90, { moves: [] }), 30, F30)).toMatchObject({
			measured: true,
			land: null,
			exit: null,
		});
	});

	it('falls back to the declared timing when the speed cannot be measured', () => {
		for (const mode of ['throw', 'null', 'short'])
			expect(mgCuePhases(info(synthSpeed), clip(90, { mode }), 30, F30)).toMatchObject({
				measured: false,
				land: 15,
				landFrom: 0,
				exit: 60,
			});
		expect(mgCuePhases(info(), clip(180), 60, F30 / 2)).toMatchObject({
			measured: false,
			land: 30,
			exit: 120,
		});
		// NaN speeds are sanitised (not moving), the rest is still measured
		expect(mgCuePhases(info(synthSpeed), clip(90, { mode: 'nan' }), 30, F30).measured).toBe(true);
	});

	it('clips longer than the cap are not measured (motionSpeed is not called)', () => {
		let calls = 0;
		const counting = info((p, t) => {
			calls++;
			return synthSpeed(p, t);
		});
		expect(mgCuePhases(counting, clip(20_001), 30, F30).measured).toBe(false);
		expect(calls).toBe(0);
		expect(mgCuePhases(counting, clip(20_000), 30, F30).measured).toBe(true);
	});

	it('hostile clips never throw', () => {
		for (const c of [
			{},
			{ duration: Number.NaN, sourceIn: Number.POSITIVE_INFINITY },
			{ duration: -5, sourceIn: -100, params: 'x' },
			{ duration: 1e12, params: null },
		]) {
			const ph = mgCuePhases(info(synthSpeed), c, 30, F30);
			expect(ph.total).toBeGreaterThanOrEqual(1);
		}
		expect(mgCuePhases(info(synthSpeed), clip(90), Number.NaN, F30).measured).toBe(false);
	});
});

function placeMg(registry = measuredRegistry, at = 30, duration = 90, sourceIn = 0, params = {}) {
	const h = new Harness({ ctx: { registries: defaultRegistries(registry) } });
	const r = h.ok([
		{
			type: 'clip.addMotionGraphic',
			at,
			duration,
			track: 'V2',
			template: { id: 'synth', version: 1 },
			params,
			ref: '$m',
		},
	]);
	const id = r.refs.$m!;
	if (sourceIn) {
		const doc = structuredClone(h.doc);
		const rate = doc.sequences[h.seqId]!.settings.frameRate;
		(doc.sequences[h.seqId]!.clips[id] as { sourceIn: number }).sourceIn =
			(sourceIn * FLICKS_PER_SECOND * rate.den) / rate.num;
		h.doc = doc;
	}
	return { h, id };
}

const mgCues = (h: Harness, registry = measuredRegistry) =>
	deriveCues(h.doc, h.seqId, { sources: ['mg'], density: 'rich', mgTemplates: registry }).cues;

describe('deriveMgCues with measured and declared timing', () => {
	it('measured cues use the movement frames, confidence and windows', () => {
		const { h } = placeMg();
		const cues = mgCues(h);
		expect(cues.map((c) => [c.kind, c.frame, c.confidence])).toEqual([
			['land', 42, 0.8],
			['exit', 112, 0.6],
		]);
		expect(cues[0]!.window).toEqual({ start: 31, end: 42 });
		expect(cues[1]!.window).toEqual({ start: 112, end: 120 });
		expect(
			cues.map((c) =>
				resolveCueAnchor(h.doc, h.seq, c.anchor as CueAnchor, { mgTemplates: measuredRegistry }),
			),
		).toEqual([42, 112]);
	});

	it('declared fallback uses lower confidence and declared timing', () => {
		const { h } = placeMg(declaredRegistry);
		const cues = mgCues(h, declaredRegistry);
		expect(cues.map((c) => [c.kind, c.frame, c.confidence])).toEqual([
			['land', 45, 0.5],
			['exit', 90, 0.4],
		]);
		// the fixture's static registry (lower-third 15 / 12 at 30 fps) gives the declared frames too
		const f = newHarness();
		f.ok([
			{
				type: 'clip.addMotionGraphic',
				at: 330,
				duration: 90,
				track: 'V1',
				template: { id: 'lower-third', version: 1 },
			},
		]);
		expect(
			deriveCues(f.doc, f.seqId, { sources: ['mg'], mgTemplates: f.ctx().registries.mgTemplates }).cues.map(
				(c) => [c.kind, c.frame, c.confidence],
			),
		).toEqual([
			['land', 345, 0.5],
			['exit', 408, 0.4],
		]);
	});

	it('a land before the visible part (sourceIn past it) gives no land cue and a null anchor', () => {
		const { h, id } = placeMg(measuredRegistry, 30, 90, 20);
		expect(mgCues(h).map((c) => c.kind)).toEqual(['exit']);
		expect(
			resolveCueAnchor(
				h.doc,
				h.seq,
				{ type: 'mg', clipId: id, event: 'intro-end' },
				{ mgTemplates: measuredRegistry },
			),
		).toBeNull();
	});
});
