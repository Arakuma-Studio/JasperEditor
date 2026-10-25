// pp-wma-preview: the one table that says which audio the preview decodes (probe, derivatives and UI read it).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	audioContainerFamily,
	BROWSER_AUDIO_CODECS,
	browserDecodesAudio,
	needsPlaybackAudio,
	playbackAudioStreamUrl,
	undecodableAudioStreams,
} from '../src/index.ts';

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';

describe('browserDecodesAudio', () => {
	it.each([
		[MP4, 'aac', true],
		[MP4, 'mp3', true],
		[MP4, 'alac', false],
		[MP4, 'ac3', false],
		[MP4, 'eac3', false],
		[MP4, 'pcm_s16be', true],
		['matroska,webm', 'opus', true],
		['matroska,webm', 'vorbis', true],
		['matroska,webm', 'dts', false],
		['matroska,webm', 'truehd', false],
		['ogg', 'vorbis', true],
		['ogg', 'flac', false],
		['wav', 'pcm_s24le', true],
		['wav', 'pcm_f32le', true],
		['wav', 'adpcm_ms', false],
		['wav', 'mp3', false],
		['mp3', 'mp3', true],
		['mp3', 'mp2', false],
		['flac', 'flac', true],
		['aac', 'aac', true],
		['mpegts', 'aac', true],
		['mpegts', 'mp2', false],
		['mpegts', 'ac3', false],
		['asf', 'wmav2', false],
		['asf', 'wmapro', false],
		['asf', 'wmalossless', false],
		['aiff', 'pcm_s16be', false],
		['caf', 'alac', false],
		['amr', 'amr_nb', false],
		['ape', 'ape', false],
		['wv', 'wavpack', false],
		['unknown', 'aac', false],
		[MP4, 'unknown', false],
		['', '', false],
	])('%s / %s → %s', (container, codec, want) => {
		expect(browserDecodesAudio(container, codec)).toBe(want);
	});

	it('reads any token of the format name, case-insensitively', () => {
		expect(audioContainerFamily('MOV,MP4,M4A')).toBe('isobmff');
		expect(audioContainerFamily('matroska,webm')).toBe('matroska');
		expect(audioContainerFamily('asf')).toBeNull();
		expect(browserDecodesAudio('Matroska,WebM', 'AAC')).toBe(true);
	});

	it('property: never throws, and is true only for a listed codec of a demuxable container', () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (container, codec) => {
				const got = browserDecodesAudio(container, codec);
				const family = audioContainerFamily(container);
				expect(got).toBe(!!family && BROWSER_AUDIO_CODECS[family].has(codec.toLowerCase()));
			}),
			{ numRuns: 500 },
		);
	});
});

const audio = (index: number, codec: string) => ({
	index,
	type: 'audio' as const,
	codec,
	sampleRate: 48000,
	channels: 2,
	channelLayout: 'stereo',
});
const video = {
	index: 0,
	type: 'video' as const,
	codec: 'h264',
	width: 1920,
	height: 1080,
	pixelAspect: { num: 1, den: 1 },
	frameRate: { num: 30, den: 1 },
	pixelFormat: 'yuv420p',
	bitDepth: 8,
	color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' as const },
	browserDecodable: true,
};
const media = (kind: 'audio' | 'video' | 'image', container: string, streams: unknown[]) =>
	({ kind, container, probe: { streams } }) as Parameters<typeof needsPlaybackAudio>[0];

describe('needsPlaybackAudio', () => {
	it('WMA audio and the AC-3 track of a video need it; AAC / WAV / silent video do not', () => {
		expect(needsPlaybackAudio(media('audio', 'asf', [audio(0, 'wmav2')]))).toBe(true);
		expect(needsPlaybackAudio(media('video', 'matroska,webm', [video, audio(1, 'ac3')]))).toBe(true);
		expect(needsPlaybackAudio(media('video', MP4, [video, audio(1, 'aac')]))).toBe(false);
		expect(needsPlaybackAudio(media('audio', 'wav', [audio(0, 'pcm_s16le')]))).toBe(false);
		expect(needsPlaybackAudio(media('video', MP4, [video]))).toBe(false);
		// images never play sound
		expect(needsPlaybackAudio(media('image', 'asf', [audio(0, 'wmav2')]))).toBe(false);
	});

	it('lists the streams the browser cannot decode (one bad stream is enough)', () => {
		const m = media('video', 'matroska,webm', [video, audio(1, 'aac'), audio(2, 'dts')]);
		expect(undecodableAudioStreams(m).map((s) => s.index)).toEqual([2]);
		expect(needsPlaybackAudio(m)).toBe(true);
	});
});

describe('playbackAudioStreamUrl', () => {
	it('turns the derivative URL into a stream WAV URL, keeping the query', () => {
		expect(playbackAudioStreamUrl('/media/mk_abc/playback-audio.json?v=0123456789ab', 1)).toBe(
			'/media/mk_abc/playback-audio/1.wav?v=0123456789ab',
		);
		expect(playbackAudioStreamUrl('http://127.0.0.1:1/media/mk_abc/playback-audio.json', 0)).toBe(
			'http://127.0.0.1:1/media/mk_abc/playback-audio/0.wav',
		);
		expect(playbackAudioStreamUrl('/media/k/playback-audio.json?v=1&sig=x', Number.NaN)).toBe(
			'/media/k/playback-audio/0.wav?v=1&sig=x',
		);
		expect(playbackAudioStreamUrl('/media/k/playback-audio.json', -3.7)).toBe(
			'/media/k/playback-audio/0.wav',
		);
	});
});

describe('Object.prototype keys (regression: fast-check seed 1848947810 hit "__proto__")', () => {
	it('never resolve to a container family or throw', () => {
		for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
			expect(audioContainerFamily(key)).toBeNull();
			expect(() => browserDecodesAudio(key, '')).not.toThrow();
			expect(browserDecodesAudio(key, 'aac')).toBe(false);
			expect(browserDecodesAudio(`mov,${key}`, 'aac')).toBe(true);
		}
	});
});
