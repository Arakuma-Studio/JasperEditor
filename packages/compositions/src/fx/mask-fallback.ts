// Preview fallback of Opacity masks (wp masks) where the GL chain cannot run (no WebGL2 / lost context, or a DOM
// layer without HTML-in-Canvas): the CPU rasteriser (`rasterizeMasks`, the same coverage definition and algorithm
// as the shader and the native export kernel) draws the coverage into an alpha image that becomes the layer
// content's CSS `mask-image` over the layer box. Renders never use it (they need the chain and fail loudly
// without it); in the preview, coverage outside the layer box (an inverted mask around a glow) is not drawn.
import { activeMasks, type ResolvedMask, rasterizeMasks } from '@jasper/project';
import { useMemo } from 'react';

/** Longest side of the fallback mask image (layer px beyond it are stretched). */
const MAX_SIDE = 1024;
const CACHE_LIMIT = 16;
const cache = new Map<string, string>();

/** A data URL whose alpha is the masks' combined coverage over a `width × height` layer box. */
export function maskImageUrl(masks: readonly ResolvedMask[], width: number, height: number): string | null {
	if (typeof document === 'undefined' || activeMasks(masks).length === 0) return null;
	const k = Math.min(1, MAX_SIDE / Math.max(1, width, height));
	const W = Math.max(1, Math.round(width * k));
	const H = Math.max(1, Math.round(height * k));
	const key = `${W}x${H}|${k}|${JSON.stringify(masks)}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const cov = rasterizeMasks(masks, W, H, (q) => [q[0] * W, q[1] * H], k);
	if (!cov) return null;
	const c = document.createElement('canvas');
	c.width = W;
	c.height = H;
	const ctx = c.getContext('2d');
	if (!ctx) return null;
	const img = ctx.createImageData(W, H);
	for (let i = 0; i < W * H; i++) {
		img.data[4 * i] = 255;
		img.data[4 * i + 1] = 255;
		img.data[4 * i + 2] = 255;
		img.data[4 * i + 3] = Math.round(cov[i]! * 255);
	}
	ctx.putImageData(img, 0, 0);
	const url = c.toDataURL('image/png');
	cache.set(key, url);
	while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
	return url;
}

/** CSS of the fallback mask (null when there is nothing to mask or the layer's chain already did it). */
export function useCpuMaskStyle(
	masks: readonly ResolvedMask[],
	box: { width: number; height: number },
	enabled: boolean,
): React.CSSProperties | null {
	return useMemo(() => {
		if (!enabled || masks.length === 0) return null;
		const url = maskImageUrl(masks, box.width, box.height);
		if (!url) return null;
		return {
			maskImage: `url(${url})`,
			WebkitMaskImage: `url(${url})`,
			maskSize: '100% 100%',
			WebkitMaskSize: '100% 100%',
			maskRepeat: 'no-repeat',
			WebkitMaskRepeat: 'no-repeat',
			maskMode: 'alpha',
		};
	}, [enabled, masks, box.width, box.height]);
}
