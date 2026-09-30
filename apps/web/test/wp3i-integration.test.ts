// WP-3I integration fixes: export file names, Program monitor motion-graphic render state.
import type { EngineJob } from '@jasper/api';
import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from '../src/export/settings.ts';
import {
	mgRenderJobForClip,
	mgRenderStateOf,
	trackMgRenderJob,
} from '../src/panels/program/mg-render-state.tsx';

const job = (patch: Partial<EngineJob>): EngineJob =>
	({
		id: 'job_mg_1',
		kind: 'mg-render',
		title: 'Motion graphic',
		origin: { type: 'user' },
		state: 'queued',
		progress: 0,
		createdAt: '2026-09-30T00:00:00.000Z',
		priority: 'interactive',
		cpuSlots: 4,
		...patch,
	}) as EngineJob;

describe('export file names', () => {
	it('drops a typed .mp4 extension (the export adds it) and keeps other names', () => {
		expect(sanitizeFileName('smoke.mp4')).toBe('smoke');
		expect(sanitizeFileName('Final Cut.MP4 ')).toBe('Final Cut');
		expect(sanitizeFileName('a/b:c')).toBe('a_b_c');
		expect(sanitizeFileName('.mp4')).toBe('Export');
		expect(sanitizeFileName('clip.mov')).toBe('clip.mov');
	});
});

describe('motion-graphic render state (MgRenderStateContext provider)', () => {
	it('maps mg-render job states to badge states', () => {
		expect(mgRenderStateOf(undefined)).toBeUndefined();
		expect(mgRenderStateOf(job({ state: 'queued' }))).toEqual({ status: 'rendering', progress: 0 });
		expect(mgRenderStateOf(job({ state: 'running', progress: 0.4 }))).toEqual({
			status: 'rendering',
			progress: 0.4,
		});
		expect(mgRenderStateOf(job({ state: 'succeeded' }))).toEqual({ status: 'ready' });
		expect(
			mgRenderStateOf(
				job({ state: 'failed', error: { code: 'RENDER_FAILED', message: 'boom', retryable: true } }),
			),
		).toEqual({ status: 'failed', message: 'boom' });
		expect(mgRenderStateOf(job({ state: 'cancelled' }))).toEqual({ status: 'none' });
	});

	it('tracks the latest render job per clip', () => {
		trackMgRenderJob('clp_A', 'job_mg_1');
		trackMgRenderJob('clp_A', 'job_mg_2');
		expect(mgRenderJobForClip('clp_A')).toBe('job_mg_2');
		expect(mgRenderJobForClip('clp_B')).toBeUndefined();
	});
});
