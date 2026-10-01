// Render keys of layer bakes (S11:LBK-020): a content address over everything that can change the pixels of a
// baked layer, so nothing is ever invalidated in place — a change of text, preset, font file, media, compositions
// bundle, anime.js, Remotion, browser or GL back end gives a new key; moving the clip in time does not.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAnimeTemplate, mgRegistry } from '@jasper/mg-templates';
import { canonicalJson, type RenderVisualClip } from '@jasper/project';
import type { BakeVariant, Rect } from './layer.ts';

/** Bumped whenever a bake's pixels would change for the same inputs (recipe, encoder settings, normalisation). */
export const LAYER_BAKE_VERSION = 1;
export const KEY_RE = /^[0-9a-f]{40}$/;

/** Environment of the renders (one per engine process; part of every key). */
export type BakeEnvironment = {
	bundleId: string;
	animejs: string;
	remotion: string;
	browser: string;
	gl: string;
};

export type KeyFont = { family: string; weight: number; style: string; fileSha256: string | null };
export type KeyMedia = {
	mediaId: string;
	fingerprint: string | null;
	size: number | null;
	mtime: number | null;
};

/** Kinds whose layers use `hash32(clipId, …)` seeds (S11:ANM-007): their clip id stays in the key. */
function seedBearing(c: RenderVisualClip): boolean {
	if (c.kind === 'motion-graphic') return true;
	const src = c.source as { animation?: { in?: unknown; out?: unknown } };
	return !!src.animation && !!(src.animation.in || src.animation.out);
}

/**
 * The clip part of the key: the clip as baked (already shifted to its span start, colour effects removed when
 * ffmpeg applies them), with the clip id replaced by a constant unless the layer is seeded by it (random stagger
 * orders, template seeds: the same content under another id may draw differently), and without fields that do
 * not change pixels (name, track).
 */
export function normalisedClip(c: RenderVisualClip): Record<string, unknown> {
	const { clipId, name: _name, trackId: _track, ...rest } = c;
	return { ...rest, clipId: seedBearing(c) ? clipId : 'clip' };
}

export type KeyMaterial = {
	v: number;
	recipe: BakeVariant['recipe'];
	frame?: number;
	clip: Record<string, unknown>;
	/** Frames of the render (span length; 1 for stills). */
	span: number;
	width: number;
	height: number;
	fps: { num: number; den: number };
	fonts: KeyFont[];
	media: KeyMedia[];
	bundleId: string;
	animejs: string;
	remotion: string;
	browser: string;
	gl: string;
	still: boolean;
	rect: Rect | null;
	/**
	 * Anime templates (S11:ATP-001): the implementation's `renderVersion` from the template registry — a template
	 * whose drawing changes without a params change bumps it. Absent for other layers.
	 */
	renderVersion?: number | null;
	/** Graded entries (Remotion path, preview): the colour effects and LUT identities; false = ungraded bake. */
	graded: false | { source: string; effects: unknown; luts: KeyMedia[] };
};

/** `renderVersion` of the anime template a clip draws (null: not an anime template or not installed). */
export function templateRenderVersion(c: RenderVisualClip): number | null {
	const mg = (c.source as { mg?: { template: { id: string; version: number }; renderer?: string } }).mg;
	if (mg?.renderer !== 'anime') return null;
	const def = mgRegistry.getDefinition(mg.template.id, mg.template.version);
	return def && isAnimeTemplate(def) ? def.renderVersion : null;
}

export function keyOf(material: KeyMaterial): string {
	return createHash('sha256').update(canonicalJson(material)).digest('hex').slice(0, 40);
}

/** sha256 of font files, cached per path + size + mtime (fonts are hashed once per engine process). */
export class FileHashCache {
	private readonly cache = new Map<string, Promise<string | null>>();

	hash(path: string | null): Promise<string | null> {
		if (!path) return Promise.resolve(null);
		return stat(path)
			.then((st) => {
				const k = `${path}|${st.size}|${st.mtimeMs}`;
				let p = this.cache.get(k);
				if (!p) {
					p = new Promise<string | null>((resolve) => {
						const h = createHash('sha256');
						createReadStream(path)
							.on('data', (d) => h.update(d))
							.on('end', () => resolve(h.digest('hex')))
							.on('error', () => resolve(null));
					});
					this.cache.set(k, p);
					if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
				}
				return p;
			})
			.catch(() => null);
	}
}
