// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGolden, type Tolerance } from '@jasper/testkit/golden';
import type { Rgba8 } from '@jasper/testkit/image';
import { decodePng } from '@jasper/testkit/png';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EffectArgs, Out, TransitionArgs } from './fx-motion-blur/entry.ts';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));
/** Golden frames of the static cases (motion blur off or nothing moves). */
const GOLDENS = join(here, 'goldens', 'motion-blur');
/**
 * Tight: a static case must not change at all; this only absorbs SwiftShader / ANGLE rounding between Chrome
 * versions (a smear or a shifted grid moves hundreds of pixels by far more).
 */
const MB_TOLERANCE: Tolerance = { minPsnr: 45, maxAbs: 16, p99: 2 };
const pngOf = (dataUrl: string | undefined): Rgba8 => {
	if (!dataUrl) throw new Error('no PNG returned');
	return decodePng(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
};
const W = 320;
const H = 180;

/**
 * The smear of a bright line in a profile (luma per pixel): its extent (pixels above 30 % of the peak, first to
 * last), the max/min ratio over its inner 60 %, notches (pixels darker than 60 % of both neighbourhoods' peaks: the
 * dips between ghost copies) and holes (inner pixels below one luma level: gaps a continuous path cannot leave).
 */
function smearStats(profile: readonly number[]) {
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

/** Disabling motion blur, or holding motion constant, must preserve the reference pixels. */
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

		it('motion blur off or no motion: identical to the pre-wave-5 output (golden frames)', async () => {
			const frames: Record<string, Rgba8> = {};
			for (const [name, a] of STATIC_EFFECTS)
				frames[name] = pngOf((await effect({ id: '', ...a, png: true })).png);
			for (const [name, a] of STATIC_TRANSITIONS)
				frames[name] = pngOf((await transition({ ...a, png: true })).png);
			const failures: string[] = [];
			for (const [name, img] of Object.entries(frames)) {
				try {
					// The perspective warps' padded canvases compress poorly (≈ 55–110 KB): a documented exception to the 50 KB cap.
					expectGolden(join(GOLDENS, `${name}.png`), img, MB_TOLERANCE, { maxBytes: 128 * 1024 });
				} catch (e) {
					failures.push((e as Error).message);
				}
			}
			expect(failures).toEqual([]);
		});

		it('fast moves smear continuously: no gaps or periodic peaks across the smear', async () => {
			const results: Record<string, ReturnType<typeof smearStats>> = {};
			for (const [name, kind, a, limits] of SMEARS) {
				const o = kind === 'effect' ? await effect(a as EffectArgs) : await transition(a as TransitionArgs);
				const s = smearStats(o.row ?? o.column ?? []);
				results[name] = s;
				if (process.env.MB_PNG_DIR && o.png)
					writeFileSync(
						join(process.env.MB_PNG_DIR, `${name}.png`),
						Buffer.from(o.png.split(',')[1]!, 'base64'),
					);
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
