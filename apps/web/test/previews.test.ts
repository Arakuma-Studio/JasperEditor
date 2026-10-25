import type { PreviewStatus } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { RenderPreviewSegment } from '@jasper/project';
import { describe, expect, it, vi } from 'vitest';
import { playbackSpans } from '../src/panels/timeline/model/renderbar.ts';
import { previewStatusStore } from '../src/previews/store.ts';

const seg = (
	startFrame: number,
	frames: number,
	hash: string,
	need: RenderPreviewSegment['need'],
): RenderPreviewSegment => ({
	startFrame,
	frames,
	hash,
	need,
	costMs: need === 'render' ? 80 : 10,
	budgetMs: 33.4,
	clipIds: [],
	absolute: false,
	reasons: need === 'none' ? [] : ['Gaussian Blur ≈ 25 ms'],
});

describe('render bar', () => {
	it('playback spans use the URL template of rendered segments only', () => {
		const segs = [seg(0, 10, 'a', 'render'), seg(10, 10, 'b', 'render')];
		expect(playbackSpans(segs, new Set(['b']), '/renders/previews/f/{hash}.mp4')).toEqual([
			{ start: 10, frames: 10, url: '/renders/previews/f/b.mp4' },
		]);
		expect(playbackSpans(segs, null, null)).toEqual([]);
	});
});

describe('preview status store', () => {
	it('uses initial status and rendered events, then invalidates deleted previews', async () => {
		const settings = { format: 'h264-iframe', size: 'full', quality: 'standard' } as const;
		const client = {
			previewStatus: async (): Promise<PreviewStatus> => {
				return {
					formatKey: 'ffffffffffffffff',
					video: ['a'],
					audio: [],
					videoUrl: '/renders/previews/ffffffffffffffff/{hash}.mp4',
					audioUrl: '/renders/previews/ffffffffffffffff/{hash}.wav',
					container: 'mp4',
					size: 'full',
					audioFiles: 0,
				};
			},
		} as unknown as EngineClient;
		vi.useFakeTimers();
		previewStatusStore.connect(client);
		try {
			previewStatusStore.ensure(settings, ['a', 'b'], []);
			await vi.runAllTimersAsync();
			expect(previewStatusStore.get(settings)).not.toBeNull();
			expect([...previewStatusStore.get(settings)!.video]).toEqual(['a']);
			previewStatusStore.onEvent({
				id: 1,
				createdAt: '',
				type: 'previews.changed',
				payload: { formatKey: 'ffffffffffffffff', hash: 'b', kind: 'video' },
			} as never);
			expect(previewStatusStore.get(settings)!.video.has('b')).toBe(true);
			previewStatusStore.onEvent({
				id: 2,
				createdAt: '',
				type: 'previews.changed',
				payload: { deleted: 2 },
			} as never);
			expect(previewStatusStore.get(settings)).toBeNull();
		} finally {
			previewStatusStore.connect(null);
			vi.useRealTimers();
		}
	});
});
