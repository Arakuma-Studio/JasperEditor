// "Sapphire other stylize" family (fx catalogue, wave 2): catalogue shape (ids, labels, bin, Sapphire param order)
// and the TypeScript maths of the entries — units, pass planning, S_PixelMosh's hold frames and time samples,
// S_StripSlide's timing. Pixel behaviour: packages/compositions/test/fx-sapphire-stylize-other-gl.test.ts.
import { describe, expect, it } from 'vitest';
import {
	defaultEffectRegistry,
	type EffectParams,
	type EffectSpec,
	fxTimeSamples,
	gpuIsTimeDependent,
	gpuPasses,
	planGpuEffect,
	SAPPHIRE_BINS,
} from '../src/index.ts';
import {
	defaultsOf,
	sapphireBlurPx,
	sapphirePoint,
} from '../src/registry/fx/sapphire-stylize-other/common.ts';
import {
	pixelMoshBlockPx,
	pixelMoshHoldFrame,
	pixelMoshSamples,
	pixelSortScale,
} from '../src/registry/fx/sapphire-stylize-other/pixel.ts';
import {
	mosaicBlockPx,
	romanTilePx,
	stripSlideProgress,
} from '../src/registry/fx/sapphire-stylize-other/tiles.ts';
import { SAPPHIRE_STYLIZE_OTHER_EFFECTS } from '../src/registry/fx/sapphire-stylize-other.ts';

const spec = (id: string) => defaultEffectRegistry.get(id) as EffectSpec;
const ctx = { width: 1920, height: 1080, pxScale: 1, fps: 30 };
const names = (id: string) => spec(id).params.map((p) => p.name);

describe('Sapphire other-stylize family', () => {
	it('has the 17 Sapphire effects, S_ labels, jasper.s ids, in the Sapphire Stylize bin', () => {
		expect(SAPPHIRE_STYLIZE_OTHER_EFFECTS.map((s) => [s.label, s.id])).toEqual([
			['S_BandPass', 'jasper.s.band-pass'],
			['S_ColorFuse', 'jasper.s.color-fuse'],
			['S_DogVision', 'jasper.s.dog-vision'],
			['S_Mosaic', 'jasper.s.mosaic'],
			['S_PixelMosh', 'jasper.s.pixel-mosh'],
			['S_PixelSort', 'jasper.s.pixel-sort'],
			['S_PrismLens', 'jasper.s.prism-lens'],
			['S_PseudoColor', 'jasper.s.pseudo-color'],
			['S_PsykoBlobs', 'jasper.s.psyko-blobs'],
			['S_PsykoStripes', 'jasper.s.psyko-stripes'],
			['S_RomanTile', 'jasper.s.roman-tile'],
			['S_Solarize', 'jasper.s.solarize'],
			['S_StripSlide', 'jasper.s.strip-slide'],
			['S_Zebrafy', 'jasper.s.zebrafy'],
			['S_ZebrafyColor', 'jasper.s.zebrafy-color'],
			['S_ZFogExponential', 'jasper.s.z-fog-exponential'],
			['S_ZFogLinear', 'jasper.s.z-fog-linear'],
		]);
		for (const s of SAPPHIRE_STYLIZE_OTHER_EFFECTS) {
			expect(s.bin).toBe(SAPPHIRE_BINS.stylize);
			expect(defaultEffectRegistry.get(s.id)).toBe(s);
		}
		expect(SAPPHIRE_STYLIZE_OTHER_EFFECTS.filter((s) => s.expensive).map((s) => s.id)).toEqual([
			'jasper.s.pixel-mosh',
			'jasper.s.pixel-sort',
			'jasper.s.prism-lens',
			'jasper.s.roman-tile',
		]);
	});

	it('keeps Sapphire parameter names, order and defaults', () => {
		expect(names('jasper.s.band-pass').slice(0, 6)).toEqual([
			'blurAmount1',
			'blurAmount2',
			'blurRel',
			'brightness',
			'saturation',
			'offsetDarks',
		]);
		expect(names('jasper.s.solarize').slice(0, 5)).toEqual([
			'threshold',
			'saturation',
			'invert',
			'brightness',
			'offsetDarks',
		]);
		expect(names('jasper.s.mosaic').slice(0, 4)).toEqual([
			'pixelFrequency',
			'pixelRelHeight',
			'pixelShift',
			'smoothColors',
		]);
		expect(names('jasper.s.z-fog-linear').slice(0, 5)).toEqual([
			'fogNear',
			'fogFar',
			'fogColor',
			'zBufferType',
			'zBufferUse',
		]);
		const d = (id: string) => defaultsOf(spec(id).params);
		expect(d('jasper.s.band-pass')).toMatchObject({
			blurAmount1: 0.112,
			blurAmount2: 0.224,
			brightness: 3,
			offsetDarks: 0.5,
		});
		expect(d('jasper.s.pixel-sort')).toMatchObject({
			threshold: 0.3,
			randomlyRestartSort: 100,
			sortResolution: 720,
			mode: 'linear',
		});
		expect(d('jasper.s.pixel-mosh')).toMatchObject({
			frameInterval: 15,
			varyFrameInterval: 0.7,
			blockSizeX: 32,
			flowFieldSmoothness: 0.8,
		});
		expect(d('jasper.s.roman-tile')).toMatchObject({
			tileSize: 0.5,
			groutWidth: 0.1,
			lightZ: 5,
			groutColor: [0.4, 0.4, 0.4, 1],
		});
		expect(d('jasper.s.z-fog-exponential')).toMatchObject({
			fogDensity: 0.7,
			zBufferType: 'whiteIsNear',
			depthFallback: 'verticalGradient',
		});
		expect(d('jasper.s.psyko-blobs')).toMatchObject({
			noiseFreq: 4,
			freqColors: 4,
			freqGreen: 1.1,
			phaseStart: 0.5,
			phaseSpeed: 1,
		});
		expect(d('jasper.s.strip-slide')).toMatchObject({
			amount: 0.5,
			speed: 10,
			slowStart: 1,
			order: 'topDown',
		});
	});

	it('converts Sapphire units', () => {
		expect(sapphirePoint(0, 0)).toEqual([0.5, 0.5]);
		expect(sapphirePoint(1, 0)).toEqual([1, 0.5]);
		expect(sapphirePoint(0, 0.5625)).toEqual([0.5, 0]); // y up, 16:9
		expect(sapphireBlurPx(1, ctx)).toBeCloseTo(57.6);
		expect(sapphireBlurPx(0.5, { width: 1920, pxScale: 0.5 })).toBeCloseTo(14.4);
		expect(sapphireBlurPx(-1, ctx)).toBe(0);
		expect(mosaicBlockPx({ pixelFrequency: 40, pixelRelHeight: 0.5 }, ctx)).toEqual([48, 24]);
		expect(romanTilePx({ tileSize: 0.5 }, ctx)).toBeCloseTo(57.6);
	});

	it('plans blurs at reduced resolution for wide widths and keeps them full size when small', () => {
		const sizes = (id: string, p: EffectParams) => {
			const s = spec(id);
			const plan = planGpuEffect(
				s,
				{ id: 'fx', params: { ...defaultsOf(s.params), ...p } },
				{ ...ctx, frame: 0, duration: 30, seed: 0.5, progress: 0 },
				{ width: 1920, height: 1080 },
			);
			return plan.passes.map((pp) => [pp.output, pp.width]);
		};
		expect(sizes('jasper.s.band-pass', {})).toEqual([
			['low1H', 1920],
			['low1', 1920],
			['low2H', 960],
			['low2', 960],
			[null, 1920],
		]);
		expect(sizes('jasper.s.zebrafy', { sourceBlur: 2 })[0]).toEqual(['srcBlurH', 480]);
	});

	it('S_PixelSort: Downsample sorts at Sort Resolution lines', () => {
		expect(pixelSortScale({}, 1080)).toBe(1);
		expect(pixelSortScale({ downsample: true, sortResolution: 720 }, 1080)).toBeCloseTo(2 / 3);
		expect(pixelSortScale({ downsample: true, sortResolution: 4000 }, 1080)).toBe(1);
		const passes = gpuPasses(
			spec('jasper.s.pixel-sort').gpu!,
			{ downsample: true, sortResolution: 540 },
			ctx,
		);
		expect(passes.find((p) => p.output === 'sorted')!.scale).toBeCloseTo(0.5);
	});

	it('S_PixelMosh: seeded hold frames every Frame Interval ± Vary, deterministic, manual hold', () => {
		const auto = { frameInterval: 15, varyFrameInterval: 0.7 };
		const holds = Array.from({ length: 300 }, (_, f) => pixelMoshHoldFrame(auto, f, 0.42));
		expect(holds).toEqual(Array.from({ length: 300 }, (_, f) => pixelMoshHoldFrame(auto, f, 0.42)));
		const starts = [...new Set(holds)];
		expect(starts[0]).toBe(0);
		for (let i = 1; i < starts.length; i++) {
			const len = starts[i]! - starts[i - 1]!;
			expect(len).toBeGreaterThanOrEqual(4); // 15 × (1 − 0.7), rounded
			expect(len).toBeLessThanOrEqual(26); // 15 × (1 + 0.7), rounded
		}
		holds.forEach((h, f) => {
			expect(h).toBeLessThanOrEqual(f);
		});
		expect(new Set(starts.slice(1).map((s, i) => s - starts[i]!)).size).toBeGreaterThan(1); // varied
		const other = Array.from({ length: 300 }, (_, f) => pixelMoshHoldFrame(auto, f, 0.9));
		expect(other).not.toEqual(holds);
		const fixed = { frameInterval: 10, varyFrameInterval: 0 };
		expect([0, 9, 10, 19, 20, 35].map((f) => pixelMoshHoldFrame(fixed, f, 0.1))).toEqual([
			0, 0, 10, 10, 20, 30,
		]);
		const manual = { varyHoldFrame: 'manual', flowWarpHoldFrame: 12 };
		expect([5, 12, 40].map((f) => pixelMoshHoldFrame(manual, f, 0.1))).toEqual([5, 12, 12]);
	});

	it('S_PixelMosh: time samples are the previous frame and the hold frame', () => {
		const p = { frameInterval: 10, varyFrameInterval: 0 };
		expect(pixelMoshSamples(p, 10, 0.1)).toEqual([]); // the hold frame itself: the source
		expect(pixelMoshSamples(p, 11, 0.1)).toEqual([-1]);
		expect(pixelMoshSamples(p, 17, 0.1)).toEqual([-1, -7]);
		expect(pixelMoshSamples({ ...p, useFlowWarp: false }, 17, 0.1)).toEqual([]);
		const s = spec('jasper.s.pixel-mosh');
		const params = { ...defaultsOf(s.params), ...p };
		expect(
			fxTimeSamples(s, params, { frame: 17, fps: 30, duration: 60, headHandle: 0, tailHandle: 0, seed: 0.1 }),
		).toEqual([-1, -7]);
		expect(gpuIsTimeDependent(s)).toBe(true);
		const u = s.gpu!.uniforms!(params, { ...ctx, frame: 17, duration: 60, seed: 0.1, progress: 0 });
		expect(u).toMatchObject({ u_elapsed: 7, u_holdIndex: { int: 1 } });
		expect(pixelMoshBlockPx({ blockSizeX: 16, blockSizeY: 8 }, 0.5)).toEqual([8, 4]);
	});

	it('S_StripSlide: every strip leaves between Amount 0 and 1, in Order rank, eased by Slow Start', () => {
		for (const rank of [0, 0.3, 1]) {
			expect(stripSlideProgress(0, rank, 10, 1)).toBe(0);
			expect(stripSlideProgress(1, rank, 10, 1)).toBe(1);
		}
		expect(stripSlideProgress(0.2, 0, 10, 0)).toBeGreaterThan(stripSlideProgress(0.2, 1, 10, 0));
		expect(stripSlideProgress(0.1, 0, 10, 1)).toBeLessThan(stripSlideProgress(0.1, 0, 10, 0)); // slow start
		expect(stripSlideProgress(0.5, 0, 1, 0)).toBeCloseTo(stripSlideProgress(0.5, 1, 1, 0)); // Speed 1: together
	});

	it('marks time-invariant only the effects without time, phase animation or video inputs', () => {
		const inv = SAPPHIRE_STYLIZE_OTHER_EFFECTS.filter((s) => !gpuIsTimeDependent(s)).map((s) => s.id);
		expect(inv).toEqual([
			'jasper.s.band-pass',
			'jasper.s.color-fuse',
			'jasper.s.dog-vision',
			'jasper.s.mosaic',
			'jasper.s.pixel-sort',
			'jasper.s.prism-lens',
			'jasper.s.pseudo-color',
			'jasper.s.roman-tile',
			'jasper.s.solarize',
		]);
	});
});
