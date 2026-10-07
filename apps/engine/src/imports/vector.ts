// Vector stills on the engine (imports workstream): SVG, PDF and PDF-compatible Illustrator (`.ai`) files register as
// `image` media with a `vector` header (document size; PDF page count and the first page's size). The pictures are
// drawn as vectors by the composition (SVG by the browser's SVG renderer, PDF pages by pdf.js) at the scale they are
// shown at, in the preview, the Remotion renders and the layer bakes of the native export: the engine never
// rasterises them.
import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { EMPTY_PROBE, SvgImportError, svgDocumentSize, type VectorInfo } from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import type { ProbeResult } from '../media/probe.ts';

const MAX_SVG_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 1024 * 1024 * 1024;
/** Largest page dimension accepted (points): 200 inches. */
const MAX_PAGE = 14400;

export const isVectorFileName = (file: string) => /\.(svgz?|pdf|ai)$/i.test(file);

export type PdfPage = { page: number; width: number; height: number };

/** Page sizes (points, `/Rotate` applied, the CropBox pdf.js shows) of a PDF document. */
export async function pdfPages(data: Uint8Array, maxPages = 10_000): Promise<PdfPage[]> {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	let doc: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
	try {
		doc = await pdfjs.getDocument({
			data,
			isEvalSupported: false,
			disableFontFace: true,
			useSystemFonts: false,
			stopAtErrors: false,
			verbosity: 0,
		}).promise;
	} catch (e) {
		const name = (e as { name?: string }).name;
		if (name === 'PasswordException')
			throw new JobError('UNSUPPORTED_MEDIA', 'The PDF is password-protected', false);
		throw new JobError('INVALID_PDF', `Not a readable PDF: ${(e as Error).message?.slice(0, 200)}`, false);
	}
	try {
		const out: PdfPage[] = [];
		const n = Math.min(doc.numPages, maxPages);
		for (let i = 1; i <= n; i++) {
			const p = await doc.getPage(i);
			const v = p.getViewport({ scale: 1 });
			out.push({ page: i, width: v.width, height: v.height });
			p.cleanup();
		}
		return out;
	} finally {
		await doc.destroy();
	}
}

/** True when the bytes start with a PDF header within the first KiB (PDF-compatible Illustrator files do). */
export function looksLikePdf(buf: Uint8Array): boolean {
	const head = Buffer.from(buf.subarray(0, 1024)).toString('latin1');
	return head.includes('%PDF-');
}

/** The text of an SVG file (`.svgz` / gzip-compressed SVG decompressed, bounded). */
export function svgText(buf: Buffer, file: string): string {
	if (/\.svgz$/i.test(file) || (buf[0] === 0x1f && buf[1] === 0x8b)) {
		try {
			return gunzipSync(buf, { maxOutputLength: MAX_SVG_BYTES }).toString('utf8');
		} catch (e) {
			throw new JobError('INVALID_SVG', `The SVGZ does not decompress: ${(e as Error).message}`, false);
		}
	}
	return buf.toString('utf8');
}

/** Probe of a vector file: an `image` (vector) whose stream size is its size at 100 %. */
export async function probeVector(file: string): Promise<ProbeResult> {
	const st = await stat(file);
	const isSvg = /\.svgz?$/i.test(file);
	if (st.size > (isSvg ? MAX_SVG_BYTES : MAX_PDF_BYTES))
		throw new JobError('UNSUPPORTED_MEDIA', 'File too large', false);
	const buf = await readFile(file);
	let vector: VectorInfo;
	if (isSvg) {
		try {
			const s = svgDocumentSize(svgText(buf, file));
			vector = { format: 'svg', width: clampDim(s.width), height: clampDim(s.height), source: 'svg' };
		} catch (e) {
			if (e instanceof SvgImportError) throw new JobError('INVALID_SVG', e.message, false);
			throw e;
		}
	} else {
		if (!looksLikePdf(buf))
			throw new JobError(
				'UNSUPPORTED_MEDIA',
				/\.ai$/i.test(file)
					? 'This Illustrator file is not PDF-compatible: save it with "Create PDF Compatible File" on'
					: 'Not a PDF document',
				false,
			);
		const pages = await pdfPages(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
		if (pages.length === 0) throw new JobError('INVALID_PDF', 'The PDF has no pages', false);
		const first = pages[0]!;
		vector = {
			format: 'pdf',
			width: clampDim(first.width),
			height: clampDim(first.height),
			page: 1,
			pageCount: pages.length,
			source: /\.ai$/i.test(file) ? 'ai' : 'pdf',
		};
	}
	const w = Math.max(1, Math.round(vector.width));
	const h = Math.max(1, Math.round(vector.height));
	return {
		kind: 'image',
		container: vector.source ?? vector.format,
		probe: {
			...EMPTY_PROBE,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: vector.format,
					width: w,
					height: h,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
					pixelFormat: 'rgba',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', range: 'pc' },
					browserDecodable: true,
				},
			],
			hasAlpha: true,
		},
		browserPlayable: 'yes',
		durationSec: null,
		frameCount: null,
		interlaced: false,
		hasVideo: true,
		hasAudio: false,
		display: { width: w, height: h },
		vector,
	};
}

function clampDim(v: number): number {
	if (!Number.isFinite(v) || v <= 0) return 1;
	return Math.min(MAX_PAGE, v);
}
