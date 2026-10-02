// ffmpeg-filter steps (S07:PST-004, PST-020, PST-021): deblock, denoise and the deshake fallback. Only LGPL
// filters (ARCHITECTURE D-13 M2 note); `assertLgplFilters` guards every generated filter text.
import type { ProcessStep } from '@jasper/project';
import type { FilterStep, StepContext } from './types.ts';

/**
 * Filters that exist only in GPL builds and must never appear in generated filter text (D-13 M2 note). Checked
 * against the LGPL FFmpeg 7.1 build: none of these is present there (apps/engine/test/processing-steps.test.ts).
 */
export const GPL_FILTERS = [
	'eq',
	'hqdn3d',
	'perspective',
	'boxblur',
	'smartblur',
	'delogo',
	'frei0r',
	'spp',
	'pp7',
	'uspp',
	'fspp',
	'mpdecimate',
	'pullup',
	'vidstabdetect',
	'vidstabtransform',
	'pp',
	'owdenoise',
	'mcdeint',
	'sab',
	'repeatfields',
	'phase',
	'kerndeint',
	'ocr',
	'stereo3d',
	'super2xsai',
	'tinterlace',
	'interlace',
	'cropdetect',
	'blackframe',
	'colormatrix',
	'histeq',
	'mptestsrc',
];

/** Filter names used in a filtergraph text (the token before `=` / `,` / `;` / `[`). */
function filterNames(graph: string): string[] {
	const out: string[] = [];
	// Quoted option values (geq expressions) may contain commas: drop them before splitting.
	for (const part of graph.replace(/'[^']*'/g, "''").split(/[,;]/)) {
		const m = /^\s*(?:\[[^\]]*\]\s*)*([a-z0-9_]+)/i.exec(part);
		if (m) out.push(m[1]);
	}
	return out;
}

/**
 * Throws when a filter text uses a GPL-only filter. `vidstab*` filters are allowed only when `allowVidstab`
 * (the engine's FFmpeg is our LGPL build with the pinned relicensed vid.stab, S07:PST-003).
 */
export function assertLgplFilters(graph: string, opts: { allowVidstab?: boolean } = {}): void {
	for (const name of filterNames(graph)) {
		if (opts.allowVidstab && /^vidstab(detect|transform)$/.test(name)) continue;
		if (GPL_FILTERS.includes(name)) throw new Error(`GPL-only filter "${name}" in generated filter text`);
	}
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function denoiseFilter(step: Extract<ProcessStep, { op: 'denoise' }>): {
	filter: string;
	format: FilterStep['format'];
} {
	const s = Math.min(1, Math.max(0, step.strength));
	switch (step.method) {
		case 'atadenoise': {
			const a = r3(0.02 + 0.08 * s);
			const b = r3(0.04 + 0.16 * s);
			return {
				filter: `atadenoise=0a=${a}:1a=${a}:2a=${a}:0b=${b}:1b=${b}:2b=${b}:s=9`,
				format: 'yuv444p16le',
			};
		}
		case 'fftdnoiz':
			return { filter: `fftdnoiz=sigma=${r3(2 + 10 * s)}:prev=1:next=1`, format: 'yuv444p16le' };
		case 'nlmeans':
			// nlmeans is 8-bit only.
			return { filter: `nlmeans=s=${r3(1 + 7 * s)}:p=7:r=15`, format: 'yuv444p' };
	}
}

export function createDenoiseStep(step: Extract<ProcessStep, { op: 'denoise' }>): FilterStep {
	const { filter, format } = denoiseFilter(step);
	return { name: `denoise(${step.method})`, format, filter: () => filter };
}

export function createDeblockStep(step: Extract<ProcessStep, { op: 'deblock' }>): FilterStep {
	const f = `deblock=filter=${step.filter}:block=${step.block ?? 8}`;
	return { name: 'deblock', format: 'yuv444p16le', filter: () => f };
}

/** Fixed centre crop of the deshake fallback for `borders: 'crop'` (deshake has no optimal zoom). */
const DESHAKE_CROP = 0.04;

/**
 * deshake works on 8-bit YUV only, and its `edge=blank` fills uncovered pixels with 0 in EVERY plane — green in
 * YUV (U = V = 0), not black. So the step runs deshake on the R'G'B' planes carried in a yuv444p frame
 * (`mergeplanes` only relabels the planes: G→Y, B→U, R→V, no conversion): blank is then true black, motion is
 * estimated on G, and no YUV range is involved at all — FFmpeg 6.1 converted the full-range yuv444p of the
 * former crop + scale to TV range, which the next stage read as full range (blacks 16, whites 235; measured).
 */
function deshakeFilter(
	step: Extract<ProcessStep, { op: 'stabilize' }>,
	size: { width: number; height: number },
): string {
	const edge = step.borders === 'crop' ? 'clamp' : 'blank';
	const parts = [
		'format=gbrp',
		'mergeplanes=0x000102:yuv444p',
		`deshake=edge=${edge}:rx=32:ry=32:blocksize=8:contrast=125`,
		'mergeplanes=0x000102:gbrp',
	];
	if (step.borders === 'crop') {
		// Crop 4 % (even sizes) centred, then scale back to the input size (in RGB: no range to lose).
		const cw = Math.round((size.width * (1 - DESHAKE_CROP)) / 2) * 2;
		const ch = Math.round((size.height * (1 - DESHAKE_CROP)) / 2) * 2;
		parts.push(
			`crop=${cw}:${ch}:${(size.width - cw) / 2}:${(size.height - ch) / 2}`,
			`scale=${size.width}:${size.height}:flags=bicubic:in_range=pc:out_range=pc`,
		);
	}
	return parts.join(',');
}

export function createDeshakeStep(step: Extract<ProcessStep, { op: 'stabilize' }>): FilterStep {
	return {
		name: 'stabilize(deshake)',
		// 16-bit RGB in; the filter goes to 8-bit planar RGB for deshake (8-bit only) and back.
		format: 'rgb48le',
		filter: (ctx: StepContext) => deshakeFilter(step, ctx),
	};
}

/** rgb48le/any → the filter's working format (full-range BT.709 for YUV). */
export function toFormat(format: FilterStep['format'], fromYuvMatrix?: string, fromRange?: string): string {
	if (format === 'rgb48le' || format === 'gbrp16le')
		return `scale=${fromYuvMatrix ? `in_color_matrix=${fromYuvMatrix}:in_range=${fromRange ?? 'tv'}:` : ''}out_range=pc:flags=accurate_rnd+full_chroma_int+full_chroma_inp,format=${format}`;
	return `scale=${fromYuvMatrix ? `in_color_matrix=${fromYuvMatrix}:in_range=${fromRange ?? 'tv'}:` : ''}out_color_matrix=bt709:out_range=pc:flags=accurate_rnd+full_chroma_int+full_chroma_inp,format=${format}`;
}

/** Working format (after `toFormat`) → rgb48le full-range BT.709 R'G'B'. */
export function fromFormatToRgb48(format: FilterStep['format']): string {
	if (format === 'rgb48le' || format === 'gbrp16le') return 'format=rgb48le';
	return 'scale=in_color_matrix=bt709:in_range=pc:out_range=pc:flags=accurate_rnd+full_chroma_int+full_chroma_inp,format=rgb48le';
}
