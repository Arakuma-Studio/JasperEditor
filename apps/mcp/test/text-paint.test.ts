// spec 13 SH-004: add_text takes every stroke (position, colour with opacity) and a shadow with spread.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	type Clip,
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

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const ids = createCounterIdSource(11);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Text', preset: 'hd-1080p-30' });
	let revision = 0;
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => {
			const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...req.transaction, origin: 'user' } as never, {
				ids,
				now: () => '2026-10-25T00:00:00.000Z',
				revision,
				registries: defaultRegistries(),
			});
			if (r.result.ok) {
				doc = r.document;
				revision++;
			}
			return { result: r.result, appliedBy: 'headless' };
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	const { server } = createJasperMcpServer({ link, agentName: 'text-test' });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const mcp = new Client({ name: 'text-test', version: '1' });
	await mcp.connect(b);
	open.push(mcp);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await mcp.callTool({ name, arguments: { projectId: 'prj_test', ...args } })) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
		return { isError: !!r.isError, text };
	};
	return { call, doc: () => doc };
}

describe('add_text strokes and shadow (spec 13 SH-004)', () => {
	it('writes every stroke and the shadow with its spread', async () => {
		const { call, doc } = await connect();
		const r = await call('add_text', {
			text: 'Pixel Pop',
			at: 0,
			duration: 30,
			strokes: [{ color: '#AE00FF', widthPx: 11.5 }, { color: '#00000080', widthPx: 4, position: 'inside' }],
			shadow: { color: '#221D58CC', distancePx: 0, blurPx: 250, spreadPx: 26.87 },
		});
		expect(r.isError, r.text).toBe(false);
		const clip = Object.values(Object.values(doc().sequences)[0]!.clips).find((c) => c.kind === 'text') as Extract<
			Clip,
			{ kind: 'text' }
		>;
		expect(clip.content.style.strokes).toEqual([
			{ color: [0xae / 255, 0, 1, 1], widthPx: 11.5, position: 'outside' },
			{ color: [0, 0, 0, 0.502], widthPx: 4, position: 'inside' },
		]);
		expect(clip.content.style.shadow).toEqual({
			color: [0x22 / 255, 0x1d / 255, 0x58 / 255, 0.8],
			angleDeg: 90,
			distancePx: 0,
			blurPx: 250,
			spreadPx: 26.87,
		});
	});

	it('refuses unknown keys and out-of-range values', async () => {
		const { call } = await connect();
		const bad = await call('add_text', { text: 'x', at: 0, duration: 30, shadow: { color: '#000000', size: 3 } });
		expect(bad.isError).toBe(true);
		const neg = await call('add_text', { text: 'x', at: 0, duration: 30, shadow: { color: '#000000', spreadPx: -1 } });
		expect(neg.isError).toBe(true);
		const many = await call('add_text', {
			text: 'x',
			at: 0,
			duration: 30,
			strokes: Array.from({ length: 17 }, () => ({ color: '#000000', widthPx: 1 })),
		});
		expect(many.isError).toBe(true);
	});
});
