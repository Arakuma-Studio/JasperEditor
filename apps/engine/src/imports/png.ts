// Raw RGBA → PNG through ffmpeg (imports workstream): layered documents' layers and composites. 8-bit sources write
// `rgba` PNGs, deeper ones `rgba64be` (16-bit) so nothing is lost; straight (unpremultiplied) alpha.
import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import type { SpawnOptions } from '../tools/process.ts';

export type RgbaImage = {
	width: number;
	height: number;
	/** 8-bit: 4 bytes per pixel; 16-bit: 4 little-endian uint16 per pixel. */
	bits: 8 | 16;
	data: Uint8Array | Uint16Array;
};

/** Writes `img` as a PNG at `out` (atomic: temp file + rename). */
export async function writeRgbaPng(ff: Ffmpeg, img: RgbaImage, out: string, opts: SpawnOptions = {}): Promise<void> {
	if (img.width < 1 || img.height < 1) throw new Error('Empty image');
	const tag = randomBytes(4).toString('hex');
	const raw = `${out}.${tag}.rgba`;
	const tmp = `${out}.${tag}.partial.png`;
	const bytes =
		img.bits === 8
			? Buffer.from(img.data.buffer, img.data.byteOffset, img.width * img.height * 4)
			: Buffer.from(img.data.buffer, img.data.byteOffset, img.width * img.height * 8);
	try {
		await writeFile(raw, bytes);
		await ff.run(
			[
				'-f',
				'rawvideo',
				'-pix_fmt',
				img.bits === 8 ? 'rgba' : 'rgba64le',
				'-s',
				`${img.width}x${img.height}`,
				'-i',
				raw,
				'-frames:v',
				'1',
				'-pix_fmt',
				img.bits === 8 ? 'rgba' : 'rgba64be',
				'-f',
				'image2',
				'-c:v',
				'png',
				tmp,
			],
			opts,
		);
		await rename(tmp, out);
	} finally {
		await rm(raw, { force: true });
		await rm(tmp, { force: true });
	}
}
