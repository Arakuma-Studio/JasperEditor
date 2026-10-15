import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type EffectInstance,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'SimWarp', preset: 'hd-1080p-30' });
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
	return { link, doc: () => doc };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'sim-warp-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'sim-warp-test', version: '1' });
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

const clipOf = (doc: ProjectDocument) =>
	Object.values(Object.values(doc.sequences)[0]!.clips)[0]! as unknown as {
		id: string;
		effects: EffectInstance[];
	};

async function withEffect(effectId: string) {
	const c = await connect();
	const solid = await c.call('apply_commands', {
		projectId: 'prj_t',
		label: 'Setup',
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 90, track: 'V1', color: [1, 0.5, 0, 1], ref: '$s' },
			{ type: 'effect.add', target: { clipId: '$s' }, effectId },
		],
	});
	expect(solid.r.isError, solid.text).toBeFalsy();
	const fx = () => clipOf(c.engine.doc()).effects[0]!;
	return { ...c, fx };
}

describe('sim-warp MCP tools', () => {
	it('Puppet: add, move, record, get, remove pins', async () => {
		const { call, fx } = await withEffect('jasper.puppet');
		const add = await call('add_puppet_pins', {
			projectId: 'prj_t',
			effectInstanceId: fx().id,
			pins: [{ position: [0.2, 0.5] }, { position: [0.8, 0.5], kind: 'starch' }],
		});
		expect(add.r.isError, add.text).toBeFalsy();
		const pins = fx().puppet!.pins;
		expect(pins.map((p) => p.kind)).toEqual(['position', 'starch']);
		expect(fx().puppet!.meshes).toHaveLength(1);
		const move = await call('move_puppet_pins', {
			projectId: 'prj_t',
			moves: [{ pinId: pins[0]!.id, position: [0.1, 0.4] }],
		});
		expect(move.r.isError, move.text).toBeFalsy();
		expect(fx().puppet!.pins[0]!.position.value).toEqual([0.1, 0.4]);
		const rec = await call('record_puppet_pins', {
			projectId: 'prj_t',
			pinId: pins[0]!.id,
			keys: [
				{ at: 0, value: [0.2, 0.5] },
				{ at: { seconds: 1 }, value: [0.3, 0.2] },
			],
		});
		expect(rec.r.isError, rec.text).toBeFalsy();
		expect(fx().puppet!.pins[0]!.position.keyframes).toHaveLength(2);
		const keyed = await call('move_puppet_pins', {
			projectId: 'prj_t',
			moves: [{ pinId: pins[0]!.id, position: [0.5, 0.5] }],
			at: 15,
		});
		expect(keyed.r.isError, keyed.text).toBeFalsy();
		expect(fx().puppet!.pins[0]!.position.keyframes).toHaveLength(3);
		const get = await call('get_puppet', { projectId: 'prj_t', effectInstanceId: fx().id, at: 30 });
		expect(get.r.isError, get.text).toBeFalsy();
		const got = get.json.pins as {
			pinId: string;
			position: { value: number[]; animated: boolean; keys: number };
		}[];
		expect(got[0]!.position).toEqual({ value: [0.3, 0.2], animated: true, keys: 3 });
		const rm = await call('remove_puppet_pins', {
			projectId: 'prj_t',
			pinIds: pins.map((p) => p.id),
			removeEmptyMeshes: true,
		});
		expect(rm.r.isError, rm.text).toBeFalsy();
		expect(fx().puppet!.pins).toHaveLength(0);
		expect(fx().puppet!.meshes).toHaveLength(0);
	});
});
