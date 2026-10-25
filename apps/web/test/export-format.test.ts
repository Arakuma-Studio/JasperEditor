// WP6.5a item 6: the Export dialog asks for the codec's own container and audio codec (ProRes: MOV + PCM; VP9: WebM +
// Opus when the engine has Opus; else MP4 + AAC) — before, it always asked for MP4 + AAC and the engine changed them
// without saying so — and the finished-export notice repeats a container / audio codec change the engine reports.
import type { Sequence } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { buildExportSettings } from '../src/export/settings.ts';
import { exportResultDetail } from '../src/home/ProjectLifecycle.tsx';
import { makeSession } from './timeline-helpers.ts';

describe('Export dialog container and audio codec', () => {
	it('buildExportSettings asks for it', () => {
		const { session, seqId } = makeSession();
		const seq = session.getCommitted().sequences[seqId] as Sequence;
		for (const [codec, opus, container, audio] of [
			['h264', true, 'mp4', 'aac'],
			['hevc', true, 'mp4', 'aac'],
			['av1', true, 'mp4', 'aac'],
			['prores', true, 'mov', 'pcm'],
			['vp9', true, 'webm', 'opus'],
			['vp9', false, 'mp4', 'aac'],
		] as const) {
			const settings = buildExportSettings(seq, { range: 'entire', engine: 'auto', codec, opus });
			expect(settings.container).toBe(container);
			expect(settings.audio?.codec).toBe(audio);
		}
	});

	it('the finished-export notice says when the file is not in the requested container or audio codec', () => {
		expect(
			exportResultDetail({
				warnings: [
					{ code: 'AUDIO_CODEC_CHANGED', message: 'PCM audio was requested but … the audio is AAC' },
					{ code: 'OUTPUT_CONTAINER_CHANGED', message: 'MOV was requested but … the file is MP4' },
					{ code: 'NATIVE_FALLBACK', message: 'not repeated' },
				],
			}),
		).toBe('PCM audio was requested but … the audio is AAC MOV was requested but … the file is MP4');
	});
});
