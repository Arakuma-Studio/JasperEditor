import { useEffect, useState } from 'react';
import { continueRender, delayRender } from 'remotion';

type LoadedImage = {
	img: HTMLImageElement | null;
	promise: Promise<HTMLImageElement | null>;
};
const imageCache = new Map<string, LoadedImage>();
/**
 * Per-frame pictures (object-matte frames) are transient: at most this many are kept (least recently
 * used first out), so long mattes do not hold every decoded frame. Effect media (textures, maps) stay cached.
 */
const TRANSIENT_IMAGES = 96;
const transient = new Set<string>();
/** URLs whose last load failed (renders turn a failed object-matte frame into an error). */
const failedImages = new Set<string>();

export function fxImageFailed(url: string): boolean {
	return failedImages.has(url) && !imageCache.get(url)?.img;
}

function touch(url: string, entry: LoadedImage): void {
	if (!transient.has(url)) return;
	imageCache.delete(url);
	imageCache.set(url, entry);
}

/** Loads an image for WebGL (`crossOrigin = anonymous`: render pages read the engine's signed URLs cross-origin). */
export function loadFxImage(
	url: string,
	opts: { transient?: boolean } = {},
): Promise<HTMLImageElement | null> {
	const hit = imageCache.get(url);
	if (hit) {
		touch(url, hit);
		return hit.promise;
	}
	const entry: LoadedImage = {
		img: null,
		promise: new Promise((resolve) => {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => {
				void (img.decode?.() ?? Promise.resolve())
					.catch(() => undefined)
					.then(() => {
						entry.img = img;
						resolve(img);
					});
			};
			img.onerror = () => {
				failedImages.add(url);
				if (failedImages.size > 1024) failedImages.delete(failedImages.values().next().value!);
				// A failed transient frame may be computed later (a running propagation): do not cache the failure.
				if (transient.has(url)) {
					imageCache.delete(url);
					transient.delete(url);
				}
				resolve(null);
			};
			img.src = url;
		}),
	};
	imageCache.set(url, entry);
	if (opts.transient) {
		transient.add(url);
		if (transient.size > TRANSIENT_IMAGES)
			for (const u of imageCache.keys()) {
				if (transient.size <= TRANSIENT_IMAGES) break;
				if (!transient.has(u) || u === url) continue;
				imageCache.delete(u);
				transient.delete(u);
			}
	}
	return entry.promise;
}

/** The loaded image of `url` (null while loading or after a failure). */
export function loadedFxImage(url: string): HTMLImageElement | null {
	return imageCache.get(url)?.img ?? null;
}

/** The loaded images of `urls` (renders wait for them with a delayRender); re-renders on arrival. Also used by the
 * transition stage for image params. */
export function useFxImages(
	urls: readonly string[],
	rendering: boolean,
	transientUrls?: ReadonlySet<string>,
): Map<string, HTMLImageElement> {
	const key = urls.join('\n');
	const missing = urls.filter((u) => !imageCache.get(u)?.img);
	const [initial] = useState(() =>
		rendering && missing.length > 0 ? delayRender(`Loading fx image ${missing[0]}`) : null,
	);
	const [, setVersion] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the URL list
	useEffect(() => {
		const need = key ? key.split('\n').filter((u) => !imageCache.get(u)?.img) : [];
		if (need.length === 0) {
			if (initial !== null) continueRender(initial);
			return;
		}
		let alive = true;
		const handle = rendering && initial === null ? delayRender(`Loading fx image ${need[0]}`) : initial;
		Promise.all(need.map((u) => loadFxImage(u, { transient: transientUrls?.has(u) }))).then(() => {
			if (alive) setVersion((v) => v + 1);
			if (handle !== null) continueRender(handle);
		});
		return () => {
			alive = false;
		};
	}, [key]);
	const out = new Map<string, HTMLImageElement>();
	for (const u of urls) {
		const img = imageCache.get(u)?.img;
		if (img) out.set(u, img);
	}
	return out;
}
