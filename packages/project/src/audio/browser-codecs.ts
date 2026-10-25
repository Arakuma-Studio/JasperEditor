// Which audio the preview can decode in the page (pp-wma-preview). Previews play audio with @remotion/media's <Audio>,
// scrub and detect peaks with mediabunny: mediabunny demuxes the container and decodes PCM itself, compressed codecs go
// to the browser's WebCodecs AudioDecoder. This table is that stack as shipped (Chromium / Electron built with the
// proprietary codecs, mediabunny 1.50): the engine's probe (`browserPlayable`), its derivatives (the playback audio
// copy) and the UI read it from here, so the decision is made once. Anything not listed — WMA, AC-3 / E-AC-3, ALAC,
// MP2, AMR, APE, DTS, AIFF and CAF containers, unknown codecs — needs the engine's playback audio (a lossless 32-bit
// float WAV per stream made with FFmpeg). Sources: docs/wp-notes/wma-preview.md.
import type { AudioStream, MediaAsset } from '../schema/media.ts';

/** mediabunny's demuxers (input formats) by ffprobe `format_name` token. */
const CONTAINER_FAMILY: Readonly<Record<string, AudioContainerFamily>> = {
	mov: 'isobmff',
	mp4: 'isobmff',
	m4a: 'isobmff',
	'3gp': 'isobmff',
	'3g2': 'isobmff',
	mj2: 'isobmff',
	matroska: 'matroska',
	webm: 'matroska',
	ogg: 'ogg',
	wav: 'wav',
	mp3: 'mp3',
	flac: 'flac',
	aac: 'adts',
	mpegts: 'mpegts',
};

export type AudioContainerFamily =
	| 'isobmff'
	| 'matroska'
	| 'ogg'
	| 'wav'
	| 'mp3'
	| 'flac'
	| 'adts'
	| 'mpegts';

/** WebCodecs AudioDecoder codecs of Chromium / Electron (AAC needs the proprietary-codec build Electron ships). */
const WEBCODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac'] as const;

/**
 * ffprobe audio codec names the preview decodes, per container family: the sample entries / codec ids each mediabunny
 * demuxer maps, restricted to what WebCodecs decodes in Chromium / Electron or mediabunny decodes itself (PCM, µ-law,
 * A-law). AC-3 / E-AC-3 are left out on purpose: mediabunny demuxes them but Chromium decodes them only on some
 * platforms (macOS / Windows / ChromeOS builds with platform decoders), and the engine decides before any client asks.
 */
export const BROWSER_AUDIO_CODECS: Readonly<Record<AudioContainerFamily, ReadonlySet<string>>> = {
	isobmff: new Set([
		...WEBCODECS,
		'pcm_s16le',
		'pcm_s16be',
		'pcm_s24le',
		'pcm_s24be',
		'pcm_s32le',
		'pcm_s32be',
		'pcm_f32le',
		'pcm_f32be',
		'pcm_f64le',
		'pcm_f64be',
		'pcm_u8',
		'pcm_s8',
		'pcm_mulaw',
		'pcm_alaw',
	]),
	matroska: new Set([
		...WEBCODECS,
		'pcm_u8',
		'pcm_s16le',
		'pcm_s24le',
		'pcm_s32le',
		'pcm_s16be',
		'pcm_s24be',
		'pcm_s32be',
		'pcm_f32le',
		'pcm_f64le',
	]),
	// mediabunny's Ogg demuxer reads Vorbis and Opus streams (no Ogg FLAC).
	ogg: new Set(['vorbis', 'opus']),
	wav: new Set([
		'pcm_u8',
		'pcm_s16le',
		'pcm_s24le',
		'pcm_s32le',
		'pcm_f32le',
		'pcm_f64le',
		'pcm_mulaw',
		'pcm_alaw',
	]),
	mp3: new Set(['mp3']),
	flac: new Set(['flac']),
	adts: new Set(['aac']),
	// MPEG-TS stream types 3/4 (MPEG audio) and 15 (ADTS AAC); MP2 is MPEG audio too but no WebCodecs codec.
	mpegts: new Set(['aac', 'mp3']),
};

/** The demuxer family of an ffprobe `format_name` ("mov,mp4,m4a,3gp,3g2,mj2" → isobmff); null = not demuxable. */
export function audioContainerFamily(container: string): AudioContainerFamily | null {
	// Lenient: documents and engine records from elsewhere may lack the field (never throw on render paths).
	if (typeof container !== 'string') return null;
	for (const token of container.toLowerCase().split(',')) {
		const f = CONTAINER_FAMILY[token.trim()];
		if (f) return f;
	}
	return null;
}

/** True when the preview decodes an audio stream of `codec` (ffprobe name) in `container` (ffprobe `format_name`). */
export function browserDecodesAudio(container: string, codec: string): boolean {
	const family = audioContainerFamily(container);
	return !!family && typeof codec === 'string' && BROWSER_AUDIO_CODECS[family].has(codec.toLowerCase());
}

type AudioSource = Pick<MediaAsset, 'kind' | 'container'> & { probe: Pick<MediaAsset['probe'], 'streams'> };

/** The audio streams of a media file the preview cannot decode (empty: the original plays). */
export function undecodableAudioStreams(m: AudioSource): AudioStream[] {
	if (m.kind !== 'audio' && m.kind !== 'video') return [];
	return (m.probe?.streams ?? []).filter(
		(s): s is AudioStream => s.type === 'audio' && !browserDecodesAudio(m.container, s.codec),
	);
}

/**
 * True when previews play the engine's playback audio instead of the file: a video or audio file with an audio stream
 * the browser cannot decode (every audio stream of the file is then played from the copy, so the clip's stream index
 * resolves the same way for all of them).
 */
export function needsPlaybackAudio(m: AudioSource): boolean {
	return undecodableAudioStreams(m).length > 0;
}

/**
 * The URL of one stream's playback audio from the derivative's URL (`…/playback-audio.json?v=…` →
 * `…/playback-audio/<streamIndex>.wav?v=…`); the query (cache-busting hash, signature) is kept.
 */
export function playbackAudioStreamUrl(derivativeUrl: string, streamIndex: number): string {
	const q = derivativeUrl.indexOf('?');
	const path = q < 0 ? derivativeUrl : derivativeUrl.slice(0, q);
	const query = q < 0 ? '' : derivativeUrl.slice(q);
	const base = path.replace(/\/playback-audio\.json$/, '/playback-audio');
	const index = Number.isFinite(streamIndex) ? Math.max(0, Math.trunc(streamIndex)) : 0;
	return `${base}/${index}.wav${query}`;
}
