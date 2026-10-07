/// <reference path="../imports-modules.d.ts" />
// Vector stills (imports workstream, docs/wp-notes/imports.md): SVG files and PDF / Illustrator pages are drawn as
// vectors at the scale they are shown at — SVG by the browser's SVG renderer (`<img>`: sandboxed, no scripts or
// external resources), PDF pages by pdf.js into a canvas — never as a fixed bitmap. The picture is made at
// `vectorRasterScale` × its size (the largest scale Motion gives the layer over the clip, rounded up to a power of
// two) and shown at its size, so zooming in stays sharp. The same component draws the Program monitor, the Remotion
// renders and the layer bakes of the native export.
import type { Animatable, RenderVisualClip } from '@jasper/project';
import { useEffect, useRef, useState } from 'react';
import { cancelRender, continueRender, delayRender, getRemotionEnvironment } from 'remotion';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';

/** Largest picture side made for a vector layer (canvas limits; ≥ 8K covers any 4K frame at 2×). */
export const VECTOR_MAX_SIDE = 8192;

const maxAbs = (a: Animatable<number> | undefined) =>
	a ? Math.max(Math.abs(a.value), ...a.keyframes.map((k) => Math.abs(k.value))) : 1;

/**
 * Picture scale of a vector layer: the largest Motion scale over the clip (its keys; a scale driven by an expression
 * is not known ahead and counts as its static value), rounded up to a power of two, at least 1, at most what keeps the picture ≤ `VECTOR_MAX_SIDE`.
 */
export function vectorRasterScale(
	clip: Pick<RenderVisualClip, 'transform'>,
	box: { width: number; height: number },
): number {
	const tr = clip.transform;
	let s = 1;
	if (tr) {
		const sh = maxAbs(tr.scale) / 100;
		const sw = tr.uniformScale ? sh : maxAbs(tr.scaleWidth) / 100;
		s = Math.max(sh, sw);
	}
	const cap = VECTOR_MAX_SIDE / Math.max(1, box.width, box.height);
	const pow = 2 ** Math.ceil(Math.log2(Math.max(1, s)));
	return Math.max(1, Math.min(cap, pow));
}

export function VectorLayer(layer: LayerProps) {
	const v = layer.media?.vector;
	if (!layer.media || !v) return null;
	return v.format === 'pdf' ? <PdfPicture layer={layer} /> : <SvgPicture layer={layer} />;
}

/** A delayRender held from mount (renders) until `release()` (stable) or unmount. */
function useHold(label: string, when: boolean): () => void {
	const rendering = getRemotionEnvironment().isRendering;
	const [handle] = useState(() => (rendering && when ? delayRender(label) : null));
	const [release] = useState(() => {
		let released = false;
		return () => {
			if (handle !== null && !released) {
				released = true;
				continueRender(handle);
			}
		};
	});
	useEffect(() => release, [release]);
	return release;
}

function SvgPicture({ layer }: { layer: LayerProps }) {
	const url = layer.media?.loaderUrl ?? null;
	const box = layer.props.box;
	const S = vectorRasterScale(layer.clip, box);
	const release = useHold(`SVG ${url}`, !!url);
	const rendering = getRemotionEnvironment().isRendering;
	return (
		<LayerBox layer={layer}>
			{url ? (
				<img
					src={url}
					alt=""
					crossOrigin="anonymous"
					data-vector="svg"
					onLoad={(e) => {
						void (e.currentTarget as HTMLImageElement)
							.decode()
							.catch(() => undefined)
							.finally(release);
					}}
					onError={() => {
						if (rendering) cancelRender(new Error(`The SVG ${url} failed to load`));
						release();
					}}
					style={{
						position: 'absolute',
						left: 0,
						top: 0,
						width: box.width * S,
						height: box.height * S,
						transform: S === 1 ? undefined : `scale(${1 / S})`,
						transformOrigin: '0 0',
						objectFit: 'fill',
						display: 'block',
					}}
				/>
			) : null}
		</LayerBox>
	);
}

type PdfDoc = { getPage(n: number): Promise<PdfPage>; numPages: number };
type PdfPage = {
	getViewport(o: { scale: number }): { width: number; height: number };
	render(o: Record<string, unknown>): { promise: Promise<void>; cancel(): void };
};

let pdfjs: Promise<{ getDocument(src: Record<string, unknown>): { promise: Promise<PdfDoc> } }> | null = null;
/** pdf.js, loaded on first use with its worker in-page (no worker URL to resolve in either bundler). */
function pdfLib() {
	pdfjs ??= (async () => {
		const worker = await import('pdfjs-dist/build/pdf.worker.mjs');
		(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
		return (await import('pdfjs-dist')) as never;
	})();
	return pdfjs;
}

const pdfDocs = new Map<string, Promise<PdfDoc>>();
function pdfDocument(url: string): Promise<PdfDoc> {
	let p = pdfDocs.get(url);
	if (!p) {
		p = pdfLib().then((lib) => lib.getDocument({ url, isEvalSupported: false, disableFontFace: false }).promise);
		pdfDocs.set(url, p);
		p.catch(() => pdfDocs.delete(url));
		if (pdfDocs.size > 16) pdfDocs.delete(pdfDocs.keys().next().value as string);
	}
	return p;
}

/**
 * Draws `page` of the PDF at `url` into `canvas` at `w` × `h` (the page stretched to the size; transparent where the
 * page has no content). Resolves when drawn; `signal` cancels.
 */
export async function drawPdfPage(
	canvas: HTMLCanvasElement,
	url: string,
	page: number,
	w: number,
	h: number,
	signal?: { cancelled: boolean; task?: { cancel(): void } | null },
): Promise<void> {
	const doc = await pdfDocument(url);
	const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
	if (signal?.cancelled) return;
	const base = p.getViewport({ scale: 1 });
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('No 2D canvas');
	ctx.clearRect(0, 0, w, h);
	const r = p.render({
		canvasContext: ctx,
		viewport: p.getViewport({ scale: w / base.width }),
		transform: [1, 0, 0, h / base.height / (w / base.width), 0, 0],
		background: 'rgba(0,0,0,0)',
	});
	if (signal) signal.task = r;
	await r.promise;
}

/** A canvas with `page` of the PDF at `url`, at most `maxSide` px on its long side (posters). */
export async function pdfPagePicture(url: string, page: number, maxSide: number): Promise<HTMLCanvasElement> {
	const doc = await pdfDocument(url);
	const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages));
	const v = p.getViewport({ scale: 1 });
	const k = maxSide / Math.max(v.width, v.height);
	const canvas = document.createElement('canvas');
	await drawPdfPage(canvas, url, page, Math.max(1, Math.round(v.width * k)), Math.max(1, Math.round(v.height * k)));
	return canvas;
}

function PdfPicture({ layer }: { layer: LayerProps }) {
	const url = layer.media?.loaderUrl ?? null;
	const page = layer.media?.vector?.page ?? 1;
	const box = layer.props.box;
	const S = vectorRasterScale(layer.clip, box);
	const canvas = useRef<HTMLCanvasElement | null>(null);
	const rendering = getRemotionEnvironment().isRendering;
	const release = useHold(`PDF ${url}`, !!url);
	const w = Math.max(1, Math.round(box.width * S));
	const h = Math.max(1, Math.round(box.height * S));
	useEffect(() => {
		if (!url || !canvas.current) return;
		const signal: { cancelled: boolean; task?: { cancel(): void } | null } = { cancelled: false };
		void drawPdfPage(canvas.current, url, page, w, h, signal)
			.then(release)
			.catch((e: unknown) => {
				if ((e as { name?: string })?.name === 'RenderingCancelledException') return;
				if (rendering) cancelRender(e instanceof Error ? e : new Error(String(e)));
				release();
			});
		return () => {
			signal.cancelled = true;
			signal.task?.cancel();
		};
	}, [url, page, w, h, rendering, release]);
	return (
		<LayerBox layer={layer}>
			<canvas
				ref={canvas}
				data-vector="pdf"
				width={w}
				height={h}
				style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block' }}
			/>
		</LayerBox>
	);
}
