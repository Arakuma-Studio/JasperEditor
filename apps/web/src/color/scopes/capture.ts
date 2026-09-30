// Frame read-back for the scopes (S06:SCP-002, source "Selected clip (graded)"). Contract with the compositions
// (wp-m2-color): inside the Program monitor's Player, `[data-clip-id="<clipId>"]` contains the layer's graded
// picture as its first `canvas` (video layers, graded stills) or `img` (ungraded stills). A `video` is accepted
// as a last resort (ungraded source while the colour stage is not mounted).

export const SCOPE_MAX_WIDTH = 256;

export type Frame = { data: Uint8ClampedArray; width: number; height: number };

type Source = HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;

const cssEscape = (s: string) =>
	typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
		? CSS.escape(s)
		: s.replace(/["\\]/g, '\\$&');

/** The graded picture element of a clip in the Program monitor, or null. */
export function findClipSource(clipId: string, root: ParentNode = document): Source | null {
	const wrappers = root.querySelectorAll('[data-testid="program-player-wrapper"]');
	for (const w of wrappers) {
		const host = w.querySelector(`[data-clip-id="${cssEscape(clipId)}"]`);
		if (!host) continue;
		const el =
			host.querySelector<HTMLCanvasElement>('canvas') ??
			host.querySelector<HTMLImageElement>('img') ??
			host.querySelector<HTMLVideoElement>('video');
		if (el) return el;
	}
	return null;
}

export function sourceSize(el: Source): { width: number; height: number } {
	if (el instanceof HTMLVideoElement) return { width: el.videoWidth, height: el.videoHeight };
	if (el instanceof HTMLImageElement) return { width: el.naturalWidth, height: el.naturalHeight };
	return { width: el.width, height: el.height };
}

/** Output size of a read-back (≤ `max` wide, aspect kept, at least 1×1). */
export function readbackSize(width: number, height: number, max = SCOPE_MAX_WIDTH) {
	if (width <= 0 || height <= 0) return null;
	const s = Math.min(1, max / width);
	return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

let scratch: HTMLCanvasElement | null = null;

/** Draws the source into a ≤ 256 px wide canvas and returns its pixels; null when not drawable (yet). */
export function readFrame(el: Source, max = SCOPE_MAX_WIDTH): Frame | null {
	const size = readbackSize(sourceSize(el).width, sourceSize(el).height, max);
	if (!size) return null;
	scratch ??= document.createElement('canvas');
	if (scratch.width !== size.width) scratch.width = size.width;
	if (scratch.height !== size.height) scratch.height = size.height;
	const g = scratch.getContext('2d', { willReadFrequently: true });
	if (!g) return null;
	try {
		g.clearRect(0, 0, size.width, size.height);
		g.drawImage(el, 0, 0, size.width, size.height);
		const img = g.getImageData(0, 0, size.width, size.height);
		return { data: img.data, width: size.width, height: size.height };
	} catch {
		// tainted or not decoded yet
		return null;
	}
}

/** Cheap content hash (sampled) to skip recomputing identical frames while paused. */
export function frameHash(f: Frame): number {
	let h = 2166136261 ^ f.width ^ (f.height << 16);
	const step = Math.max(4, Math.floor(f.data.length / 4096) * 4);
	for (let i = 0; i < f.data.length; i += step) {
		h ^= f.data[i]! | (f.data[i + 1]! << 8) | (f.data[i + 2]! << 16);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** RGB of a CSS colour (any syntax, e.g. a `--pr-*` token value), resolved by the browser. */
export function cssColorRgb(value: string, fallback: [number, number, number]): [number, number, number] {
	if (typeof document === 'undefined') return fallback;
	const c = document.createElement('canvas');
	c.width = 1;
	c.height = 1;
	const g = c.getContext('2d', { willReadFrequently: true });
	if (!g || !value) return fallback;
	try {
		g.fillStyle = value;
		g.fillRect(0, 0, 1, 1);
		const d = g.getImageData(0, 0, 1, 1).data;
		return [d[0]!, d[1]!, d[2]!];
	} catch {
		return fallback;
	}
}
