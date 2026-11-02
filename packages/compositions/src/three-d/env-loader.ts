// three-d: loading Radiance `.hdr` media for environment lights (spec 19 TL-075), through the shared reader of
// @jasper/project, decoded in small turns so a large panorama never freezes the app. Cached by URL.
import { decodeHdrAsync, HDR_MAX_OUTPUT_SIDE, type HdrImage } from '@jasper/project';

export type LoadedHdr = HdrImage;

type Entry =
	| { state: 'loading'; promise: Promise<void> }
	| { state: 'ready'; value: LoadedHdr }
	| { state: 'error'; error: string };

/** Decoded panoramas kept: each is up to 134 MB of floats. */
const MAX_ENTRIES = 4;
const cache = new Map<string, Entry>();

/** The decoded HDR of a URL, or its state. Starts loading on first call; `onChange` runs when it settles. */
export function hdrAt(url: string, onChange: () => void): Entry {
	const hit = cache.get(url);
	if (hit) {
		if (hit.state === 'loading') hit.promise.then(onChange, onChange);
		return hit;
	}
	const promise = (async () => {
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const bytes = new Uint8Array(await res.arrayBuffer());
			const value = await decodeHdrAsync(
				bytes,
				HDR_MAX_OUTPUT_SIDE,
				() => new Promise((r) => setTimeout(r, 0)),
			);
			cache.set(url, { state: 'ready', value });
		} catch (e) {
			cache.set(url, { state: 'error', error: (e as Error).message ?? String(e) });
		}
	})();
	const entry: Entry = { state: 'loading', promise };
	cache.set(url, entry);
	if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
	promise.then(onChange, onChange);
	return entry;
}
