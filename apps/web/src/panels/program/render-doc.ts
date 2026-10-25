// Builds the Player's inputProps from the session (ARCHITECTURE §8): the drawn document (committed or
// gesture transient) → buildRenderSnapshot with media URLs from MediaRuntime (`/media/<key>`, or the
// proxy when proxies are on and ready, S04:PX-004) → structural sharing with the previous doc.
import { resolveCatalogFont } from '@jasper/api';
import { type RenderDoc, type RenderOptions, stabilizeRenderDoc } from '@jasper/compositions';
import {
	browserPictureNeed,
	buildRenderSnapshot,
	type FontRef,
	type MediaAsset,
	type MediaHandle,
	mediaDecodeHints,
	mediaLoaderPath,
	needsPlaybackAudio,
	type ProjectDocument,
	playbackAudioStreamUrl,
	proxyKeyOf,
	sequenceDuration,
} from '@jasper/project';
import type { MediaRuntime } from '@jasper/session';
import { mediaKeyOf } from '../../import/assets.ts';

type ProxyTier = '720' | '540';
type MediaUrlFn = (mediaKey: string, variant?: 'original' | { proxy: ProxyTier }) => string;

/** Default URL builder (same-origin engine paths, ARCHITECTURE §8). */
const defaultMediaUrl: MediaUrlFn = (key, variant = 'original') => {
	const k = encodeURIComponent(key);
	return variant === 'original' ? `/media/${k}` : `/media/${k}/proxy/${variant.proxy}`;
};

/**
 * pp-wma-preview: the playback audio a preview plays for an asset whose audio the browser cannot decode — stream index →
 * WAV URL once the engine made it, null until then (the preview is silent rather than failing on the original) —
 * or undefined when the original's audio plays.
 */
function playbackAudioUrls(
	asset: MediaAsset,
	runtime: Pick<MediaRuntime, 'playbackAudio' | 'playbackAudioUrl'> | undefined,
): Record<string, string> | null | undefined {
	if (!needsPlaybackAudio(asset)) return undefined;
	const url = runtime?.playbackAudio?.state === 'ready' ? runtime.playbackAudioUrl : null;
	if (!url) return null;
	const out: Record<string, string> = {};
	for (const s of asset.probe.streams)
		if (s.type === 'audio') out[String(s.index)] = playbackAudioStreamUrl(url, s.index);
	return out;
}

/**
 * Runtime media handle for an asset, or null when offline (S03:RND-032). Uses the runtime playback
 * URL when the engine reported one, else the engine-store locator, else a `url` locator.
 */
export function resolveMediaHandle(
	asset: MediaAsset,
	runtime: MediaRuntime | undefined,
	opts: {
		mediaUrl?: MediaUrlFn;
		proxyTier?: ProxyTier;
		/** gaps (Toggle Proxies): play the attached proxy (`asset.proxy`) when there is one. */
		attachedProxies?: boolean;
		/** The playback resolution asks for the engine's proxies (default: whatever is ready). */
		autoProxies?: boolean;
	} = {},
): MediaHandle | null {
	if (runtime && (runtime.availability === 'offline' || runtime.availability === 'error')) return null;
	const mediaUrl = opts.mediaUrl ?? defaultMediaUrl;
	const key = mediaKeyOf(asset);
	const urlLoc = asset.locators.find((l) => l.type === 'url');
	const url =
		runtime?.playbackUrl ?? (key ? mediaUrl(key) : urlLoc && urlLoc.type === 'url' ? urlLoc.url : null);
	if (!url) return null;
	const proxyReady = runtime?.proxy.state === 'ready';
	const autoProxyUrl = proxyReady
		? (runtime?.proxyUrl ?? (key ? mediaUrl(key, { proxy: opts.proxyTier ?? '720' }) : null))
		: null;
	// gaps (PRJ-8): Toggle Proxies plays the attached proxy; media without one keep the engine proxy only when the
	// playback resolution asks for it or the browser cannot decode the original.
	const attachedKey = opts.attachedProxies ? proxyKeyOf(asset) : null;
	const proxyUrl = attachedKey
		? mediaUrl(attachedKey)
		: opts.attachedProxies &&
				opts.autoProxies === false &&
				mediaDecodeHints(asset.probe).browserDecodable !== false
			? null
			: autoProxyUrl;
	const vs = asset.probe.streams.find((s) => s.type === 'video');
	const rotation = asset.probe.rotationDegrees;
	const swap = rotation === 90 || rotation === 270;
	const w = vs?.type === 'video' ? vs.width : null;
	const h = vs?.type === 'video' ? vs.height : null;
	// imports: Lottie / vector documents, and the engine's interpreted picture (display / interpreted proxy) when the
	// asset needs one (the snapshot marks it `browserDecodable: false`, so the original is never shown).
	const need = browserPictureNeed(asset);
	const loader = mediaLoaderPath(asset);
	const variantKey = need.picture ? `${need.picture}:${need.variant}` : null;
	const variantUrl =
		variantKey && runtime?.variant?.key === variantKey && runtime.variant.state === 'ready'
			? (runtime.variant.url ?? null)
			: null;
	return {
		...(loader && key ? { loaderUrl: `${mediaUrl(key).replace(/\/media\/.*$/, '')}${loader}` } : {}),
		url,
		proxyUrl: variantKey ? variantUrl : proxyUrl,
		kind: asset.kind,
		width: swap ? h : w,
		height: swap ? w : h,
		durationFlicks: asset.probe.durationFlicks,
		hasAudio: asset.probe.streams.some((s) => s.type === 'audio'),
		rotation,
		...mediaDecodeHints(asset.probe),
		...((p) => (p === undefined ? {} : { playbackAudio: p }))(playbackAudioUrls(asset, runtime)),
	};
}

type FontCatalogLike = Parameters<typeof resolveCatalogFont>[0];

/**
 * Font file URL from the engine catalog (`GET /api/fonts`, S04 §18): the same choice the engine's exports make
 * (`resolveCatalogFont`: family, then a library face's PostScript / full / legacy family name; latin subset, italic
 * when there is one, nearest weight), else null (the text layer falls back to the default sans).
 */
function fontUrlFromCatalog(
	catalog: FontCatalogLike | null,
	font: Pick<FontRef, 'family'>,
	weight: number,
	italic: boolean,
): string | null {
	return resolveCatalogFont(catalog, font.family, weight, italic)?.file.url ?? null;
}

type RenderDocInput = {
	doc: ProjectDocument;
	sequenceId: string;
	media: Record<string, MediaRuntime>;
	proxyTier?: ProxyTier;
	mediaUrl?: MediaUrlFn;
	/** gaps (Toggle Proxies): play attached proxies. */
	attachedProxies?: boolean;
	/** The playback resolution's engine proxies are on (`toggles.useProxies`). */
	autoProxies?: boolean;
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
				...(input.attachedProxies ? { attachedProxies: true, autoProxies: !!input.autoProxies } : {}),
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
