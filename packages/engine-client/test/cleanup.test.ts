// EngineClient transcript cleanup calls (spec 14): the analysis job request and the validated analysis file; an
// evicted analysis and an invalid file become EngineErrors.
import { FAST_SETTINGS } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EngineClient, EngineError } from '../src/index.ts';

function client(handler: (url: string, init: RequestInit) => Response) {
	const calls: Array<{ url: string; body?: unknown }> = [];
	const c = new EngineClient({
		baseUrl: 'http://e',
		token: 't',
		fetch: async (input, init) => {
			calls.push({ url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
			return handler(String(input), init ?? {});
		},
	});
	return { c, calls };
}

const json = (v: unknown, status = 200) =>
	new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

const file = {
	format: 'jasper-cleanup-analysis',
	version: 1,
	analysisId: 'cla_1',
	projectId: 'prj_1',
	sequenceId: 'seq_1',
	revision: 3,
	createdAt: '2026-10-26T00:00:00.000Z',
	analysis: {
		ok: true,
		settings: FAST_SETTINGS,
		findings: [],
		groups: [],
		script: null,
		media: [],
		plan: {
			sequenceId: 'seq_1',
			clipIds: [],
			ranges: [],
			kept: [],
			stats: {
				inputDuration: 0,
				outputDuration: 0,
				removedByKind: {},
				joins: 0,
				cutsPerMinute: 0,
				deadAirPerMinute: null,
				largestSilenceLeft: null,
			},
			skipped: [],
			fadeMs: 4,
			jlFrames: 0,
		},
	},
};

describe('EngineClient cleanup', () => {
	it('submits the analysis job and reads the analysis', async () => {
		const job = {
			id: 'job_1',
			kind: 'cleanup-analysis',
			title: 'Clean Up Voice – analysis',
			origin: 'user',
			state: 'queued',
			progress: null,
			createdAt: '2026-10-26T00:00:00.000Z',
			priority: 'interactive',
			cpuSlots: 1,
		};
		const { c, calls } = client((url) => (url.includes('/analyses/') ? json(file) : json(job, 202)));
		const j = await c.analyzeCleanup({ projectId: 'prj_1', presetId: 'builtin.natural' }, true);
		expect(j.kind).toBe('cleanup-analysis');
		expect(calls[0]).toEqual({
			url: 'http://e/api/cleanup/analyze?wait=1',
			body: { projectId: 'prj_1', presetId: 'builtin.natural' },
		});
		const f = await c.getCleanupAnalysis('cla_1');
		expect(f.analysis.plan.fadeMs).toBe(4);
		expect(calls[1]!.url).toBe('http://e/api/cleanup/analyses/cla_1');
	});

	it('an evicted analysis is CLEANUP_ANALYSIS_NOT_FOUND; an invalid file is refused', async () => {
		const gone = client(() =>
			json({ code: 'CLEANUP_ANALYSIS_NOT_FOUND', message: 'No such analysis', retryable: false }, 404),
		);
		await expect(gone.c.getCleanupAnalysis('cla_x')).rejects.toMatchObject({ code: 'CLEANUP_ANALYSIS_NOT_FOUND' });
		const bad = client(() => json({ ...file, analysis: { ...file.analysis, findings: [{ id: 1 }] } }));
		await expect(bad.c.getCleanupAnalysis('cla_1')).rejects.toBeInstanceOf(EngineError);
	});
});
