// Editing automation tools (spec 15 EA-041): decorate_cuts, add_punch_ins, add_ken_burns — conventions (titles,
// annotations, strict arguments), parameters passed as the pass's plain data (times as frames / seconds /
// timecode), dry runs answered at once, proposals waited for, E_TOO_LARGE as a tool error with the range, the guide,
// and refresh_proposal's reroll.
import type { AutomationPassResult, EngineJob } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { createCounterIdSource, createEmptyProject, type ProjectDocument } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const P = 'prj_automation';
const doc: ProjectDocument = createEmptyProject({ ids: createCounterIdSource(3), name: 'A', preset: 'hd-1080p-30' });
const SEQ = Object.keys(doc.sequences)[0]!;

const result = (mode: 'propose' | 'dryRun', pass: string, proposalId: string | null): AutomationPassResult => ({
	mode,
	pass: pass as AutomationPassResult['pass'],
	projectId: P,
	sequenceId: SEQ,
	summary: {
		pass: pass as AutomationPassResult['pass'],
		sequenceId: SEQ,
		seed: 1,
		count: 3,
		considered: 4,
		coverage: 0.75,
		skipped: {
			count: 1,
			byCode: { 'too-close': 1 },
			first: [{ frame: 50, timecode: '00:00:01:20', code: 'too-close', reason: 'too close to the previous kit' }],
		},
		families: { jolt: 2, whip: 1 },
		cost: { class: 'remotion', frames: 80, effects: ['jasper.transform'] },
		track: 'new track FX',
		warnings: [],
	},
	sfx: { enabled: true, type: 'whoosh', available: 4, placed: 3, sounds: 3, unsounded: 0 },
	budget: { fits: true, items: 4, commands: 13 },
	proposalId,
	revision: proposalId ? 4 : null,
	itemCount: proposalId ? 4 : 3,
	invalid: [],
	warnings: [],
});

function fakeEngine(opts: { jobState?: 'succeeded' | 'failed'; error?: EngineJob['error'] } = {}) {
	const calls: { name: string; args: unknown[] }[] = [];
	const job = (state: string, res?: unknown): EngineJob =>
		({
			id: 'job_1',
			kind: 'edit-automation',
			title: 'Decorate Cuts',
			origin: { type: 'agent', agentRunId: 'automation-test' },
			state,
			progress: state === 'succeeded' ? 1 : 0,
			createdAt: '2026-10-26T00:00:00.000Z',
			...(res !== undefined ? { result: res } : {}),
			...(opts.error ? { error: opts.error } : {}),
		}) as unknown as EngineJob;
	let lastPass = 'decorate-cuts';
	const client = {
		agentQuery: async () => ({ result: doc, revision: 3, via: 'headless' }),
		automationPass: async (projectId: string, pass: string, req: { mode?: string }) => {
			calls.push({ name: 'automationPass', args: [projectId, pass, req] });
			lastPass = pass;
			if (req.mode === 'dryRun') return result('dryRun', pass, null);
			return job('queued');
		},
		getJob: async () =>
			job(
				opts.jobState ?? 'succeeded',
				(opts.jobState ?? 'succeeded') === 'succeeded' ? result('propose', lastPass, 'prp_0000000000000009') : undefined,
			),
		refreshProposal: async (projectId: string, proposalId: string, req: unknown) => {
			calls.push({ name: 'refreshProposal', args: [projectId, proposalId, req] });
			return {
				proposal: { items: [], id: proposalId },
				refreshed: ['kit:120'],
				dropped: [],
				unchanged: [],
				stale: [],
				revision: 4,
			};
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, calls };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(opts: Parameters<typeof fakeEngine>[0] = {}) {
	const engine = fakeEngine(opts);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'automation-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'automation-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
		return { r, json: JSON.parse((r.content[0] as { text: string }).text) as Record<string, any> };
	};
	return { engine, client, call };
}

describe('editing automation tools', () => {
	it('are listed with titles and edit annotations', async () => {
		const t = await connect();
		const { tools } = await t.client.listTools();
		for (const name of ['decorate_cuts', 'add_punch_ins', 'add_ken_burns']) {
			const tool = tools.find((x) => x.name === name)!;
			expect(tool, name).toBeDefined();
			expect(tool.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			});
			expect(tool.inputSchema.additionalProperties).toBe(false);
		}
	});

	it('decorate_cuts dry run: parameters as plain data, the range in frames; nothing waited for', async () => {
		const t = await connect();
		const { r, json } = await t.call('decorate_cuts', {
			projectId: P,
			mode: 'dryRun',
			families: { spin: 0 },
			range: { start: { seconds: 1 }, end: '00:00:10:00' },
			sfx: { variety: 8 },
			seed: 5,
		});
		expect(r.isError).toBeFalsy();
		expect(t.engine.calls[0]).toEqual({
			name: 'automationPass',
			args: [
				P,
				'decorate-cuts',
				{
					sequenceId: SEQ,
					mode: 'dryRun',
					params: { families: { spin: 0 }, sfx: { variety: 8 }, seed: 5, range: { start: 30, end: 300 } },
				},
			],
		});
		expect(json).toMatchObject({
			pass: 'decorate-cuts',
			count: 3,
			coverage: 0.75,
			families: { jolt: 2, whip: 1 },
			export: { cost: 'remotion' },
			sfx: { type: 'whoosh', placed: 3 },
			proposalId: null,
		});
		expect(json.next).toContain('mode "propose"');
	});

	it('add_punch_ins / add_ken_burns propose: the job is waited for and the proposal named', async () => {
		const t = await connect();
		const p = await t.call('add_punch_ins', { projectId: P, density: 1, target: { x: 0.3, y: 0.4 }, method: 'motion' });
		expect(p.r.isError).toBeFalsy();
		expect(p.json.proposalId).toBe('prp_0000000000000009');
		expect(p.json.next).toContain('Review panel');
		expect(t.engine.calls[0]!.args[2]).toEqual({
			sequenceId: SEQ,
			mode: 'propose',
			params: { density: 1, target: { x: 0.3, y: 0.4 }, method: 'motion' },
		});
		const k = await t.call('add_ken_burns', { projectId: P, share: 0.2, excludeClipIds: ['clp_1'] });
		expect(k.r.isError).toBeFalsy();
		expect(t.engine.calls[1]!.args[1]).toBe('ken-burns');
	});

	it('strict arguments: unknown keys and bad values are refused before the engine is called', async () => {
		const t = await connect();
		const a = await t.call('decorate_cuts', { projectId: P, covrage: 1 });
		expect(a.r.isError).toBe(true);
		expect(a.json.error.code).toBe('E_UNKNOWN_ARGUMENT');
		const b = await t.call('add_ken_burns', { projectId: P, share: 2 });
		expect(b.r.isError).toBe(true);
		const c = await t.call('decorate_cuts', { projectId: P, range: { start: 100, end: 10 } });
		expect(c.r.isError).toBe(true);
		expect(c.json.error.code).toBe('E_INVALID_PARAM');
		expect(t.engine.calls).toEqual([]);
	});

	it('a pass too big for one proposal is E_TOO_LARGE with the range that fits', async () => {
		const t = await connect({
			jobState: 'failed',
			error: {
				code: 'PROPOSAL_TOO_LARGE',
				message: 'The proposal would need 6200 commands',
				retryable: false,
				detail: { code: 'E_TOO_LARGE', suggestedRange: { start: 0, end: 90_000 } },
			} as EngineJob['error'],
		});
		const r = await t.call('decorate_cuts', { projectId: P });
		expect(r.r.isError).toBe(true);
		expect(r.json.error.code).toBe('E_TOO_LARGE');
		expect(r.json.error.hint).toContain('suggested range');
	});

	it('refresh_proposal passes reroll; the guide has the editing automation section', async () => {
		const t = await connect();
		const r = await t.call('refresh_proposal', {
			projectId: P,
			proposalId: 'prp_0000000000000009',
			itemIds: ['kit:120'],
			reroll: true,
		});
		expect(r.r.isError).toBeFalsy();
		expect(t.engine.calls.at(-1)!.args[2]).toEqual({ itemIds: ['kit:120'], reroll: true });
		const g = await t.client.readResource({ uri: 'jasper://guide' });
		const text = (g.contents[0] as { text: string }).text;
		for (const s of ['Editing automation', 'decorate_cuts', 'add_punch_ins', 'add_ken_burns', 'reroll: true'])
			expect(text).toContain(s);
	});
});
