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
});
