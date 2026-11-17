// measure_loudness waits for the engine's analysis JOB (reported: a 15:36 sequence through a Rubber Band R3 Pitch
// Shifter took minutes to mix, and the request that waited for it timed out at 180 s twice). The fake engine's
// analysis runs while the tool polls it; past the tool's wait the job is named with the call that finishes it.
import type { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject, type ProjectDocument } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const LOUDNESS = {
	integratedLufs: -19.4,
	lra: 6.1,
	truePeakDbtp: -1.2,
	samplePeakDb: -1.5,
	maxMomentaryLufs: -12,
	maxShortTermLufs: -15,
	durationSec: 936,
};

/** An engine whose analysis job is still mixing for `polls` reads (Infinity: until the end of the test). */
function fakeEngine(polls: number) {
	const doc: ProjectDocument = createEmptyProject({
		ids: createCounterIdSource(5),
		name: 'Long mix',
		preset: 'hd-1080p-30',
	});
	const waited: boolean[] = [];
	const scopes: unknown[] = [];
	const cancelled: string[] = [];
	let left = polls;
	const job = () => {
		const done = left <= 0;
		return {
			id: 'job_mix',
			kind: 'analysis',
			title: 'Analyze audio – tracks',
			state: done ? 'succeeded' : 'running',
			progress: done ? 1 : 0.5,
			...(done
				? {
						result: {
							sampleRate: 48000,
							range: { startFrame: 0, endFrame: 28080 },
							loudness: LOUDNESS,
							mixHash: 'mix_1',
						},
					}
				: { stage: 'Mixing audio: frame 14040 of 28080' }),
		};
	};
	const client = {
		agentQuery: async () => ({ result: doc, revision: 1, via: 'headless' }),
		analyzeAudio: async (req: { scope: unknown }, wait?: boolean) => {
			waited.push(!!wait);
			scopes.push(req.scope);
			return { ...job(), state: 'queued', progress: 0 };
		},
		getJob: async () => {
			left--;
			return job();
		},
		cancelJob: async (id: string) => {
			cancelled.push(id);
			return { ...job(), state: 'cancelled' };
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, waited, cancelled, scopes };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
	vi.useRealTimers();
});

async function connect(polls: number) {
	const engine = fakeEngine(polls);
	const { server } = createJasperMcpServer({
		link: engine.link,
		agentName: 'loudness-test',
		toolsets: 'all',
	});
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'loudness-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const progress: string[] = [];
	let firstProgress!: () => void;
	const reported = new Promise<void>((resolve) => {
		firstProgress = resolve;
	});
	const measure = async (args: Record<string, unknown> = {}) => {
		const r = (await client.callTool(
			{ name: 'measure_loudness', arguments: { projectId: 'prj_t', tracks: ['A1'], ...args } },
			undefined,
			{
				// the tool waits up to 300 s: longer than the client's default request timeout
				timeout: 600_000,
				onprogress: (p) => {
					progress.push(p.message ?? '');
					firstProgress();
				},
			},
		)) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		expect(r.isError, text).toBeFalsy();
		return JSON.parse(text) as Record<string, unknown>;
	};
	return { engine, measure, progress, reported };
}

describe('measure_loudness on a slow mix', () => {
	it('waits for the analysis job with its progress and returns the measurement', async () => {
		const { engine, measure, progress } = await connect(2);
		const r = await measure();
		expect(r).toMatchObject({ loudness: LOUDNESS, stale: false });
		expect(engine.waited).toEqual([false]);
		expect(progress.some((m) => m.includes('frame 14040 of 28080'))).toBe(true);
	});

	it('past its wait returns the running job and the call that finishes it, and leaves the job running', async () => {
		const { engine, measure, reported } = await connect(Number.POSITIVE_INFINITY);
		vi.useFakeTimers();
		let settled = false;
		const pending = measure().finally(() => {
			settled = true;
		});
		await Promise.race([reported, pending]);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(300_000);
		const r = await pending;
		expect(r).toMatchObject({ jobId: 'job_mix', timedOut: true });
		expect(r.next).toBe('Call wait_for_job {jobId: "job_mix"}: its result is the measurement.');
		expect(engine.cancelled).toEqual([]);
	});
});

describe('measure_loudness scopes', () => {
	// Video team report (2026-11-17): scope "tracks" with start/end measured the whole sequence.
	it('measures start…end (or In/Out) of soloed tracks and of the mix whatever the scope says', async () => {
		const { engine, measure } = await connect(0);
		await measure({ scope: 'tracks', start: 30, end: 90 });
		await measure({ scope: 'inOut' });
		await measure({ scope: 'sequence', tracks: undefined, start: 30, end: 90 });
		await measure({ scope: 'range', tracks: undefined, start: 30 });
		expect(engine.scopes).toEqual([
			{ type: 'tracks', trackIds: ['A1'], startFrame: 30, endFrame: 90 },
			{ type: 'tracks', trackIds: ['A1'], inOut: true },
			{ type: 'range', startFrame: 30, endFrame: 90 },
			{ type: 'range', startFrame: 30 },
		]);
	});
});
