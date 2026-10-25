// Proposals for new features at MCP (spec 15 §2.1): list_proposal_features, refresh_proposal (and its refusal),
// E_TOO_LARGE / E_NOT_REFRESHABLE as tool errors with hints, the guide, and the batch commands' describe_commands
// examples applied to a real document (apply_commands carries them like any command).
import type { EngineClient } from '@jasper/engine-client';
import { EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type Proposal,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_EXAMPLES } from '../src/examples.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const P = 'prj_features';
const PRP = 'prp_0000000000000001';
const registries = defaultRegistries();

const proposal = (state: 'pending' | 'stale'): Proposal =>
	({
		version: 1,
		id: PRP,
		projectId: P,
		sequenceId: null,
		feature: 'edit-automation',
		title: 'Decorate Cuts',
		summary: '',
		author: { agent: 'features-test' },
		createdAt: '2026-10-25T00:00:00.000Z',
		updatedAt: '2026-10-25T00:00:00.000Z',
		baseRevision: 0,
		docHash: 'x',
		items: [{ id: 'k1', label: 'Kit', group: 'cut-kits', commands: [{ type: 'marker.add', frame: 1 }], requires: [], state }],
	}) as Proposal;

function fakeEngine(opts: { refreshable: boolean }) {
	const calls: { name: string; args: unknown[] }[] = [];
	const client = {
		proposalFeatures: async (projectId: string) => {
			calls.push({ name: 'proposalFeatures', args: [projectId] });
			return {
				features: [
					{
						id: 'edit-automation',
						name: 'Editing automation',
						description: 'Decorations of the cut',
						itemNoun: { one: '1 edit', other: '{0} edits' },
						groups: [{ id: 'cut-kits', label: 'Cut kits' }],
						producers: ['decorate_cuts'],
						agentAccept: { setting: 'project', allowed: true, default: true, explicit: false },
						refreshable: opts.refreshable,
					},
				],
			};
		},
		refreshProposal: async (projectId: string, proposalId: string, req: unknown) => {
			calls.push({ name: 'refreshProposal', args: [projectId, proposalId, req] });
			if (!opts.refreshable)
				throw new EngineError('PROPOSAL_NOT_REFRESHABLE', 'The producer of "edit-automation" proposals does not re-plan items', {
					status: 409,
					detail: { code: 'E_NOT_REFRESHABLE' },
				});
			return { proposal: proposal('pending'), refreshed: ['k1'], dropped: [], unchanged: [], stale: [], revision: 4 };
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

async function connect(opts: { refreshable: boolean }) {
	const engine = fakeEngine(opts);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'features-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'features-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		return { r, json: JSON.parse((r.content[0] as { text: string }).text) as Record<string, any> };
	};
	return { engine, client, call };
}

describe('proposal feature tools', () => {
	it('list_proposal_features returns the features with the agent-accept state', async () => {
		const t = await connect({ refreshable: true });
		const { r, json } = await t.call('list_proposal_features', { projectId: P });
		expect(r.isError).toBeFalsy();
		expect(json.features[0]).toMatchObject({ id: 'edit-automation', agentAccept: { allowed: true }, refreshable: true });
	});

	it('refresh_proposal re-plans stale items (default "stale"); refused with E_NOT_REFRESHABLE and a hint', async () => {
		const t = await connect({ refreshable: true });
		const { r, json } = await t.call('refresh_proposal', { projectId: P, proposalId: PRP });
		expect(r.isError).toBeFalsy();
		expect(json).toMatchObject({ refreshed: ['k1'], counts: { pending: 1 } });
		expect(t.engine.calls.at(-1)).toEqual({ name: 'refreshProposal', args: [P, PRP, { itemIds: 'stale' }] });
		const u = await connect({ refreshable: false });
		const refused = await u.call('refresh_proposal', { projectId: P, proposalId: PRP, itemIds: ['k1'] });
		expect(refused.r.isError).toBe(true);
		expect(refused.json.error.code).toBe('E_NOT_REFRESHABLE');
		expect(refused.json.error.hint).toContain('propose the changed part again');
		// strict arguments
		const bad = await u.call('refresh_proposal', { projectId: P, proposalId: PRP, itemIds: 'all' });
		expect(bad.r.isError).toBe(true);
	});

	it('the guide explains features, agent accept, refresh, E_TOO_LARGE and the batch commands', async () => {
		const t = await connect({ refreshable: true });
		const g = await t.client.readResource({ uri: 'jasper://guide' });
		const text = (g.contents[0] as { text: string }).text;
		for (const s of ['list_proposal_features', 'refresh_proposal', 'E_TOO_LARGE', 'clip.addAdjustmentBatch', 'keyframe.addBatch', 'meta.anchorOn'])
			expect(text).toContain(s);
	});
});

describe('batch command examples (describe_commands)', () => {
	it('clip.addAdjustmentBatch and keyframe.addBatch apply to a real document as written', () => {
		const ids = createCounterIdSource(3);
		const doc: ProjectDocument = createEmptyProject({ ids, name: 'Examples', preset: 'hd-1080p-30' });
		const r = applyTransaction(
			doc,
			{
				label: 'examples',
				origin: 'user',
				commands: [
					{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [1, 0, 0, 1], ref: '$clip' },
					COMMAND_EXAMPLES['clip.addAdjustmentBatch'],
					COMMAND_EXAMPLES['keyframe.addBatch'],
				],
			},
			{ ids, now: () => '2026-10-25T00:00:00.000Z', revision: 0, registries },
		);
		expect(r.result.ok, JSON.stringify(r.result.ok ? null : r.result.errors)).toBe(true);
		const seq = Object.values(r.document.sequences)[0]!;
		const adj = Object.values(seq.clips).find((c) => c.kind === 'adjustment')!;
		expect([adj.start, adj.duration, adj.name]).toEqual([50, 20, 'Zoom-blur']);
	});
});
