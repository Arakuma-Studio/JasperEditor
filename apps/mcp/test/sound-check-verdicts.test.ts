// sound_check's humanVerdicts and custom target (wp-note "Phase 5 → WP5.2"): the user's listen-here verdicts — the
// `comment` markers the editor's Sound Check panel writes ("Sound Check: sounds right" / "Sound Check: flagged" + the
// note) — come back to the agent with their timecode, the listen slot they sit on, and the note; an agent's own
// marker with that name is not a human verdict; `target` reaches the engine request. The engine is faked (the real
// check runs in `sound-check.test.ts`).
import type { SoundCheckRequest } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	SOUND_CHECK_VERDICT_MARKER,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { resultFixture } from './sound-check-report-fixture.ts';
import { readToolResponse } from './tool-response.ts';

function fakeEngine() {
	const ids = createCounterIdSource(5);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Check', preset: 'hd-1080p-30' });
	let revision = 0;
	const seqId = Object.keys(doc.sequences)[0]!;
	const apply = (tx: Record<string, unknown>, origin: unknown) => {
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', sequenceId: seqId, label: 'x', ...tx, origin } as never,
			{ ids, now: () => '2026-10-17T00:00:00.000Z', revision, registries: defaultRegistries() },
		);
		if (r.result.ok) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	// the user listened: the hero sounds right, the worst moment is flagged with a note; an agent wrote a marker with
	// the same name (not a human verdict) and the user an ordinary comment marker
	const user = apply(
		{
			commands: [
				{ type: 'marker.add', frame: 91, name: SOUND_CHECK_VERDICT_MARKER.ok, markerType: 'comment' },
				{
					type: 'marker.add',
					frame: 90,
					name: SOUND_CHECK_VERDICT_MARKER.flag,
					markerType: 'comment',
					comment: 'The impact is late',
				},
				{ type: 'marker.add', frame: 12, name: 'Check the logo', markerType: 'comment' },
			],
		},
		'user',
	);
	if (!user.ok) throw new Error(JSON.stringify(user.errors));
	const agent = apply(
		{
			commands: [
				{ type: 'marker.add', frame: 150, name: SOUND_CHECK_VERDICT_MARKER.ok, markerType: 'comment' },
			],
		},
		{ agent: 'other-agent' },
	);
	if (!agent.ok) throw new Error(JSON.stringify(agent.errors));
	const requests: SoundCheckRequest[] = [];
	const job = (state: string) => ({
		id: 'job_check',
		kind: 'sound-check',
		title: 'Sound Check',
		origin: { type: 'agent', agentRunId: 'x' },
		state,
		progress: state === 'succeeded' ? 1 : 0,
		createdAt: '2026-10-17T10:00:00.000Z',
		priority: 'user',
		cpuSlots: 2,
		...(state === 'succeeded' ? { result: resultFixture({ projectId: 'prj_test', sequenceId: seqId }) } : {}),
	});
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		soundCheck: async (req: SoundCheckRequest) => {
			requests.push(req);
			return job('queued');
		},
		getJob: async () => job('succeeded'),
		call: async (name: string) => {
			throw new Error(`unexpected call ${name}`);
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, requests, seqId };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'check-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'check-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (args: Record<string, unknown>) =>
		readToolResponse(
			(await client.callTool({
				name: 'sound_check',
				arguments: { projectId: 'prj_test', images: false, ...args },
			})) as CallToolResult,
		);
	return { engine, call };
}

describe('sound_check humanVerdicts / target', () => {
	it('returns the user’s listen-here verdicts with timecode, slot and note; not an agent’s marker', async () => {
		const { call, engine } = await connect();
		const r = await call({});
		expect(r.isError).toBe(false);
		expect(r.body.humanVerdicts).toEqual([
			expect.objectContaining({
				frame: 90,
				timecode: '00:00:03:00',
				verdict: 'flagged',
				note: 'The impact is late',
				slot: 'worst',
			}),
			expect.objectContaining({
				frame: 91,
				timecode: '00:00:03:01',
				verdict: 'sounds right',
				note: null,
				slot: 'hero',
			}),
		]);
		expect(engine.requests[0]).not.toHaveProperty('target');
	});

	it('passes a custom target to the engine; refuses one out of range', async () => {
		const { call, engine } = await connect();
		const r = await call({ target: { integratedLufs: -20, truePeakDb: -2 } });
		expect(r.isError).toBe(false);
		expect(engine.requests[0]).toMatchObject({ target: { integratedLufs: -20, truePeakDb: -2 } });
		const bad = await call({ target: { integratedLufs: -80, truePeakDb: -2 } });
		expect(bad.isError).toBe(true);
	});
});
