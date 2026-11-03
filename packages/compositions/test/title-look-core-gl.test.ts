// @vitest-environment node
// The look's core in real WebGL2 (spec 19 §5, TL-031, TL-093): the shape field on soft alpha, per-letter finishes through
// the runs, and lights that stay on screen when the title turns. The picture tests every type gets are in
// title-look-gl.test.ts; this file holds what the planner and the field must do around them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LookRecipe, Paint, SpanBox, SpanGlyph } from '@jasper/project';
import { encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	CHROME,
	type LookImage,
	type LookPage,
	type LookRequest,
	layerCrop,
	lumaOver,
	openLookPage,
	over,
	resampleLuma,
	ssim,
} from './title-look-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** TL_CORE_PICTURES=<dir>: the pictures these tests measure, over grey, to look at. */
function keep(name: string, img: LookImage): void {
	const dir = process.env.TL_CORE_PICTURES;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.png`),
		encodePng({ width: img.width, height: img.height, data: over(img, 96) }),
	);
}

const flat = (r: number, g: number, b: number, a = 1): Paint => ({ kind: 'color', color: [r, g, b, a] });

/** Alpha at canvas px (x, y), bilinear, 0..1. */
function alphaAt(img: LookImage, x: number, y: number): number {
	const x0 = Math.floor(x - 0.5);
	const y0 = Math.floor(y - 0.5);
	const fx = x - 0.5 - x0;
	const fy = y - 0.5 - y0;
	const at = (i: number, j: number) => {
		const xi = Math.min(img.width - 1, Math.max(0, i));
		const yj = Math.min(img.height - 1, Math.max(0, j));
		return img.data[(yj * img.width + xi) * 4 + 3]! / 255;
	};
	return (
		(at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
		(at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
	);
}

/** Along `rays` rays from (cx, cy): the alpha-weighted mean radius of what is drawn, and how much is drawn, per ray. */
function radialProfile(img: LookImage, cx: number, cy: number, rMax: number, rays = 180) {
	const out: { radius: number; mass: number; beyond: (r: number) => number }[] = [];
	for (let k = 0; k < rays; k++) {
		const t = (2 * Math.PI * k) / rays;
		const samples: [number, number][] = [];
		for (let r = 0; r <= rMax; r += 0.25)
			samples.push([r, alphaAt(img, cx + Math.cos(t) * r, cy + Math.sin(t) * r)]);
		const mass = samples.reduce((s, [, a]) => s + a, 0) * 0.25;
		const radius = samples.reduce((s, [r, a]) => s + r * a, 0) * (0.25 / Math.max(mass, 1e-9));
		out.push({
			radius,
			mass,
			beyond: (from) => samples.filter(([r]) => r >= from).reduce((s, [, a]) => s + a, 0) * 0.25,
		});
	}
	return out;
}

const stats = (v: number[]) => {
	const mean = v.reduce((s, x) => s + x, 0) / v.length;
	return { mean, sd: Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) };
};

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('Title Look core', { timeout: 240_000 }, () => {
	let tl: LookPage;

	beforeAll(async () => {
		tl = await openLookPage(here);
	}, 120_000);

	afterAll(async () => {
		await tl?.browser.close();
	}, 120_000);

	describe('the shape field on soft alpha (TL-031)', () => {
		// A glow's picture as an effect after it sees it: an opaque core, then a long 8-bit tail. Box 320 × 160.
		const BOX = { width: 320, height: 160 };
		const SOFT = { kind: 'soft', x: 0.5, y: 0.5, r: 0.12, soft: 0.14 } as const;
		// exp(−(d / soft)²) = ½ at d = soft·√ln 2: the edge of the soft part, layer px from the centre.
		const EDGE = BOX.height * (SOFT.r + SOFT.soft * Math.sqrt(Math.LN2));
		const rim: LookRecipe = { layers: [{ type: 'rim', params: { width: 3, paint: flat(1, 0.2, 0.1) } }] };
		const render = (over: Partial<LookRequest> = {}) =>
			tl.render({ recipe: rim, input: SOFT, box: BOX, unitPx: 100, ...over });

		it('a rim around soft alpha is one smooth ring at half opacity, not a ragged line in the tail', async () => {
			const img = await render();
			const cx = img.box.x + BOX.width / 2;
			const cy = img.box.y + BOX.height / 2;
			const rays = radialProfile(img, cx, cy, Math.min(img.width, img.height) / 2 - 1);
			keep('soft-rim', img);
			// Every ray crosses the whole rim: 3 px, and the pixel it reaches under the shape.
			for (const r of rays) expect(r.mass).toBeGreaterThan(3.4);
			for (const r of rays) expect(r.mass).toBeLessThan(4.6);
			const { mean, sd } = stats(rays.map((r) => r.radius));
			// Round: the ring's radius varies by a fraction of a pixel around it.
			expect(sd).toBeLessThan(0.35);
			// Where the soft part is half opaque: the band runs from 1 px inside it to 3 px out.
			expect(Math.abs(mean - (EDGE + 1))).toBeLessThan(1.5);
			// Nothing further out: the tail has no edge of its own.
			for (const r of rays) expect(r.beyond(mean + 4)).toBeLessThan(0.05);
		});

		it('is the same ring at twice the resolution (TL-034)', async () => {
			const a = await render();
			const b = await render({ box: { width: 640, height: 320 }, unitPx: 200 });
			const ca = layerCrop(a, lumaOver(a, 128));
			const cb = layerCrop(b, lumaOver(b, 128));
			expect(ssim(resampleLuma(cb.data, cb.w, cb.h, ca.w, ca.h), ca.data, ca.w, ca.h)).toBeGreaterThan(0.97);
		});
	});
	describe('per-letter finishes through the runs (TL-093)', () => {
		const BOX = { width: 420, height: 180 };
		// Three letters: A and C keep the look's finish, B's run gives it another.
		const A = { x: 0.1, y: 0.15, w: 0.18, h: 0.6 };
		const B = { x: 0.4, y: 0.15, w: 0.18, h: 0.6 };
		const C = { x: 0.7, y: 0.15, w: 0.18, h: 0.6 };
		type Box = typeof A;
		const boxOf = (r: Box): SpanBox => [
			r.x * BOX.width,
			r.y * BOX.height,
			(r.x + r.w) * BOX.width,
			(r.y + r.h) * BOX.height,
		];
		const glyphs = (finishB?: string, dy = 0): SpanGlyph[] => [
			{ box: boxOf(A), line: 0 },
			{
				box: boxOf(B),
				line: 0,
				...(dy ? { toDrawn: [1, 0, 0, 0, 1, dy, 0, 0, 1] } : {}),
				...(finishB ? { finish: finishB } : {}),
			},
			{ box: boxOf(C), line: 0 },
		];
		const look = (finish: string): LookRecipe => ({
			layers: [
				{ type: 'rim', params: { width: 4, paint: flat(0.1, 0.1, 0.4) } },
				{ type: 'face', params: { finish, paint: flat(0.9, 0.7, 0.2) } },
			],
		});
		const render = (finish: string, g: SpanGlyph[], dy = 0) =>
			tl.render({
				recipe: look(finish),
				input: { kind: 'bars', bars: [A, { ...B, y: B.y + dy / BOX.height }, C] },
				box: BOX,
				unitPx: 100,
				glyphs: g,
			});
		/** Mean absolute difference of RGBA over a letter's box grown by `m` px, 0..255. */
		const diffIn = (a: LookImage, b: LookImage, r: Box, m = 6) => {
			let sum = 0;
			let n = 0;
			const x0 = Math.floor(a.box.x + r.x * BOX.width - m);
			const y0 = Math.floor(a.box.y + r.y * BOX.height - m);
			const x1 = Math.ceil(a.box.x + (r.x + r.w) * BOX.width + m);
			const y1 = Math.ceil(a.box.y + (r.y + r.h) * BOX.height + m);
			for (let y = y0; y < y1; y++)
				for (let x = x0; x < x1; x++)
					for (let k = 0; k < 4; k++) {
						const i = (y * a.width + x) * 4 + k;
						sum += Math.abs(a.data[i]! - b.data[i]!);
						n++;
					}
			return sum / n;
		};

		it('a letter whose run sets a finish draws its face with it; the others keep the look’s', async () => {
			const flatAll = await render('flat', glyphs());
			const metalAll = await render('metal', glyphs());
			const mixed = await render('flat', glyphs('metal'));
			keep('run-finish', mixed);
			// Metal is no flat colour: B must have changed, and A and C must not.
			expect(diffIn(flatAll, metalAll, B)).toBeGreaterThan(10);
			expect(diffIn(mixed, metalAll, B)).toBeLessThan(0.5);
			expect(diffIn(mixed, flatAll, A)).toBe(0);
			expect(diffIn(mixed, flatAll, C)).toBe(0);
		});

		it('the other way round: one letter keeps a flat face on a metal look', async () => {
			const flatAll = await render('flat', glyphs());
			const metalAll = await render('metal', glyphs());
			const mixed = await render('metal', glyphs('flat'));
			expect(diffIn(mixed, flatAll, B)).toBeLessThan(0.5);
			expect(diffIn(mixed, metalAll, A)).toBeLessThan(0.5);
			expect(diffIn(mixed, metalAll, C)).toBeLessThan(0.5);
		});

		it('a run giving the look’s own finish draws exactly the look', async () => {
			const plain = await render('glass', glyphs());
			expect(diffIn(await render('glass', glyphs('glass')), plain, B)).toBe(0);
		});

		it('goes with its letter when the letter moves', async () => {
			// B drawn 30 px lower: its record carries the move, and the finish follows it there.
			const dy = 30;
			const moved = { ...B, y: B.y + dy / BOX.height };
			const img = await render('flat', glyphs('metal', dy), dy);
			expect(diffIn(img, await render('metal', glyphs(undefined, dy), dy), moved)).toBeLessThan(0.5);
			expect(diffIn(img, await render('flat', glyphs(undefined, dy), dy), A)).toBe(0);
		});
	});
	describe('lights fixed on screen when the title turns', () => {
		const BOX = { width: 240, height: 240 };
		// A disc is the same picture however its layer turns: what changes is only where the screen is.
		const DISC = { kind: 'disc', x: 0.5, y: 0.5, r: 0.28 } as const;
		const look: LookRecipe = {
			light: { angle: 210, altitude: 35 },
			layers: [
				{ type: 'innerShadow', params: { distance: 4, blur: 3, angle: 60 } },
				{ type: 'rim', params: { width: 5, finish: 'bevel', paint: flat(0.85, 0.6, 0.2) } },
				{ type: 'face', params: { finish: 'reflection', paint: flat(0.6, 0.65, 0.7) } },
				{ type: 'extrude', params: { depth: 8, angle: 120 } },
				{ type: 'shadow', params: { distance: 10, blur: 4, angle: 30 } },
			],
		};
		/** The map of a layer turned `deg` clockwise on screen. */
		const turned = (deg: number) => {
			const t = (deg * Math.PI) / 180;
			return { a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t), d: Math.cos(t) };
		};
		/** RGBA at (dx, dy) canvas px from the centre of the layer box, bilinear. */
		const at = (img: LookImage, dx: number, dy: number) => {
			const x = img.box.x + img.box.w / 2 + dx - 0.5;
			const y = img.box.y + img.box.h / 2 + dy - 0.5;
			const x0 = Math.floor(x);
			const y0 = Math.floor(y);
			const fx = x - x0;
			const fy = y - y0;
			const px = (i: number, j: number, k: number) => img.data[(j * img.width + i) * 4 + k]!;
			return [0, 1, 2, 3].map(
				(k) =>
					(px(x0, y0, k) * (1 - fx) + px(x0 + 1, y0, k) * fx) * (1 - fy) +
					(px(x0, y0 + 1, k) * (1 - fx) + px(x0 + 1, y0 + 1, k) * fx) * fy,
			);
		};
		/** Mean |difference| of premultiplied RGB between the upright look and the turned one seen on screen. */
		const onScreen = (upright: LookImage, layer: LookImage, deg: number) => {
			const t = (deg * Math.PI) / 180;
			let sum = 0;
			let n = 0;
			for (let y = -100; y <= 100; y += 2)
				for (let x = -100; x <= 100; x += 2) {
					// Within the disc of what both canvases hold, however the layer turns.
					if (x * x + y * y > 100 * 100) continue;
					// Screen q = R·p: the layer point under it is p = Rᵀ·q.
					const lx = Math.cos(t) * x + Math.sin(t) * y;
					const ly = -Math.sin(t) * x + Math.cos(t) * y;
					const a = at(upright, x, y);
					const b = at(layer, lx, ly);
					for (let k = 0; k < 3; k++) sum += Math.abs((a[k]! * a[3]!) / 255 - (b[k]! * b[3]!) / 255);
					n += 3;
				}
			return sum / n;
		};
		const render = (layerMap?: ReturnType<typeof turned>) =>
			tl.render({ recipe: look, input: DISC, box: BOX, unitPx: 100, ...(layerMap ? { layerMap } : {}) });

		it('a turned title shows the light, the room and the shadows where the upright one does', async () => {
			const upright = await render();
			for (const deg of [40, 90, 200]) {
				const layer = await render(turned(deg));
				keep(`turned-${deg}`, layer);
				// What a fixed light would not do: the layer's own picture differs from the upright one's.
				expect(onScreen(upright, layer, 0)).toBeGreaterThan(4);
				expect(onScreen(upright, layer, deg)).toBeLessThan(1.5);
			}
			keep('upright', upright);
		});

		it('a mirrored title keeps its light on screen too', async () => {
			const upright = await render();
			// Flipped horizontally: the layer's x axis points left on screen.
			const layer = await render({ a: -1, b: 0, c: 0, d: 1 });
			let sum = 0;
			let n = 0;
			for (let y = -100; y <= 100; y += 2)
				for (let x = -100; x <= 100; x += 2) {
					// Within the disc of what both canvases hold, however the layer turns.
					if (x * x + y * y > 100 * 100) continue;
					const a = at(upright, x, y);
					const b = at(layer, -x, y);
					for (let k = 0; k < 3; k++) sum += Math.abs((a[k]! * a[3]!) / 255 - (b[k]! * b[3]!) / 255);
					n += 3;
				}
			expect(sum / n).toBeLessThan(1.5);
		});

		it('an upright layer map draws exactly what no map draws', async () => {
			const a = await render();
			const b = await render({ a: 2, b: 0, c: 0, d: 2 });
			expect(onScreen(a, b, 0)).toBeLessThan(0.05);
		});
	});
});
