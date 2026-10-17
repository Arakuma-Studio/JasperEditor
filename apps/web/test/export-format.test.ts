// WP6.5a item 6: the Export dialog asks for the codec's own container and audio codec (ProRes: MOV + PCM; VP9: WebM +
// Opus when the engine has Opus; else MP4 + AAC) — before, it always asked for MP4 + AAC and the engine changed them
// without saying so — and the finished-export notice repeats a container / audio codec change the engine reports.
import type { Sequence } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { buildExportSettings, exportFormatOf } from '../src/export/settings.ts';
import { exportResultDetail } from '../src/home/ProjectLifecycle.tsx';
import { makeSession } from './timeline-helpers.ts';

describe('Export dialog container and audio codec', () => {
	it('exportFormatOf follows the codec', () => {
		expect(exportFormatOf('h264', true)).toEqual({ container: 'mp4', audio: 'aac' });
		expect(exportFormatOf('hevc', true)).toEqual({ container: 'mp4', audio: 'aac' });
		expect(exportFormatOf('av1', true)).toEqual({ container: 'mp4', audio: 'aac' });
		expect(exportFormatOf('prores', true)).toEqual({ container: 'mov', audio: 'pcm' });
		expect(exportFormatOf('vp9', true)).toEqual({ container: 'webm', audio: 'opus' });
		expect(exportFormatOf('vp9', false)).toEqual({ container: 'mp4', audio: 'aac' });
	});

	it('buildExportSettings asks for it', () => {
		const { session, seqId } = makeSession();
		const seq = session.getCommitted().sequences[seqId] as Sequence;
		const s = (codec: 'h264' | 'prores' | 'vp9', opus?: boolean) =>
			buildExportSettings(seq, { range: 'entire', engine: 'auto', codec, ...(opus === undefined ? {} : { opus }) });
		expect([s('h264').container, s('h264').audio?.codec]).toEqual(['mp4', 'aac']);
		expect([s('prores').container, s('prores').audio?.codec]).toEqual(['mov', 'pcm']);
		expect([s('vp9').container, s('vp9').audio?.codec]).toEqual(['webm', 'opus']);
		expect([s('vp9', false).container, s('vp9', false).audio?.codec]).toEqual(['mp4', 'aac']);
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
