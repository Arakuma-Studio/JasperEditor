// Contact sheets of looks: labelled tiles over a mid grey, for looking at finishes with your own eyes. Pixels that pass an
// assertion can still read as flat grey. `pnpm exec vitest run packages/compositions/test/title-look-finishes-gl.test.ts` with
// TL_SHEET=<file.png> writes the sheet of every finish and layer type.
import { writeFileSync } from 'node:fs';
import { encodePng } from '@jasper/testkit/png';
import type { LookImage, LookPage } from './title-look-harness.ts';
import { over } from './title-look-harness.ts';

const LABEL_H = 20;

type Tile = { label: string; image: LookImage };

/** `tiles` in rows of `columns`, each cropped or padded to `w`×`h` around its centre, over `bg`. */
export async function writeSheet(
	tl: LookPage,
	file: string,
	tiles: readonly Tile[],
	columns: number,
	w: number,
	h: number,
	bg = 96,
): Promise<void> {
	const rows = Math.ceil(tiles.length / columns);
	const W = columns * w;
	const H = rows * (h + LABEL_H);
	const data = new Uint8Array(W * H * 4).fill(255);
	for (let t = 0; t < tiles.length; t++) {
		const tile = tiles[t]!;
		const ox = (t % columns) * w;
		const oy = Math.floor(t / columns) * (h + LABEL_H);
		const label = await tl.label(tile.label, w, LABEL_H);
		for (let y = 0; y < LABEL_H; y++)
			data.set(label.subarray(y * w * 4, (y + 1) * w * 4), (oy + y) * W * 4 + ox * 4);
		const flat = over(tile.image, bg);
		const dx = Math.round((tile.image.width - w) / 2);
		const dy = Math.round((tile.image.height - h) / 2);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const sx = x + dx;
				const sy = y + dy;
				const at = (oy + LABEL_H + y) * W * 4 + (ox + x) * 4;
				if (sx < 0 || sy < 0 || sx >= tile.image.width || sy >= tile.image.height) {
					data[at] = data[at + 1] = data[at + 2] = bg;
					continue;
				}
				const from = (sy * tile.image.width + sx) * 4;
				data[at] = flat[from]!;
				data[at + 1] = flat[from + 1]!;
				data[at + 2] = flat[from + 2]!;
			}
	}
	writeFileSync(file, encodePng({ width: W, height: H, data }));
}
