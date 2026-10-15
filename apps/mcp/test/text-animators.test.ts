import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type TextAnimatorGroup,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Text', preset: 'hd-1080p-30' });
	let revision = 0;
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-10-07T00:00:00.000Z',
			revision,
			registries: defaultRegistries(),
		});
		if (r.result.ok && !tx.dryRun) {
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const setup = apply({
		label: 'setup',
		commands: [
			{
				type: 'clip.addText',
				at: 0,
				duration: 150,
				track: 'V1',
				content: { text: 'Hello world' },
				ref: '$t',
			},
		],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, doc: () => doc, text: setup.refs.$t! };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'text-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'text-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		let json: Record<string, unknown> = {};
		try {
			json = JSON.parse(text);
		} catch {}
		return { r, text, json };
	};
	return { engine, call };
}

const animatorsOf = (doc: ProjectDocument, id: string) =>
	(Object.values(doc.sequences)[0]!.clips[id] as { animators?: TextAnimatorGroup[] }).animators ?? [];

describe('text animator MCP tools', () => {
	it('add_text_animator with values, keys and a range; add_text_selector; get; remove', async () => {
		const { engine, call } = await connect();
		const r = await call('add_text_animator', {
			projectId: 'prj_t',
			clipId: engine.text,
			properties: ['position', 'opacity'],
			values: { position: [0, 40], opacity: 0 },
			range: { shape: 'rampUp', basedOn: 'words' },
			keys: {
				'range.offset': [
					[0, -100],
					[1, 100],
				],
			},
		});
		expect(r.r.isError, r.text).toBeFalsy();
		const a = animatorsOf(engine.doc(), engine.text)[0]!;
		expect(a.properties.position!.value).toEqual([0, 40]);
		const s = a.selectors[0]!;
		expect(s.kind === 'range' && [s.shape, s.basedOn, s.offset.keyframes.map((k) => k.value)]).toEqual([
			'rampUp',
			'words',
			[-100, 100],
		]);
		const sel = await call('add_text_selector', {
			projectId: 'prj_t',
			clipId: engine.text,
			animatorId: a.id,
			kind: 'expression',
			expression: 'textIndex % 2 * 100',
			settings: { basedOn: 'words' },
		});
		expect(sel.r.isError, sel.text).toBeFalsy();
		const ex = animatorsOf(engine.doc(), engine.text)[0]!.selectors[1]!;
		expect(ex.kind === 'expression' && [ex.basedOn, ex.amount.expression?.text]).toEqual([
			'words',
			'textIndex % 2 * 100',
		]);
		const got = await call('get_text_animators', { projectId: 'prj_t', clipId: engine.text });
		expect((got.json.animators as unknown[]).length).toBe(1);
		const bad = await call('add_text_animator', {
			projectId: 'prj_t',
			clipId: engine.text,
			properties: ['wobble'],
		});
		expect(bad.r.isError).toBe(true);
		const rm = await call('remove_text_animators', { projectId: 'prj_t', clipId: engine.text });
		expect(rm.r.isError, rm.text).toBeFalsy();
		expect(animatorsOf(engine.doc(), engine.text)).toEqual([]);
	});
	it('set_text_path creates a guide mask and Path Options', async () => {
		const { engine, call } = await connect();
		const r = await call('set_text_path', {
			projectId: 'prj_t',
			clipId: engine.text,
			points: [
				[0, 1],
				[0.5, 0],
				[1, 1],
			],
			firstMargin: 10,
		});
		expect(r.r.isError, r.text).toBeFalsy();
		const clip = Object.values(engine.doc().sequences)[0]!.clips[engine.text] as {
			masks?: { id: string; mode: string }[];
			pathOptions?: { maskId: string; firstMargin: { value: number } };
		};
		expect(clip.masks![0]!.mode).toBe('none');
		expect(clip.pathOptions!.maskId).toBe(clip.masks![0]!.id);
		expect(clip.pathOptions!.firstMargin.value).toBe(10);
	});
});
