// @vitest-environment node
// Contact sheets of the generators (spec 19 §7): short sequences of every generator as a look layer and as a standalone
// effect, written as PNGs to look at. Motion has to read as fire, smoke or lightning, not as noise, and no assertion
// sees that. `GEN_SHEETS=1 [GEN_ONLY=fire,smoke] [GEN_DIR=…] pnpm exec vitest run <this file> --maxWorkers=1`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LookRecipe, TITLE_GENERATORS } from '@jasper/project';
import { encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { CHROME, type LookImage, type LookPage, openLookPage } from './title-look-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.GEN_DIR ?? '/tmp/title-looks/sheets';
const ONLY = process.env.GEN_ONLY?.split(',') ?? null;
const BG = [18, 20, 30];
/** Seconds of a sheet: a strip that shows motion between neighbours and over a longer span. */
const TIMES = [0, 0.1, 0.2, 0.3, 0.6, 1.2];

type Tile = { img: LookImage };

/** Tiles side by side over a dark ground, at one tile size (the largest of each row is the row height). */
function sheet(rows: Tile[][], gap = 6): Buffer {
	const widths = rows.map((r) => r.reduce((w, t) => w + t.img.width + gap, gap));
	const heights = rows.map((r) => Math.max(...r.map((t) => t.img.height)) + gap);
	const width = Math.max(...widths);
	const height = heights.reduce((a, b) => a + b, gap);
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = 40;
		data[i + 1] = 40;
		data[i + 2] = 44;
		data[i + 3] = 255;
	}
	let y0 = gap;
	rows.forEach((row, ri) => {
		let x0 = gap;
		for (const { img } of row) {
			for (let y = 0; y < img.height; y++)
				for (let x = 0; x < img.width; x++) {
					const s = (y * img.width + x) * 4;
					const d = ((y0 + y) * width + x0 + x) * 4;
					const a = img.data[s + 3]! / 255;
					for (let k = 0; k < 3; k++) data[d + k] = img.data[s + k]! * a + BG[k]! * (1 - a);
					data[d + 3] = 255;
				}
			x0 += img.width + gap;
		}
		y0 += heights[ri]!;
	});
	return encodePng({ width, height, data });
}

describe.runIf(!!CHROME && process.env.GEN_SHEETS === '1')('generator sheets', { timeout: 900_000 }, () => {
	let tl: LookPage;
	beforeAll(async () => {
		tl = await openLookPage(here);
		mkdirSync(OUT, { recursive: true });
	}, 120_000);
	afterAll(() => tl?.browser.close());

	const FACE = { type: 'face', params: { paint: { kind: 'color', color: [0.95, 0.95, 0.98, 1] } } };
	const palette = { glow: [0.2, 0.75, 1, 1], accent1: [1, 0.25, 0.5, 1], shadow: [0.1, 0.08, 0.2, 1], base: [0.75, 0.7, 0.9, 1] };

	for (const g of TITLE_GENERATORS) {
		if (ONLY && !ONLY.includes(g.id)) continue;
		it(g.id, async () => {
			const rows: Tile[][] = [];
			const presets = g.presets?.length ? g.presets : [{ id: 'default', label: 'Default', params: {} }];
			// Each preset as a look layer on text.
			for (const preset of presets.slice(0, 4)) {
				const row: Tile[] = [];
				for (const t of TIMES.slice(0, preset === presets[0] ? 6 : 3)) {
					const recipe = {
						palette,
						layers: g.front
							? [FACE, { type: `generator:${g.id}`, params: { ownColors: true, ...preset.params } }]
							: [{ type: `generator:${g.id}`, params: { ownColors: true, ...preset.params } }, FACE],
					} as unknown as LookRecipe;
					const img = await tl.render({
						recipe,
						input: { kind: 'text', text: 'TITLE', size: 84 },
						box: { width: 300, height: 110 },
						contentSeconds: t,
					});
					row.push({ img });
				}
				rows.push(row);
			}
			// The look's palette through the luma map, and the standalone effect.
			const recolor: Tile[] = [];
			for (const t of [0.2, 0.6]) {
				const recipe = {
					palette,
					layers: g.front
						? [FACE, { type: `generator:${g.id}`, params: { ownColors: false } }]
						: [{ type: `generator:${g.id}`, params: { ownColors: false } }, FACE],
				} as unknown as LookRecipe;
				recolor.push({
					img: await tl.render({
						recipe,
						input: { kind: 'text', text: 'TITLE', size: 84 },
						box: { width: 300, height: 110 },
						contentSeconds: t,
					}),
				});
			}
			for (const f of [0, 12]) {
				recolor.push({
					img: await tl.renderEffect({
						effectId: `jasper.generator.${g.id}`,
						box: { width: 480, height: 270 },
						frame: f,
					}),
				});
			}
			rows.push(recolor);
			writeFileSync(join(OUT, `generators-${g.id}.png`), sheet(rows));
		});
	}
});
