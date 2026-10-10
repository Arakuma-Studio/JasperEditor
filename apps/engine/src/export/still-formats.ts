// File ▸ Export ▸ Frame (workstream gaps, docs/wp-notes/gaps.md §EX-3): the rendered PNG still converted to the
// format the user chose. 8-bit RGB for JPEG / TIFF / BMP / Targa, 10-bit RGB DPX, and OpenEXR in linear light: the
// display-referred still is linearised with the working space's own EOTF (BT.1886 ≈ γ2.4 for Rec. 709, the sRGB
// curve for sRGB, γ2.6 for DCI-P3, γ2.2) — the inverse of what the Program monitor displays — and written as half
// floats with ZIP compression, BT.709 primaries.
import type { ChildProcess } from 'node:child_process';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StillFormat } from '@jasper/api';
import { colorSpace } from '@jasper/project';
import type { Ffmpeg } from '../tools/ffmpeg.ts';

export type StillCurve = 'bt1886' | 'srgb' | 'gamma26' | 'gamma22';

/** EOTF of a display curve (signal 0..1 → linear light 0..1). */
export function eotf(curve: StillCurve, v: number): number {
	const x = Math.min(1, Math.max(0, v));
	switch (curve) {
		case 'srgb':
			return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
		case 'gamma26':
			return x ** 2.6;
		case 'gamma22':
			return x ** 2.2;
		default:
			return x ** 2.4;
	}
}

/** The display curve of the still of a sequence in `workingSpace` (HDR spaces are shown as Rec. 709 / BT.1886). */
export function stillCurveFor(workingSpace: string | undefined): StillCurve {
	const c = workingSpace ? colorSpace(workingSpace) : undefined;
	if (c?.kind !== 'sdr') return 'bt1886';
	return c.curve === 'srgb' || c.curve === 'gamma26' || c.curve === 'gamma22' ? c.curve : 'bt1886';
}

/** Largest still the EXR path linearises in memory (8K UHD). */
const MAX_EXR_PIXELS = 7680 * 4320;

type Opts = {
	jpegQuality?: number;
	curve: StillCurve;
	scratch: string;
	signal?: AbortSignal;
	onSpawn?: (child: ChildProcess) => void;
};

/** ffmpeg -q:v for a 1–100 JPEG quality (100 → 2, 1 → 31). */
export function jpegQscale(quality = 90): number {
	const q = Math.min(100, Math.max(1, Math.round(quality)));
	return Math.round(31 - ((q - 1) / 99) * 29);
}

/** Encoder arguments for the 8/10-bit formats (after `-i <png>`). */
export function stillEncodeArgs(format: Exclude<StillFormat, 'png' | 'exr'>, jpegQuality?: number): string[] {
	switch (format) {
		case 'jpeg':
			return [
				'-c:v',
				'mjpeg',
				'-pix_fmt',
				'yuvj444p',
				'-q:v',
				String(jpegQscale(jpegQuality)),
				'-f',
				'image2',
			];
		case 'tiff':
			return ['-c:v', 'tiff', '-pix_fmt', 'rgb24', '-compression_algo', 'lzw', '-f', 'image2'];
		case 'dpx':
			return ['-c:v', 'dpx', '-pix_fmt', 'gbrp10le', '-f', 'image2'];
		case 'bmp':
			return ['-c:v', 'bmp', '-pix_fmt', 'bgr24', '-f', 'image2'];
		case 'tga':
			return ['-c:v', 'targa', '-pix_fmt', 'bgr24', '-f', 'image2'];
	}
}

async function size(ff: Ffmpeg, file: string, opts: Pick<Opts, 'signal'>): Promise<{ w: number; h: number }> {
	const j = await ff.probeJson(
		['-show_entries', 'stream=width,height', '-select_streams', 'v:0', file],
		opts,
	);
	const s = (j.streams as { width?: number; height?: number }[] | undefined)?.[0];
	const w = Number(s?.width);
	const h = Number(s?.height);
	if (!(w > 0 && h > 0)) throw new Error('The rendered frame has no size');
	return { w, h };
}

/**
 * Converts `png` (the rendered still) to `format` next to it as `<dir>/output.<ext>`; the PNG is removed unless the
 * format is PNG. Returns the path written.
 */
export async function convertStill(
	ff: Ffmpeg,
	png: string,
	format: StillFormat,
	ext: string,
	opts: Opts,
): Promise<string> {
	if (format === 'png') return png;
	const out = join(opts.scratch, `still.${ext}`);
	const run = { signal: opts.signal, ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}) };
	if (format === 'exr') {
		const { w, h } = await size(ff, png, run);
		if (w * h > MAX_EXR_PIXELS) throw new Error('Frames larger than 8K cannot be written as OpenEXR');
		const raw = join(opts.scratch, 'still.rgb');
		await ff.run(['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-frames:v', '1', raw], run);
		const rgb = await readFile(raw);
		if (rgb.length < w * h * 3) throw new Error('The rendered frame is truncated');
		const lut = new Float32Array(256);
		for (let i = 0; i < 256; i++) lut[i] = eotf(opts.curve, i / 255);
		// gbrpf32le: planes G, B, R.
		const planes = new Float32Array(w * h * 3);
		const n = w * h;
		for (let i = 0; i < n; i++) {
			planes[i] = lut[rgb[i * 3 + 1]!]!;
			planes[n + i] = lut[rgb[i * 3 + 2]!]!;
			planes[2 * n + i] = lut[rgb[i * 3]!]!;
		}
		const f32 = join(opts.scratch, 'still.f32');
		await writeFile(f32, Buffer.from(planes.buffer, planes.byteOffset, planes.byteLength));
		await rm(raw, { force: true });
		await ff.run(
			[
				'-f',
				'rawvideo',
				'-pix_fmt',
				'gbrpf32le',
				'-s',
				`${w}x${h}`,
				'-i',
				f32,
				'-frames:v',
				'1',
				'-c:v',
				'exr',
				'-format',
				'half',
				'-compression',
				'zip1',
				'-color_primaries',
				'bt709',
				'-color_trc',
				'linear',
				'-f',
				'image2',
				out,
			],
			run,
		);
		await rm(f32, { force: true });
	} else {
		await ff.run(['-i', png, '-frames:v', '1', ...stillEncodeArgs(format, opts.jpegQuality), out], run);
	}
	if (!(await stat(out)).size) throw new Error(`The ${format} encoder wrote an empty file`);
	const dest = png.replace(/\.png$/, `.${ext}`);
	await rename(out, dest);
	await rm(png, { force: true });
	return dest;
}
