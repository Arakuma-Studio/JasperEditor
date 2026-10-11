// Every export path applies outputFilters before the encoder's pixel format. The working-to-output LUT
// uses the same outputTransformFn as the preview display stage.
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportSettings } from '@jasper/api';
import {
	bakeLut,
	type ColorSpaceDef,
	colorSpace,
	defaultWorkingSettings,
	displaySpaceFor,
	isHdrSpace,
	type OutputSpaceId,
	outputTransformFn,
	type SequenceColorInfo,
	serializeCube,
} from '@jasper/project';
import { quoteFilterPath } from './extension.ts';

export type ExportHdrMetadata = {
	/** Mastering display: primaries, peak and black (cd/m²). */
	masteringDisplay: { primaries: 'bt2020' | 'p3d65' | 'bt709'; maxNits: number; minNits: number };
	maxCll?: number;
	maxFall?: number;
};

export type ExportColor = {
	space: ColorSpaceDef;
	/** The working space it is converted from. */
	working: SequenceColorInfo;
	/** ffmpeg tag names (`-color_primaries`, `-color_trc`, `-colorspace`). */
	tags: { primaries: string; trc: string; matrix: string };
	/** ITU-T H.273 code points of the tags (bitstream filters, AV1 sequence header). */
	codes: { primaries: number; trc: number; matrix: number };
	/** swscale `out_color_matrix` name. */
	swsMatrix: 'bt709' | 'bt2020';
	bitDepth: 8 | 10 | 12;
	hdr: ExportHdrMetadata | null;
	/** Working → output differ (a LUT is applied before the YUV conversion). */
	converts: boolean;
};

const PRIMARY_CODES: Record<string, number> = { bt709: 1, bt2020: 9, smpte431: 11, smpte432: 12 };
const TRC_CODES: Record<string, number> = {
	bt709: 1,
	linear: 8,
	'iec61966-2-1': 13,
	'bt2020-10': 14,
	'bt2020-12': 15,
	smpte2084: 16,
	'arib-std-b67': 18,
};
const MATRIX_CODES: Record<string, number> = { bt709: 1, bt2020nc: 9 };

/** Encoders that write more than 8 bits per component, and their maximum. */
const DEEP_ENCODERS: Record<string, 10 | 12> = {
	prores_ks: 10,
	libsvtav1: 10,
	'libaom-av1': 12,
	'libvpx-vp9': 12,
	// gaps (EX-2): hardware HEVC Main10 (libkvazaar in the LGPL build is 8-bit only).
	hevc_videotoolbox: 10,
	hevc_nvenc: 10,
	hevc_qsv: 10,
	hevc_amf: 10,
	hevc_vaapi: 10,
};

export class ExportColorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ExportColorError';
	}
}

/** The output colour of an export (throws `ExportColorError` for impossible combinations). */
export function exportColorOf(
	video: Pick<NonNullable<ExportSettings['video']>, 'colorSpace' | 'bitDepth' | 'hdrMetadata'> | undefined,
	working: SequenceColorInfo | undefined,
	encoder: string | null,
): ExportColor {
	const w: SequenceColorInfo = working ?? {
		...defaultWorkingSettings('rec709'),
		linearize: false,
		blendLinear: false,
	};
	const id =
		!video?.colorSpace || video.colorSpace === 'working' ? w.space : (video.colorSpace as OutputSpaceId);
	const space = colorSpace(id);
	if (!space?.tags) throw new ExportColorError(`"${id}" is not an export colour space`);
	const hdr = isHdrSpace(space);
	const max = encoder ? (DEEP_ENCODERS[encoder] ?? 8) : 8;
	const bitDepth = video?.bitDepth ?? (encoder === 'prores_ks' ? 10 : hdr && max >= 10 ? 10 : 8);
	if (bitDepth > max)
		throw new ExportColorError(
			`${encoder ?? 'This encoder'} writes ${max}-bit video; ${bitDepth}-bit needs ProRes, AV1, VP9 or a hardware HEVC encoder (Main10)`,
		);
	let trc = space.tags.trc;
	// BT.2020 SDR at 10/12 bits carries the BT.2020 transfer code of its depth (H.273: same curve as BT.709).
	if (space.id === 'rec2020' && bitDepth >= 10) trc = bitDepth === 12 ? 'bt2020-12' : 'bt2020-10';
	const tags = { ...space.tags, trc };
	const md = video?.hdrMetadata?.masteringDisplay;
	return {
		space,
		working: w,
		tags,
		codes: {
			primaries: PRIMARY_CODES[tags.primaries] ?? 2,
			trc: TRC_CODES[tags.trc] ?? 2,
			matrix: MATRIX_CODES[tags.matrix] ?? 2,
		},
		swsMatrix: tags.matrix === 'bt2020nc' ? 'bt2020' : 'bt709',
		bitDepth,
		hdr: hdr
			? {
					masteringDisplay: md ?? {
						primaries: space.gamut === 'p3d65' ? 'p3d65' : 'bt2020',
						maxNits: space.kind === 'hlg' ? 1000 : w.hdrPeakNits,
						minNits: 0.0001,
					},
					...(video?.hdrMetadata?.maxCll ? { maxCll: video.hdrMetadata.maxCll } : {}),
					...(video?.hdrMetadata?.maxFall ? { maxFall: video.hdrMetadata.maxFall } : {}),
				}
			: null,
		converts: !!outputTransformFn(w, space),
	};
}

/** `setparams` stamping the output tags on every frame (the encoders read the frame's properties). */
export function frameTagsFilter(c: Pick<ExportColor, 'tags'>): string {
	return `setparams=color_primaries=${c.tags.primaries}:color_trc=${c.tags.trc}:colorspace=${c.tags.matrix}:range=tv`;
}

/** `-colorspace … -color_primaries … -color_trc … -color_range tv` */
export function colorTagArgs(c: Pick<ExportColor, 'tags'>): string[] {
	return [
		'-colorspace',
		c.tags.matrix,
		'-color_primaries',
		c.tags.primaries,
		'-color_trc',
		c.tags.trc,
		'-color_range',
		'tv',
	];
}

/** Lattice of output conversion LUTs (HDR ↔ SDR conversions are steep: 65³). */
function outputLutSize(c: ExportColor): number {
	const wHdr = isHdrSpace(colorSpace(c.working.space)!);
	return wHdr !== isHdrSpace(c.space) ? 65 : 33;
}

/** 8-bit `lut3d` stores truncate: tables are written +0.5/255 so they round to nearest (as the colour extension). */
const ROUNDING_BIAS = 0.5 / 255;

/**
 * Bakes the working → output conversion into a content-addressed `.cube` under `dir` (null when the output is the
 * working space). The filter text is `lut3d=file=…:interp=tetrahedral` on 8-bit RGBA.
 */
export async function outputLutFilter(c: ExportColor, dir: string): Promise<string | null> {
	const fn = outputTransformFn(c.working, c.space);
	if (!fn) return null;
	const lut = bakeLut(outputLutSize(c), fn, `JasperEditor output ${c.working.space} → ${c.space.id}`);
	return writeCubeFilter(lut, dir);
}

/**
 * The output conversion of the encoded video, appended after rate/size: the output LUT (if any), the YUV matrix
 * and range, the tags. `lutFilter` from `outputLutFilter`.
 */
export function outputFilters(c: ExportColor, lutFilter: string | null, swsFlags: string): string[] {
	return [
		...(lutFilter ? ['format=rgba', lutFilter] : []),
		`scale=out_color_matrix=${c.swsMatrix}:out_range=tv:${swsFlags}`,
		'setsar=1',
		frameTagsFilter(c),
	];
}

/** SVT-AV1 `mastering-display` / `content-light` parameters (in-band AV1 metadata OBUs). */
export function svtHdrParams(c: ExportColor): string | null {
	if (!c.hdr) return null;
	const p = MASTERING_PRIMARIES[c.hdr.masteringDisplay.primaries];
	const f = (v: number) => v.toFixed(4);
	const parts = [
		`mastering-display=G(${f(p.g[0])},${f(p.g[1])})B(${f(p.b[0])},${f(p.b[1])})R(${f(p.r[0])},${f(p.r[1])})WP(0.3127,0.3290)L(${c.hdr.masteringDisplay.maxNits},${c.hdr.masteringDisplay.minNits})`,
	];
	if (c.hdr.maxCll !== undefined || c.hdr.maxFall !== undefined)
		parts.push(`content-light=${c.hdr.maxCll ?? 0},${c.hdr.maxFall ?? 0}`);
	return parts.join(':');
}

/** Mastering display primaries (CIE xy) of the choices. */
export const MASTERING_PRIMARIES = {
	bt2020: { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046] },
	p3d65: { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06] },
	bt709: { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06] },
} as const;

/** Stills (Export Frame, `render_frame`): the display rendition of the working space (identity for Rec. 709 / sRGB). */
export async function displayLutFilter(
	working: SequenceColorInfo | undefined,
	dir: string,
): Promise<string | null> {
	if (!working) return null;
	const fn = outputTransformFn(working, displaySpaceFor(working.space));
	if (!fn) return null;
	const wHdr = isHdrSpace(colorSpace(working.space)!);
	const lut = bakeLut(wHdr ? 65 : 33, fn, `JasperEditor display ${working.space}`);
	return writeCubeFilter(lut, dir);
}

async function writeCubeFilter(lut: ReturnType<typeof bakeLut>, dir: string): Promise<string> {
	const text = serializeCube({ ...lut, data: lut.data.map((v) => v + ROUNDING_BIAS) });
	const file = join(dir, `${createHash('sha256').update(text).digest('hex')}.cube`);
	await mkdir(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.partial`;
	await writeFile(tmp, text);
	await rename(tmp, file);
	return `lut3d=file=${quoteFilterPath(file)}:interp=tetrahedral`;
}

/** Whether an export output is plain 8-bit BT.709 SDR (what every path wrote before colour management). */
export function isPlainRec709Output(c: ExportColor | undefined): boolean {
	return !c || (c.space.id === 'rec709' && !c.converts && c.bitDepth === 8);
}
