// The contact sheet of the glows stream: every layer type and effect on a dark ground, labelled, for looking at.
// TL_SHEET=/path/to.png pnpm exec vitest run packages/compositions/test/title-look-glows-gl.test.ts -t "contact sheet"
import { writeFileSync } from 'node:fs';
import { encodePng } from '@jasper/testkit/png';
import type { LookImage, LookPage } from './title-look-harness.ts';

export type SheetTile = { label: string; img: LookImage; bg?: number };

const TILE = { w: 340, h: 220 };

/** A tile: the image centred on its layer box, over a ground of `bg` (the ground a sequence would composite it on). */
function paste(sheet: Uint8Array, W: number, x0: number, y0: number, t: SheetTile) {
	const bg = t.bg ?? 18;
	const { img } = t;
	const cx = Math.round(img.box.x + img.box.w / 2);
	const cy = Math.round(img.box.y + img.box.h / 2);
	for (let y = 0; y < TILE.h; y++)
		for (let x = 0; x < TILE.w; x++) {
			const sx = cx - TILE.w / 2 + x;
			const sy = cy - TILE.h / 2 + y;
			const o = ((y0 + y) * W + x0 + x) * 4;
			const inside = sx >= 0 && sy >= 0 && sx < img.width && sy < img.height;
			const i = (sy * img.width + sx) * 4;
			const a = inside ? img.data[i + 3]! / 255 : 0;
			// A sequence composites the signal: premultiplied `data` over the ground, as the Program does.
			for (let k = 0; k < 3; k++)
				sheet[o + k] = Math.round((inside ? img.data[i + k]! * a : 0) + bg * (1 - a));
			sheet[o + 3] = 255;
		}
}

export async function writeSheet(tl: LookPage, path: string, tiles: readonly SheetTile[], columns = 4) {
	const rows = Math.ceil(tiles.length / columns);
	const W = columns * TILE.w;
	const H = rows * TILE.h;
	const sheet = new Uint8Array(W * H * 4);
	tiles.forEach((t, i) => {
		paste(sheet, W, (i % columns) * TILE.w, Math.floor(i / columns) * TILE.h, t);
	});
	const png = encodePng({ width: W, height: H, data: sheet }).toString('base64');
	const labelled = await tl.page.evaluate(
		async ([b64, labels, cols, tw, th]) => {
			const img = new Image();
			img.src = `data:image/png;base64,${b64}`;
			await img.decode();
			const c = document.createElement('canvas');
			c.width = img.width;
			c.height = img.height;
			const ctx = c.getContext('2d')!;
			ctx.drawImage(img, 0, 0);
			ctx.font = '12px "Liberation Sans", Arial, sans-serif';
			(labels as string[]).forEach((l, i) => {
				const x = (i % (cols as number)) * (tw as number) + 6;
				const y = Math.floor(i / (cols as number)) * (th as number) + 15;
				ctx.fillStyle = 'rgba(0,0,0,0.7)';
				ctx.fillRect(x - 3, y - 12, ctx.measureText(l).width + 6, 16);
				ctx.fillStyle = '#fff';
				ctx.fillText(l, x, y);
			});
			return c.toDataURL('image/png').slice('data:image/png;base64,'.length);
		},
		[png, tiles.map((t) => t.label), columns, TILE.w, TILE.h] as const,
	);
	writeFileSync(path, Buffer.from(labelled, 'base64'));
}
