// @vitest-environment node
// Adaptive shutter motion blur (wave 5) in a real WebGL2 (headless Chrome, SwiftShader when there is no GPU): the
// moving effects and transitions run through the GPU host on a thin bright line, and the intensity profile across the
// smear is checked — continuous (no gaps, no periodic peaks: low max/min ratio for constant-speed moves, no notches
// for shakes), deterministic (same pixels on re-render, in any frame order), reduced taps at a preview scale, and
// IDENTICAL output with motion blur off or without motion (checksums recorded from the pre-wave-5 code in
// fx-motion-blur/baseline.json; MB_BASELINE_WRITE=1 re-records them). MB_REPORT=<file> writes the smear metrics and
// timings (MB_PERF=1 adds 1080p timings). FX_GL=0 skips it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EffectArgs, Out, TransitionArgs } from './fx-motion-blur/entry.ts';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(here, 'fx-motion-blur', 'baseline.json');
const W = 320;
const H = 180;

/**
 * The smear of a bright line in a profile (luma per pixel): its extent (pixels above 30 % of the peak, first to
 * last), the max/min ratio over its inner 60 %, notches (pixels darker than 60 % of both neighbourhoods' peaks: the
 * dips between ghost copies) and holes (inner pixels below one luma level: gaps a continuous path cannot leave).
 */
export function smearStats(profile: readonly number[]) {
	const max = Math.max(...profile);
	const on = profile.map((v) => v > 0.3 * max);
	const first = on.indexOf(true);
	const last = on.lastIndexOf(true);
	if (first < 0) return { length: 0, ratio: Number.POSITIVE_INFINITY, notches: 0, holes: 0, max };
	const lo = Math.round(first + 0.2 * (last - first));
	const hi = Math.round(last - 0.2 * (last - first));
	const inner = profile.slice(lo, hi + 1);
	const ratio = Math.max(...inner) / Math.max(0.5, Math.min(...inner));
	let notches = 0;
	for (let i = lo; i <= hi; i++) {
		const l = Math.max(...profile.slice(Math.max(first, i - 4), i));
		const r = Math.max(...profile.slice(i + 1, Math.min(last, i + 4) + 1));
		if (profile[i]! < 0.6 * Math.min(l, r) && Math.min(l, r) > 2) notches++;
	}
	const holes = profile.slice(first, last + 1).filter((v) => v < 1).length;
	return { length: last - first + 1, ratio, notches, holes, max };
}

/** Cases whose output must be identical to the pre-wave-5 code: motion blur off, or nothing moves. */
const STATIC_EFFECTS: [string, Partial<EffectArgs>][] = [
	['shake-default', { id: 'jasper.s.shake', frame: 12, seed: 0.3 }],
	['shake-default-grid', { id: 'jasper.s.shake', frame: 5, paint: 'grid' }],
	['shake-twitchy-off', { id: 'jasper.s.shake', frame: 9, params: { style: 'twitchy', amplitude: 4 } }],
	[
		'shake-rgb-off',
		{ id: 'jasper.s.shake', frame: 7, paint: 'grid', params: { redPhase: 0.4, rgbRandomness: 0.5 } },
	],
	[
		'shake-blur-static',
		{ id: 'jasper.s.shake', frame: 7, paint: 'grid', params: { motionBlur: true, amplitude: 0 } },
	],
	[
		'shake-blur-zero',
		{ id: 'jasper.s.shake', frame: 7, params: { motionBlur: true, moBlurLength: 0, amplitude: 3 } },
	],
	['corner-pin-default', { id: 'jasper.s.warp-corner-pin', paint: 'grid' }],
	['corner-pin-blur-static', { id: 'jasper.s.warp-corner-pin', paint: 'grid', params: { motionBlur: true } }],
	[
		'corner-pin-moving-off',
		{
			id: 'jasper.s.warp-corner-pin',
			paint: 'grid',
			frame: 5,
			keys: [
				{
					frame: 0,
					params: { topLeft: [0, 0], topRight: [0.5, 0], bottomLeft: [0, 0.5], bottomRight: [0.5, 0.5] },
				},
				{
					frame: 10,
					params: { topLeft: [0.5, 0.5], topRight: [1, 0.5], bottomLeft: [0.5, 1], bottomRight: [1, 1] },
				},
			],
		},
	],
	['perspective-default', { id: 'jasper.s.warp-perspective', paint: 'grid' }],
	[
		'perspective-blur-static',
		{ id: 'jasper.s.warp-perspective', paint: 'grid', params: { motionBlur: true } },
	],
	[
		'perspective-moving-off',
		{
			id: 'jasper.s.warp-perspective',
			paint: 'grid',
			frame: 5,
			keys: [
				{ frame: 0, params: { swing: 0 } },
				{ frame: 10, params: { swing: 90 } },
			],
		},
	],
	['transform-default', { id: 'jasper.transform', paint: 'grid' }],
	[
		'transform-shutter-static',
		{
			id: 'jasper.transform',
			paint: 'grid',
			params: { useCompShutterAngle: false, shutterAngle: 180, rotation: 20 },
		},
	],
	[
		'transform-moving-comp-shutter',
		{
			id: 'jasper.transform',
			paint: 'grid',
			frame: 5,
			keys: [
				{ frame: 0, params: { position: [0.2, 0.5] } },
				{ frame: 10, params: { position: [0.8, 0.5] } },
			],
		},
	],
	['freelens-default', { id: 'jasper.s.free-lens', paint: 'grid', frame: 4 }],
	[
		'freelens-shake-off',
		{ id: 'jasper.s.free-lens', paint: 'grid', frame: 4, params: { xRandAmp: 2, motionBlur: false } },
	],
	['strip-slide-noblur', { id: 'jasper.s.strip-slide', paint: 'grid', params: { motionBlur: 0 } }],
	['blur-mo-curves-static', { id: 'jasper.s.blur-mo-curves', paint: 'grid', params: { rotate: 10 } }],
	['film-damage-default', { id: 'jasper.s.film-damage', paint: 'grid', frame: 3 }],
];

const STATIC_TRANSITIONS: [string, Omit<TransitionArgs, 'width' | 'height'>][] = [
	...(
		[
			'jasper.travel-motion',
			'jasper.pull-motion',
			'jasper.spin-motion',
			'jasper.3d-roll',
			'jasper.film-roll',
			'jasper.roll',
			'jasper.stretch-transition',
			'jasper.3d-spin',
			'jasper.3d-spinback',
			'jasper.whip',
		] as const
	).map((id): [string, Omit<TransitionArgs, 'width' | 'height'>] => [
		`${id}-blur0`,
		{ id, frame: 4, duration: 10, from: 'grid', to: 'vline', params: { blur: 0 } },
	]),
	[
		'earthquake-still',
		{
			id: 'jasper.earthquake',
			frame: 4,
			duration: 10,
			from: 'grid',
			to: 'vline',
			params: { amplitude: 0, rotation: 0 },
		},
	],
	[
		'directional-blur-ends',
		{
			id: 'jasper.directional-blur-transition',
			frame: 0,
			duration: 10,
			from: 'grid',
			to: 'vline',
			params: { endPercent: 0 },
		},
	],
	[
		'strip-slide-transition-noblur',
		{
			id: 'jasper.s.strip-slide-transition',
			frame: 4,
			duration: 10,
			from: 'grid',
			to: 'vline',
			params: { motionBlur: 0 },
		},
	],
	[
		'swish-pan-noblur',
		{
			id: 'jasper.s.swish-pan',
			frame: 4,
			duration: 10,
			from: 'grid',
			to: 'vline',
			params: { blurAmount: 0 },
		},
	],
	[
		'dissolve-shake-off',
		{
			id: 'jasper.s.dissolve-shake',
			frame: 4,
			duration: 10,
			from: 'grid',
			to: 'vline',
			params: { motionBlur: false },
		},
	],
	[
		'dissolve-shake-still',
		{
			id: 'jasper.s.dissolve-shake',
			frame: 4,
			duration: 10,
			from: 'grid',
			to: 'vline',
			params: { amplitude: 0 },
		},
	],
];

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'adaptive shutter motion blur in WebGL2 (headless Chrome)',
	{ timeout: 240_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const report: Record<string, unknown> = {};
		const effect = (a: Partial<EffectArgs> & { id: string }): Promise<Out> =>
			page.evaluate(
				(args) => (window as unknown as { __mb: { runEffect(a: unknown): unknown } }).__mb.runEffect(args),
				{ width: W, height: H, ...a },
			) as Promise<Out>;
		const transition = (
			a: Omit<TransitionArgs, 'width' | 'height'> & Partial<TransitionArgs>,
		): Promise<Out> =>
			page.evaluate(
				(args) =>
					(window as unknown as { __mb: { runTransition(a: unknown): unknown } }).__mb.runTransition(args),
				{ width: W, height: H, ...a },
			) as Promise<Out>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-motion-blur', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
			if (process.env.MB_REPORT) writeFileSync(process.env.MB_REPORT, JSON.stringify(report, null, 2));
		});

		it('motion blur off or no motion: identical to the pre-wave-5 output', async () => {
			const got: Record<string, number> = {};
			for (const [name, a] of STATIC_EFFECTS) got[name] = (await effect({ id: '', ...a })).checksum;
			for (const [name, a] of STATIC_TRANSITIONS) got[name] = (await transition(a)).checksum;
			if (process.env.MB_BASELINE_WRITE === '1') {
				writeFileSync(BASELINE, `${JSON.stringify(got, null, '\t')}\n`);
				return;
			}
			const want = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
			for (const k of Object.keys(got)) expect(got[k], k).toBe(want[k]);
		});

		it('fast moves smear continuously: no gaps or periodic peaks across the smear', async () => {
			const results: Record<string, ReturnType<typeof smearStats> & { taps?: number }> = {};
			for (const [name, kind, a, limits] of SMEARS) {
				const o = kind === 'effect' ? await effect(a as EffectArgs) : await transition(a as TransitionArgs);
				const s = smearStats(o.row ?? o.column ?? []);
				results[name] = { ...s, ...(o.uniforms?.u_mbPlan ? { taps: o.uniforms.u_mbPlan[0] } : {}) };
				if (process.env.MB_PNG_DIR && o.png)
					writeFileSync(
						join(process.env.MB_PNG_DIR, `${name}.png`),
						Buffer.from(o.png.split(',')[1]!, 'base64'),
					);
				if (process.env.MB_NO_ASSERT) continue;
				expect(s.length, `${name} smear length`).toBeGreaterThanOrEqual(limits.minLength);
				expect(s.notches, `${name} notches`).toBe(0);
				if (!limits.allowHoles) expect(s.holes, `${name} holes`).toBe(0);
				if (limits.maxRatio) expect(s.ratio, `${name} max/min`).toBeLessThan(limits.maxRatio);
			}
			report.smears = results;
		});

		it('deterministic: same pixels on re-render and in any frame order (no frame-random jitter)', async () => {
			const twitchy = SMEARS.find(([n]) => n === 'shake-twitchy')![2] as EffectArgs;
			const pin = SMEARS.find(([n]) => n === 'corner-pin-fast')![2] as EffectArgs;
			const travel = SMEARS.find(([n]) => n === 'travel-motion')![2] as TransitionArgs;
			const a = await effect({ ...twitchy, png: false });
			const p1 = await effect({ ...pin, png: false });
			const t1 = await transition({ ...travel, png: false });
			await effect({ ...twitchy, frame: 11, png: false });
			await effect({ ...pin, frame: 3, png: false });
			await transition({ ...travel, frame: 7, png: false });
			expect((await effect({ ...twitchy, png: false })).checksum).toBe(a.checksum);
			expect((await effect({ ...pin, png: false })).checksum).toBe(p1.checksum);
			expect((await transition({ ...travel, png: false })).checksum).toBe(t1.checksum);
			// The jitter is per pixel + seed, not per frame: another seed changes the grain of a capped smear.
			const fast = { ...twitchy, png: false, params: { ...twitchy.params, amplitude: 10 } };
			expect((await effect({ ...fast, seed: 0.7 })).checksum).not.toBe((await effect(fast)).checksum);
		});

		it('the preview scale reduces the taps proportionally; Draft / High quality presets', async () => {
			const wave = SMEARS.find(([n]) => n === 'shake-wave')![2] as EffectArgs;
			const full = await effect({ ...wave, png: false });
			const half = await effect({ ...wave, png: false, scale: 0.5 });
			const quarter = await effect({ ...wave, png: false, scale: 0.25 });
			const taps = (o: Out) => o.uniforms!.u_mbPlan![0]!;
			expect(taps(full)).toBe(40);
			expect(taps(half)).toBe(20);
			expect(taps(quarter)).toBe(10);
			const s = smearStats(half.row ?? []);
			expect(s.holes).toBe(0);
			expect(s.notches).toBe(0);
			const draft = await effect({ ...wave, png: false, params: { ...wave.params, mbQuality: 'draft' } });
			expect(taps(draft)).toBe(16);
			const fast = { ...wave, png: false, params: { ...wave.params, amplitude: 12 } };
			expect(taps(await effect(fast))).toBe(64);
			expect(taps(await effect({ ...fast, params: { ...fast.params, mbQuality: 'high' } }))).toBe(96);
			report.taps = { full: taps(full), half: taps(half), quarter: taps(quarter), draft: taps(draft) };
		});

		it.runIf(process.env.MB_PERF === '1')('1080p frame times (MB_PERF=1)', { timeout: 900_000 }, async () => {
			const at = (a: Partial<EffectArgs> & { id: string }) =>
				effect({ width: 1920, height: 1080, paint: 'grid', repeat: 3, ...a });
			const shake = { id: 'jasper.s.shake', frame: 29 };
			const cases: [string, Partial<EffectArgs> & { id: string }][] = [
				['shake-off', { ...shake, params: { amplitude: 1 } }],
				['shake-typical (Normal, amp 1, blur on)', { ...shake, params: { amplitude: 1, motionBlur: true } }],
				[
					'shake-twitchy-amp5 (worst, blur on)',
					{
						...shake,
						params: { motionBlur: true, style: 'twitchy', amplitude: 5, frequency: 12, stillness: 0 },
					},
				],
				[
					'shake-twitchy-amp5 1/2 preview',
					{
						...shake,
						scale: 0.5,
						params: { motionBlur: true, style: 'twitchy', amplitude: 5, frequency: 12, stillness: 0 },
					},
				],
				[
					'shake-twitchy-amp5 draft',
					{
						...shake,
						params: {
							motionBlur: true,
							style: 'twitchy',
							amplitude: 5,
							frequency: 12,
							stillness: 0,
							mbQuality: 'draft',
						},
					},
				],
				[
					'shake-rgb-amp5 (3 channels, blur on)',
					{
						...shake,
						params: {
							motionBlur: true,
							style: 'twitchy',
							amplitude: 5,
							frequency: 12,
							stillness: 0,
							redPhase: 0.3,
							bluePhase: -0.3,
						},
					},
				],
			];
			const out: Record<string, { ms: number; taps: number }> = {};
			for (const [name, a] of cases) {
				const o = await at(a);
				out[name] = { ms: Math.round(o.ms! * 10) / 10, taps: o.uniforms?.u_mbPlan?.[0] ?? 1 };
			}
			report.perf1080 = out;
			console.info(JSON.stringify(out, null, 2));
		});
	},
);

/**
 * `allowHoles`: Jumpy's jumps are instantaneous in the shake model (held random targets), so a jump inside the shutter
 * is two exposures joined by a streak of 1/15 of the exposure time (box shutter): fainter than one luma level.
 */
type Limits = { minLength: number; maxRatio?: number; allowHoles?: boolean };
const row = H / 2;
const png = !!process.env.MB_PNG_DIR;
/** Moving cases: [name, kind, args, limits]. Rows are layer px (effects) / frame px (transitions). */
const SMEARS: [string, 'effect' | 'transition', EffectArgs | TransitionArgs, Limits][] = [
	[
		// A sinusoidal shake through its zero crossing at frame 0: 40 px per frame, the fastest point of the wave.
		'shake-wave',
		'effect',
		{
			id: 'jasper.s.shake',
			width: W,
			height: H,
			frame: 0,
			row,
			png,
			params: { motionBlur: true, amplitude: 3, xRandAmp: 0, yRandAmp: 0, xWaveAmp: 1, xWaveFreq: 2 },
		},
		{ minLength: 30, maxRatio: 1.6 },
	],
	[
		'shake-twitchy',
		'effect',
		{
			id: 'jasper.s.shake',
			width: W,
			height: H,
			frame: 29,
			row,
			png,
			params: {
				motionBlur: true,
				style: 'twitchy',
				amplitude: 5,
				frequency: 12,
				stillness: 0,
				xRandAmp: 1,
				yRandAmp: 0,
			},
		},
		{ minLength: 12 },
	],
	[
		'shake-jumpy',
		'effect',
		{
			id: 'jasper.s.shake',
			width: W,
			height: H,
			frame: 25,
			row,
			png,
			params: {
				motionBlur: true,
				style: 'jumpy',
				amplitude: 3,
				frequency: 24,
				xRandAmp: 1,
				yRandAmp: 0,
				drift: 1,
			},
		},
		{ minLength: 4, allowHoles: true },
	],
	[
		// The pinned quad (half the layer) races 72 px per frame to the right.
		'corner-pin-fast',
		'effect',
		{
			id: 'jasper.s.warp-corner-pin',
			width: W,
			height: H,
			frame: 2,
			row,
			png,
			params: { motionBlur: true, moBlurLength: 1 },
			keys: [
				{
					frame: 0,
					params: {
						topLeft: [-0.3, 0.25],
						topRight: [0.2, 0.25],
						bottomLeft: [-0.3, 0.75],
						bottomRight: [0.2, 0.75],
					},
				},
				{
					frame: 4,
					params: {
						topLeft: [0.6, 0.25],
						topRight: [1.1, 0.25],
						bottomLeft: [0.6, 0.75],
						bottomRight: [1.1, 0.75],
					},
				},
			],
		},
		{ minLength: 60, maxRatio: 1.6 },
	],
	[
		// Transform, 180° shutter: 128 px per frame → a 64 px smear.
		'transform-fast',
		'effect',
		{
			id: 'jasper.transform',
			width: W,
			height: H,
			frame: 1,
			row,
			png,
			params: { useCompShutterAngle: false, shutterAngle: 180 },
			keys: [
				{ frame: 0, params: { position: [0.1, 0.5] } },
				{ frame: 2, params: { position: [0.9, 0.5] } },
			],
		},
		{ minLength: 55, maxRatio: 1.6 },
	],
	[
		'perspective-swing',
		'effect',
		{
			id: 'jasper.s.warp-perspective',
			width: W,
			height: H,
			frame: 2,
			row,
			png,
			params: { motionBlur: true, latitude: 20, wrapX: 'no', wrapY: 'no' },
			keys: [
				{ frame: 0, params: { shiftOrig: [0, 0] } },
				{ frame: 4, params: { shiftOrig: [0.8, 0] } },
			],
		},
		{ minLength: 20 },
	],
	[
		'freelens-shake',
		'effect',
		{
			id: 'jasper.s.free-lens',
			width: W,
			height: H,
			frame: 9,
			row,
			png,
			params: {
				xRandAmp: 3,
				amplitude: 4,
				frequency: 30,
				xRandFreq: 2,
				tiltX: 0,
				lightLeak: false,
				vignette: false,
				glowBrightness: 0,
			},
		},
		{ minLength: 6 },
	],
	[
		'travel-motion',
		'transition',
		{
			id: 'jasper.travel-motion',
			width: W,
			height: H,
			frame: 4,
			duration: 10,
			row,
			png,
			to: 'none',
			params: { blur: 100 },
		},
		{ minLength: 40 },
	],
	[
		'roll-3d',
		'transition',
		{
			id: 'jasper.3d-roll',
			width: W,
			height: H,
			frame: 4,
			duration: 10,
			row,
			png,
			to: 'none',
			params: { blur: 100, bend: 0 },
		},
		{ minLength: 40 },
	],
	[
		'whip',
		'transition',
		{
			id: 'jasper.whip',
			width: W,
			height: H,
			frame: 4,
			duration: 10,
			row,
			png,
			to: 'none',
			params: { blur: 100 },
		},
		{ minLength: 40 },
	],
	[
		'swish-pan',
		'transition',
		{
			id: 'jasper.s.swish-pan',
			width: W,
			height: H,
			frame: 3,
			duration: 10,
			row,
			png,
			to: 'none',
			params: { direction: 'right' },
		},
		{ minLength: 40 },
	],
	[
		// An eased (ease-in) keyframed shift: the blur follows the curve, not the straight line between the ends.
		'blur-mo-curves',
		'effect',
		{
			id: 'jasper.s.blur-mo-curves',
			width: W,
			height: H,
			frame: 3,
			row,
			png,
			params: { shutterDuration: 1 },
			keys: [
				{ frame: 0, params: { shift: [0, 0] } },
				{ frame: 2, params: { shift: [0.1, 0] } },
				{ frame: 4, params: { shift: [0.5, 0] } },
			],
		},
		{ minLength: 25, maxRatio: 2.5 },
	],
	[
		'strip-slide-transition',
		'transition',
		{
			id: 'jasper.s.strip-slide-transition',
			width: W,
			height: H,
			frame: 4,
			duration: 10,
			column: W / 2,
			png,
			from: 'hline',
			to: 'none',
			params: { motionBlur: 2, stripAngle: 90, stripSize: 2 },
		},
		{ minLength: 20 },
	],
	[
		'earthquake',
		'transition',
		{
			id: 'jasper.earthquake',
			width: W,
			height: H,
			frame: 9,
			duration: 20,
			row,
			png,
			to: 'none',
			params: { rotation: 0, amplitude: 200 },
		},
		{ minLength: 4 },
	],
];
