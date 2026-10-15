// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EffectParams } from '@jasper/project';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOptions } from './fx-sapphire-paint-kaleido-edges/entry.ts';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'sapphire-paint-kaleido-edges in WebGL2 (headless Chrome)',
	{ timeout: 240_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const probe = (id: string, p: EffectParams, o: RunOptions, pts: [number, number][]) =>
			page.evaluate(([id, p, o, pts]) => window.__pke.probe(id, p, o, pts), [id, p, o, pts] as const);
		const diff = (id: string, p: EffectParams, o: RunOptions = {}) =>
			page.evaluate(([id, p, o]) => window.__pke.diffFromInput(id, p, o), [id, p, o] as const);
		const sig = (id: string, p: EffectParams, o: RunOptions = {}) =>
			page.evaluate(([id, p, o]) => window.__pke.signature(id, p, o), [id, p, o] as const);

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-sapphire-paint-kaleido-edges', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('Mix with Orig = 1 gives the input back', async () => {
			for (const id of FAMILY_IDS) {
				expect(await diff(id, { mixWithOriginal: 1 }, { pattern: 'checker' }), id).toBeLessThan(1);
			}
		});

		it('kaleidoscopes and tiles are the identity at Kaleido Amount 0 / unit zoom', async () => {
			const o: RunOptions = { pattern: 'shapes' };
			for (const id of ['triangles', 'squares', 'diamonds', 'oct', 'polar', 'radial'])
				expect(await diff(`jasper.s.kaleido-${id}`, { kaleidoAmount: 0, filter: false }, o), id).toBeLessThan(
					1,
				);
			const unit = { insideZdist: 1, overallZdist: 1, insideRotate: 0, filter: false };
			expect(await diff('jasper.s.flys-eye-rect', unit, o)).toBeLessThan(1);
			expect(await diff('jasper.s.flys-eye-hex', unit, o)).toBeLessThan(1);
			expect(await diff('jasper.s.tile-scramble', { scrambleSpeed: 0 }, o)).toBeLessThan(1);
			expect(await diff('jasper.s.tile-scramble', {}, o)).toBeGreaterThan(2);
		});

		it('S_Kaleido:Squares mirrors the picture around the centre', async () => {
			// zDist 1: the mirror cell is one layer height; a point and its mirror image across the cell edge match.
			const r = await probe(
				'jasper.s.kaleido-squares',
				{ zDist: 1, filter: false },
				{ pattern: 'shapes', width: 96, height: 48 },
				[
					[48 + 20, 24],
					[48 + 28, 24],
				],
			);
			// Cell edges at ±24 px from the centre (half the height): x = 68 and x = 76 mirror around 72.
			for (let k = 0; k < 3; k++) expect(Math.abs(r.pixels[0]![k]! - r.pixels[1]![k]!)).toBeLessThan(8);
		});

		it('edges: a black|white step lights up only at the edge; direction and colour follow the edge side', async () => {
			const o: RunOptions = { pattern: 'split', width: 64, height: 32 };
			const pts: [number, number][] = [
				[32, 16],
				[8, 16],
				[56, 16],
			];
			const e = await probe('jasper.s.edge-detect', {}, o, pts);
			expect(e.pixels[0]![0]).toBeGreaterThan(200);
			expect(e.pixels[1]![0]).toBeLessThan(10);
			expect(e.pixels[2]![0]).toBeLessThan(10);
			// Brightness rises to the right: a rightward Direction sees it, a leftward one does not (unless bidirectional).
			const right = await probe('jasper.s.edges-in-direction', { direction: [1, 0] }, o, pts);
			const left = await probe('jasper.s.edges-in-direction', { direction: [-1, 0] }, o, pts);
			const both = await probe(
				'jasper.s.edges-in-direction',
				{ direction: [-1, 0], bidirectional: true },
				o,
				pts,
			);
			expect(right.pixels[0]![0]).toBeGreaterThan(200);
			expect(left.pixels[0]![0]).toBeLessThan(10);
			expect(both.pixels[0]![0]).toBeGreaterThan(200);
			// The edge faces left (from the bright side towards the dark one): the Left colour (red-ish).
			const c = await probe(
				'jasper.s.edge-colorize',
				{ left: [1, 0, 0, 1], right: [0, 0, 1, 1], top: [0, 1, 0, 1], bottom: [1, 1, 0, 1] },
				o,
				pts,
			);
			expect(c.pixels[0]![0]).toBeGreaterThan(150);
			expect(c.pixels[0]![2]).toBeLessThan(60);
			expect(c.pixels[1]!.slice(0, 3)).toEqual([0, 0, 0]);
			const d = await probe('jasper.s.edge-detect-double', {}, o, pts);
			expect(d.pixels[1]![0]).toBeLessThan(10);
		});

		it('halftones: black where the picture is black, paper where it is white', async () => {
			const o: RunOptions = { pattern: 'split', width: 64, height: 32 };
			const pts: [number, number][] = [
				[6, 10],
				[58, 10],
			];
			const ht = await probe('jasper.s.half-tone', {}, o, pts);
			expect(ht.pixels[0]!.slice(0, 3)).toEqual([0, 0, 0]);
			expect(ht.pixels[1]!.slice(0, 3)).toEqual([255, 255, 255]);
			const white = await probe('jasper.s.half-tone', { dots: 'white' }, o, pts);
			expect(white.pixels[0]![0]).toBeLessThan(5);
			expect(white.pixels[1]![0]).toBeGreaterThan(250);
			const col = await probe('jasper.s.half-tone-color', {}, o, pts);
			expect(col.pixels[0]![0]).toBeLessThan(5);
			expect(col.pixels[1]!.slice(0, 3)).toEqual([255, 255, 255]);
			const rings = await probe('jasper.s.half-tone-rings', {}, o, pts);
			expect(rings.pixels[1]!.slice(0, 3)).toEqual([255, 255, 255]);
		});

		it('posterize quantises a ramp into a few levels', async () => {
			const xs = Array.from({ length: 32 }, (_, i): [number, number] => [i * 2 + 0.5, 4]);
			const r = await probe(
				'jasper.s.posterize',
				{ amount: 0.25, smoothEdges: 0, smoothSource: 0 },
				{ pattern: 'ramp', width: 64, height: 8 },
				xs,
			);
			const levels = new Set(r.pixels.map((p) => Math.round(p[0] / 16)));
			expect(levels.size).toBeLessThanOrEqual(5);
			expect(levels.size).toBeGreaterThanOrEqual(4);
		});

		it('emboss keeps a flat picture and shades a relief from the light side', async () => {
			const flat = await probe('jasper.s.emboss', {}, { pattern: 'flat', width: 32, height: 32 }, [[16, 16]]);
			expect(Math.abs(flat.pixels[0]![0] - 128)).toBeLessThan(4);
			// A bright square: its upper-left rim faces the default light (brighter), the lower-right rim is shadowed.
			const sq = await probe(
				'jasper.s.emboss',
				{ bumpsSmooth: 0.5 },
				{ pattern: 'alphaSquare', width: 64, height: 64 },
				[
					[16, 32],
					[47, 32],
				],
			);
			expect(sq.pixels[0]![0]).toBeGreaterThan(sq.pixels[1]![0]);
		});

		it('transparent input stays transparent', async () => {
			const o: RunOptions = { pattern: 'alphaSquare', width: 64, height: 48 };
			for (const id of [
				'jasper.s.half-tone',
				'jasper.s.posterize',
				'jasper.s.cartoon',
				'jasper.s.emboss',
				'jasper.s.etching',
				'jasper.s.auto-paint',
				'jasper.s.brush-oil',
			]) {
				const r = await probe(id, {}, o, [[2, 2]]);
				expect(r.pixels[0]![3], id).toBe(0);
			}
		});

		it('seeded strokes: deterministic, different per seed, stable over time unless jittered', async () => {
			const o: RunOptions = { pattern: 'shapes', width: 96, height: 64 };
			for (const id of [
				'jasper.s.auto-paint',
				'jasper.s.sketch',
				'jasper.s.brush-oil',
				'jasper.s.tile-scramble',
			]) {
				const a = await sig(id, {}, o);
				expect(await sig(id, {}, o), id).toBe(a);
				expect(await sig(id, { seed: 7 }, o), id).not.toBe(a);
				expect(await sig(id, {}, { ...o, clipId: 'other' }), id).not.toBe(a);
			}
			const still = await sig('jasper.s.auto-paint', {}, { ...o, frame: 0 });
			expect(await sig('jasper.s.auto-paint', {}, { ...o, frame: 10 })).toBe(still);
			expect(await sig('jasper.s.auto-paint', { jitterFrames: 1 }, { ...o, frame: 10 })).not.toBe(
				await sig('jasper.s.auto-paint', { jitterFrames: 1 }, { ...o, frame: 11 }),
			);
			// Animated: S_KaleidoRadial turns the picture inside (Rotate Inside Speed), S_Crosshatch wobbles.
			expect(await sig('jasper.s.kaleido-radial', {}, { ...o, frame: 0 })).not.toBe(
				await sig('jasper.s.kaleido-radial', {}, { ...o, frame: 15 }),
			);
			expect(await sig('jasper.s.kaleido-radial', { rotateInsideSpeed: 0 }, { ...o, frame: 0 })).toBe(
				await sig('jasper.s.kaleido-radial', { rotateInsideSpeed: 0 }, { ...o, frame: 15 }),
			);
		});
	},
);

const FAMILY_IDS = [
	'jasper.s.auto-paint',
	'jasper.s.sketch',
	'jasper.s.etching',
	'jasper.s.brush-oil',
	'jasper.s.brush-chalk',
	'jasper.s.crosshatch',
	'jasper.s.cartoon',
	'jasper.s.cartoon-paint',
	'jasper.s.posterize',
	'jasper.s.half-tone',
	'jasper.s.half-tone-color',
	'jasper.s.half-tone-rings',
	'jasper.s.kaleido-triangles',
	'jasper.s.kaleido-squares',
	'jasper.s.kaleido-diamonds',
	'jasper.s.kaleido-oct',
	'jasper.s.kaleido-polar',
	'jasper.s.kaleido-radial',
	'jasper.s.flys-eye-circles',
	'jasper.s.flys-eye-hex',
	'jasper.s.flys-eye-rect',
	'jasper.s.tile-scramble',
	'jasper.s.edge-detect',
	'jasper.s.edge-detect-double',
	'jasper.s.edges-in-direction',
	'jasper.s.edge-colorize',
	'jasper.s.emboss',
	'jasper.s.emboss-shiny',
	'jasper.s.emboss-distort',
	'jasper.s.emboss-glass',
];
