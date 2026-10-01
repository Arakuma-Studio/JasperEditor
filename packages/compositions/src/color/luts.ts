// LUT assets and baked colour-run LUTs for the preview/render colour stage (S06:LUT-003, CG-013).
// - LUT assets (`.cube` media) are fetched once per session from their immutable `/media/<key>` URL and parsed
//   once (cache by URL without the query string, so re-signed render URLs hit the same entry).
// - Baked run LUTs are cached by `colorRunKey` in an LRU per layer (64 entries, S06:CG-013).
import { bakeColorRun, type ColorRunEffect, type EffectRegistry, type Lut, parseCube } from '@jasper/project';

type AssetEntry = { lut: Lut | null; error: string | null; promise: Promise<Lut | null> };
const assets = new Map<string, AssetEntry>();

/** Cache identity of a media URL: without query/hash (render URLs carry a signature). */
export function lutUrlKey(url: string): string {
	const i = url.search(/[?#]/);
	return i >= 0 ? url.slice(0, i) : url;
}

/** Loads and parses a `.cube` asset (once per URL); resolves null on failure (the grade skips it, CG-004). */
export function loadLutAsset(url: string, fetchImpl: typeof fetch = fetch): Promise<Lut | null> {
	const k = lutUrlKey(url);
	const hit = assets.get(k);
	if (hit) return hit.promise;
	const entry: AssetEntry = {
		lut: null,
		error: null,
		promise: fetchImpl(url)
			.then(async (r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				const lut = parseCube(await r.text());
				entry.lut = lut;
				return lut;
			})
			.catch((e: unknown) => {
				entry.error = (e as Error).message ?? String(e);
				return null;
			}),
	};
	assets.set(k, entry);
	return entry.promise;
}

/** The parsed asset if it finished loading: a Lut, null (failed), or undefined (not loaded yet). */
export function loadedLutAsset(url: string): Lut | null | undefined {
	const e = assets.get(lutUrlKey(url));
	if (!e) return undefined;
	if (e.lut) return e.lut;
	return e.error !== null ? null : undefined;
}

const BAKES_PER_LAYER = 64;
const bakes = new Map<string, Map<string, Lut | null>>();

/**
 * The baked LUT of a colour run (null = identity), cached by run key in the layer's LRU. The bake is the same
 * `bakeColorRun` the engine uses (33³, S06:CG-012).
 */
export function bakedRunLut(
	layerId: string,
	key: string,
	effects: readonly ColorRunEffect[],
	registry: EffectRegistry,
	lut: (mediaId: string) => Lut | null,
	size: number,
): Lut | null {
	let lru = bakes.get(layerId);
	if (!lru) {
		lru = new Map();
		bakes.set(layerId, lru);
	}
	if (lru.has(key)) {
		const v = lru.get(key)!;
		lru.delete(key);
		lru.set(key, v);
		return v;
	}
	const baked = bakeColorRun(effects, registry, { lut }, size);
	lru.set(key, baked);
	while (lru.size > BAKES_PER_LAYER) lru.delete(lru.keys().next().value!);
	return baked;
}
