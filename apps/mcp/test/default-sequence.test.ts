// Tools' optional `sequenceId` defaults to the project's first sequence (every tool documents it) also when the
// project has several sequences — a nest or a multi-camera source sequence is enough. Regression (verify workstream):
// the command system refuses sequence-scoped commands without a sequenceId in such projects, and the tools forwarded
// none, so add_text, add_marker, record_multicam_cuts… failed in any project with a nest. The fake engine here applies
// transactions exactly as sent (no injected sequenceId), like the real one.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

function fakeEngine() {
	const ids = createCounterIdSource(11);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Two sequences', preset: 'hd-1080p-30' });
	let revision = 0;
	const first = Object.keys(doc.sequences)[0]!;
	const sent: Record<string, unknown>[] = [];
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-10-08T00:00:00.000Z',
			revision,
			registries: defaultRegistries(),
		});
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const second = apply({
		label: 'setup',
		sequenceId: first,
		commands: [{ type: 'sequence.create', name: 'Second', ref: '$s' }],
	});
	if (!second.ok) throw new Error(JSON.stringify(second.errors));
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => {
			sent.push(req.transaction);
			return { result: apply(req.transaction), appliedBy: 'headless' };
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, first, second: second.refs.$s as string, sent };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'seq-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'seq-test', version: '1' });
	await client.connect(b);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({
			name,
			arguments: { projectId: 'prj_test', ...args },
		})) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
		return { isError: !!r.isError, text };
	};
	return { engine, call };
}

describe('default sequence of MCP tools in a project with several sequences', () => {
	it('add_text and add_marker without sequenceId edit the first sequence', async () => {
		const { engine, call } = await connect();
		expect(Object.keys(engine.doc().sequences)).toHaveLength(2);
		const t = await call('add_text', { text: 'Hello', at: 0, duration: 30 });
		expect(t.isError, t.text).toBe(false);
		const m = await call('add_marker', { at: 10, name: 'M' });
		expect(m.isError, m.text).toBe(false);
		const doc = engine.doc();
		expect(Object.values(doc.sequences[engine.first]!.clips).some((c) => c.kind === 'text')).toBe(true);
		expect(Object.values(doc.sequences[engine.second]!.clips)).toHaveLength(0);
		expect(Object.values(doc.sequences[engine.first]!.markers ?? {}).map((x) => x.name)).toContain('M');
	});

	it('an explicit sequenceId is sent as given and not second-guessed', async () => {
		const { engine, call } = await connect();
		const t = await call('add_text', { text: 'There', at: 0, duration: 30, sequenceId: engine.second });
		expect(t.isError, t.text).toBe(false);
		expect(Object.values(engine.doc().sequences[engine.second]!.clips)).toHaveLength(1);
		expect(Object.values(engine.doc().sequences[engine.first]!.clips)).toHaveLength(0);
		expect(engine.sent).toHaveLength(1);
	});

	it('other refusals are returned unchanged: no retry with a sequenceId, one retry without', async () => {
		const { engine, call } = await connect();
		const r = await call('add_text', {
			text: 'x',
			at: 0,
			duration: 30,
			track: 'A1',
			sequenceId: engine.first,
		});
		expect(r.isError).toBe(true);
		expect(engine.sent).toHaveLength(1);
		// Without one: refused for the sequence, retried on the first, refused for the track — that error is returned.
		const r2 = await call('add_text', { text: 'x', at: 0, duration: 30, track: 'A1' });
		expect(r2.isError).toBe(true);
		expect(r2.text).not.toMatch(/several sequences/);
		expect(engine.sent).toHaveLength(3);
		expect(Object.values(engine.doc().sequences[engine.first]!.clips)).toHaveLength(0);
	});
});
