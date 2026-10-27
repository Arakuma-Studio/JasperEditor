// Spec 17 at MCP (scapply): per-item default selection in get_proposal / accept_proposal (an agent's "all" takes the
// selected items and never the maybe group; the rest is reported as notSelected; named ids pass through), the E_STALE
// hint, and the describe_commands examples of transcript.replaceWords / scriptFix.configure applied to a real document.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type ProjectDocument,
	type Proposal,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TX_ERROR_HINTS } from '../src/errors.ts';
import { COMMAND_EXAMPLES } from '../src/examples.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const P = 'prj_scriptfix';
const PRP = 'prp_0000000000000017';

const item = (id: string, group: string, selected?: boolean) => ({
	id,
	label: `Fix ${id}`,
	group,
	meta: { group },
	commands: [{ type: 'marker.add', frame: 1 }],
	requires: [],
	state: 'pending' as const,
	...(selected !== undefined ? { selected } : {}),
});

const proposal = (items: ReturnType<typeof item>[]): Proposal =>
	({
		version: 1,
		id: PRP,
		projectId: P,
		sequenceId: null,
		feature: 'transcript-correction',
		title: 'Fix transcript',
		summary: '',
		author: { agent: 'fixer' },
		createdAt: '2026-10-27T00:00:00.000Z',
		updatedAt: '2026-10-27T00:00:00.000Z',
		baseRevision: 0,
		docHash: 'x',
		items,
	}) as Proposal;

function fakeEngine(p: Proposal) {
	const accepts: unknown[] = [];
	const client = {
		getProposal: async () => ({ proposal: p, expiresAt: '2026-11-27T00:00:00.000Z', revision: 3 }),
		acceptProposal: async (_pid: string, _id: string, req: { itemIds: string[] | 'all' }) => {
			accepts.push(req);
			const ids = req.itemIds === 'all' ? p.items.map((i) => i.id) : req.itemIds;
			return {
				proposal: { ...p, items: p.items.map((i) => (ids.includes(i.id) ? { ...i, state: 'accepted' } : i)) },
				applied: ids,
				added: [],
				skipped: [],
				stale: [],
				result: { label: 'Accept' },
				appliedBy: 'headless',
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
	return { link, accepts };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(p: Proposal) {
	const engine = fakeEngine(p);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'scriptfix-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'scriptfix-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
		return { r, json: JSON.parse((r.content[0] as { text: string }).text) as Record<string, any> };
	};
	return { engine, call };
}

describe('per-item default selection at MCP (SC-061)', () => {
	it('get_proposal reports selected: false on unselected items', async () => {
		const t = await connect(proposal([item('f1', 'fix'), item('m1', 'maybe', false)]));
		const { r, json } = await t.call('get_proposal', { projectId: P, proposalId: PRP, ghosts: false });
		expect(r.isError).toBeFalsy();
		expect(json.items.map((i: { itemId: string; selected?: boolean }) => [i.itemId, i.selected])).toEqual([
			['f1', undefined],
			['m1', false],
		]);
	});

	it('accept_proposal "all" sends the selected non-maybe items and lists the rest as notSelected', async () => {
		const t = await connect(
			proposal([item('f1', 'fix'), item('s1', 'spelling'), item('m1', 'maybe', false), item('m2', 'maybe', true)]),
		);
		const { r, json } = await t.call('accept_proposal', { projectId: P, proposalId: PRP, itemIds: 'all' });
		expect(r.isError).toBeFalsy();
		expect(t.engine.accepts).toEqual([{ itemIds: ['f1', 's1'] }]);
		expect(json).toMatchObject({ applied: ['f1', 's1'], notSelected: ['m1', 'm2'] });
		// named ids pass through as given
		await t.call('accept_proposal', { projectId: P, proposalId: PRP, itemIds: ['m1'] });
		expect(t.engine.accepts.at(-1)).toEqual({ itemIds: ['m1'] });
	});

	it('nothing selected: refused with a hint, nothing sent', async () => {
		const t = await connect(proposal([item('m1', 'maybe', false)]));
		const { r, json } = await t.call('accept_proposal', { projectId: P, proposalId: PRP, itemIds: 'all' });
		expect(r.isError).toBe(true);
		expect(json.error.code).toBe('E_INVALID_PARAM');
		expect(json.error.hint).toContain('naming their ids');
		expect(t.engine.accepts).toEqual([]);
	});

	it('E_STALE has a hint', () => {
		expect(TX_ERROR_HINTS.E_STALE).toContain('re-plan');
	});
});

const AUDIO = {
	kind: 'audio',
	fingerprint: `q1:${'7'.repeat(64)}`,
	originalName: 'voice.wav',
	sizeBytes: 1000,
	container: 'wav',
	probe: {
		durationFlicks: 10 * FLICKS_PER_SECOND,
		startTimecode: null,
		streams: [{ index: 0, type: 'audio', codec: 'pcm_s16le', sampleRate: 48000, channels: 1, channelLayout: 'mono' }],
		rotationDegrees: 0,
		hasAlpha: false,
		variableFrameRate: false,
	},
	locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_voice' }],
	derivation: null,
	importedAt: '2026-10-27T00:00:00.000Z',
};

describe('script-fix command examples (describe_commands)', () => {
	it('transcript.replaceWords and scriptFix.configure apply to a real document as written', () => {
		const ids = createCounterIdSource(3);
		const doc: ProjectDocument = createEmptyProject({ ids, name: 'Examples', preset: 'hd-1080p-30' });
		const s = (x: number) => Math.round(x * FLICKS_PER_SECOND);
		const r = applyTransaction(
			doc,
			{
				label: 'examples',
				origin: 'user',
				commands: [
					{ type: 'media.register', asset: AUDIO, ref: '$m' },
					{ type: 'clip.place', source: { mediaId: '$m' }, at: 0, tracks: { audio: ['A1'] } },
					{
						type: 'transcript.create',
						id: 'trs_00000000000000EX',
						mediaId: '$m',
						language: 'es',
						origin: 'manual',
						words: [
							{ text: 'Glimer', start: s(1), end: s(1.3) },
							{ text: 'box', start: s(1.3), end: s(1.5) },
							{ text: 'la', start: s(2.5), end: s(3) },
							{ text: 'tienda', start: s(3.1), end: s(3.5) },
						],
					},
					COMMAND_EXAMPLES['transcript.replaceWords'],
					COMMAND_EXAMPLES['scriptFix.configure'],
				],
			},
			{ ids, now: () => '2026-10-27T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
		);
		expect(r.result.ok, JSON.stringify(r.result.ok ? null : r.result.errors)).toBe(true);
		expect(r.document.transcripts.trs_00000000000000EX!.words.map((w) => w.text)).toEqual([
			'Glimmerbox',
			'la',
			'de',
			'tienda',
		]);
	});
});
