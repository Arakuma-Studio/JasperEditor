// Family "sapphire-paint-kaleido-edges" (fx catalogue, wave 2): the Sapphire names, ids and bins, Sapphire's
// parameter names/defaults where they matter, the unit maths of the TS hooks (blur sigmas, stroke cells, padding,
// pass plans) and which effects redraw over time. Pixels are checked in packages/compositions/test/
// fx-sapphire-paint-kaleido-edges-gl.test.ts (real WebGL2).
import { describe, expect, it } from 'vitest';
import {
	defaultEffectRegistry,
	type EffectSpec,
	type FxFrameContext,
	gpuIsTimeDependent,
	gpuPadding,
	planGpuEffect,
	SAPPHIRE_BINS,
	validateGpuEffect,
} from '../src/index.ts';
import { blurPasses, sUnitsPx } from '../src/registry/fx/sapphire-paint-kaleido-edges/common.ts';
import { edgeGain, edgeSmoothSigma } from '../src/registry/fx/sapphire-paint-kaleido-edges/edges.ts';
import { brushSizePx, strokeCellPx } from '../src/registry/fx/sapphire-paint-kaleido-edges/paint.ts';
import { SAPPHIRE_PAINT_KALEIDO_EDGES_EFFECTS as FAMILY } from '../src/registry/fx/sapphire-paint-kaleido-edges.ts';

const EXPECTED: Record<string, string> = {
	S_AutoPaint: 'jasper.s.auto-paint',
	S_Sketch: 'jasper.s.sketch',
	S_Etching: 'jasper.s.etching',
	'S_Brush:Oil': 'jasper.s.brush-oil',
	'S_Brush:Chalk': 'jasper.s.brush-chalk',
	S_Crosshatch: 'jasper.s.crosshatch',
	S_Cartoon: 'jasper.s.cartoon',
	S_CartoonPaint: 'jasper.s.cartoon-paint',
	S_Posterize: 'jasper.s.posterize',
	S_HalfTone: 'jasper.s.half-tone',
	S_HalfToneColor: 'jasper.s.half-tone-color',
	S_HalfToneRings: 'jasper.s.half-tone-rings',
	'S_Kaleido:Triangles': 'jasper.s.kaleido-triangles',
	'S_Kaleido:Squares': 'jasper.s.kaleido-squares',
	'S_Kaleido:Diamonds': 'jasper.s.kaleido-diamonds',
	'S_Kaleido:Oct': 'jasper.s.kaleido-oct',
	S_KaleidoPolar: 'jasper.s.kaleido-polar',
	S_KaleidoRadial: 'jasper.s.kaleido-radial',
	S_FlysEyeCircles: 'jasper.s.flys-eye-circles',
	S_FlysEyeHex: 'jasper.s.flys-eye-hex',
	S_FlysEyeRect: 'jasper.s.flys-eye-rect',
	S_TileScramble: 'jasper.s.tile-scramble',
	S_EdgeDetect: 'jasper.s.edge-detect',
	S_EdgeDetectDouble: 'jasper.s.edge-detect-double',
	S_EdgesInDirection: 'jasper.s.edges-in-direction',
	S_EdgeColorize: 'jasper.s.edge-colorize',
	S_Emboss: 'jasper.s.emboss',
	S_EmbossShiny: 'jasper.s.emboss-shiny',
	S_EmbossDistort: 'jasper.s.emboss-distort',
	S_EmbossGlass: 'jasper.s.emboss-glass',
};

const byLabel = (label: string): EffectSpec => FAMILY.find((s) => s.label === label)!;
const defaults = (s: EffectSpec, over: Record<string, unknown> = {}) =>
	({ ...Object.fromEntries(s.params.map((p) => [p.name, p.default])), ...over }) as never;
const paramDefault = (label: string, name: string) =>
	byLabel(label).params.find((p) => p.name === name)?.default;
const CTX: FxFrameContext = {
	width: 1920,
	height: 1080,
	pxScale: 1,
	fps: 30,
	frame: 0,
	duration: 150,
	seed: 0.5,
	progress: 0,
};

describe('sapphire-paint-kaleido-edges family', () => {
	it('has every Sapphire effect of the family, with its label, id and the Sapphire Stylize bin', () => {
		expect(Object.fromEntries(FAMILY.map((s) => [s.label, s.id]))).toEqual(EXPECTED);
		for (const s of FAMILY) {
			expect(s.bin).toBe(SAPPHIRE_BINS.stylize);
			expect(s.gpu).toBeDefined();
			expect(defaultEffectRegistry.get(s.id)).toBe(s);
			expect(validateGpuEffect(s)).toEqual([]);
			expect(s.params.at(-1)?.name).toBe('mixWithOriginal');
		}
	});

	it('keeps Sapphire parameter names and defaults', () => {
		expect(byLabel('S_HalfTone').params.map((p) => p.label)).toEqual([
			'Dots',
			'Dots Frequency',
			'Dots Angle',
			'Dots Rel Width',
			'Dots Sharpness',
			'Dots Lighten',
			'Smooth Source',
			'Color1',
			'Color0',
			'Dots Shift',
			'Mix with Orig',
		]);
		expect(paramDefault('S_HalfToneColor', 'shiftRed')).toEqual([0, 0.5]);
		expect(paramDefault('S_EdgeDetect', 'edgeSmooth')).toBe(0.0224);
		expect(paramDefault('S_EdgeDetectDouble', 'brightness2')).toBe(1.5);
		expect(paramDefault('S_EdgesInDirection', 'direction')).toEqual([0.389, 0.361]);
		expect(paramDefault('S_EdgeColorize', 'top')).toEqual([1, 0.85, 0.5, 1]);
		expect(paramDefault('S_Emboss', 'lightDir')).toEqual([-0.5, 0.361]);
		expect(paramDefault('S_EmbossGlass', 'steps')).toBe(5);
		expect(paramDefault('S_Kaleido:Triangles', 'zDist')).toBe(2);
		expect(paramDefault('S_KaleidoRadial', 'rotateInsideSpeed')).toBe(30);
		expect(paramDefault('S_FlysEyeHex', 'tileFrequency')).toBe(12);
		expect(paramDefault('S_TileScramble', 'wrap')).toBe('none');
		expect(paramDefault('S_Crosshatch', 'strokeFrequency')).toBe(100);
		expect(paramDefault('S_Brush:Oil', 'layers')).toBe(3);
		expect(byLabel('S_Brush:Oil').params.map((p) => p.name)).toContain('deterioration');
		expect(byLabel('S_Brush:Chalk').params.map((p) => p.name)).toContain('chalkiness');
		expect(byLabel('S_AutoPaint').params.find((p) => p.name === 'style')?.optionLabels).toEqual([
			'Van Gogh',
			'Hairy Paint',
			'Pointalize',
		]);
		// Centres are on-canvas points.
		for (const l of ['S_Kaleido:Squares', 'S_KaleidoPolar', 'S_KaleidoRadial'])
			expect(byLabel(l).params.find((p) => p.name === 'center')?.ui?.control).toBe('point');
	});

	it('has a Seed exactly where Sapphire does (fed into u_seed)', () => {
		const seeded = FAMILY.filter((s) => s.params.some((p) => p.name === 'seed')).map((s) => s.label);
		expect(seeded.sort()).toEqual(
			[
				'S_AutoPaint',
				'S_Sketch',
				'S_Brush:Oil',
				'S_Brush:Chalk',
				'S_Crosshatch',
				'S_CartoonPaint',
				'S_TileScramble',
			].sort(),
		);
	});

	it('maps Sapphire units to the layer size', () => {
		expect(sUnitsPx(1, { width: 1920, pxScale: 1 })).toBeCloseTo(19.2);
		expect(sUnitsPx(0.0224, { width: 1920, pxScale: 0.5 })).toBeCloseTo(0.215, 3);
		expect(sUnitsPx(-1, { width: 1920, pxScale: 1 })).toBe(0);
		expect(strokeCellPx(50, { width: 1920, pxScale: 1 })).toBeCloseTo(38.4);
		expect(strokeCellPx(0, { width: 1920, pxScale: 1 })).toBeCloseTo(19200);
		expect(brushSizePx({ maxSize: 1.5 } as never, 1920)).toBeCloseTo(57.6);
		expect(edgeSmoothSigma({ edgeSmooth: 0.1, subpixelSmooth: false } as never, 'edgeSmooth', CTX)).toBe(2);
		expect(edgeSmoothSigma({ edgeSmooth: 0.1 } as never, 'edgeSmooth', CTX)).toBeCloseTo(1.92);
		expect(edgeGain(0)).toBe(2);
		expect(edgeGain(4)).toBeGreaterThan(edgeGain(1));
	});

	it('blurs big radii at a reduced resolution', () => {
		expect(blurPasses('source', 'b', 2).map((p) => p.scale)).toEqual([1, 1]);
		expect(blurPasses('source', 'b', 12).map((p) => p.scale)).toEqual([0.5, 0.5]);
		expect(blurPasses('source', 'b', 40).map((p) => p.scale)).toEqual([0.25, 0.25]);
		expect(blurPasses('source', 'b', 40)[1]!.output).toBe('b');
	});

	it('plans every effect within the texture budget at 1080p and at a tiny size', () => {
		for (const s of FAMILY) {
			for (const size of [
				{ width: 1920, height: 1080 },
				{ width: 8, height: 4 },
			]) {
				const plan = planGpuEffect(
					s,
					{ id: 'fx', params: defaults(s) },
					{ ...CTX, ...size },
					{ width: size.width, height: size.height },
				);
				expect(plan.passes.length).toBeGreaterThan(0);
				expect(plan.passes.at(-1)!.output).toBeNull();
			}
		}
		const cp = planGpuEffect(
			byLabel('S_CartoonPaint'),
			{ id: 'fx', params: defaults(byLabel('S_CartoonPaint')) },
			CTX,
			{ width: 1920, height: 1080 },
		);
		expect(cp.passes.filter((p) => p.output).length).toBeLessThanOrEqual(12);
	});

	it('Brush: Soft Borders pads by the brush reach; otherwise the effect stays in the layer box', () => {
		const oil = byLabel('S_Brush:Oil');
		const ctx = { width: 1000, height: 500, pxScale: 1, fps: 30 };
		expect(gpuPadding(oil, defaults(oil), ctx)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
		const pad = gpuPadding(oil, defaults(oil, { softBorders: true, maxSize: 2 }), ctx);
		expect(pad.left).toBeCloseTo(30);
		expect(pad.bottom).toBeCloseTo(30);
	});

	it('S_EmbossGlass clamps Steps to the shader loop', () => {
		const glass = byLabel('S_EmbossGlass');
		expect(glass.gpu!.uniforms!(defaults(glass, { steps: 100 }), CTX)).toEqual({ u_stepCount: { int: 32 } });
		expect(glass.gpu!.uniforms!(defaults(glass, { steps: 1 }), CTX)).toEqual({ u_stepCount: { int: 3 } });
	});

	it('only the animated or frame-seeded effects redraw every frame', () => {
		const dynamic = FAMILY.filter((s) => gpuIsTimeDependent(s)).map((s) => s.label);
		expect(dynamic.sort()).toEqual(
			[
				// Jitter Frames / Animate Speed / Rotate Inside Speed:
				'S_AutoPaint',
				'S_Sketch',
				'S_CartoonPaint',
				'S_Crosshatch',
				'S_KaleidoRadial',
				// A video Bumps input changes over time:
				'S_Emboss',
				'S_EmbossShiny',
				'S_EmbossDistort',
				'S_EmbossGlass',
			].sort(),
		);
	});

	it('marks the heavy effects expensive', () => {
		const heavy = FAMILY.filter((s) => s.expensive).map((s) => s.label);
		for (const l of [
			'S_AutoPaint',
			'S_Sketch',
			'S_Brush:Oil',
			'S_Brush:Chalk',
			'S_CartoonPaint',
			'S_EmbossGlass',
		])
			expect(heavy).toContain(l);
	});
});
