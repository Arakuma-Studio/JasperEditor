// @vitest-environment node
// Spec 19 §14 library check: every factory look on a real title, in its own bundled font, through the real planner and
// WebGL2. Each tile must draw and must not clip at its padding. `TITLE_LOOKS_SHEET=<png>` writes the contact sheet; set
// `TITLE_LOOKS_COLORWAY=<colorway id>` to see the whole library in one colourway.

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
} from '@jasper/project';
import { encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, type LookImage, type LookPage, openLookPage } from './title-look-harness.ts';

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

		it('draws every look without clipping, and the sheet can be written', async () => {
			const way = process.env.TITLE_LOOKS_COLORWAY
				? factoryColorway(process.env.TITLE_LOOKS_COLORWAY)
				: undefined;
			const rows = Math.ceil(FACTORY_LOOKS.length / COLS);
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
			for (const [i, l] of FACTORY_LOOKS.entries()) {
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
