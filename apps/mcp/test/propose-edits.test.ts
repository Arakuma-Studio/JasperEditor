// Spec 18 AF-PROP-002 at MCP: `propose_edits` turns an agent's cut (strategy + items with group / reason / beat /
// quote / commands / alternatives) into ONE rough-cut proposal, all-or-nothing: argument refusals (bad group, too
// many items or commands, the strategy's length and sentences) never reach the engine; the engine's refusal lists
// each failing item index with its command error (E_PROPOSAL_INVALID, nothing stored); the result carries the
// proposal id, a ghost summary of what the cut creates, removes, moves and trims, and the wait_for_proposal hint.
// The fake engine stores proposals through the real model (`createProposal`, `proposalItemFailures`).
import type { EngineClient } from '@jasper/engine-client';
import { EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	createProposal,
	defaultRegistries,
	type ProjectDocument,
	type Proposal,
	proposalItemFailures,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const registries = defaultRegistries();
const NOW = '2026-10-31T10:00:00.000Z';

/** V1: A [0,60) B [60,120) C [120,180). */
function project() {
	const ids = createCounterIdSource(3);
	const doc0: ProjectDocument = createEmptyProject({ ids, name: 'Cut', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc0.sequences)[0]!;
	const r = applyTransaction(
		doc0,
		{
			label: 'seed',
			origin: 'user',
			sequenceId: seqId,
			commands: [0, 60, 120].map((at) => ({
				type: 'clip.addSolid',
				at,
				duration: 60,
				track: 'V1',
				color: [1, 1, 1, 1],
			})),
		},
		{ ids, now: () => NOW, revision: 0, registries },
	);
	if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
	const doc = r.document;
	const [a, b, c] = Object.values(doc.sequences[seqId]!.clips).sort((x, y) => x.start - y.start);
	return { doc, seqId, a: a!.id, b: b!.id, c: c!.id };
}

function fakeEngine(doc: ProjectDocument, revision = 5) {
	const calls: { name: string; args: unknown[] }[] = [];
	let n = 0;
	const stored: Proposal[] = [];
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		getProposal: async (_projectId: string, proposalId: string) => {
			const proposal = stored.find((x) => x.id === proposalId);
			if (!proposal) throw new EngineError('PROPOSAL_NOT_FOUND', 'gone', { status: 404 });
			return { proposal, revision, expiresAt: '2026-11-30T10:00:00.000Z' };
		},
		createProposal: async (projectId: string, req: Record<string, unknown>) => {
			calls.push({ name: 'createProposal', args: [projectId, req] });
			const { allOrNothing, expectedRevision, author: _a, ...draft } = req;
			if (typeof expectedRevision === 'number' && expectedRevision > revision)
				throw new EngineError('REVISION_CONFLICT', `Revision ${expectedRevision} is ahead`, {
					status: 409,
					detail: { code: 'E_REVISION_MISMATCH', revision },
				});
			const ctx = { registries, now: () => NOW, revision };
			const r = createProposal(
				doc,
				draft,
				{
					id: `prp_${String(++n).padStart(16, '0')}`,
					projectId,
					author: { agent: 'cut-test' },
					now: NOW,
					revision,
				},
				ctx,
			);
			if (!r.ok)
				throw new EngineError('VALIDATION_FAILED', `The proposal is malformed: ${r.errors[0]!.message}`, {
					status: 400,
					detail: { code: r.errors[0]!.code, errors: r.errors },
				});
			const failures = allOrNothing ? proposalItemFailures(doc, r.proposal, ctx) : [];
			if (failures.length)
				throw new EngineError('PROPOSAL_INVALID', `Nothing was stored: ${failures.length} items fail`, {
					status: 422,
					detail: { code: 'E_PROPOSAL_INVALID', items: failures, revision },
				});
			stored.push(r.proposal);
			return { proposal: r.proposal, revision, evicted: [], expiresAt: '2026-11-30T10:00:00.000Z' };
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, calls, stored };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(revision?: number) {
	const p = project();
	const engine = fakeEngine(p.doc, revision);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'cut-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'cut-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (args: Record<string, unknown>, name = 'propose_edits') => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		let json: Record<string, unknown> & {
			error?: { code: string; message: string; hint?: string; details?: unknown };
		};
		try {
			json = JSON.parse(text);
		} catch {
			json = { error: { code: 'TEXT', message: text } };
		}
		return { r, json };
	};
	return { ...p, engine, call };
}

const STRATEGY = 'Open on the hook. Cut the weak middle take. Put the product shot on V2 under the demo.';

describe('propose_edits (AF-PROP-002)', () => {
	it('stores one rough-cut proposal and returns its id, a ghost summary and the review hint', async () => {
		const t = await connect();
		const { r, json } = await t.call({
			projectId: t.doc.projectId,
			sequenceId: t.seqId,
			title: 'Tight cut',
			strategy: STRATEGY,
			items: [
				{
					group: 'removed',
					beat: 'Middle take',
					quote: 'and then, uh, the thing',
					reason: 'Weaker read than the ending',
					commands: [{ type: 'clip.extract', clipIds: [t.b] }],
				},
				{
					group: 'selects',
					reason: 'Tighten the opening',
					commands: [{ type: 'clip.trim', clipId: t.a, edge: 'out', deltaFrames: -10, mode: 'ripple' }],
				},
				{
					group: 'reorder',
					reason: 'The ending reads better above the B-roll',
					commands: [
						{ type: 'clip.move', clipIds: [t.c], deltaFrames: 0, deltaTracks: 1, createTracks: true },
					],
				},
				{
					group: 'b-roll',
					beat: 'Product',
					reason: 'Cover the jump with the product shot',
					commands: [{ type: 'clip.addSolid', at: 200, duration: 30, track: 'V1', color: [0, 0, 0, 1] }],
					alternatives: [
						{
							label: 'Longer shot',
							reason: 'Hold it through the line',
							commands: [{ type: 'clip.addSolid', at: 200, duration: 60, track: 'V1', color: [0, 0, 0, 1] }],
						},
					],
				},
			],
		});
		expect(r.isError, JSON.stringify(json)).toBeFalsy();
		// what was sent: the rough-cut draft, all-or-nothing, the strategy as its summary
		const sent = t.engine.calls[0]!.args[1] as Record<string, unknown> & { items: Record<string, unknown>[] };
		expect(sent).toMatchObject({
			feature: 'rough-cut',
			sequenceId: t.seqId,
			title: 'Tight cut',
			summary: STRATEGY,
			allOrNothing: true,
		});
		expect(sent).not.toHaveProperty('expectedRevision');
		expect(sent.items[0]).toMatchObject({
			id: 'e0',
			group: 'removed',
			meta: { group: 'removed', beat: 'Middle take', quote: 'and then, uh, the thing' },
		});
		expect(json).toMatchObject({
			proposalId: t.engine.stored[0]!.id,
			feature: 'rough-cut',
			itemCount: 4,
			counts: { pending: 4 },
			groups: { removed: 1, selects: 1, reorder: 1, 'b-roll': 1 },
			ghostSummary: { clips: { created: 1, removed: 1, moved: 1, trimmed: 1 } },
		});
		const table = json.ghosts as string;
		expect(table).toMatch(/e0 \| pending \| delete clip \| V1/);
		expect(table).toMatch(/e3 \| pending \| create clip \| V1 \| 00:00:06:20/);
		expect(json.next).toMatch(/wait_for_proposal/);
		expect(json.next).toMatch(/Review panel/);
		// get_proposal reads the rows back with their reason, beat and quote
		const got = await t.call({ projectId: t.doc.projectId, proposalId: json.proposalId }, 'get_proposal');
		expect(got.r.isError, JSON.stringify(got.json)).toBeFalsy();
		expect((got.json.items as unknown[])[0]).toMatchObject({
			itemId: 'e0',
			group: 'removed',
			why: 'Weaker read than the ending',
			beat: 'Middle take',
			quote: 'and then, uh, the thing',
		});
		expect(got.json.summary).toBe(STRATEGY);
		expect(got.json.next).not.toMatch(/sound_check/);
	});

	it('one failing item refuses the whole cut, listing each failing index with its command error', async () => {
		const t = await connect();
		const { r, json } = await t.call({
			projectId: t.doc.projectId,
			sequenceId: t.seqId,
			title: 'Cut',
			strategy: 'Drop two takes.',
			items: [
				{ group: 'removed', reason: 'B', commands: [{ type: 'clip.extract', clipIds: [t.b] }] },
				{
					group: 'removed',
					reason: 'gone',
					commands: [
						{ type: 'marker.add', frame: 1 },
						{ type: 'clip.lift', clipIds: ['clp_ZZZZZZZZZZZZZZZZ'] },
					],
				},
				{ group: 'removed', reason: 'B again', commands: [{ type: 'clip.extract', clipIds: [t.b] }] },
			],
		});
		expect(r.isError).toBe(true);
		expect(json.error).toMatchObject({
			code: 'E_PROPOSAL_INVALID',
			details: {
				failures: [
					{ index: 1, code: 'E_NOT_FOUND', commandIndex: 1 },
					{ index: 2, code: 'E_CONFLICT', commandIndex: null },
				],
			},
		});
		expect(json.error!.hint).toMatch(/Nothing was stored/);
		expect(t.engine.stored).toEqual([]);
		// a malformed command (unknown keys) is listed by its item index too
		const bad = await t.call({
			projectId: t.doc.projectId,
			sequenceId: t.seqId,
			title: 'Cut',
			strategy: 'Drop a take.',
			items: [
				{ group: 'removed', reason: 'ok', commands: [{ type: 'marker.add', frame: 1 }] },
				{ group: 'removed', reason: 'typo', commands: [{ type: 'clip.lift', clipIds: [t.b], clipsIds: [] }] },
			],
		});
		expect(bad.r.isError).toBe(true);
		expect(bad.json.error).toMatchObject({
			code: 'E_PROPOSAL_INVALID',
			details: { failures: [{ index: 1, commandIndex: 0 }] },
		});
		expect(t.engine.stored).toEqual([]);
	});

	it('refuses bad arguments before the engine: group, sizes, the strategy', async () => {
		const t = await connect();
		const item = { group: 'selects', reason: 'Keep', commands: [{ type: 'marker.add', frame: 1 }] };
		const args = (o: Record<string, unknown>) => ({
			projectId: t.doc.projectId,
			sequenceId: t.seqId,
			title: 'Cut',
			strategy: 'Keep it.',
			items: [item],
			...o,
		});
		const refused = async (o: Record<string, unknown>) => {
			const { r, json } = await t.call(args(o));
			expect(r.isError, JSON.stringify(o).slice(0, 200)).toBe(true);
			return `${json.error!.code}: ${json.error!.message}`;
		};
		expect(await refused({ items: [{ ...item, group: 'keepers' }] })).toMatch(/group/);
		expect(await refused({ items: Array(201).fill(item) })).toMatch(/items/);
		expect(await refused({ items: [{ ...item, commands: Array(101).fill(item.commands[0]) }] })).toMatch(
			/commands/,
		);
		expect(await refused({ items: [{ ...item, reason: 'x'.repeat(281) }] })).toMatch(/reason/);
		expect(await refused({ items: [{ ...item, beat: 'x'.repeat(41) }] })).toMatch(/beat/);
		const full = { ...item, commands: Array(100).fill(item.commands[0]) };
		expect(await refused({ items: Array(21).fill(full) })).toMatch(/^E_INVALID_PARAM: .*2000 commands/);
		expect(await refused({ strategy: 'x'.repeat(2001) })).toMatch(/strategy/);
		expect(await refused({ strategy: 'A. B. C. D. E. F. G. H. I.' })).toMatch(
			/^E_INVALID_PARAM: .*sentences/,
		);
		expect(t.engine.calls).toEqual([]);
	});

	it('passes expectedRevision; ahead of the document → E_REVISION_MISMATCH', async () => {
		const t = await connect(5);
		const item = { group: 'other', reason: 'Mark it', commands: [{ type: 'marker.add', frame: 1 }] };
		const base = { projectId: t.doc.projectId, sequenceId: t.seqId, title: 'Cut', strategy: 'Mark it.' };
		const ok = await t.call({ ...base, items: [item], expectedRevision: 5 });
		expect(ok.r.isError, JSON.stringify(ok.json)).toBeFalsy();
		expect((t.engine.calls[0]!.args[1] as { expectedRevision: number }).expectedRevision).toBe(5);
		const ahead = await t.call({ ...base, items: [item], expectedRevision: 9 });
		expect(ahead.r.isError).toBe(true);
		expect(ahead.json.error!.code).toBe('E_REVISION_MISMATCH');
	});
});
