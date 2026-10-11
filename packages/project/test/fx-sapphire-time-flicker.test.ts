// Sapphire Time + Flicker family (fx catalogue, wave 2): the TypeScript side — time remaps, sample offsets, derived
// uniforms and pass plans are pure, deterministic functions of params + frame (random seeks and parallel renders
// agree), and follow Sapphire's documented behaviour.
import { describe, expect, it } from 'vitest';
import {
	type EffectSpec,
	FX_MAX_TIME_SAMPLES,
	type FxFrameContext,
	type FxTimeContext,
	gpuPasses,
	SAPPHIRE_BINS,
} from '../src/index.ts';
import {
	clampToSpan,
	flickerGains,
	freezeFrameSource,
	historyOffsets,
	inSpan,
	jitterFramesSource,
	randomEditsSource,
	retimeSource,
	reverseEditsSource,
	seededPermutation,
	spreadOffsets,
} from '../src/registry/fx/sapphire-time-flicker/time-math.ts';
import { SAPPHIRE_TIME_FLICKER_EFFECTS } from '../src/registry/fx/sapphire-time-flicker.ts';

const byLabel = new Map(SAPPHIRE_TIME_FLICKER_EFFECTS.map((s) => [s.label, s]));
const spec = (label: string): EffectSpec => {
	const s = byLabel.get(label);
	if (!s) throw new Error(`no ${label}`);
	return s;
};
const defaults = (s: EffectSpec, over: Record<string, unknown> = {}) =>
	({ ...Object.fromEntries(s.params.map((p) => [p.name, p.default])), ...over }) as never;
const tctx = (frame: number, over: Partial<FxTimeContext> = {}): FxTimeContext => ({
	frame,
	fps: 30,
	duration: 60,
	headHandle: 0,
	tailHandle: 0,
	seed: 0.37,
	...over,
});
const fctx = (frame: number): FxFrameContext => ({
	width: 640,
	height: 360,
	pxScale: 1,
	fps: 30,
	frame,
	duration: 60,
	seed: 0.37,
	progress: 0,
});
const remap = (
	label: string,
	frame: number,
	over: Record<string, unknown> = {},
	ctx: Partial<FxTimeContext> = {},
) => Math.floor(spec(label).gpu!.time!.remap!(defaults(spec(label), over), tctx(frame, ctx)));
const samples = (
	label: string,
	frame: number,
	over: Record<string, unknown> = {},
	ctx: Partial<FxTimeContext> = {},
) => spec(label).gpu!.time!.samples!(defaults(spec(label), over), tctx(frame, ctx));

const LABELS = [
	'S_CutToDissolve',
	'S_Feedback',
	'S_FeedbackBubble',
	'S_FeedbackDistort',
	'S_FieldRemove',
	'S_FreezeFrame',
	'S_GetFrame',
	'S_JitterFrames',
	'S_MotionDetect',
	'S_NearestColor',
	'S_RandomEdits',
	'S_RepairFrames',
	'S_Retime',
	'S_ReverseClip',
	'S_ReverseEdits',
	'S_TimeAverage',
	'S_TimeDisplace',
	'S_TimeSlice',
	'S_TimeWarpRGB',
	'S_Trails',
	'S_TrailsDiffuse',
	'S_Flicker',
	'S_FlickerMatch',
	'S_FlickerMatchColor',
	'S_FlickerMatchMatte',
	'S_FlickerMchMatteColor',
	'S_FlickerRemove',
	'S_FlickerRemoveColor',
	'S_FlickerRemoveMatte',
	'S_FlickerRmMatteColor',
];

describe('Sapphire Time + Flicker family', () => {
	it('has every Sapphire Time and Flicker effect, in the Sapphire Time bin, valid', () => {
		expect(SAPPHIRE_TIME_FLICKER_EFFECTS.map((s) => s.label)).toEqual(LABELS);
		for (const s of SAPPHIRE_TIME_FLICKER_EFFECTS) {
			expect(s.id).toMatch(/^jasper\.s\.[a-z0-9-]+$/);
			expect(s.bin).toBe(SAPPHIRE_BINS.time);
		}
	});

	it('every time hook is pure: same inputs → same outputs, over random seeks and settings', () => {
		const frames = [0, 1, 7, 29, 30, 59, -3, 63, 12, 0];
		const variants: Record<string, Record<string, unknown>[]> = {
			S_Retime: ['speed', 'longer', 'scale', 'fps', 'length', 'variable'].map((mode) => ({
				mode,
				inputFrame: 12.5,
			})),
			S_GetFrame: [{ getFrame: 7.25, interpFrames: true }],
			S_FlickerRemove: [{ holdFromFrame: true, holdFrame: 4 }],
			S_CutToDissolve: [{ show: 'cutFrames' }, { show: 'a' }],
			S_RepairFrames: [{ show: 'badFrame' }],
			S_TimeDisplace: [{ shiftRelativeTo: 'frame0' }],
		};
		for (const s of SAPPHIRE_TIME_FLICKER_EFFECTS) {
			const t = s.gpu!.time;
			for (const over of [{}, ...(variants[s.label] ?? [])]) {
				const p = defaults(s, over);
				for (const f of frames) {
					const ctx = tctx(f, { headHandle: 4, tailHandle: 4 });
					if (t?.remap) {
						const r = t.remap(p, ctx);
						expect(Number.isFinite(r)).toBe(true);
						expect(t.remap(p, { ...ctx })).toBe(r);
					}
					if (t?.samples) {
						const a = t.samples(p, ctx);
						expect(t.samples(p, { ...ctx })).toEqual(a);
						expect(a.length).toBeLessThanOrEqual(FX_MAX_TIME_SAMPLES);
						const base = t.remap ? clampToSpan(t.remap(p, ctx), ctx) : f;
						for (const o of a) {
							expect(Number.isInteger(o)).toBe(true);
							// never outside the drawn span (would read as transparent)
							expect(base + o).toBeGreaterThanOrEqual(-4);
							expect(base + o).toBeLessThanOrEqual(63);
						}
						expect([...a].sort((x, y) => x - y)).toEqual(a);
					}
					const u = s.gpu!.uniforms?.(p, fctx(f));
					if (u) expect(s.gpu!.uniforms!(p, fctx(f))).toEqual(u);
				}
				// the pass plan is a function of the params only
				const ctx = { width: 640, height: 360, pxScale: 1, fps: 30 };
				expect(JSON.stringify(gpuPasses(s.gpu!, p, ctx))).toBe(JSON.stringify(gpuPasses(s.gpu!, p, ctx)));
			}
		}
	});

	it('S_FreezeFrame follows the documented sequences', () => {
		// 1-based in the docs: 1 2 3 4 5 6 7 8 9 10 11 → 1 1 1 1 1 6 6 6 6 6 11
		expect(Array.from({ length: 11 }, (_, f) => freezeFrameSource(f, 5, 0))).toEqual([
			0, 0, 0, 0, 0, 5, 5, 5, 5, 5, 10,
		]);
		// Frame Start 3: the first hold is shorter, then every 5 frames from frame 3.
		expect(Array.from({ length: 9 }, (_, f) => freezeFrameSource(f, 5, 3))).toEqual([
			0, 0, 0, 3, 3, 3, 3, 3, 8,
		]);
		expect(remap('S_FreezeFrame', 7)).toBe(5);
	});

	it('S_ReverseClip and S_ReverseEdits', () => {
		expect(remap('S_ReverseClip', 0)).toBe(59);
		expect(remap('S_ReverseClip', 59)).toBe(0);
		// 1 2 3 4 5 6 7 8 9 10 11 → 5 4 3 2 1 10 9 8 7 6 15 (1-based)
		expect(Array.from({ length: 11 }, (_, f) => reverseEditsSource(f, 5, 0, false, 60))).toEqual([
			4, 3, 2, 1, 0, 9, 8, 7, 6, 5, 14,
		]);
		// Reverse All: segments play forwards again, in backwards order.
		expect(reverseEditsSource(0, 5, 0, true, 60)).toBe(55);
		expect(reverseEditsSource(4, 5, 0, true, 60)).toBe(59);
		expect(reverseEditsSource(5, 5, 0, true, 60)).toBe(50);
	});

	it('S_JitterFrames stays within ±dist, groups frames, depends on the seed', () => {
		const a = Array.from({ length: 60 }, (_, f) => jitterFramesSource(f, 1, 10, 0.37, 1000));
		for (let f = 0; f < 60; f++) expect(Math.abs(a[f]! - Math.max(0, f))).toBeLessThanOrEqual(10);
		expect(new Set(a.map((x, f) => x - f)).size).toBeGreaterThan(5);
		const b = Array.from({ length: 60 }, (_, f) => jitterFramesSource(f, 1, 10, 0.91, 1000));
		expect(b).not.toEqual(a);
		const g = Array.from({ length: 8 }, (_, f) => jitterFramesSource(100 + f, 4, 10, 0.37, 1000) - (100 + f));
		expect(new Set(g.slice(0, 4)).size).toBe(1);
		expect(new Set(g.slice(4, 8)).size).toBe(1);
	});

	it('S_RandomEdits is a permutation of whole segments', () => {
		const p = seededPermutation(30, 0.37);
		expect([...p].sort((x, y) => x - y)).toEqual(Array.from({ length: 30 }, (_, i) => i));
		const shown = Array.from({ length: 60 }, (_, f) => randomEditsSource(f, 2, 0.37, 60));
		expect([...shown].sort((x, y) => x - y)).toEqual(Array.from({ length: 60 }, (_, i) => i));
		for (let f = 0; f < 60; f += 2) expect(shown[f + 1]).toBe(shown[f]! + 1);
		expect(shown).not.toEqual(Array.from({ length: 60 }, (_, i) => i));
		expect(Array.from({ length: 60 }, (_, f) => randomEditsSource(f, 2, 0.5, 60))).not.toEqual(shown);
	});

	it('S_Retime modes map output frames to source frames', () => {
		const at = (over: Record<string, unknown>, f: number) =>
			retimeSource(defaults(spec('S_Retime'), over), f, 60);
		expect(at({ mode: 'speed', speed: 0.5 }, 10)).toBe(5);
		expect(at({ mode: 'longer', percentLonger: 100 }, 10)).toBe(5);
		expect(at({ mode: 'scale', percent: 50 }, 10)).toBe(20);
		expect(at({ mode: 'fps', inputFps: 24, outputFps: 48 }, 10)).toBe(5);
		expect(at({ mode: 'length', outputLength: 120 }, 10)).toBe(5);
		expect(at({ mode: 'variable', inputFrame: 33.5 }, 10)).toBe(33.5);
		// fractional frames: remap floors, the next frame is a sample, u_t blends
		const s = spec('S_Retime');
		const p = defaults(s, { speed: 0.25 });
		expect(s.gpu!.time!.remap!(p, tctx(3))).toBe(0.75);
		expect(s.gpu!.time!.samples!(p, tctx(3))).toEqual([1]);
		expect(s.gpu!.time!.samples!(p, tctx(4))).toEqual([]);
		expect(s.gpu!.uniforms!(p, fctx(3))).toEqual({ u_t: 0.75 });
	});

	it('S_GetFrame shows Get Frame, blending the next frame with Interp Frames', () => {
		expect(remap('S_GetFrame', 40, { getFrame: 12 })).toBe(12);
		expect(samples('S_GetFrame', 40, { getFrame: 12.5 })).toEqual([]);
		expect(samples('S_GetFrame', 40, { getFrame: 12.5, interpFrames: true })).toEqual([1]);
		expect(samples('S_GetFrame', 40, { getFrame: 59.5, interpFrames: true })).toEqual([]); // past the end
	});

	it('trails/feedback windows: ≤ 8 samples reaching back Max Steps, starting fresh at the first frame', () => {
		expect(historyOffsets(15)).toEqual([-15, -13, -11, -9, -8, -6, -4, -2]);
		expect(historyOffsets(3)).toEqual([-3, -2, -1]);
		expect(samples('S_Trails', 30)).toEqual([-15, -13, -11, -9, -8, -6, -4, -2]);
		expect(samples('S_Trails', 5)).toEqual([-4, -2]);
		expect(samples('S_Trails', 0)).toEqual([]);
		expect(samples('S_Feedback', 2, {}, { headHandle: 10 })).toEqual([-11, -9, -8, -6, -4, -2]);
		// the recursion is replayed in one pass (one upload of the samples); FeedbackDistort adds its lens passes
		const pc = { width: 64, height: 36, pxScale: 1, fps: 30 };
		const s = spec('S_Trails');
		expect(gpuPasses(s.gpu!, defaults(s), pc)).toHaveLength(1);
		const d = spec('S_FeedbackDistort');
		expect(gpuPasses(d.gpu!, defaults(d), pc).map((x) => x.output ?? null)).toEqual([
			'lensLuma',
			'lensBlurH',
			'lensBlur',
			null,
		]);
	});

	it('S_TimeAverage / S_NearestColor average/scan the current frame and the previous ones', () => {
		expect(samples('S_TimeAverage', 30, { aveOverFrames: 4 })).toEqual([-3, -2, -1]);
		expect(samples('S_TimeAverage', 30, { aveOverFrames: 1 })).toEqual([]);
		expect(samples('S_TimeAverage', 30)).toEqual([-9, -8, -7, -6, -5, -3, -2, -1]);
		expect(samples('S_NearestColor', 30, { steps: 3 })).toEqual([-2, -1]);
	});

	it('S_TimeSlice / S_TimeDisplace sample their window (exact up to 9 frames, spread beyond)', () => {
		expect(spreadOffsets(-3, 3)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
		expect(spreadOffsets(-10, 10)).toHaveLength(8);
		expect(samples('S_TimeSlice', 30, { sliceNumber: 8 })).toEqual([-4, -3, -2, -1, 1, 2, 3, 4]);
		expect(samples('S_TimeSlice', 30)).toHaveLength(8);
		expect(samples('S_TimeDisplace', 30, { blackTimeShift: -2, whiteTimeShift: 2 })).toEqual([-2, -1, 1, 2]);
		// Frame 0: absolute frames 0…4 at frame 30 → offsets −30…−26
		expect(
			samples('S_TimeDisplace', 30, { shiftRelativeTo: 'frame0', blackTimeShift: 0, whiteTimeShift: 4 }),
		).toEqual([-30, -29, -28, -27, -26]);
		expect(inSpan([-5, 2, 2, 9], 3, tctx(3, { duration: 10 }))).toEqual([2]);
	});

	it('S_TimeWarpRGB samples one frame per shifted channel', () => {
		expect(samples('S_TimeWarpRGB', 30)).toEqual([-1, 1]);
		expect(spec('S_TimeWarpRGB').gpu!.uniforms!(defaults(spec('S_TimeWarpRGB')), fctx(30))).toEqual({
			u_twOffsets: [-1, -0, 1],
		});
		expect(samples('S_TimeWarpRGB', 0)).toEqual([1]);
	});

	it('S_CutToDissolve: the other side of the cut inside the window, eased progress', () => {
		const p = { cutPoint: 30, dissolveLength: 6 };
		expect(samples('S_CutToDissolve', 26, p)).toEqual([]);
		expect(samples('S_CutToDissolve', 27, p)).toEqual([3]); // B side held at frame 30
		expect(samples('S_CutToDissolve', 31, p)).toEqual([-2]); // A side held at frame 29
		expect(samples('S_CutToDissolve', 33, p)).toEqual([]);
		expect(samples('S_CutToDissolve', 50, { ...p, show: 'cutFrames' })).toEqual([-21, -20]);
		const u = (f: number, o = {}) =>
			spec('S_CutToDissolve').gpu!.uniforms!(defaults(spec('S_CutToDissolve'), { ...p, ...o }), fctx(f)) as {
				u_ct: number;
			};
		const ts = [27, 28, 29, 30, 31, 32].map((f) => u(f).u_ct);
		for (let i = 1; i < ts.length; i++) expect(ts[i]!).toBeGreaterThan(ts[i - 1]!);
		expect(ts[0]!).toBeGreaterThan(0);
		expect(ts[5]!).toBeLessThan(1);
		expect(u(29, { slowInOut: 0 }).u_ct).toBeCloseTo(2.5 / 6);
		expect(u(27, { slowInOut: 4 }).u_ct).toBeLessThan(u(27, { slowInOut: 0 }).u_ct);
	});

	it('S_RepairFrames reads the good frames around the bad ones', () => {
		const p = { firstBadFrame: 10, badFrameCount: 2 };
		expect(samples('S_RepairFrames', 9, p)).toEqual([]);
		expect(samples('S_RepairFrames', 10, p)).toEqual([-1, 2]);
		expect(samples('S_RepairFrames', 11, p)).toEqual([-2, 1]);
		expect(samples('S_RepairFrames', 40, { ...p, show: 'badFrame' })).toEqual([-30]);
		const u = spec('S_RepairFrames').gpu!.uniforms!(defaults(spec('S_RepairFrames'), p), fctx(11));
		expect(u).toEqual({ u_t: 2 / 3, u_bad: true });
	});

	it('S_MotionDetect compares with Delay Frames before (or after) the current frame', () => {
		expect(samples('S_MotionDetect', 30)).toEqual([-1]);
		expect(samples('S_MotionDetect', 30, { delayFrames: -2 })).toEqual([2]);
		expect(samples('S_MotionDetect', 0)).toEqual([]);
	});

	it('S_Flicker gains: deterministic, seed-dependent, within the amplitude, wave per channel', () => {
		const s = spec('S_Flicker');
		const g = (f: number, over: Record<string, unknown> = {}, seed = 0.37) =>
			flickerGains(defaults(s, over), f, 30, seed);
		const a = Array.from({ length: 30 }, (_, f) => g(f));
		expect(Array.from({ length: 30 }, (_, f) => g(f))).toEqual(a);
		expect(Array.from({ length: 30 }, (_, f) => g(f, {}, 0.8))).not.toEqual(a);
		for (const [r, gg, b] of a) {
			expect(r).toBe(gg); // luma flicker only by default
			expect(gg).toBe(b);
			expect(Math.abs(r - 1)).toBeLessThanOrEqual(0.2 + 1e-9);
		}
		expect(new Set(a.map((x) => x[0])).size).toBeGreaterThan(10);
		const w = g(3, { randLumaAmp: 0, waveAmp: 1, waveGPhase: 0.5 });
		expect(w[0]).toBeCloseTo(2 - w[1]!, 9); // opposite phases
		expect(g(5, { amplitude: 0 })).toEqual([1, 1, 1]);
		expect(g(5, { amplitude: 0, brightness: 2 })).toEqual([2, 2, 2]);
	});

	it('flicker tools: Hold From Frame samples the hold frame; the reference reduction pass is added', () => {
		expect(samples('S_FlickerRemove', 30)).toEqual([]);
		expect(samples('S_FlickerRemove', 30, { holdFromFrame: true, holdFrame: 4 })).toEqual([-26]);
		const s = spec('S_FlickerRemoveColor');
		const ctx = { width: 640, height: 360, pxScale: 1, fps: 30 };
		expect(gpuPasses(s.gpu!, defaults(s), ctx).map((p) => p.output ?? null)).toEqual(['flStats', null]);
		expect(gpuPasses(s.gpu!, defaults(s, { holdFromFrame: true }), ctx).map((p) => p.output ?? null)).toEqual(
			['flStats', 'flRef', null],
		);
		expect(spec('S_FlickerMatch').gpu!.time).toBeUndefined();
	});
});
