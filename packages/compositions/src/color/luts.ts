// LUT assets and baked colour-run LUTs for the preview/render colour stage (S06:LUT-003, CG-013).
// - LUT assets (`.cube` media) are fetched once per session from their immutable `/media/<key>` URL and parsed
//   once (cache by URL without the query string, so re-signed render URLs hit the same entry).
// - Baked run LUTs are cached by `colorRunKey` in an LRU per layer (64 entries, S06:CG-013).
import {
	bakeColorRun,
	type ColorRunEffect,
	type EffectRegistry,
	isOcioBundle,
	type Lut,
	OcioConfig,
	parseLutFile,
	type SequenceColorInfo,
} from '@jasper/project';

/** color-mgmt: colour assets are LUTs or custom OCIO configs (bundles), told apart by their content. */
type ColorAsset = Lut | OcioConfig;
type AssetEntry = { lut: ColorAsset | null | undefined; promise: Promise<ColorAsset | null> };

function parseColorAsset(text: string): ColorAsset {
	if (text.trimStart().startsWith('{')) {
		const json = JSON.parse(text) as unknown;
		if (isOcioBundle(json)) return OcioConfig.fromBundle(json);
		throw new Error('Not a colour asset');
	}
	return parseLutFile(text, null);
}
const assets = new Map<string, AssetEntry>();

/** Cache identity of a media URL: without query/hash (render URLs carry a signature). */
export function lutUrlKey(url: string): string {
	const i = url.search(/[?#]/);
	return i >= 0 ? url.slice(0, i) : url;
}

/**
 * Loads and parses a LUT asset (once per URL; color-mgmt: any supported format, sniffed from the content since media
 * URLs carry no extension); resolves null on failure (the grade skips it, CG-004).
 */
export function loadColorAsset(url: string): Promise<ColorAsset | null> {
	const k = lutUrlKey(url);
	const hit = assets.get(k);
	if (hit) return hit.promise;
	const entry: AssetEntry = {
		lut: undefined,
		promise: fetch(url)
			.then(async (r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				const lut = parseColorAsset(await r.text());
				entry.lut = lut;
				return lut;
			})
			.catch(() => {
				entry.lut = null;
				return null;
			}),
	};
	assets.set(k, entry);
	return entry.promise;
}

/** A LUT asset (once per URL); null on failure or for a non-LUT colour asset. */
export function loadLutAsset(url: string): Promise<Lut | null> {
	return loadColorAsset(url).then((v) => (v instanceof OcioConfig ? null : v));
}

/** The parsed asset if it finished loading: a Lut, null (failed or not a LUT), or undefined (not loaded yet). */
export function loadedLutAsset(url: string): Lut | null | undefined {
	const v = assets.get(lutUrlKey(url))?.lut;
	return v instanceof OcioConfig ? null : v;
}

/** color-mgmt: the parsed OCIO config of a `color-config` asset: config, null (failed), undefined (loading). */
export function loadedColorConfig(url: string): OcioConfig | null | undefined {
	const v = assets.get(lutUrlKey(url))?.lut;
	return v === undefined ? undefined : v instanceof OcioConfig ? v : null;
}

/** Whether an asset finished loading (either kind). */
export function colorAssetLoaded(url: string): boolean {
	return assets.get(lutUrlKey(url))?.lut !== undefined;
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
	/** color-mgmt: the working space (and OCIO configs) the colour ops read. */
	ctx: { working?: SequenceColorInfo; colorConfig?: (mediaId: string) => OcioConfig | null } = {},
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
	const baked = bakeColorRun(effects, registry, { lut, ...ctx }, size);
	lru.set(key, baked);
	while (lru.size > BAKES_PER_LAYER) lru.delete(lru.keys().next().value!);
	return baked;
}
