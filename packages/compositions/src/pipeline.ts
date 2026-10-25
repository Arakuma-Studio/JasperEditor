// Pure helpers for the per-layer pipeline (S03 §4.2): source → effects (crop first) → transform →
// opacity → blend. No React here so the math is unit-testable and shared by the layers.
import {
	audioFadeGain,
	type BlendMode,
	blendModeInfo,
	defaultEffectRegistry,
	type EffectRegistry,
	evaluate,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	type MediaHandle,
	type Rational,
	type RenderAudioClip,
	type ResolvedEffect,
} from '@jasper/project';
import type { CSSProperties } from 'react';
import type { RenderOptions } from './types.ts';

export const CROP_EFFECT_ID = 'jasper.crop';

/**
 * CSS `mix-blend-mode` of a clip blend mode (keyframes-blend): the W3C modes, whose Chrome implementation equals the
 * formulas of `blend-modes.ts` (measured bit-exact on opaque pixels, ≤ 1 code value with partial alpha); undefined
 * for Normal and for the modes the GL compositor draws (`isCssBlend` false: Dissolve, Linear Burn, Darker / Lighter
 * Color, Linear Dodge (Add), Vivid / Linear / Pin Light, Hard Mix, Subtract, Divide, the utility modes — CSS has no
 * exact equivalent; `plus-lighter` differs from Add in alpha).
 */
export function blendModeCss(mode: BlendMode | string): CSSProperties['mixBlendMode'] | undefined {
	return (blendModeInfo(mode)?.css ?? undefined) as CSSProperties['mixBlendMode'] | undefined;
}

/** One wrapper element of the effect chain, innermost (applied first) → outermost. */
export type EffectStage = {
	id: string;
	effectId: string;
	style: CSSProperties;
	/** SVG `<filter>` markup referenced by `style.filter = url(#svgId)`. */
	svg?: { id: string; markup: string };
};

/**
 * Effect chain for a layer, in application order. Crop is always first (S03 §4.2 step 2,
 * ARCHITECTURE §8), then the remaining enabled effects in stack order. Disabled effects and ids the
 * registry does not know are bypassed (S01:FX-022).
 */
export function effectStages(
	effects: readonly ResolvedEffect[],
	uidPrefix: string,
	registry: EffectRegistry = defaultEffectRegistry,
): EffectStage[] {
	const ordered = [
		...effects.filter((e) => e.effectId === CROP_EFFECT_ID),
		...effects.filter((e) => e.effectId !== CROP_EFFECT_ID),
	];
	const out: EffectStage[] = [];
	for (const fx of ordered) {
		if (!fx.enabled) continue;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (spec?.appliesTo !== 'video') continue;
		const style: CSSProperties = {};
		const css = spec.preview.css?.(fx.params);
		if (css) Object.assign(style, css);
		let svg: EffectStage['svg'];
		if (spec.preview.svgFilter) {
			const id = `${uidPrefix}-${fx.id}`.replace(/[^\w-]/g, '_');
			const markup = spec.preview.svgFilter(fx.params, id);
			if (markup) {
				svg = { id, markup };
				style.filter = style.filter ? `${style.filter} url(#${id})` : `url(#${id})`;
			}
		}
		if (Object.keys(style).length === 0 && !svg) continue;
		if (style.transform && !style.transformOrigin) style.transformOrigin = 'center';
		out.push({ id: fx.id, effectId: fx.effectId, style, ...(svg ? { svg } : {}) });
	}
	return out;
}

/** dB → linear amplitude. `-Infinity` (and anything ≤ -96 dB) is silence. */
export function dbToGain(db: number): number {
	if (!Number.isFinite(db) || db <= -96) return 0;
	return 10 ** (db / 20);
}

/** Remotion throws for volumes ≥ 100 (it assumes a percent mistake); stay well below. */
export const MAX_PREVIEW_GAIN = 16;

/**
 * Linear gain of an audio clip at clip-local frame `f` (S01:FX-010 subset, S03:KND-011/020):
 * `gainDb + volumeDb(t) + track volumeDb(T) + master volumeDb(T)`. Mute/solo are already resolved in
 * the snapshot (muted tracks are absent). With the audio-mix preview graph (`includeBus` false) only the clip's own
 * gain, volume and fades are applied here; the graph does pan, the track fader, buses and the Mix.
 */
export function audioGainAt(
	clip: Pick<
		RenderAudioClip,
		'start' | 'duration' | 'sourceIn' | 'speed' | 'gainDb' | 'volumeDb' | 'track' | 'fades'
	>,
	f: number,
	fps: Rational,
	master?: { volumeDb: RenderAudioClip['volumeDb'] },
	/** audio-mix: false when the preview mix graph applies the track fader and the Mix (default true). */
	includeBus = true,
): number {
	const F = flicksPerFrame(fps);
	const i = Math.max(0, Math.min(clip.duration - 1, f));
	const content = clip.speed.reverse
		? clip.sourceIn + (clip.duration - 1 - i) * F * clip.speed.rate
		: clip.sourceIn + i * F * clip.speed.rate;
	// Track and master properties live in sequence time (S01:KF-002).
	const seqT = (clip.start + i) * F;
	const db =
		clip.gainDb +
		evaluate(clip.volumeDb, content) +
		(includeBus ? evaluate(clip.track.volumeDb, seqT) + (master ? evaluate(master.volumeDb, seqT) : 0) : 0);
	// Audio fades at the clip's edges (one-sided audio transitions, S01:TRN-004).
	return Math.min(MAX_PREVIEW_GAIN, dbToGain(db)) * audioFadeGain(clip.fades, clip.start + i);
}

/**
 * Remotion's `trimBefore` is in composition frames of *media* time and is not scaled by
 * `playbackRate` (media time = elapsed × playbackRate + trimBefore / fps; verified in
 * @remotion/media 4.0.499 `getTimeInSeconds`). So it is the clip's `sourceIn` expressed in
 * sequence frames. Fractional values are allowed.
 */
function trimBeforeFrames(sourceInFlicks: number, fps: Rational | number): number {
	const f = typeof fps === 'number' ? fps : fps.num / fps.den;
	return (sourceInFlicks / FLICKS_PER_SECOND) * f;
}

/**
 * `trimBefore` of a video layer whose `<Sequence>` starts `headHandle` frames before the clip (the incoming
 * side of a transition shows content from before the clip's in-point, S01:TRN-003).
 */
export function videoTrimBefore(
	clip: { sourceIn: number; speed: { rate: number }; headHandle?: number },
	fps: Rational | number,
): number {
	return Math.max(0, trimBeforeFrames(clip.sourceIn, fps) - (clip.headHandle ?? 0) * clip.speed.rate);
}

/**
 * The volume callback of Remotion media receives `useCurrentFrame() + cumulatedNegativeFrom`, i.e.
 * frames since the media first became visible in the composition. When the export range starts
 * inside a clip (`<Sequence from>` negative) that is not the clip-local frame; this converts it.
 */
export function volumeFrameToClipFrame(volumeFrame: number, sequenceFrom: number): number {
	return volumeFrame + Math.max(0, -sequenceFrom);
}

/**
 * Media URL for a layer: the proxy when it is ready and either proxies are on or the browser cannot decode
 * the original (mandatory proxy, S04:PX-004: ProRes, DNxHD…), else the original.
 */
export function mediaSrc(
	media: Pick<MediaHandle, 'url' | 'proxyUrl' | 'browserDecodable'>,
	options: Pick<RenderOptions, 'useProxies'>,
): string {
	return (options.useProxies || media.browserDecodable === false) && media.proxyUrl
		? media.proxyUrl
		: media.url;
}

/**
 * pp-wma-preview: the audio URL a preview plays for stream `streamIndex` (container index, `channels.streamIndex`) of a
 * media: its playback audio when the browser cannot decode the original's audio (null while it is not ready: silent,
 * never the undecodable original), else `mediaSrc`.
 */
export function audioSrc(
	media: Pick<MediaHandle, 'url' | 'proxyUrl' | 'browserDecodable' | 'playbackAudio'>,
	streamIndex: number,
	options: Pick<RenderOptions, 'useProxies'>,
): string | null {
	if (media.playbackAudio === undefined) return mediaSrc(media, options);
	const urls = media.playbackAudio;
	if (!urls) return null;
	return urls[String(streamIndex)] ?? Object.values(urls)[0] ?? null;
}

/**
 * pp-wma-preview: `<Video>` props for media whose audio the browser cannot decode: no audio track (an index past every
 * track), so the picture plays instead of the whole element failing on the undecodable track. The sound plays from
 * the playback audio (`audioSrc`).
 */
export function videoAudioTrackProps(
	media: Pick<MediaHandle, 'playbackAudio'>,
): { audioStreamIndex?: number } {
	return media.playbackAudio === undefined ? {} : { audioStreamIndex: NO_AUDIO_TRACK };
}
const NO_AUDIO_TRACK = 1_000_000;

/** Where a video layer gets its picture from (S03:KND-010). */
export type VideoSource =
	/** `@remotion/media` `<Video>` (WebCodecs): everything a browser decodes, VP8/VP9 alpha included. */
	| { via: 'media'; src: string }
	/**
	 * `<OffthreadVideo>`: frames extracted by the render's FFmpeg. For originals a browser cannot decode
	 * (ProRes…), in engine renders only; `transparent` keeps the alpha channel (ProRes 4444).
	 */
	| { via: 'offthread'; src: string; transparent: boolean }
	/** Preview of an original the browser cannot decode while its proxy is not ready yet. */
	| { via: 'pending-proxy' };

export function videoSource(
	media: Pick<MediaHandle, 'url' | 'proxyUrl' | 'browserDecodable' | 'alpha'>,
	options: Pick<RenderOptions, 'useProxies' | 'isPreview'>,
): VideoSource {
	if (media.browserDecodable !== false) return { via: 'media', src: mediaSrc(media, options) };
	// Renders never use proxies: full quality, and an alpha original keeps its alpha.
	if (!options.isPreview) return { via: 'offthread', src: media.url, transparent: media.alpha === true };
	return media.proxyUrl ? { via: 'media', src: media.proxyUrl } : { via: 'pending-proxy' };
}

/** Premount window for media layers: 2 s of frames (S03:RND-020). */
export function premountFrames(fps: number): number {
	return Math.max(1, Math.round(fps * 2));
}
