// @vitest-environment node
// Spec 19 §7 in real WebGL2: what no fingerprint can prove. Every generator is a closed form of time and seed (TL-061):
// frame N is the same reached from any direction, after a seek, and across a razor cut. Identity is stable (TL-062): stars,
// particles and drops do not re-roll when the title's pixels change. Fingerprints, padding and resolution of each type are
// in `title-look-gl.test.ts`; contact sheets in `title-look-generators-sheets.test.ts`.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LookRecipe, type Paint, TITLE_GENERATORS } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	CHROME,
	type LookImage,
	type LookPage,
	type LookRequest,
	layerCrop,
	lumaOver,
	openLookPage,
	pixel,
	resampleLuma,
	ssim,
} from './title-look-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FACE = { type: 'face', params: { paint: { kind: 'color', color: [0.3, 0.3, 0.3, 1] } as Paint } };
const TEXT: LookRequest['input'] = { kind: 'text', text: 'Ag', size: 64 };
const BOX = { width: 200, height: 90 };

/** Largest difference of any channel of any pixel. */
function maxDiff(a: LookImage, b: LookImage): number {
	expect([a.width, a.height]).toEqual([b.width, b.height]);
	let m = 0;
	for (let i = 0; i < a.data.length; i++) m = Math.max(m, Math.abs(a.data[i]! - b.data[i]!));
	return m;
}

/** Mean absolute difference over all channels. */
function meanDiff(a: LookImage, b: LookImage): number {
	let s = 0;
	for (let i = 0; i < a.data.length; i++) s += Math.abs(a.data[i]! - b.data[i]!);
	return s / a.data.length;
}

/**
 * Mean difference of alpha over 12 px cells. Particles a pixel or two wide that moved by one pixel differ per pixel about as
 * much as new ones do; over cells, what moved a little barely shows and what was re-rolled does.
 */
function cellDiff(a: LookImage, b: LookImage, cell = 12): number {
	let s = 0;
	let n = 0;
	for (let y = 0; y + cell <= a.height; y += cell)
		for (let x = 0; x + cell <= a.width; x += cell) {
			s += Math.abs(energy(a, x, y, x + cell, y + cell) - energy(b, x, y, x + cell, y + cell));
			n++;
		}
	return s / (n * cell * cell);
}

/** Sum of alpha over a rectangle of canvas px: how much light is there. */
function energy(img: LookImage, x0 = 0, y0 = 0, x1 = img.width, y1 = img.height): number {
	let e = 0;
	for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++)
		for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) e += pixel(img, x, y)[3];
	return e;
}

/** Largest difference over a rectangle of canvas px, with `b` read `dx` px to the right of `a`. */
function maxDiffShifted(
	a: LookImage,
	b: LookImage,
	dx: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
) {
	let m = 0;
	for (let y = y0; y < y1; y++)
		for (let x = x0; x < x1; x++) {
			const p = pixel(a, x, y);
			const q = pixel(b, x + dx, y);
			for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(p[k]! - q[k]!));
		}
	return m;
}

const layer = (id: string, params: Record<string, unknown> = {}, front = false): LookRecipe =>
	({
		layers: front
			? [FACE, { type: `generator:${id}`, params: { ownColors: true, ...params } }]
			: [{ type: `generator:${id}`, params: { ownColors: true, ...params } }, FACE],
	}) as LookRecipe;

/** What each generator needs to move at all: a preset where its default is still by design. */
const MOVING: Record<string, Record<string, number>> = {
	shockwave: { cycle: 1.2 },
	inkSplatter: { revealTime: 2 },
	brushSwirl: { writeTime: 2 },
	lensFlare: { flicker: 60, flickerRate: 8 },
};

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('generators in WebGL2', { timeout: 300_000 }, () => {
	let tl: LookPage;
	beforeAll(async () => {
		tl = await openLookPage(here);
	}, 120_000);
	afterAll(async () => {
		await tl?.browser.close();
	});

	const look = (
		id: string,
		contentSeconds: number,
		params: Record<string, unknown> = {},
		over: Partial<LookRequest> = {},
	) => {
		const g = TITLE_GENERATORS.find((x) => x.id === id)!;
		return tl.render({
			recipe: layer(id, { ...MOVING[id], ...params }, g.front === true),
			input: TEXT,
			box: BOX,
			contentSeconds,
			...over,
		});
	};

	describe('TL-061: closed forms of time', () => {
		for (const g of TITLE_GENERATORS)
			it(`${g.id}: frame N is the same from any direction and after a seek, and time moves it`, async () => {
				const n = await look(g.id, 0.7);
				await look(g.id, 1.9); // a seek forward…
				const fromAhead = await look(g.id, 0.7);
				await look(g.id, 0.1); // …and back
				const fromBehind = await look(g.id, 0.7);
				expect(maxDiff(n, fromAhead)).toBe(0);
				expect(maxDiff(n, fromBehind)).toBe(0);
				// Stepping through frames arrives at the same picture as jumping there: there is no state to arrive with.
				for (const t of [0.6, 0.63, 0.66]) await look(g.id, t);
				expect(maxDiff(n, await look(g.id, 0.7))).toBe(0);
				expect(meanDiff(n, await look(g.id, 1.3))).toBeGreaterThan(0.002);
			});

		for (const g of TITLE_GENERATORS)
			it(`${g.id}: the standalone effect scrubs exactly and a razor cut changes nothing (max diff 0)`, async () => {
				const effectId = `jasper.generator.${g.id}`;
				const params = MOVING[g.id] ?? {};
				const box = { width: 240, height: 136 };
				const uncut = await tl.renderEffect({ effectId, box, frame: 40, params });
				await tl.renderEffect({ effectId, box, frame: 90, params });
				expect(maxDiff(uncut, await tl.renderEffect({ effectId, box, frame: 40, params }))).toBe(0);
				// The right part of a cut at frame 25: its own frame 15, its origin's frame offset 25, the origin's seed.
				const right = await tl.renderEffect({ effectId, box, frame: 15, frameOffset: 25, params });
				expect(maxDiff(uncut, right)).toBe(0);
				// A part that lost its offset is a different picture: the assertion above has something to catch.
				const lost = await tl.renderEffect({ effectId, box, frame: 15, params });
				expect(meanDiff(uncut, lost)).toBeGreaterThan(0.002);
			});

		it('the seed changes the pattern, and two layers of one look can differ by Variation', async () => {
			const a = await look('fire', 0.5);
			const b = await look('fire', 0.5, {}, { seed: 11 });
			const c = await look('fire', 0.5, { variation: 3 });
			expect(meanDiff(a, b)).toBeGreaterThan(0.2);
			expect(meanDiff(a, c)).toBeGreaterThan(0.2);
		});
	});

	describe('hold-frame boil and continuous modes', () => {
		for (const [id, params] of [
			['lightning', { motion: 'boil', boilRate: 10 }],
			['speedLines', { motion: 'boil', boilRate: 10 }],
		] as const)
			it(`${id}: boil holds every frame of a step and re-rolls the next`, async () => {
				const a = await look(id, 0.31, params);
				const b = await look(id, 0.38, params);
				const c = await look(id, 0.42, params);
				expect(maxDiff(a, b)).toBe(0);
				expect(meanDiff(b, c)).toBeGreaterThan(0.01);
			});

		for (const [id, params] of [
			['lightning', { motion: 'crawl' }],
			['speedLines', { motion: 'flow' }],
		] as const)
			it(`${id}: the continuous mode moves on every frame, by a little`, async () => {
				const a = await look(id, 0.5, params);
				const b = await look(id, 0.5 + 1 / 30, params);
				const c = await look(id, 1.3, params);
				const step = meanDiff(a, b);
				expect(step).toBeGreaterThan(0);
				expect(step).toBeLessThan(meanDiff(a, c));
			});
	});

	describe('Particles: 7 emitters, 11 shapes, wrapped age, ballistic position', () => {
		const emitters = ['point', 'ellipse', 'rect', 'ring', 'line', 'full', 'layer'];
		const shapes = [
			'dot',
			'glint4',
			'glint6',
			'ember',
			'square',
			'confetti',
			'petal',
			'star',
			'heart',
			'bokeh',
			'rain',
		];

		for (const emitter of emitters)
			it(`emitter ${emitter} draws`, async () => {
				const off = await tl.render({
					recipe: { layers: [FACE] } as LookRecipe,
					input: TEXT,
					box: BOX,
					pad: 80,
				});
				const img = await look(
					'particles',
					0.8,
					{ emitter, rx: 40, ry: 30, travel: 30, count: 300 },
					{ pad: 80 },
				);
				const a = lumaOver(off, 0);
				const b = lumaOver(img, 0);
				let lit = 0;
				for (let i = 0; i < Math.min(a.length, b.length); i++) if (b[i]! > a[i]! + 8) lit++;
				expect(lit).toBeGreaterThan(20);
			});

		for (const shape of shapes)
			it(`shape ${shape} draws and moves`, async () => {
				const params = {
					shape,
					emitter: 'ellipse',
					rx: 50,
					ry: 30,
					size: 8,
					count: 60,
					distribution: 'scatter',
					travel: 40,
				};
				const a = await look('particles', 0.4, params);
				const b = await look('particles', 0.5, params);
				expect(energy(a)).toBeGreaterThan(0);
				expect(meanDiff(a, b)).toBeGreaterThan(0.002);
			});

		it('scatter moves: Pachislop has no motion, here a particle drifts through its life', async () => {
			const params = {
				emitter: 'rect',
				rx: 60,
				ry: 30,
				distribution: 'scatter',
				count: 40,
				size: 6,
				travel: 60,
				glow: 0,
			};
			expect(
				meanDiff(await look('particles', 0.4, params), await look('particles', 0.6, params)),
			).toBeGreaterThan(0.01);
		});

		it('position is ballistic: one particle lands where start + v·t + g·t²/2 says, at any age, in any order', async () => {
			const params = {
				emitter: 'point',
				distribution: 'stream',
				timing: 'once',
				stagger: 0,
				count: 1,
				lifetime: 4,
				lifeRandom: 0,
				drag: 0,
				cone: 0,
				angle: 0,
				travel: 200,
				gravity: 40,
				size: 6,
				sizeRandom: 0,
				depth: 0,
				glow: 0,
				brightness: 800,
				opacityRandom: 0,
				colorMode: 'solid',
				color: [1, 1, 1, 1],
			};
			const centroid = (img: LookImage) => {
				let sx = 0;
				let sy = 0;
				let w = 0;
				for (let y = 0; y < img.height; y++)
					for (let x = 0; x < img.width; x++) {
						const a = pixel(img, x, y)[3];
						if (a < 200) continue;
						sx += x * a;
						sy += y * a;
						w += a;
					}
				return [sx / w, sy / w] as const;
			};
			const unit = 64 * 0.01;
			const recipe = {
				layers: [{ type: 'generator:particles', params: { ownColors: true, ...params } }],
			} as LookRecipe;
			const at = async (t: number) =>
				tl.render({
					recipe,
					input: { kind: 'rect', x: 0, y: 0, w: 0, h: 0 },
					box: BOX,
					unitPx: 64,
					contentSeconds: t,
				});
			const speed = (200 / 4) * unit * 0.8; // the stream's own pace at this seed is read from two ages below
			const [x0, y0] = centroid(await at(0.5));
			const [x1, y1] = centroid(await at(2.5));
			const [x2] = centroid(await at(1.5));
			// Uniform motion along x, whatever the pace of this particle: the middle age is the mean of the two others.
			expect(Math.abs(x2 - (x0 + x1) / 2)).toBeLessThan(0.8);
			expect(x1 - x0).toBeGreaterThan(speed * 0.5);
			// Gravity: 40 % of the unit per s², the displacement between ages 0.5 and 2.5 s is g(2.5² − 0.5²)/2.
			expect(Math.abs(y1 - y0 - (40 * unit * (2.5 ** 2 - 0.5 ** 2)) / 2)).toBeLessThan(1);
		});

		it('tumble turns a solid particle through its life, closed form', async () => {
			const params = {
				emitter: 'ellipse',
				rx: 40,
				ry: 20,
				distribution: 'scatter',
				shape: 'confetti',
				size: 10,
				count: 30,
				tumble: 90,
				tumbleRate: 1,
				travel: 0,
				lifetime: 60,
			};
			expect(
				meanDiff(await look('particles', 10, params), await look('particles', 10.2, params)),
			).toBeGreaterThan(0.02);
		});
	});

	describe('TL-062: identity is stable when the title moves', () => {
		const box = { width: 320, height: 120 };
		/** Two "letters" at fractions of the box. `dx` moves the second, `all` moves both. */
		const letters = (dx: number, all = 0, opacity = 1): LookRequest['input'] => ({
			kind: 'letters',
			letters: [
				{ x: 0.15 + all, y: 0.3, w: 0.16, h: 0.4 },
				{ x: 0.66 + dx + all, y: 0.3, w: 0.16, h: 0.4, opacity },
			],
		});
		const px = (n: number) => n / box.width;
		const parts = (params: Record<string, unknown>) =>
			({ layers: [{ type: 'generator:particles', params: { ownColors: true, ...params } }] }) as LookRecipe;
		const edge = {
			emitFrom: 'edge',
			count: 500,
			travel: 12,
			size: 2.5,
			capture: 12,
			depth: 0,
			glow: 0,
			sway: 0,
		};
		const draw = (recipe: LookRecipe, input: LookRequest['input'], t = 0.8) =>
			tl.render({ recipe, input, box, unitPx: 64, contentSeconds: t, pad: 30 });

		it('a letter that moves leaves the particles of the other letters exactly where they were', async () => {
			const a = await draw(parts(edge), letters(0));
			const b = await draw(parts(edge), letters(px(14)));
			// Around the first letter, well before the medial axis between the letters.
			const x0 = Math.round(a.box.x + box.width * 0.02);
			const x1 = Math.round(a.box.x + box.width * 0.42);
			expect(maxDiffShifted(a, b, 0, x0, 0, x1, a.height)).toBeLessThanOrEqual(2);
			// Around the second, particles did move.
			expect(meanDiff(a, b)).toBeGreaterThan(0.01);
		});

		it('a letter moving by a pixel moves particles by about a pixel: nothing re-rolls', async () => {
			const a = await draw(parts(edge), letters(0, 0));
			const b = await draw(parts(edge), letters(0, px(1)));
			const rerolled = await draw(parts({ ...edge, variation: 9 }), letters(0, 0));
			expect(cellDiff(a, b)).toBeLessThan(0.4 * cellDiff(a, rerolled));
		});

		it('with the alpha bounds as anchor, a title moving whole inside its box carries every particle exactly', async () => {
			const params = { ...edge, anchor: 'bounds' };
			const a = await draw(parts(params), letters(0, 0));
			const b = await draw(parts(params), letters(0, px(10)));
			expect(maxDiffShifted(a, b, 10, 40, 10, a.width - 40, a.height - 10)).toBeLessThanOrEqual(6);
			expect(energy(a)).toBeGreaterThan(0);
		});

		it('a letter fading in wakes its sites in place, with no pop and no effect on the other letters', async () => {
			const steps = [0.02, 0.1, 0.2, 0.35, 0.5, 0.7, 1];
			const frames: LookImage[] = [];
			for (const o of steps) frames.push(await draw(parts(edge), letters(0, 0, o)));
			const x1 = Math.round(frames[0]!.box.x + box.width * 0.42);
			const right = frames.map((f) => energy(f, x1));
			for (let i = 1; i < steps.length; i++) {
				expect(maxDiffShifted(frames[0]!, frames[i]!, 0, 0, 0, x1, frames[0]!.height)).toBeLessThanOrEqual(2);
				expect(right[i]! - right[i - 1]!).toBeGreaterThanOrEqual(-1);
			}
			const total = right.at(-1)! - right[0]!;
			expect(total).toBeGreaterThan(0);
			for (let i = 1; i < steps.length; i++) expect(right[i]! - right[i - 1]!).toBeLessThan(total * 0.6);
		});

		it('per-letter animated text: a wave of offsets keeps the look of every particle', async () => {
			// Each letter bobs on its own phase, as an offset animator does: the picture changes little between frames.
			const wave = (t: number): LookRequest['input'] => ({
				kind: 'letters',
				letters: [0, 1, 2, 3].map((i) => ({
					x: 0.1 + i * 0.21,
					y: 0.3 + 0.02 * Math.sin(t * 6 + i),
					w: 0.14,
					h: 0.4,
				})),
			});
			const a = await draw(parts(edge), wave(0));
			const b = await draw(parts(edge), wave(1 / 30));
			const rerolled = await draw(parts({ ...edge, variation: 9 }), wave(0));
			expect(cellDiff(a, b)).toBeLessThan(0.4 * cellDiff(a, rerolled));
		});

		const stars = (params: Record<string, unknown> = {}) =>
			({
				layers: [
					{ type: 'face', params: { paint: { kind: 'source' } } },
					{
						type: 'generator:glints',
						params: { ownColors: true, twinkle: 0, size: 30, large: 3, small: 4, ...params },
					},
				],
			}) as LookRecipe;

		const bare = { layers: [{ type: 'face', params: { paint: { kind: 'source' } } }] } as LookRecipe;

		it('glints: with the alpha bounds as anchor, stars move with the title exactly', async () => {
			const params = { anchor: 'bounds' };
			const a = await draw(stars(params), letters(0, 0));
			const b = await draw(stars(params), letters(0, px(16)));
			expect(energy(a)).toBeGreaterThan(0);
			// Inside a margin: stars reach past the first letter, the canvas stays where it is.
			expect(maxDiffShifted(a, b, 16, 60, 10, a.width - 60, a.height - 10)).toBeLessThanOrEqual(12);
		});

		it('glints: a title sliding through its box keeps its stars: no pop on any frame', async () => {
			const frames: LookImage[] = [];
			const lit: number[] = [];
			for (let i = 0; i <= 14; i++) {
				const f = await draw(stars(), letters(0, px(i)));
				frames.push(f);
				lit.push(energy(f) - energy(await draw(bare, letters(0, px(i)))));
			}
			const mean = lit.reduce((a, b) => a + b, 0) / lit.length;
			expect(mean).toBeGreaterThan(0);
			for (let i = 1; i < lit.length; i++) expect(Math.abs(lit[i]! - lit[i - 1]!) / mean).toBeLessThan(0.05);
			// The stars ride the title: the picture one step later, read one pixel on, is nearly the same.
			for (let i = 1; i < frames.length; i += 3) {
				const a = frames[i - 1]!;
				const b = frames[i]!;
				let far = 0;
				for (let y = 8; y < a.height - 8; y += 2)
					for (let x = 8; x < a.width - 8; x += 2) {
						const p = pixel(a, x, y)[3];
						const q = pixel(b, x + 1, y)[3];
						if (Math.abs(p - q) > 120) far++;
					}
				expect(far).toBeLessThan(40);
			}
		});

		it('glints: a highlight rising past another hands over without a pop (no temporal history needed)', async () => {
			const e: number[] = [];
			const steps = 12;
			for (let i = 0; i <= steps; i++) {
				const v = Math.round(100 + (i / steps) * 120)
					.toString(16)
					.padStart(2, '0');
				const input: LookRequest['input'] = {
					kind: 'letters',
					letters: [
						{ x: 0.15, y: 0.3, w: 0.16, h: 0.4, color: '#a0a0a0' },
						{ x: 0.36, y: 0.3, w: 0.16, h: 0.4, color: `#${v}${v}${v}` },
					],
				};
				e.push(energy(await draw(stars(), input)) - energy(await draw(bare, input)));
			}
			const mean = e.reduce((a, b) => a + b, 0) / e.length;
			for (let i = 1; i < e.length; i++) expect(Math.abs(e[i]! - e[i - 1]!) / mean).toBeLessThan(0.12);
		});

		it('glints: each star twinkles on its own beat and stays where it is', async () => {
			const params = { twinkle: 100, twinkleRate: 1 };
			const frames: LookImage[] = [];
			for (let i = 0; i < 6; i++) frames.push(await draw(stars(params), letters(0), 0.25 * i));
			// Brightness of the two halves of the title over time: they do not rise and fall together.
			const mid = Math.round(frames[0]!.box.x + box.width * 0.5);
			const left = frames.map((f) => energy(f, 0, 0, mid));
			const right = frames.map((f) => energy(f, mid));
			const correlate = (a: number[], b: number[]) => {
				const ma = a.reduce((x, y) => x + y) / a.length;
				const mb = b.reduce((x, y) => x + y) / b.length;
				let s = 0;
				let sa = 0;
				let sb = 0;
				for (let i = 0; i < a.length; i++) {
					s += (a[i]! - ma) * (b[i]! - mb);
					sa += (a[i]! - ma) ** 2;
					sb += (b[i]! - mb) ** 2;
				}
				return s / Math.sqrt(sa * sb || 1);
			};
			expect(Math.max(...left) - Math.min(...left)).toBeGreaterThan(0);
			expect(Math.abs(correlate(left, right))).toBeLessThan(0.98);
		});

		it('ink: a moved letter does not re-roll the drops', async () => {
			const ink = (params: Record<string, unknown> = {}) =>
				({
					layers: [
						{ type: 'generator:inkSplatter', params: { ownColors: true, color: [1, 1, 1, 1], ...params } },
					],
				}) as LookRecipe;
			const a = await draw(ink(), letters(0, 0));
			const b = await draw(ink(), letters(0, px(1)));
			const rerolled = await draw(ink({ variation: 9 }), letters(0, 0));
			expect(cellDiff(a, rerolled)).toBeGreaterThan(0);
			expect(cellDiff(a, b)).toBeLessThan(0.5 * cellDiff(a, rerolled));
		});

		it('ink: each drop lands at its own moment', async () => {
			const recipe = {
				layers: [
					{ type: 'generator:inkSplatter', params: { ownColors: true, color: [1, 1, 1, 1], revealTime: 1 } },
				],
			} as LookRecipe;
			const e: number[] = [];
			for (const t of [0.1, 0.3, 0.5, 0.7, 1]) e.push(energy(await draw(recipe, letters(0), t)));
			for (let i = 1; i < e.length; i++) expect(e[i]!).toBeGreaterThan(e[i - 1]!);
		});
	});

	describe('Shockwave: one Progress, a frozen texture', () => {
		const ring = (ringProgress: number) => ({
			ringProgress,
			profile: 'fibrous',
			rings: 1,
			radius: 100,
			textureRadius: 100,
			ringWidth: 24,
			softIn: 0,
			softOut: 0,
			flash: 0,
			breakup: 0,
		});
		const atAngles = (img: LookImage, radiusPx: number) => {
			const cx = img.box.x + img.box.w / 2;
			const cy = img.box.y + img.box.h / 2;
			const out: number[] = [];
			for (let i = 0; i < 180; i++) {
				const a = (i / 180) * Math.PI * 2;
				// The strongest light across the band at this angle.
				let m = 0;
				for (let r = -12; r <= 12; r += 2)
					m = Math.max(
						m,
						pixel(img, cx + Math.cos(a) * (radiusPx + r), cy + Math.sin(a) * (radiusPx + r))[3],
					);
				out.push(m);
			}
			return out;
		};
		const correlation = (a: number[], b: number[]) => {
			const ma = a.reduce((x, y) => x + y) / a.length;
			const mb = b.reduce((x, y) => x + y) / b.length;
			let s = 0;
			let sa = 0;
			let sb = 0;
			for (let i = 0; i < a.length; i++) {
				s += (a[i]! - ma) * (b[i]! - mb);
				sa += (a[i]! - ma) ** 2;
				sb += (b[i]! - mb) ** 2;
			}
			return s / Math.sqrt(sa * sb);
		};
		const render = (p: number) =>
			tl.render({
				recipe: {
					layers: [{ type: 'generator:shockwave', params: { ownColors: true, ...ring(p) } }],
				} as LookRecipe,
				input: { kind: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
				box: { width: 320, height: 320 },
				unitPx: 100,
			});

		it('the texture keeps its angle as the ring grows: it does not swim', async () => {
			const eased = (p: number) => 100 * (1 - (1 - p) ** 2);
			const a = atAngles(await render(40), eased(0.4));
			const b = atAngles(await render(60), eased(0.6));
			expect(correlation(a, b)).toBeGreaterThan(0.85);
		});

		it('the same ring with its texture radius moved is another texture: the check above can fail', async () => {
			const eased = 100 * (1 - 0.6 ** 2);
			const a = atAngles(await render(40), eased);
			const other = await tl.render({
				recipe: {
					layers: [
						{ type: 'generator:shockwave', params: { ownColors: true, ...ring(40), textureRadius: 57 } },
					],
				} as LookRecipe,
				input: { kind: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
				box: { width: 320, height: 320 },
				unitPx: 100,
			});
			expect(correlation(a, atAngles(other, eased))).toBeLessThan(0.7);
		});

		it('Loop Every drives the same Progress: a closed form of time', async () => {
			const on = (t: number, p: number, cycle: number) =>
				tl.render({
					recipe: {
						layers: [{ type: 'generator:shockwave', params: { ownColors: true, ...ring(p), cycle } }],
					} as LookRecipe,
					input: { kind: 'rect', x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
					box: { width: 320, height: 320 },
					unitPx: 100,
					contentSeconds: t,
				});
			expect(maxDiff(await on(0.5, 0, 1), await on(1.5, 0, 1))).toBe(0);
		});
	});

	describe('TL-051: colour through a look', () => {
		const palette = { accent1: [0.1, 0.3, 1, 1] } as NonNullable<LookRecipe['palette']>;
		const fire = (ownColors: boolean) =>
			({
				palette,
				layers: [{ type: 'generator:fire', params: { ownColors, paint: { kind: 'role', role: 'accent1' } } }],
			}) as LookRecipe;
		const text = { input: TEXT, box: BOX, contentSeconds: 0.4 };

		it('fire keeps its fixed colours by default, and follows the palette when released, with a white hot core', async () => {
			const own = await tl.render({ recipe: fire(true), ...text });
			const mapped = await tl.render({ recipe: fire(false), ...text });
			let redder = 0;
			let bluer = 0;
			let hot = 0;
			for (let y = 0; y < own.height; y++)
				for (let x = 0; x < own.width; x++) {
					const a = pixel(own, x, y);
					const b = pixel(mapped, x, y);
					if (a[3] > 200 && a[0] > a[2] + 40) redder++;
					if (b[3] > 200 && b[2] > b[0] + 40) bluer++;
					if (b[3] > 240 && b[0] > 235 && b[1] > 235 && b[2] > 235) hot++;
				}
			expect(redder).toBeGreaterThan(200);
			expect(bluer).toBeGreaterThan(200);
			expect(hot).toBeGreaterThan(10);
		});

		it('a look layer defaults to the palette, except fire; the role follows a colourway', async () => {
			const recipe = (role: Record<string, unknown>) =>
				({ palette: role, layers: [{ type: 'generator:corona', params: {} }, FACE] }) as LookRecipe;
			const a = await tl.render({ recipe: recipe({ glow: [1, 0, 0, 1] }), ...text });
			const b = await tl.render({ recipe: recipe({ glow: [0, 1, 0, 1] }), ...text });
			expect(meanDiff(a, b)).toBeGreaterThan(0.5);
		});

		it('a gradient paint maps through the ramp', async () => {
			const recipe = {
				layers: [
					{
						type: 'generator:corona',
						params: {
							paint: {
								kind: 'gradient',
								gradient: {
									type: 'linear',
									span: 'block',
									angle: 0,
									stops: [
										{ at: 0, paint: { color: [0, 0, 0, 1] } },
										{ at: 1, paint: { color: [1, 0, 0, 1] } },
									],
								},
							},
						},
					},
				],
			} as LookRecipe;
			const img = await tl.render({ recipe, ...text });
			let red = 0;
			for (let i = 0; i < img.data.length; i += 4) if (img.data[i]! > 150 && img.data[i + 1]! < 60) red++;
			expect(red).toBeGreaterThan(20);
		});

		it('ink takes the paint flat: black ink cannot go through a luma map', async () => {
			const recipe = {
				palette: { shadow: [0.9, 0.1, 0.2, 1] },
				layers: [{ type: 'generator:inkSplatter', params: { paint: { kind: 'role', role: 'shadow' } } }],
			} as LookRecipe;
			const img = await tl.render({ recipe, ...text });
			let red = 0;
			for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]! > 200 && img.data[i]! > 180) red++;
			expect(red).toBeGreaterThan(30);
		});
	});

	describe('Standalone (TL-060)', () => {
		const box = { width: 240, height: 136 };

		it('fire and smoke rise from the bottom of the frame, the shape-aware ones read a stand-in shape', async () => {
			const fire = await tl.renderEffect({ effectId: 'jasper.generator.fire', box, frame: 12 });
			expect(energy(fire, 0, 100)).toBeGreaterThan(energy(fire, 0, 0, fire.width, 40) * 4);
			for (const id of ['corona', 'backlight', 'lightning', 'glints', 'inkSplatter', 'particles']) {
				const img = await tl.renderEffect({ effectId: `jasper.generator.${id}`, box, frame: 12 });
				expect(energy(img), id).toBeGreaterThan(0);
			}
		});

		it('draws over what is below it, in the framework signal, and leaves the rest alone', async () => {
			const input = { kind: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#204060' } as const;
			const img = await tl.renderEffect({ effectId: 'jasper.generator.fire', box, frame: 12, input });
			expect(pixel(img, 120, 8).slice(0, 3)).toEqual([0x20, 0x40, 0x60]);
			expect(pixel(img, 120, 130)[0]).toBeGreaterThan(0xa0);
		});

		it('a preview scale draws the same picture', async () => {
			const params = { emitter: 'ellipse', count: 400, size: 6 };
			for (const [effectId, p] of [
				['jasper.generator.fire', {}],
				['jasper.generator.particles', params],
			] as const) {
				const full = await tl.renderEffect({
					effectId,
					box: { width: 480, height: 270 },
					frame: 12,
					params: p,
				});
				const half = await tl.renderEffect({
					effectId,
					box: { width: 480, height: 270 },
					frame: 12,
					params: p,
					pxScale: 0.5,
				});
				const f = layerCrop(full, lumaOver(full, 0));
				const h = layerCrop(half, lumaOver(half, 0));
				expect(ssim(resampleLuma(f.data, f.w, f.h, h.w, h.h), h.data, h.w, h.h), effectId).toBeGreaterThan(
					0.8,
				);
			}
		});
	});

	// Cost on this host (docs/performance.md §7): TL_PERF=1. Reports; the budget is on a real GPU.
	it.runIf(process.env.TL_PERF === '1')(
		'per-frame cost of each generator at 1080p',
		{ timeout: 900_000 },
		async () => {
			for (const g of TITLE_GENERATORS) {
				const req: LookRequest = {
					recipe: layer(g.id, MOVING[g.id] ?? {}, g.front === true),
					input: { kind: 'text', text: 'Title Look', size: 200 },
					box: { width: 1200, height: 280 },
					contentSeconds: 0.5,
					timingOnly: true,
				};
				const first = await tl.render(req);
				const runs: number[] = [];
				for (let i = 0; i < 3; i++) runs.push((await tl.render(req)).ms);
				runs.sort((a, b) => a - b);
				const half = (await tl.render({ ...req, pxScale: 0.5 })).ms;
				console.info(
					`[generator-perf] ${g.id}: canvas ${first.width}×${first.height}, ${first.passes} passes, median ${runs[1]!.toFixed(0)} ms, at 1/2 ${half.toFixed(0)} ms`,
				);
			}
			const base = await tl.render({
				recipe: { layers: [FACE] } as LookRecipe,
				input: { kind: 'text', text: 'Title Look', size: 200 },
				box: { width: 1200, height: 280 },
				timingOnly: true,
			});
			console.info(`[generator-perf] face only: ${base.ms.toFixed(0)} ms`);
		},
	);

	it('Speed Lines: the title focus keeps the lines off the shape, as it changes', async () => {
		const recipe = {
			layers: [
				{
					type: 'generator:speedLines',
					params: {
						ownColors: true,
						motion: 'still',
						padding: 10,
						jitter: 0,
						extent: 120,
						lineWidth: 8,
						count: 200,
					},
				},
			],
		} as LookRecipe;
		const at = (x: number) =>
			tl.render({
				recipe,
				input: { kind: 'rect', x, y: 0.4, w: 0.2, h: 0.2 },
				box: { width: 200, height: 100 },
				unitPx: 64,
			});
		const a = await at(0.2);
		const b = await at(0.6);
		const hole = (img: LookImage, x: number) => pixel(img, img.box.x + x, img.box.y + 50)[3];
		// Over each shape there are no lines; far from it there are.
		expect(hole(a, 60)).toBe(0);
		expect(hole(b, 140)).toBe(0);
		expect(meanDiff(a, b)).toBeGreaterThan(0.1);
	});
});
