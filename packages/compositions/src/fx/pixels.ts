// sim-warp: CPU pixels of images bound to `media` params of shader effects that read maps while simulating
// (`GpuEffect.cpuPixels`: Wave World's ground, Foam's flow map, Shatter's custom map, Particle Playground's maps).
// Loaded with the effects' image loader (renders wait with a delayRender), read once with a 2D canvas (downscaled to
// at most FX_PIXELS_MAX on the long side) and cached per URL. Deterministic: the same picture gives the same bytes.
import { FX_PIXELS_MAX, type FxPixels } from '@jasper/project';
import { useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';
import { loadFxImage } from './FxPicture.tsx';

const loaded = new Map<string, HTMLImageElement | null>();
const pixels = new Map<string, FxPixels | null>();

/** The pixels of a loaded image (null when not loaded, failed, or without a 2D canvas). */
export function fxPixelsOf(url: string): FxPixels | null {
	const hit = pixels.get(url);
	if (hit !== undefined) return hit;
	const img = loaded.get(url);
	if (!img) return null;
	const w0 = img.naturalWidth || img.width;
	const h0 = img.naturalHeight || img.height;
	if (!(w0 > 0 && h0 > 0)) {
		pixels.set(url, null);
		return null;
	}
	const k = Math.min(1, FX_PIXELS_MAX / Math.max(w0, h0));
	const w = Math.max(1, Math.round(w0 * k));
	const h = Math.max(1, Math.round(h0 * k));
	try {
		const c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		const ctx = c.getContext('2d', { willReadFrequently: true });
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0, w, h);
		const data = ctx.getImageData(0, 0, w, h).data;
		const out: FxPixels = { width: w, height: h, data, key: `${url}#${w}x${h}` };
		pixels.set(url, out);
		if (pixels.size > 64) pixels.delete(pixels.keys().next().value!);
		return out;
	} catch {
		// A tainted canvas (no CORS) cannot be read: the map is treated as missing.
		pixels.set(url, null);
		return null;
	}
}

/**
 * Loads the images whose pixels shader effects read on the CPU; returns a version that changes when one arrives
 * (re-plan). Renders wait for them (delayRender).
 */
export function useFxPixels(urls: readonly string[], rendering: boolean): number {
	const key = urls.join('\n');
	const missing = urls.filter((u) => !loaded.has(u));
	const [initial] = useState(() =>
		rendering && missing.length > 0 ? delayRender(`Loading fx map ${missing[0]}`) : null,
	);
	const [version, setVersion] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the URL list
	useEffect(() => {
		const need = key ? key.split('\n').filter((u) => !loaded.has(u)) : [];
		if (need.length === 0) {
			if (initial !== null) continueRender(initial);
			return;
		}
		let alive = true;
		const handle = rendering && initial === null ? delayRender(`Loading fx map ${need[0]}`) : initial;
		Promise.all(
			need.map((u) =>
				loadFxImage(u).then((img) => {
					loaded.set(u, img);
				}),
			),
		).then(() => {
			if (alive) setVersion((v) => v + 1);
			if (handle !== null) continueRender(handle);
		});
		return () => {
			alive = false;
		};
	}, [key]);
	return version;
}
