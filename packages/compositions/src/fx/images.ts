import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cancelRender, continueRender, delayRender } from 'remotion';

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

/** Bumped on every failed load, so what shows a failure (a layer's chip) recomputes. */
let failures = 0;
const failureListeners = new Set<() => void>();
const subscribeFailures = (f: () => void) => {
	failureListeners.add(f);
	return () => failureListeners.delete(f);
};

/** A number that changes when an fx image fails to load (a dependency for what reads `fxImageFailed`). */
export function useFxImageFailures(): number {
	return useSyncExternalStore(
		subscribeFailures,
		() => failures,
		() => failures,
	);
}

let standIn: HTMLCanvasElement | null = null;
/**
 * The preview's stand-in for an effect picture that could not be read: a magenta and black checkerboard, never a blank
 * texture, so the layer shows that something is missing (the chip says what). Renders never draw it: they fail.
 */
export function fxImageStandIn(): HTMLCanvasElement {
	if (standIn) return standIn;
	const c = document.createElement('canvas');
	c.width = 64;
	c.height = 64;
	const ctx = c.getContext('2d')!;
	for (let y = 0; y < 8; y++)
		for (let x = 0; x < 8; x++) {
			ctx.fillStyle = (x + y) % 2 ? '#000000' : '#ff00ff';
			ctx.fillRect(x * 8, y * 8, 8, 8);
		}
	standIn = c;
	return c;
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
				failures++;
				for (const f of failureListeners) f();
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

/**
 * The loaded images of `urls` (renders wait for them with a delayRender); re-renders on arrival. Also used by the
 * transition stage for image params. Renders: a URL of `required` that cannot be read fails the render with its message
 * (AGENTS §4: never drawn without the picture), and the wait lasts until the re-render with the images has committed,
 * so a frame is not captured from the draw before they arrived.
 */
export function useFxImages(
	urls: readonly string[],
	rendering: boolean,
	transientUrls?: ReadonlySet<string>,
	required?: ReadonlyMap<string, string>,
): Map<string, HTMLImageElement> {
	const key = urls.join('\n');
	const missing = urls.filter((u) => !imageCache.get(u)?.img);
	const [initial] = useState(() =>
		rendering && missing.length > 0 ? delayRender(`Loading fx image ${missing[0]}`) : null,
	);
	const [version, setVersion] = useState(0);
	const requiredRef = useRef(required);
	requiredRef.current = required;
	/** A render's wait, released once the re-render that has the images is committed. */
	const arrived = useRef<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: released after the commit of each arrival
	useEffect(() => {
		if (arrived.current === null) return;
		const h = arrived.current;
		arrived.current = null;
		continueRender(h);
	}, [version]);
	useEffect(
		() => () => {
			if (arrived.current !== null) continueRender(arrived.current);
			arrived.current = null;
		},
		[],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the URL list
	useEffect(() => {
		const need = key ? key.split('\n').filter((u) => !imageCache.get(u)?.img) : [];
		if (need.length === 0) {
			if (initial !== null) continueRender(initial);
			return;
		}
		let alive = true;
		const handle = rendering && initial === null ? delayRender(`Loading fx image ${need[0]}`) : initial;
		Promise.all(need.map((u) => loadFxImage(u, { transient: transientUrls?.has(u) }))).then((got) => {
			if (rendering) {
				const failed = need.findIndex((u, i) => !got[i] && requiredRef.current?.has(u));
				if (failed >= 0) {
					cancelRender(new Error(requiredRef.current!.get(need[failed]!)));
					return;
				}
			}
			if (alive) {
				if (handle !== null && arrived.current === null) arrived.current = handle;
				else if (handle !== null) continueRender(handle);
				setVersion((v) => v + 1);
			} else if (handle !== null) continueRender(handle);
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
