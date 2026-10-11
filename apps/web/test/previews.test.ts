import type { PreviewStatus, PreviewStatusRequest } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { RenderPreviewSegment } from '@jasper/project';
import { describe, expect, it, vi } from 'vitest';
import { playbackSpans, renderBarSpans } from '../src/panels/timeline/model/renderbar.ts';
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
	it('colours segments by need, turns rendered ones green and merges adjacent green spans', () => {
		const segs = [
			seg(0, 10, 'a', 'none'),
			seg(10, 10, 'b', 'realtime'),
			seg(20, 5, 'c', 'render'),
			seg(25, 5, 'd', 'render'),
		];
		const spans = renderBarSpans(segs, null);
		expect(spans.map((s) => [s.startFrame, s.endFrame, s.state])).toEqual([
			[10, 20, 'yellow'],
			[20, 25, 'red'],
			[25, 30, 'red'],
		]);
		expect(spans[1]!.title).toMatch(/Needs rendering.*80 ms.*Gaussian Blur/);
		const green = renderBarSpans(segs, new Set(['a', 'b', 'c']));
		expect(green.map((s) => [s.startFrame, s.endFrame, s.state])).toEqual([
			[0, 25, 'green'],
			[25, 30, 'red'],
		]);
	});

	it('playback spans use the URL template of rendered segments only', () => {
		const segs = [seg(0, 10, 'a', 'render'), seg(10, 10, 'b', 'render')];
		expect(playbackSpans(segs, new Set(['b']), '/renders/previews/f/{hash}.mp4')).toEqual([
			{ start: 10, frames: 10, url: '/renders/previews/f/b.mp4' },
		]);
		expect(playbackSpans(segs, null, null)).toEqual([]);
	});
});

describe('preview status store', () => {
	it('asks once per hash, adds rendered hashes from events and forgets on deletion', async () => {
		const settings = { format: 'h264-iframe', size: 'full', quality: 'standard' } as const;
		const calls: PreviewStatusRequest[] = [];
		const client = {
			previewStatus: vi.fn(async (req: PreviewStatusRequest): Promise<PreviewStatus> => {
				calls.push(req);
				return {
					formatKey: 'ffffffffffffffff',
					video: (req.video ?? []).filter((h) => h === 'a'),
					audio: [],
					videoUrl: '/renders/previews/ffffffffffffffff/{hash}.mp4',
					audioUrl: '/renders/previews/ffffffffffffffff/{hash}.wav',
					container: 'mp4',
					size: 'full',
					audioFiles: 0,
				};
			}),
		} as unknown as EngineClient;
		previewStatusStore.connect(client);
		previewStatusStore.ensure(settings, ['a', 'b'], []);
		await vi.waitFor(() => expect(previewStatusStore.get(settings)).not.toBeNull());
		expect([...previewStatusStore.get(settings)!.video]).toEqual(['a']);
		previewStatusStore.ensure(settings, ['a', 'b'], []);
		await new Promise((r) => setTimeout(r, 100));
		expect(calls).toHaveLength(1);
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
		previewStatusStore.connect(null);
	});
});
