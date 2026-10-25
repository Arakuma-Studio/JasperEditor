// Vector drawings of the social-comment cards (icons, badges, default avatars, the bubble tail) as SVG IMAGES, not
// inline SVG. Chrome anti-aliases small inline SVG paths inside a scaled card differently depending on the scales it
// drew them at before (its path coverage cache): a frame of the entrance painted after other frames (renderFrames, the
// Player) differed from the same frame painted alone (renderStill) by up to 2/255 on icon edges, in 17 of 20 runs. As an
// image, the drawing is rasterized whole at the painted size, every time: 0 differences in 10 runs (docs/wp-notes/
// social-comments.md "Paint determinism"). An image document is self-contained: colours are concrete (no
// `currentColor`) and gradient ids cannot collide between cards.
//
// The render waits for each image's decode (`delayRender`, like `EmojiImage`); a data URL never fails to load, and
// if it did the render is released rather than held.
import { type CSSProperties, useLayoutEffect, useRef } from 'react';
import { useDelayRender } from 'remotion';

const esc = (v: string | number) =>
	String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** One `<path>` of a vector image. */
export type VectorPath = { d: string; fill: string; fillRule?: 'evenodd' | 'nonzero'; fillOpacity?: number };
/** A `<linearGradient gradientUnits="userSpaceOnUse">` (ids are local to the image). */
export type VectorGradient = {
	id: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	stops: readonly { offset: number; color: string }[];
};

/** The SVG document of a drawing (pure; exported for tests). */
export function vectorSvg(o: {
	viewBox: string;
	width: number;
	height: number;
	paths: readonly VectorPath[];
	gradients?: readonly VectorGradient[];
	/** `none` stretches the drawing into the box (default: keep its aspect, centred). */
	preserveAspectRatio?: 'none';
}): string {
	const defs = o.gradients?.length
		? `<defs>${o.gradients
				.map(
					(g) =>
						`<linearGradient id="${esc(g.id)}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">${g.stops
							.map((s) => `<stop offset="${s.offset}" stop-color="${esc(s.color)}"/>`)
							.join('')}</linearGradient>`,
				)
				.join('')}</defs>`
		: '';
	const paths = o.paths
		.map(
			(p) =>
				`<path d="${esc(p.d)}" fill="${esc(p.fill)}"${p.fillRule ? ` fill-rule="${p.fillRule}"` : ''}${
					p.fillOpacity !== undefined ? ` fill-opacity="${p.fillOpacity}"` : ''
				}/>`,
		)
		.join('');
	const aspect = o.preserveAspectRatio ? ` preserveAspectRatio="${o.preserveAspectRatio}"` : '';
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${esc(o.viewBox)}" width="${o.width}" height="${o.height}"${aspect} overflow="visible">${defs}${paths}</svg>`;
}

/** The data URL of a drawing. */
export function vectorUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The SVG document of a vector image element (tests: `vectorDocument(img)` → its paths). */
export function vectorMarkupOf(el: Element): string | null {
	const src = el.getAttribute('src') ?? '';
	const i = src.indexOf(',');
	return src.startsWith('data:image/svg+xml') && i >= 0 ? decodeURIComponent(src.slice(i + 1)) : null;
}

/**
 * A vector drawing as an `<img>` of its SVG document, `width × height` px, `display: block`. Carries
 * `data-vector=""` (and `name`, when given, as its value) so callers and tests can find it.
 */
export function VectorImage(p: {
	viewBox: string;
	width: number;
	height: number;
	paths: readonly VectorPath[];
	gradients?: readonly VectorGradient[];
	preserveAspectRatio?: 'none';
	name?: string;
	style?: CSSProperties;
}) {
	const url = vectorUrl(vectorSvg(p));
	const ref = useRef<HTMLImageElement>(null);
	const { delayRender, continueRender } = useDelayRender();
	// biome-ignore lint/correctness/useExhaustiveDependencies: the URL identifies the image
	useLayoutEffect(() => {
		const img = ref.current;
		if (!img) return;
		const handle = delayRender(`Drawing ${p.name ?? 'vector image'}`);
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			continueRender(handle);
		};
		const ok = () => {
			img.decode().then(finish, finish);
		};
		img.addEventListener('load', ok);
		img.addEventListener('error', finish);
		if (img.complete) ok();
		return () => {
			img.removeEventListener('load', ok);
			img.removeEventListener('error', finish);
			finish();
		};
	}, [url]);
	return (
		<img
			ref={ref}
			key={url}
			src={url}
			alt=""
			aria-hidden="true"
			width={p.width}
			height={p.height}
			draggable={false}
			data-vector={p.name ?? ''}
			style={{ display: 'block', flexShrink: 0, width: p.width, height: p.height, ...p.style }}
		/>
	);
}
