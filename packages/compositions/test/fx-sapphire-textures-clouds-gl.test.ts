// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = [number, number, number, number];
type Opts = { width?: number; height?: number; frame?: number; clip?: string; input?: string };
type Stats = { mean: number; std: number; alpha: number; rgb: number[]; hash: number };
type P = Record<string, unknown>;

const S = (name: string) => `jasper.s.${name}`;
const SMALL = { width: 96, height: 54 };
const STILL = new Set([
	S('texture-chroma-spiral'),
	S('texture-noise-emboss'),
	S('texture-noise-paint'),
	S('texture-weave'),
]);

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'sapphire-textures-clouds in WebGL2 (headless Chrome)',
	// SwiftShader renders every pixel on the CPU; the first two cases exercise every generator.
	{ timeout: 900_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const api = <T>(fn: string, ...args: unknown[]): Promise<T> =>
			page.evaluate(
				([f, a]) =>
					(window as unknown as { __stc: Record<string, (...x: unknown[]) => unknown> }).__stc[f as string]!(
						...(a as unknown[]),
					),
				[fn, args] as const,
			) as Promise<T>;
		const stats = (id: string, p: P = {}, o: Opts = {}) => api<Stats>('stats', id, p, o);
		const diff = (id: string, a: [P, Opts], b: [P, Opts]) => api<number>('diff', id, a, b);
		const pixel = (id: string, p: P, o: Opts, x: number, y: number) => api<Px>('pixel', id, p, o, x, y);

		let ids: string[] = [];

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-sapphire-textures-clouds-gl', 'entry.ts')));
			ids = await api<string[]>('ids');
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('opaque input stays opaque with default texture settings', async () => {
			for (const id of ids) {
				const s = await stats(id, {}, { ...SMALL, frame: 12 });
				expect(s.alpha, id).toBeGreaterThanOrEqual(254.5);
			}
		});

		it('animated defaults change over time while still textures stay still', async () => {
			for (const id of ids) {
				// 4/3 s is not a multiple of Moire's default half-second ring phase.
				const change = await diff(id, [{}, { ...SMALL, frame: 30 }], [{}, { ...SMALL, frame: 70 }]);
				if (STILL.has(id)) expect(change, id).toBe(0);
				else expect(change, id).toBeGreaterThan(0);
			}
		});

		it('is deterministic; the Seed param and the instance seed change the pattern', async () => {
			for (const id of [S('clouds'), S('texture-cells'), S('texture-noise-paint'), S('texture-neurons')]) {
				const a = await stats(id, {}, { frame: 7 });
				const b = await stats(id, {}, { frame: 7 });
				expect(b.hash).toBe(a.hash);
				const c = await stats(id, { seed: 5.5 }, { frame: 7 });
				expect(c.hash).not.toBe(a.hash);
				const d = await stats(id, {}, { frame: 7, clip: 'clip2' });
				expect(d.hash).not.toBe(a.hash);
			}
		});

		it('combine, background brightness, output opacity and mix with original', async () => {
			const id = S('clouds');
			// Mult with a black background → black.
			const mult = await stats(id, { combine: 'mult' }, { input: '#000000' });
			expect(mult.mean).toBeLessThan(1);
			// Add with Bg Brightness 0 = the texture alone.
			expect(await diff(id, [{ combine: 'add', bgBrightness: 0 }, {}], [{}, {}])).toBeLessThan(0.5);
			// Screen over white → white.
			expect((await stats(id, { combine: 'screen' }, { input: '#ffffff' })).mean).toBeGreaterThan(254);
			// Copy From Input keeps the layer's transparency; All Opaque fills the box.
			expect((await stats(id, {}, { input: 'transparent' })).alpha).toBe(0);
			expect((await stats(id, { outputOpacity: 'allOpaque' }, { input: 'transparent' })).alpha).toBe(255);
			const half = await pixel(id, {}, { input: 'half' }, 150, 45);
			expect(half[3]).toBe(0);
			const orig = await pixel(id, { mixWithOriginal: 1 }, { input: '#ff0000' }, 40, 40);
			expect(orig).toEqual([255, 0, 0, 255]);
			const red = await stats(id, { color0: [1, 0, 0, 1], color1: [1, 0, 0, 1] });
			expect(red.std).toBeLessThan(0.5);
			expect(red.rgb[0]).toBeGreaterThan(254);
		});

		it('tiles: a tile sits on the layer centre; Invert swaps it', async () => {
			const id = S('texture-tiles');
			const o = { width: 160, height: 90, frame: 0 };
			expect((await pixel(id, { morphSpeed: 0 }, o, 80, 45))[0]).toBeGreaterThan(240);
			expect((await pixel(id, { morphSpeed: 0, invert: true }, o, 80, 45))[0]).toBeLessThan(15);
			// Size 0 → all Color0, Size 1.2 → all Color1.
			expect((await stats(id, { size: 0 })).mean).toBeLessThan(3);
			expect((await stats(id, { size: 1.2 })).mean).toBeGreaterThan(252);
		});

		it('spots: without warp, spots on the cell centres and gaps on the corners', async () => {
			const id = S('texture-spots');
			const p = { randWarpAmp: 0 };
			// Frequency 8 per layer height (90 px): cells of 11.25 px; the layer centre is a cell corner.
			expect((await pixel(id, p, {}, 80, 45))[0]).toBeLessThan(15);
			expect((await pixel(id, p, {}, 80 + 5.6, 45 + 5.6))[0]).toBeGreaterThan(240);
		});

		it('moire: the rings are centred on A Center (bright crest at phase 0)', async () => {
			const id = S('texture-moire');
			const p = {
				frequency: 2,
				phaseSpeed: 0,
				moireSpeed: 0,
				bBrightness: 0,
				aBrightness: 2,
				phaseRed: 0,
				phaseGreen: 0,
			};
			const c = await pixel(id, { ...p, aCenter: [0.5, 0.5] }, {}, 80, 45);
			expect(c[0]).toBeGreaterThan(240);
		});

		it('clouds perspective: past the horizon the clouds fade to their mean', async () => {
			const id = S('clouds-perspective');
			const top = await pixel(id, { latitude: -80, shiftSpeed: [0, 0] }, {}, 80, 1);
			expect(Math.abs(top[0] - 128)).toBeLessThan(10);
		});

		it('plasma and neurons: the glow adds light around the lines', async () => {
			for (const id of [S('texture-plasma'), S('texture-neurons')]) {
				const off = await stats(id, { glowBrightness: 0 });
				const on = await stats(id);
				expect(on.mean).toBeGreaterThan(off.mean + 2);
				// The glow colour tints it: a red glow on mono lines → more red than blue.
				const red = await stats(id, { glowColor: [1, 0, 0, 1], color: [0, 0, 0, 1], glowBrightness: 6 });
				expect(red.rgb[0]).toBeGreaterThan(red.rgb[2]! + 2);
			}
		});

		it('noise paint: Jitter Frames re-randomises the strokes only every N frames', async () => {
			const id = S('texture-noise-paint');
			expect(await diff(id, [{ jitterFrames: 4 }, { frame: 4 }], [{ jitterFrames: 4 }, { frame: 7 }])).toBe(
				0,
			);
			expect(
				await diff(id, [{ jitterFrames: 4 }, { frame: 7 }], [{ jitterFrames: 4 }, { frame: 8 }]),
			).toBeGreaterThan(1);
			expect(await diff(id, [{}, { frame: 3 }], [{}, { frame: 40 }])).toBe(0);
		});
	},
);
