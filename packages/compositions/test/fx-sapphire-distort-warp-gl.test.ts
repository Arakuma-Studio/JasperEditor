// @vitest-environment node
// Sapphire Distort family in a real WebGL2 (headless Chrome, SwiftShader when there is no GPU): the effects run
// through the GPU host (src/fx/host.ts) on a procedural picture (colour quadrants, a black grid, a white disc in the
// centre — see fx-sapphire-distort-warp/entry.ts) and the pixels are checked: identity settings, one characteristic
// pixel per effect, padding, transparent input, determinism and seeds, time. FX_GL=0 skips it.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunArgs } from './fx-sapphire-distort-warp/entry.ts';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = [number, number, number, number];
type Out = { probes: Px[]; checksum: number; canvas: number[]; box: number[] };
const near = (a: Px, b: Px, tol = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const W = 160;
const H = 90;
// Probe points of the 160×90 test picture (layer px): quadrants red/green/blue/yellow, the white disc (r = 11.25).
const P = {
	centre: [80, 45],
	red: [25, 15],
	green: [135, 15],
	blue: [25, 75],
	yellow: [135, 75],
	nearDisc: [84, 57], // just outside the disc (r ≈ 12.6), between grid lines (every 10 px)
	corner: [3, 3],
} as const satisfies Record<string, [number, number]>;
const RED: Px = [221, 51, 51, 255];
const WHITE: Px = [255, 255, 255, 255];

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire Distort effects in WebGL2 (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const run = (a: Partial<RunArgs> & { id: string }): Promise<Out> =>
			page.evaluate(
				(args) =>
					(window as unknown as { __dw: { run(a: unknown): unknown } }).__dw.run(args) as Promise<Out>,
				{ width: W, height: H, ...a },
			) as Promise<Out>;
		const probe = (id: string, params: Record<string, unknown> = {}, extra: Partial<RunArgs> = {}) =>
			run({ id, params, probes: Object.values(P) as [number, number][], ...extra });
		const at = (o: Out, k: keyof typeof P) => o.probes[Object.keys(P).indexOf(k)]!;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'fx-sapphire-distort-warp', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('runs all 24 effects with their defaults; transparent input stays transparent', async () => {
			const ids = await page.evaluate(() => (window as unknown as { __dw: { ids(): string[] } }).__dw.ids());
			expect(ids).toHaveLength(24);
			for (const id of ids) {
				const o = await probe(id, {}, { paint: 'none', frame: 5 });
				for (const px of o.probes) expect(px, id).toEqual([0, 0, 0, 0]);
			}
		});

		it('identity settings give the source back', async () => {
			const src = await probe('jasper.s.warp-transform');
			expect(near(at(src, 'red'), RED)).toBe(true);
			expect(near(at(src, 'centre'), WHITE)).toBe(true);
			const identities: [string, Record<string, unknown>][] = [
				['jasper.s.warp-fish-eye', { amount: 0 }],
				['jasper.s.warp-magnify', { magnifyAmount: 1 }],
				['jasper.s.warp-waves', { amplitude: 0 }],
				['jasper.s.warp-waves2', { aAmplitude: 0, bAmplitude: 0 }],
				['jasper.s.warp-puddle', { amplitude: 0 }],
				['jasper.s.warp-bubble', { amplitude: 0 }],
				['jasper.s.warp-vortex', { vortexStart: 0 }],
				['jasper.s.distort', { amount: 0 }],
				['jasper.s.distort-rgb', { amount: 0 }],
				['jasper.s.distort-chroma', { amount: 0 }],
				['jasper.s.warp-puff', { amount: 0 }],
				['jasper.s.shake', { amplitude: 0 }],
				['jasper.s.stretch-frame-edges', { centerSqueeze: 1, smooth: 0 }],
				['jasper.s.warp-repeat', { warpAmount: 0 }],
				['jasper.s.warp-chroma', { warpAmount: 0 }],
				['jasper.s.warp-perspective', { latitude: 0, zDist: 1 }],
				['jasper.s.parallax-strips', { mode: 'manual', manualAmount: 0 }],
			];
			for (const [id, params] of identities) {
				const o = await probe(id, params, { frame: 7 });
				for (const k of Object.keys(P) as (keyof typeof P)[])
					expect(near(at(o, k), at(src, k), 10), `${id} ${k}: ${at(o, k)} vs ${at(src, k)}`).toBe(true);
			}
		});

		it('magnifiers enlarge the centre disc; a pinch shrinks it', async () => {
			for (const id of ['jasper.s.warp-magnify', 'jasper.s.warp-fish-eye'])
				expect(near(at(await probe(id), 'nearDisc'), WHITE), id).toBe(true);
			const pinch = await probe('jasper.s.warp-fish-eye', { amount: -1 });
			expect(near(at(pinch, 'centre'), WHITE)).toBe(true);
			// The disc edge moved inwards: 9 px above the centre is no longer white.
			const o = await run({ id: 'jasper.s.warp-fish-eye', params: { amount: -1.5 }, probes: [[80, 36]] });
			expect(o.probes[0]![0] + o.probes[0]![1] + o.probes[0]![2]).toBeLessThan(700);
		});

		it('S_WarpTransform moves the picture and pads the layer to keep it', async () => {
			const o = await run({
				id: 'jasper.s.warp-transform',
				params: { shift: [0.5, 0] },
				probes: [
					[25 + 80, 15],
					[165, 15],
					[25, 15],
				],
			});
			expect(o.canvas).toEqual([W + 82, H]); // 0.5 × 160 + 2 px slack on the right
			expect(near(o.probes[0]!, RED)).toBe(true); // red quadrant moved right by half a width
			expect(o.probes[1]![3]).toBeGreaterThan(200); // drawn outside the box (padding)
			expect(o.probes[2]![3]).toBe(0); // vacated area: Wrap No → transparent
			const tiled = await run({
				id: 'jasper.s.warp-transform',
				params: { shift: [0.5, 0], wrapX: 'tile' },
				probes: [[25, 15]],
			});
			expect(tiled.probes[0]![3]).toBe(255);
		});

		it('S_WarpCornerPin: inside the quad the picture, outside transparent', async () => {
			const o = await run({
				id: 'jasper.s.warp-corner-pin',
				params: {
					topLeft: [0.25, 0.25],
					topRight: [0.75, 0.25],
					bottomLeft: [0.25, 0.75],
					bottomRight: [0.75, 0.75],
				},
				probes: [
					[80, 45],
					[10, 10],
					[52.5, 30], // ← source (25, 15)
				],
			});
			expect(near(o.probes[0]!, WHITE)).toBe(true);
			expect(o.probes[1]![3]).toBe(0);
			expect(near(o.probes[2]!, RED)).toBe(true); // the red quadrant scaled into the top-left of the quad
		});

		it('S_WarpPolar draws a disk: transparent outside the outer radius, the picture inside', async () => {
			const o = await run({
				id: 'jasper.s.warp-polar',
				probes: [
					[3, 3],
					[80, 30],
				],
			});
			expect(o.probes[0]![3]).toBe(0);
			expect(o.probes[1]![3]).toBe(255);
		});

		it('S_Shake: deterministic per seed, different seeds differ, moves over time, pads small layers', async () => {
			const a = await run({ id: 'jasper.s.shake', frame: 12, seed: 0.3 });
			const b = await run({ id: 'jasper.s.shake', frame: 12, seed: 0.3 });
			const c = await run({ id: 'jasper.s.shake', frame: 12, seed: 0.6 });
			const d = await run({ id: 'jasper.s.shake', frame: 13, seed: 0.3 });
			expect(a.checksum).toBe(b.checksum);
			expect(c.checksum).not.toBe(a.checksum);
			expect(d.checksum).not.toBe(a.checksum);
			expect(a.canvas[0]).toBeGreaterThan(W);
			const mb = await run({
				id: 'jasper.s.shake',
				frame: 12,
				seed: 0.3,
				params: { motionBlur: true, amplitude: 3 },
			});
			expect(mb.checksum).not.toBe(a.checksum);
		});

		it('random and animated warps: seeds and time change the picture deterministically', async () => {
			// u_seed (clip + instance + the Seed param, mixed by the framework's fxSeed) drives the pattern.
			for (const id of ['jasper.s.warp-bubble', 'jasper.s.parallax-strips', 'jasper.s.warp-bubble2']) {
				const a = await run({ id, frame: 3, seed: 0.2 });
				const b = await run({ id, frame: 3, seed: 0.2 });
				const c = await run({ id, frame: 3, seed: 0.7 });
				expect(a.checksum, id).toBe(b.checksum);
				expect(c.checksum, id).not.toBe(a.checksum);
			}
			// S_WarpBubble2's per-pattern seeds are params of their own.
			const a2 = await run({ id: 'jasper.s.warp-bubble2', frame: 3 });
			const b2 = await run({ id: 'jasper.s.warp-bubble2', frame: 3, params: { aSeed: 4 } });
			expect(b2.checksum).not.toBe(a2.checksum);
			for (const id of ['jasper.s.warp-puddle', 'jasper.s.warp-bubble', 'jasper.s.warp-waves2']) {
				const a = await run({ id, frame: 0 });
				const b = await run({ id, frame: 15 });
				expect(b.checksum, id).not.toBe(a.checksum);
			}
		});

		it('S_WarpDrops ripples around the bright spots of the Centers map only', async () => {
			const plain = await probe('jasper.s.warp-transform');
			// Centers: white dots at (40, 27), (80, 54), (120, 31.5).
			const pts: [number, number][] = [
				[40, 22],
				[44, 27],
				[5, 85],
				[155, 85],
			];
			const src = await run({ id: 'jasper.s.warp-transform', probes: pts });
			const o = await run({
				id: 'jasper.s.warp-drops',
				params: { amplitude: 6 },
				media: { centers: 'dots' },
				probes: pts,
				paint: 'grid',
			});
			expect(plain.probes.length).toBeGreaterThan(0);
			const moved = (i: number) => !near(o.probes[i]!, src.probes[i]!, 10);
			// Far corners are untouched; around the first dot something moved (one of two probes at least).
			expect(moved(2)).toBe(false);
			expect(moved(3)).toBe(false);
			const big = await run({
				id: 'jasper.s.warp-drops',
				params: { amplitude: 6 },
				media: { centers: 'dots' },
				paint: 'grid',
			});
			const none = await run({
				id: 'jasper.s.warp-drops',
				params: { amplitude: 0 },
				media: { centers: 'dots' },
			});
			expect(big.checksum).not.toBe(none.checksum);
		});

		it('S_Distort follows the Lens: a flat lens changes nothing, the dots lens warps', async () => {
			const src = await run({ id: 'jasper.s.warp-transform' });
			const flat = await run({ id: 'jasper.s.distort', media: { lens: 'solid' } });
			expect(flat.checksum).toBe(src.checksum);
			const dots = await run({ id: 'jasper.s.distort', media: { lens: 'dots' } });
			expect(dots.checksum).not.toBe(src.checksum);
		});

		it('S_DistortRGB separates the channels at lens edges', async () => {
			const o = await run({
				id: 'jasper.s.distort-rgb',
				params: { amount: 8, warpRed: -1, warpGreen: 0, warpBlue: 1 },
				probes: [
					[80, 34],
					[80, 56],
					[91, 45],
					[69, 45],
				],
			});
			// At the white disc's edge the channels come from different places: some probe is not grey.
			const chromatic = o.probes.some(
				([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 40 && Math.max(r, g, b) > 150,
			);
			expect(chromatic).toBe(true);
		});
	},
);
