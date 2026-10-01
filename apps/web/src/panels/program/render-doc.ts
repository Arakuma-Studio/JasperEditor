// Builds the Player's inputProps from the session (ARCHITECTURE §8): the drawn document (committed or
// gesture transient) → buildRenderSnapshot with media URLs from MediaRuntime (`/media/<key>`, or the
// proxy when proxies are on and ready, S04:PX-004) → structural sharing with the previous doc.
import { type RenderDoc, type RenderOptions, stabilizeRenderDoc } from '@jasper/compositions';
import {
	buildRenderSnapshot,
	type FontRef,
	type MediaAsset,
	type MediaHandle,
	mediaDecodeHints,
	type ProjectDocument,
	sequenceDuration,
} from '@jasper/project';
import type { MediaRuntime } from '@jasper/session';

type ProxyTier = '720' | '540';
type MediaUrlFn = (mediaKey: string, variant?: 'original' | { proxy: ProxyTier }) => string;

/** Default URL builder (same-origin engine paths, ARCHITECTURE §8). */
const defaultMediaUrl: MediaUrlFn = (key, variant = 'original') => {
	const k = encodeURIComponent(key);
	return variant === 'original' ? `/media/${k}` : `/media/${k}/proxy/${variant.proxy}`;
};

function engineKey(asset: MediaAsset): string | null {
	const loc = asset.locators.find((l) => l.type === 'engine-store');
	return loc && loc.type === 'engine-store' ? loc.key : null;
}

/**
 * Runtime media handle for an asset, or null when offline (S03:RND-032). Uses the runtime playback
 * URL when the engine reported one, else the engine-store locator, else a `url` locator.
 */
export function resolveMediaHandle(
	asset: MediaAsset,
	runtime: MediaRuntime | undefined,
	opts: { mediaUrl?: MediaUrlFn; proxyTier?: ProxyTier } = {},
): MediaHandle | null {
	if (runtime && (runtime.availability === 'offline' || runtime.availability === 'error')) return null;
	const mediaUrl = opts.mediaUrl ?? defaultMediaUrl;
	const key = engineKey(asset);
	const urlLoc = asset.locators.find((l) => l.type === 'url');
	const url =
		runtime?.playbackUrl ?? (key ? mediaUrl(key) : urlLoc && urlLoc.type === 'url' ? urlLoc.url : null);
	if (!url) return null;
	const proxyReady = runtime?.proxy.state === 'ready';
	const proxyUrl = proxyReady
		? (runtime?.proxyUrl ?? (key ? mediaUrl(key, { proxy: opts.proxyTier ?? '720' }) : null))
		: null;
	const vs = asset.probe.streams.find((s) => s.type === 'video');
	const rotation = asset.probe.rotationDegrees;
	const swap = rotation === 90 || rotation === 270;
	const w = vs?.type === 'video' ? vs.width : null;
	const h = vs?.type === 'video' ? vs.height : null;
	return {
		url,
		proxyUrl,
		kind: asset.kind,
		width: swap ? h : w,
		height: swap ? w : h,
		durationFlicks: asset.probe.durationFlicks,
		hasAudio: asset.probe.streams.some((s) => s.type === 'audio'),
		rotation,
		...mediaDecodeHints(asset.probe),
	};
}

type FontCatalogLike = {
	fonts: { family: string; files: { weight: number; style: 'normal' | 'italic'; url: string }[] }[];
};

/**
 * Font file URL from the engine catalog (`GET /api/fonts`, S04 §18): exact weight/style, else the
 * nearest weight of the same style, else null (the text layer falls back to the default sans).
 */
function fontUrlFromCatalog(
	catalog: FontCatalogLike | null,
	font: Pick<FontRef, 'family'>,
	weight: number,
	italic: boolean,
): string | null {
	const fam = catalog?.fonts.find((f) => f.family.toLowerCase() === font.family.toLowerCase());
	if (!fam || fam.files.length === 0) return null;
	const style = italic ? 'italic' : 'normal';
	const same = fam.files.filter((f) => f.style === style);
	const pool = same.length ? same : fam.files;
	let best = pool[0]!;
	for (const f of pool) if (Math.abs(f.weight - weight) < Math.abs(best.weight - weight)) best = f;
	return best.url;
}

type RenderDocInput = {
	doc: ProjectDocument;
	sequenceId: string;
	media: Record<string, MediaRuntime>;
	proxyTier?: ProxyTier;
	mediaUrl?: MediaUrlFn;
	/** Engine font catalog (null while unavailable: text falls back to the default sans). */
	fontCatalog?: FontCatalogLike | null;
};

/** Minimum Player length for an empty sequence: 10 s of frames (S03:PGM-001). */
const EMPTY_SEQUENCE_SECONDS = 10;

export function buildProgramDoc(input: RenderDocInput, prev: RenderDoc | null): RenderDoc {
	const next = buildRenderSnapshot(input.doc, input.sequenceId, {
		resolveMedia: (asset) =>
			resolveMediaHandle(asset, input.media[asset.id], {
				mediaUrl: input.mediaUrl,
				proxyTier: input.proxyTier,
			}),
		resolveFont: (font, weight, italic) =>
			fontUrlFromCatalog(input.fontCatalog ?? null, font, weight, italic),
	});
	return stabilizeRenderDoc(prev, next);
}

/**
 * Player length: the sequence end plus one frame, so `End` (TL-834: one past the last content frame,
 * black) is a valid Player frame; empty sequences get 10 s so the ruler stays usable.
 */
export function playerDurationFrames(doc: ProjectDocument, sequenceId: string): number {
	const seq = doc.sequences[sequenceId];
	if (!seq) return 1;
	const end = sequenceDuration(seq);
	if (end === 0) {
		const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
		return Math.round(EMPTY_SEQUENCE_SECONDS * fps);
	}
	return end + 1;
}

/** Whether any clip in the doc plays from a proxy (PROXY chip, S05:PGM-011). */
export function usesProxies(doc: RenderDoc, options: Pick<RenderOptions, 'useProxies'>): boolean {
	return options.useProxies && Object.values(doc.media).some((m) => !!m?.proxyUrl);
}
