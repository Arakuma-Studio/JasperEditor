// Hover scrub (S05:PRJ-005): thumbnails from the engine's sprite sheets (S04:TH-002, ARCHITECTURE D-10).
import { type SpriteIndex, SpriteIndexSchema } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';

const cache = new Map<string, Promise<SpriteIndex | null>>();

export function loadSpriteIndex(engine: EngineClient, mediaKey: string): Promise<SpriteIndex | null> {
	const hit = cache.get(mediaKey);
	if (hit) return hit;
	const p = fetch(engine.mediaUrl(mediaKey, 'sprite.json'), { credentials: 'include' })
		.then(async (r) => {
			if (!r.ok) return null;
			const parsed = SpriteIndexSchema.safeParse(await r.json());
			return parsed.success ? parsed.data : null;
		})
		.catch(() => null)
		.then((v) => {
			if (!v) cache.delete(mediaKey); // retry later (sprite may not be ready yet)
			return v;
		});
	cache.set(mediaKey, p);
	return p;
}

/** The sprite tile to show at `fraction` (0 = media start, 1 = end) of a `durationSec` long clip. */
export function spriteTileAt(index: SpriteIndex, fraction: number, durationSec: number) {
	if (!index.tiles.length) return null;
	const t = Math.max(0, Math.min(1, fraction)) * durationSec;
	let best = index.tiles[0]!;
	for (const tile of index.tiles) {
		if (tile.timeSec <= t) best = tile;
		else break;
	}
	return best;
}

/** CSS background for one tile scaled to `boxWidth` pixels. */
export function spriteTileStyle(
	engine: EngineClient,
	mediaKey: string,
	index: SpriteIndex,
	tile: { sheet: number; index: number },
	boxWidth: number,
): React.CSSProperties {
	const scale = boxWidth / index.tileWidth;
	const col = tile.index % index.columns;
	const row = Math.floor(tile.index / index.columns);
	return {
		backgroundImage: `url("${engine.mediaUrl(mediaKey, { sprite: tile.sheet })}")`,
		backgroundSize: `${index.columns * index.tileWidth * scale}px auto`,
		backgroundPosition: `${-col * index.tileWidth * scale}px ${-row * index.tileHeight * scale}px`,
		backgroundRepeat: 'no-repeat',
	};
}
