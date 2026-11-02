// @vitest-environment node
// Finishes and the layer types over them in real WebGL2 (spec 19 §5.1, TL-034, TL-036, TL-038). The picture tests every type
// gets are in title-look-gl.test.ts; this file holds what each one must do, and a contact sheet to look at (TL_SHEET=<png>).
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type LookRecipe,
	type Paint,
	type SpanGlyph,
	TL_ENV_PRESETS,
	TL_PATTERN_KINDS,
	TL_PROFILES,
} from '@jasper/project';
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
import { writeSheet } from './title-look-sheet.ts';

const here = dirname(fileURLToPath(import.meta.url));

const flat = (r: number, g: number, b: number, a = 1): Paint => ({ kind: 'color', color: [r, g, b, a] });
const palette = {
	face: [0.92, 0.72, 0.2, 1],
	faceAlt: [1, 0.9, 0.55, 1],
	keyline: [0.08, 0.1, 0.2, 1],
	shadow: [0.05, 0.03, 0.02, 1],
	accent1: [0.1, 0.1, 0.12, 1],
	accent2: [0.95, 0.3, 0.2, 1],
	base: [0.12, 0.2, 0.45, 1],
} as NonNullable<LookRecipe['palette']>;

const TEXT: LookRequest['input'] = { kind: 'text', text: 'Agate', size: 120 };
const BOX = { width: 420, height: 180 };
const SHAPES = { input: { kind: 'shapes' } as const, unitPx: 120, box: BOX };

const face = (finish: string, params: Record<string, unknown> = {}, paint?: Paint): LookRecipe => ({
	palette,
	layers: [{ type: 'face', params: { finish, ...params, ...(paint ? { paint } : {}) } }],
});

/** Luma spread inside the shape: a finish that reads as flat colour has almost none. */
function lumaSpread(img: LookImage): number {
	const values: number[] = [];
	for (let i = 0; i < img.data.length; i += 4) {
		if (img.data[i + 3]! < 250) continue;
		values.push(0.2126 * img.data[i]! + 0.7152 * img.data[i + 1]! + 0.0722 * img.data[i + 2]!);
	}
	values.sort((a, b) => a - b);
	return values[Math.floor(values.length * 0.95)]! - values[Math.floor(values.length * 0.05)]!;
}

const meanRgb = (img: LookImage) => {
	const s = [0, 0, 0];
	let n = 0;
	for (let i = 0; i < img.data.length; i += 4) {
		if (img.data[i + 3]! < 250) continue;
		for (let k = 0; k < 3; k++) s[k]! += img.data[i + k]!;
		n++;
	}
	return s.map((v) => v / Math.max(1, n)) as [number, number, number];
};

const difference = (a: LookImage, b: LookImage) => {
	let sum = 0;
	for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!);
	return sum / a.data.length;
};

describe.runIf(!!CHROME && process.env.FX_GL !== '0')('Title Look finishes', { timeout: 180_000 }, () => {
	let tl: LookPage;

	beforeAll(async () => {
		tl = await openLookPage(here);
	}, 120_000);

	afterAll(async () => {
		await tl?.browser.close();
	});

	const render = (recipe: LookRecipe, over: Partial<LookRequest> = {}) =>
		tl.render({ recipe, input: TEXT, box: BOX, ...over });

	it.runIf(!!process.env.TL_SHEET)('writes the contact sheet', { timeout: 600_000 }, async () => {
		const metals = ['gold', 'silver', 'chrome', 'copper', 'brushed'];
		const tiles: { label: string; recipe: LookRecipe; over?: Partial<LookRequest> }[] = [
			...metals.map((m) => ({ label: `metal ${m}`, recipe: face('metal', { metalKind: m }) })),
			...TL_ENV_PRESETS.map((e) => ({
				label: `chrome in ${e}`,
				recipe: face('metal', { metalKind: 'chrome', metalEnv: e }),
			})),
			...TL_ENV_PRESETS.map((e) => ({
				label: `reflection ${e}`,
				recipe: face('reflection', { reflectionEnv: e }, flat(0.2, 0.3, 0.8)),
			})),
			{ label: 'glass', recipe: { palette, layers: [{ type: 'plate', params: { grow: 0, paint: flat(0.15, 0.17, 0.2) } }, { type: 'face', params: { finish: 'glass', paint: flat(0.3, 0.6, 1) } }] } },
			{ label: 'gradient map', recipe: face('gradientMap') },
			{ label: 'gloss', recipe: face('gloss', {}, flat(0.8, 0.1, 0.15)) },
			...TL_PROFILES.map((p) => ({
				label: `bevel ${p}`,
				recipe: face(
					'bevel',
					{
						bevelProfile: p,
						bevelSize: 10,
						bevelCurve: {
							curve: [
								[0, 0],
								[0.4, 1],
								[0.6, 0.3],
								[1, 1],
							],
						},
					},
					flat(0.8, 0.25, 0.2),
				),
			})),
			{ label: 'bevel fit', recipe: face('bevel', { bevelFit: true, bevelDepth: 180 }, flat(0.3, 0.7, 0.4)) },
			{ label: 'satin', recipe: face('satin', {}, flat(0.75, 0.2, 0.3)) },
			...TL_PATTERN_KINDS.filter((k) => k !== 'image').map((k) => ({
				label: `pattern ${k}`,
				recipe: face('pattern', { patternKind: k }, flat(0.95, 0.85, 0.5)),
			})),
			{ label: 'inline', recipe: { palette, layers: [{ type: 'face' }, { type: 'inline', params: { inset: 3, width: 2.5, paint: flat(0.1, 0.1, 0.3) } }] } },
			{ label: 'bevelled rim', recipe: { palette, layers: [{ type: 'rim', params: { width: 8, finish: 'bevel', bevelFit: true, bevelDepth: 200, paint: flat(0.2, 0.3, 0.7) } }, { type: 'face' }] } },
			{ label: 'chrome rim', recipe: { palette, layers: [{ type: 'rim', params: { width: 9, finish: 'metal' } }, { type: 'face', params: { paint: flat(0.1, 0.1, 0.15) } }] } },
			...['contour', 'hull', 'box', 'slant', 'pill'].map((k) => ({
				label: `plate ${k}`,
				recipe: { palette, layers: [{ type: 'plate', params: { kind: k } }, { type: 'face' }] } as LookRecipe,
			})),
			{ label: 'gold plate', recipe: { palette, layers: [{ type: 'plate', params: { kind: 'slant', finish: 'metal', metalKind: 'gold', metalFit: false, metalSize: 3 } }, { type: 'face', params: { paint: flat(0.1, 0.05, 0.05) } }] } },
			{ label: 'sheen', recipe: { palette, layers: [{ type: 'face' }, { type: 'sheen' }] } },
			{ label: 'gloss layer', recipe: { palette, layers: [{ type: 'rim', params: { width: 5 } }, { type: 'face' }, { type: 'gloss' }] } },
			{ label: 'texture noise', recipe: { palette, layers: [{ type: 'face' }, { type: 'texture' }] } },
			{ label: 'texture grain', recipe: { palette, layers: [{ type: 'face' }, { type: 'texture', params: { kind: 'grain', scale: 0.8, amount: 70 } }] } },
			{ label: 'texture pattern', recipe: { palette, layers: [{ type: 'face' }, { type: 'texture', params: { kind: 'pattern', motif: 'leopard', amount: 100, scale: 16 } }] } },
			{ label: 'dry brush', recipe: { palette, layers: [{ type: 'rim', params: { width: 5 } }, { type: 'face' }, { type: 'texture', params: { kind: 'erosion', amount: 60, scale: 1.2 } }] } },
		];
		const out = [];
		for (const t of tiles) out.push({ label: t.label, image: await render(t.recipe, t.over) });
		await writeSheet(tl, process.env.TL_SHEET!, out, 5, 340, 170);
	});
});

export const unused = { lumaSpread, meanRgb, difference, pixel, ssim, layerCrop, lumaOver, resampleLuma, SHAPES };
export type { SpanGlyph };
