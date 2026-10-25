// pp-wma-preview: the editor follows the engine's playback audio of media whose audio the browser cannot decode (WMA,
// AC-3…), hands its URLs to the preview (Program, Source, scrubbing, Detect Peak) and shows its state on the clip.
import type { EngineJob, RegisteredMedia, TypedEvent } from '@jasper/api';
import type { MediaAsset } from '@jasper/project';
import type { MediaRuntime } from '@jasper/session';
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { browserAudioSource } from '../src/audio/browser-decode.ts';
import { buildMediaAsset } from '../src/import/assets.ts';
import { createMediaRuntimeSync } from '../src/import/media-runtime.ts';
import { playbackAudioUrls, resolveMediaHandle } from '../src/panels/program/render-doc.ts';
import { playbackAudioBadge } from '../src/panels/timeline/model/playback-audio.ts';
import { memorySession, registered, ScriptedEngine } from './wp2e/helpers.ts';

afterEach(cleanup);

function wma(): RegisteredMedia {
	const r = registered('song.wma', { kind: 'audio', key: 'mk_song00000001' });
	return {
		...r,
		container: 'asf',
		browserPlayable: 'no',
		probe: {
			...r.probe,
			streams: [{ index: 0, type: 'audio', codec: 'wmav2', sampleRate: 44100, channels: 2, channelLayout: '' }],
		},
	};
}

const asset = (r: RegisteredMedia, id = 'med_1') => buildMediaAsset(r, { id, now: 't' }) as MediaAsset;
const rt = (patch: Partial<MediaRuntime>): MediaRuntime => ({
	availability: 'online',
	playbackUrl: '/media/mk_song00000001',
	proxyUrl: null,
	posterUrl: null,
	spriteUrl: null,
	peaksUrl: null,
	proxy: { state: 'none', progress: 0 },
	thumbs: { state: 'none', progress: 0 },
	peaks: { state: 'ready', progress: 1 },
	derived: null,
	ingest: null,
	...patch,
});
const URL0 = '/media/mk_song00000001/playback-audio.json?v=abcdef012345';

describe('media handles for previews', () => {
	it('WMA: the stream WAVs once ready, null (silent) before, never the original', () => {
		const a = asset(wma());
		expect(playbackAudioUrls(a, rt({ playbackAudio: { state: 'ready', progress: 1 }, playbackAudioUrl: URL0 }))).toEqual({
			'0': '/media/mk_song00000001/playback-audio/0.wav?v=abcdef012345',
		});
		expect(playbackAudioUrls(a, rt({ playbackAudio: { state: 'running', progress: 0.4 } }))).toBeNull();
		expect(playbackAudioUrls(a, undefined)).toBeNull();
		const h = resolveMediaHandle(a, rt({ playbackAudio: { state: 'ready', progress: 1 }, playbackAudioUrl: URL0 }));
		expect(h?.url).toBe('/media/mk_song00000001');
		expect(h?.playbackAudio).toEqual({ '0': '/media/mk_song00000001/playback-audio/0.wav?v=abcdef012345' });
		expect(resolveMediaHandle(a, rt({}))?.playbackAudio).toBeNull();
	});

	it('AAC media keep playing the original (no playbackAudio key at all)', () => {
		const a = asset(registered('clip.mp4'));
		expect(playbackAudioUrls(a, rt({}))).toBeUndefined();
		expect(resolveMediaHandle(a, rt({}))).not.toHaveProperty('playbackAudio');
	});

	it('scrubbing / Detect Peak read the stream WAV (its only track), nothing while it is being made', () => {
		const base = { url: '/media/k', proxyUrl: null };
		expect(browserAudioSource({ ...base, playbackAudio: { '3': '/w/3.wav' } }, 3)).toEqual({
			url: '/w/3.wav',
			streamIndex: 0,
		});
		expect(browserAudioSource({ ...base, playbackAudio: null }, 3)).toBeNull();
		expect(browserAudioSource(base, 3)).toEqual({ url: '/media/k', streamIndex: 3 });
		expect(browserAudioSource({ ...base, proxyUrl: '/p', browserDecodable: false }, 1)).toEqual({
			url: '/p',
			streamIndex: 1,
		});
	});
});

describe('runtime sync with the engine', () => {
	it('follows the playback-audio derivative: status, job progress and the ready URL', async () => {
		const { session } = await memorySession();
		const reg = wma();
		const id = session.ctx.ids.next('med');
		expect(
			session.apply({
				label: 'Import',
				origin: 'user',
				commands: [{ type: 'media.register', asset: buildMediaAsset(reg, { id, now: 't' }) }],
			}).ok,
		).toBe(true);
		const none = { state: 'none', progress: 0 };
		const engine = new ScriptedEngine().on((r) =>
			r.path === `/api/media/${reg.mediaKey}`
				? {
						body: {
							mediaKey: reg.mediaKey,
							status: 'processing',
							derivatives: {
								keyframes: none,
								poster: none,
								sprite: none,
								peaks: { state: 'ready', progress: 1, url: '/media/x/peaks.json?v=1' },
								'proxy-720': none,
								'proxy-540': none,
								'playback-audio': { state: 'queued', progress: 0, jobId: 'job_pa' },
							},
						},
					}
				: undefined,
		);
		let push: (e: TypedEvent | null) => void = () => {};
		const sync = createMediaRuntimeSync(session, engine.client(), (l) => {
			push = l;
			return () => {};
		});
		try {
			await waitFor(() => expect(session.getState().media[id]?.playbackAudio?.state).toBe('queued'));
			push({
				type: 'job.updated',
				payload: {
					id: 'job_pa',
					kind: 'playback-audio',
					title: 'Playback audio – song.wma',
					state: 'running',
					progress: 0.5,
					assetId: reg.mediaKey,
					dedupeKey: 'playback-audio:abc',
				} as EngineJob,
			} as TypedEvent);
			expect(session.getState().media[id]?.playbackAudio).toMatchObject({ state: 'running', progress: 0.5 });
			push({
				type: 'derivative.ready',
				payload: { mediaKey: reg.mediaKey, kind: 'playback-audio', url: URL0 },
			} as TypedEvent);
			const media = session.getState().media[id]!;
			expect(media.playbackAudio?.state).toBe('ready');
			expect(media.playbackAudioUrl).toBe(URL0);
			const a = session.getCommitted().media[id] as MediaAsset;
			expect(resolveMediaHandle(a, media)?.playbackAudio).toEqual({
				'0': '/media/mk_song00000001/playback-audio/0.wav?v=abcdef012345',
			});
		} finally {
			sync.dispose();
		}
	});
});

describe('timeline badge', () => {
	const a = asset(wma());
	it('shows progress while the playback audio is made, a visible failure, nothing once ready', () => {
		expect(playbackAudioBadge(a, rt({ playbackAudio: { state: 'queued', progress: 0 } }))).toMatchObject({
			label: 'Audio queued',
			tone: 'busy',
		});
		expect(playbackAudioBadge(a, rt({ playbackAudio: { state: 'running', progress: 0.42 } }))).toMatchObject({
			label: 'Audio 42%',
			tone: 'busy',
		});
		const failed = playbackAudioBadge(a, rt({ playbackAudio: { state: 'failed', progress: 0, error: 'boom' } }));
		expect(failed?.tone).toBe('failed');
		expect(failed?.title).toContain('boom');
		expect(playbackAudioBadge(a, rt({ playbackAudio: { state: 'ready', progress: 1 } }))).toBeNull();
		// offline media show "Media Offline" instead; AAC media never get a badge
		expect(playbackAudioBadge(a, rt({ availability: 'offline', playbackAudio: { state: 'queued', progress: 0 } }))).toBeNull();
		expect(
			playbackAudioBadge(asset(registered('clip.mp4')), rt({ playbackAudio: { state: 'none', progress: 0 } })),
		).toBeNull();
	});
});
