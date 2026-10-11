import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type ShapeItem,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Shapes', preset: 'hd-1080p-30' });
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
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'shapes-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'shapes-test', version: '1' });
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

const shapeClips = (doc: ProjectDocument) =>
	Object.values(Object.values(doc.sequences)[0]!.clips).filter((c) => c.kind === 'shape') as unknown as {
		id: string;
		shape: { type: string; contents: ShapeItem[] };
	}[];

describe('vector shape MCP tools', () => {
	it('presets, add, get, update (nested taper / transform), path edits, remove', async () => {
		const { engine, call } = await connect();
		const presets = await call('list_shape_presets');
		expect((presets.json.presets as { id: string }[]).map((p) => p.id)).toContain('heart');
		const add = await call('add_vector_shape', {
			projectId: 'prj_t',
			at: 0,
			items: [
				{
					type: 'group',
					name: 'G',
					transform: { rotation: 15, scale: [50, 50] },
					contents: [
						{ type: 'path', path: 'M0 0 L100 0 L50 80' },
						{ type: 'stroke', width: 6, taper: { startLength: 30, startWidth: 0 } },
					],
				},
				{ type: 'trim', end: 50 },
			],
			position: [400, 300],
		});
		expect(add.r.isError, add.text).toBeFalsy();
		const clip = shapeClips(engine.doc())[0]!;
		const group = clip.shape.contents[0] as Extract<ShapeItem, { type: 'group' }>;
		expect(group.transform.rotation.value).toBe(15);
		const stroke = group.contents[1] as Extract<ShapeItem, { type: 'stroke' }>;
		expect(stroke.taper?.startLength.value).toBe(30);
		const get = await call('get_shape', { projectId: 'prj_t', clipId: clip.id });
		expect(get.r.isError, get.text).toBeFalsy();
		expect((get.json.paths as { path: { vertices: unknown[] } }[])[0]!.path.vertices).toHaveLength(3);
		const bad = await call('update_shape_item', {
			projectId: 'prj_t',
			clipId: clip.id,
			itemId: stroke.id,
			patch: { taper: { startLenght: 5 } },
		});
		expect(bad.r.isError).toBe(true);
		expect(bad.text).toContain('startLength');
		const upd = await call('update_shape_item', {
			projectId: 'prj_t',
			clipId: clip.id,
			itemId: stroke.id,
			patch: { lineCap: 'round', dashes: [8, 4] },
		});
		expect(upd.r.isError, upd.text).toBeFalsy();
		const path = group.contents[0]!;
		const ed = await call('edit_shape_path', {
			projectId: 'prj_t',
			clipId: clip.id,
			itemId: path.id,
			ops: [{ op: 'setClosed', closed: true }],
		});
		expect(ed.r.isError, ed.text).toBeFalsy();
		expect(
			(
				engine.doc() &&
				((shapeClips(engine.doc())[0]!.shape.contents[0] as Extract<ShapeItem, { type: 'group' }>)
					.contents[0] as Extract<ShapeItem, { type: 'path' }>)
			).path.value.closed,
		).toBe(true);
		const rm = await call('remove_shape_items', {
			projectId: 'prj_t',
			clipId: clip.id,
			itemIds: [clip.shape.contents[1]!.id],
		});
		expect(rm.r.isError, rm.text).toBeFalsy();
		expect(shapeClips(engine.doc())[0]!.shape.contents).toHaveLength(1);
	});

	it('svg_to_shape: dry run reports warnings, apply adds a clip; convert_shape_to_vector', async () => {
		const { engine, call } = await connect();
		const svg = '<svg viewBox="0 0 100 100"><rect width="100" height="50" fill="#f00"/><text>hi</text></svg>';
		const dry = await call('svg_to_shape', { projectId: 'prj_t', svg, at: 0, dryRun: true });
		expect(dry.r.isError, dry.text).toBeFalsy();
		expect((dry.json.warnings as string[]).some((w) => w.includes('text'))).toBe(true);
		expect(shapeClips(engine.doc())).toHaveLength(0);
		const done = await call('svg_to_shape', { projectId: 'prj_t', svg, at: 0 });
		expect(done.r.isError, done.text).toBeFalsy();
		expect(shapeClips(engine.doc())).toHaveLength(1);
		const rect = await call('add_shape', { projectId: 'prj_t', type: 'rect', at: 200 });
		expect(rect.r.isError, rect.text).toBeFalsy();
		const id = shapeClips(engine.doc()).find((c) => c.shape.type === 'rect')!.id;
		const conv = await call('convert_shape_to_vector', { projectId: 'prj_t', clipIds: [id] });
		expect(conv.r.isError, conv.text).toBeFalsy();
		expect(shapeClips(engine.doc()).every((c) => c.shape.type === 'vector')).toBe(true);
	});
});
