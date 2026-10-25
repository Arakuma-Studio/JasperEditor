// pp-wma-preview: previews play the engine's playback audio of media whose audio the browser cannot decode (WMA,
// AC-3…), per clip stream, silent while it is being made; everything else keeps playing the original.
import { FLICKS_PER_SECOND, type MediaHandle, type RenderAudioClip } from '@jasper/project';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@remotion/media', async (orig) => ({
	...(await orig<typeof import('@remotion/media')>()),
	Audio: (p: { src: string }) => <i data-audio-src={p.src} />,
	Video: (p: { src: string; muted?: boolean; audioStreamIndex?: number }) => (
		<i data-video-src={p.src} data-muted={String(!!p.muted)} data-audio-index={String(p.audioStreamIndex)} />
	),
}));

const { AudioLayer, AssetComposition, audioSrc, videoAudioTrackProps } = await import('../src/index.ts');

const WMA: MediaHandle = {
	url: '/media/mk_wma',
	proxyUrl: null,
	kind: 'audio',
	width: null,
	height: null,
	durationFlicks: 4 * FLICKS_PER_SECOND,
	hasAudio: true,
	rotation: 0,
	playbackAudio: {
		'0': '/media/mk_wma/playback-audio/0.wav?v=1',
		'2': '/media/mk_wma/playback-audio/2.wav?v=1',
	},
};

const clip = (streamIndex: number) =>
	({
		clipId: 'clp_a',
		mediaId: 'med_wma',
		trackId: 'trk_a1',
		start: 0,
		duration: 30,
		sourceIn: 0,
		speed: { rate: 1, reverse: false, maintainPitch: true },
		gainDb: 0,
		volumeDb: { value: 0 },
		track: { volumeDb: 0, pan: 0, mute: false },
		channels: { streamIndex, map: [] },
		fades: [],
		effects: [],
	}) as unknown as RenderAudioClip;

const opts = { isPreview: true, useProxies: false, transparentBackground: false } as never;
const srcs = (node: ReactNode, attr: string) =>
	[...render(<div>{node}</div>).container.querySelectorAll(`[${attr}]`)].map((e) => e.getAttribute(attr));

describe('audioSrc', () => {
	it('picks the clip stream’s playback WAV, falls back to the first, is null while not ready', () => {
		expect(audioSrc(WMA, 2, { useProxies: false })).toBe('/media/mk_wma/playback-audio/2.wav?v=1');
		expect(audioSrc(WMA, 5, { useProxies: false })).toBe('/media/mk_wma/playback-audio/0.wav?v=1');
		expect(audioSrc({ ...WMA, playbackAudio: null }, 0, { useProxies: false })).toBeNull();
		// absent: the original (or the mandatory proxy) as for any media
		const { playbackAudio: _, ...plain } = WMA;
		expect(audioSrc(plain, 0, { useProxies: false })).toBe('/media/mk_wma');
		expect(audioSrc({ ...plain, proxyUrl: '/p', browserDecodable: false }, 0, { useProxies: false })).toBe(
			'/p',
		);
	});

	it('takes the audio track off <Video> of such media only', () => {
		expect(videoAudioTrackProps(WMA).audioStreamIndex).toBeGreaterThan(1000);
		expect(videoAudioTrackProps({ playbackAudio: null }).audioStreamIndex).toBeGreaterThan(1000);
		expect(videoAudioTrackProps({})).toEqual({});
	});
});

describe('AudioLayer', () => {
	it('plays the playback audio of the clip’s stream, never the undecodable original', () => {
		expect(srcs(<AudioLayer clip={clip(2)} media={WMA} fps={30} options={opts} />, 'data-audio-src')).toEqual(
			['/media/mk_wma/playback-audio/2.wav?v=1'],
		);
		expect(
			srcs(
				<AudioLayer clip={clip(0)} media={{ ...WMA, playbackAudio: null }} fps={30} options={opts} />,
				'data-audio-src',
			),
		).toEqual([]);
		const { playbackAudio: _, ...plain } = WMA;
		expect(
			srcs(<AudioLayer clip={clip(0)} media={plain} fps={30} options={opts} />, 'data-audio-src'),
		).toEqual(['/media/mk_wma']);
	});
});

describe('Source monitor (AssetComposition)', () => {
	it('an audio file plays its first playback stream; a video plays its picture muted plus the playback audio', () => {
		expect(srcs(<AssetComposition asset={WMA} fps={30} />, 'data-audio-src')).toEqual([
			'/media/mk_wma/playback-audio/0.wav?v=1',
		]);
		const mkv: MediaHandle = {
			...WMA,
			url: '/media/mk_mkv',
			kind: 'video',
			width: 640,
			height: 360,
			playbackAudio: { '1': '/media/mk_mkv/playback-audio/1.wav?v=2' },
		};
		const { container } = render(<AssetComposition asset={mkv} fps={30} />);
		const v = container.querySelector('[data-video-src]')!;
		expect(v.getAttribute('data-video-src')).toBe('/media/mk_mkv');
		expect(v.getAttribute('data-muted')).toBe('true');
		expect(Number(v.getAttribute('data-audio-index'))).toBeGreaterThan(1000);
		expect(container.querySelector('[data-audio-src]')?.getAttribute('data-audio-src')).toBe(
			'/media/mk_mkv/playback-audio/1.wav?v=2',
		);
		// while it is being made: the picture, no sound
		const pending = render(<AssetComposition asset={{ ...mkv, playbackAudio: null }} fps={30} />).container;
		expect(pending.querySelector('[data-video-src]')).not.toBeNull();
		expect(pending.querySelector('[data-audio-src]')).toBeNull();
	});
});
