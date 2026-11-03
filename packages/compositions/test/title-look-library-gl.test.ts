// @vitest-environment node
// Spec 19 §14 library check: every factory look on a real title, in its own bundled font, through the real planner and
// WebGL2. Each tile must draw and must not clip at its padding. `TITLE_LOOKS_SHEET=<png>` writes the contact sheet; set
// `TITLE_LOOKS_COLORWAY=<colorway id>` to see the whole library in one colourway, and `TITLE_LOOKS_ONLY=<ids>` (look ids or
// category ids, comma-separated) to sheet part of it while working on it. Unset, every look is checked.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	FACTORY_LOOKS,
	type FactoryLook,
	factoryColorway,
	type LookRecipe,
	lookCategory,
	TITLE_GENERATORS,
} from '@jasper/project';
import { encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, type LookImage, type LookPage, openLookPage, over } from './title-look-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(here, '..', '..', '..', 'apps', 'engine');
const DISPLAY = join(ENGINE, 'fonts', 'display');
const require_ = createRequire(join(ENGINE, 'package.json'));

const TILE = { w: 640, h: 216 };
const BOX = { width: 560, height: 150 };
const COLS = 4;

type Face = { family: string; weight: number; file: Uint8Array };

/** The bytes of a face: a display family's committed file, or fontsource's `latin` file. */
function faceFile(family: string, weight: number): Uint8Array {
	const manifest = JSON.parse(readFileSync(join(DISPLAY, 'manifest.json'), 'utf8')) as {
		families: { id: string; family: string; files: { file: string; weights: number[] }[] }[];
	};
	const m = manifest.families.find((f) => f.family === family);
	if (m) {
		const file = m.files.find((x) => x.weights.includes(weight));
		if (!file) throw new Error(`${family} has no weight ${weight}`);
		return readFileSync(join(DISPLAY, m.id, 'files', file.file));
	}
	const id = family.toLowerCase().replace(/ /g, '-');
	const dir = dirname(require_.resolve(`@fontsource/${id}/metadata.json`));
	return readFileSync(join(dir, 'files', `${id}-latin-${weight}-normal.woff2`));
}

const JAPANESE = /[぀-ヿ㐀-鿿]/;

/** The face the sample text is set in: what `chooseLookFont` picks. */
function sampleFace(l: FactoryLook): { family: string; weight: number; trackingEm: number } {
	const f = l.recipe.font!;
	if (JAPANESE.test(l.sampleText) && f.ja)
		return { family: f.ja.family, weight: f.ja.weight ?? 400, trackingEm: 0 };
	return { family: f.family, weight: f.weight ?? 400, trackingEm: f.trackingEm ?? 0 };
}

/** A mid-toned backdrop with soft dark and bright areas: a look has to hold on footage, not on a flat colour. */
function backdrop(x: number, y: number): [number, number, number] {
	const v =
		0.27 +
		0.13 * Math.sin(x * 0.0047 + 1.3) * Math.cos(y * 0.0071) +
		0.07 * Math.sin((x + y) * 0.0113) +
		0.02 * Math.sin(x * 0.0413) * Math.sin(y * 0.0371);
	return [v * 0.92, v, v * 1.12];
}

function composite(
	sheet: Uint8Array,
	sheetW: number,
	ox: number,
	oy: number,
	img: Pick<LookImage, 'width' | 'height' | 'data' | 'box'>,
): void {
	const dx = Math.round(ox + (TILE.w - img.box.w) / 2 - img.box.x);
	const dy = Math.round(oy + (TILE.h - img.box.h) / 2 - img.box.y);
	for (let y = 0; y < img.height; y++)
		for (let x = 0; x < img.width; x++) {
			const px = x + dx;
			const py = y + dy;
			if (px < ox || px >= ox + TILE.w || py < oy || py >= oy + TILE.h) continue;
			const s = (y * img.width + x) * 4;
			const a = img.data[s + 3]! / 255;
			const d = (py * sheetW + px) * 4;
			for (let k = 0; k < 3; k++) sheet[d + k] = Math.round(img.data[s + k]! * a + sheet[d + k]! * (1 - a));
		}
}

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'the factory library in WebGL2',
	{ timeout: 600_000 },
	() => {
		let tl: LookPage;

		beforeAll(async () => {
			tl = await openLookPage(here);
			const faces = new Map<string, Face>();
			for (const l of FACTORY_LOOKS) {
				const f = sampleFace(l);
				faces.set(`${f.family}|${f.weight}`, {
					family: f.family,
					weight: f.weight,
					file: faceFile(f.family, f.weight),
				});
			}
			for (const f of faces.values()) await tl.loadFont(f.family, f.weight, f.file);
		}, 120_000);

		afterAll(async () => {
			await tl?.browser.close();
		});

		// TL-051: runs for every registered generator; with none registered there is nothing to recolour.
		it.runIf(TITLE_GENERATORS.length > 0)(
			'recolours generators by luma, keeps alpha, and leaves a fixed layer alone',
			async () => {
				const palette = (id: string) => factoryColorway(id)!.palette;
				for (const g of TITLE_GENERATORS) {
					const shot = (colorway: string, fixedColor: boolean) =>
						tl.render({
							recipe: {
								palette: palette(colorway),
								// Own Colours off: a generator that defaults to its own colours (fire) recolours too, so
								// `fixedColor` alone is what keeps the colours in the fixed shots (integration 2). A face of the
								// clip's own picture, behind or in front as the generator asks (TL-064): Glints places its stars
								// on the highlights of the stack, which a generator alone does not have.
								layers: (() => {
									const face = { type: 'face', params: { paint: { kind: 'source' } } };
									const gen = {
										type: `generator:${g.id}`,
										// Glints draws a few small twinkling stars by default; steady larger ones, as its own
										// GL test draws them, give the colourway enough pixels to show in a mean.
										// Its own colours a mid orange: a white picture stays white in every colourway (hot
										// cores stay white, TL-051), so white defaults (Speed Lines) would show no colourway.
										params: {
											...Object.fromEntries(
												g.params.filter((p) => p.type === 'color').map((p) => [p.name, [0.8, 0.45, 0.2, 1]]),
											),
											ownColors: false,
											...(g.id === 'glints' ? { twinkle: 0, size: 30, large: 3, small: 4 } : {}),
										},
										...(fixedColor ? { fixedColor } : {}),
									};
									return g.front ? [face, gen] : [gen, face];
								})(),
							},
							// Letters with a brighter corner, so highlights have a place to be.
							input: {
								kind: 'letters',
								letters: [
									{ x: 0.2, y: 0.25, w: 0.25, h: 0.5 },
									{ x: 0.55, y: 0.25, w: 0.25, h: 0.5 },
								],
							},
							box: { width: 320, height: 200 },
							unitPx: 100,
							contentSeconds: 1,
						});
					const blue = await shot('colorway.cobalt', false);
					const red = await shot('colorway.crimson', false);
					const fixedA = await shot('colorway.cobalt', true);
					const fixedB = await shot('colorway.crimson', true);
					const rgbDiff = (a: LookImage, b: LookImage) => {
						let n = 0;
						for (let i = 0; i < a.data.length; i += 4)
							n += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
						return n / a.data.length;
					};
					const alphaDiff = (a: LookImage, b: LookImage) => {
						let n = 0;
						for (let i = 3; i < a.data.length; i += 4) n = Math.max(n, Math.abs(a.data[i]! - b.data[i]!));
						return n;
					};
					// Per pixel that recolouring touched (a recoloured shot differs from the generator's own colours), so a
					// sparse generator such as Glints is held to the same change as one that fills the box (integration 2:
					// the mean over the whole frame was set with a stand-in generator, before any shipped).
					let touched = 0;
					let change = 0;
					for (let i = 0; i < blue.data.length; i += 4) {
						let moved = false;
						for (let k = 0; k < 3; k++)
							moved ||=
								Math.abs(blue.data[i + k]! - fixedA.data[i + k]!) > 2 ||
								Math.abs(red.data[i + k]! - fixedA.data[i + k]!) > 2;
						if (!moved) continue;
						touched++;
						change += Math.abs(blue.data[i]! - red.data[i]!) + Math.abs(blue.data[i + 2]! - red.data[i + 2]!);
					}
					expect(touched, `${g.id} is recoloured`).toBeGreaterThan(0);
					expect(change / touched, `${g.id} follows the colourway`).toBeGreaterThan(20);
					expect(rgbDiff(blue, red), `${g.id} follows the colourway`).toBeGreaterThan(0);
					expect(rgbDiff(fixedA, fixedB), `${g.id} fixed`).toBe(0);
					// The generators' rule (integration 2) keeps alpha in `luma` and `flat` modes; `light` treats the picture
					// as light, so its alpha follows the mapped brightness, but it never paints where the generator does not.
					if ((g.color?.mode ?? 'light') === 'light') {
						let outside = 0;
						for (let i = 3; i < blue.data.length; i += 4)
							if (fixedA.data[i] === 0) outside = Math.max(outside, blue.data[i]!);
						expect(outside, `${g.id} paints only where it draws`).toBeLessThanOrEqual(2);
					} else expect(alphaDiff(blue, fixedA), `${g.id} keeps alpha`).toBeLessThanOrEqual(2);
					const out = process.env.TITLE_LOOKS_RECOLOR_DIR;
					if (out)
						for (const [name, img] of [
							['blue', blue],
							['red', red],
							['fixed', fixedA],
						] as const)
							writeFileSync(
								join(out, `${g.id}-${name}.png`),
								encodePng({ width: img.width, height: img.height, data: over(img, 40) }),
							);
				}
			},
		);

		it('draws every look without clipping, and the sheet can be written', async () => {
			const way = process.env.TITLE_LOOKS_COLORWAY
				? factoryColorway(process.env.TITLE_LOOKS_COLORWAY)
				: undefined;
			const only = process.env.TITLE_LOOKS_ONLY?.split(',').map((x) => x.trim());
			const looks = only ? FACTORY_LOOKS.filter((l) => only.includes(l.libraryId) || only.includes(l.category)) : FACTORY_LOOKS;
			const rows = Math.ceil(looks.length / COLS);
			const W = COLS * TILE.w;
			const H = rows * TILE.h;
			const sheet = new Uint8Array(W * H * 4);
			for (let y = 0; y < H; y++)
				for (let x = 0; x < W; x++) {
					const c = backdrop(x, y);
					const i = (y * W + x) * 4;
					for (let k = 0; k < 3; k++) sheet[i + k] = Math.round(Math.max(0, Math.min(1, c[k]!)) * 255);
					sheet[i + 3] = 255;
				}
			for (const [i, l] of looks.entries()) {
				const f = sampleFace(l);
				const size = await tl.fitSize({
					text: l.sampleText,
					size: 96,
					width: BOX.width - 60 - f.trackingEm * 96 * l.sampleText.length,
					font: f,
				});
				const recipe: LookRecipe = way ? { ...l.recipe, palette: way.palette } : l.recipe;
				const img = await tl.render({
					recipe,
					input: { kind: 'text', text: l.sampleText, size, font: f },
					box: BOX,
				});
				let drawn = 0;
				let edge = 0;
				for (let y = 0; y < img.height; y++)
					for (let x = 0; x < img.width; x++) {
						const a = img.data[(y * img.width + x) * 4 + 3]!;
						if (a > 8) drawn++;
						if (a > 8 && (x === 0 || y === 0 || x === img.width - 1 || y === img.height - 1)) edge++;
					}
				expect(drawn, `${l.libraryId} draws`).toBeGreaterThan(2000);
				expect(edge, `${l.libraryId} clips at its padding`).toBe(0);
				composite(sheet, W, (i % COLS) * TILE.w, Math.floor(i / COLS) * TILE.h, img);
				expect(lookCategory(l.category), l.libraryId).toBeTruthy();
			}
			const out = process.env.TITLE_LOOKS_SHEET;
			if (out) {
				if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
				writeFileSync(out, encodePng({ width: W, height: H, data: sheet }));
			}
		});
	},
);
