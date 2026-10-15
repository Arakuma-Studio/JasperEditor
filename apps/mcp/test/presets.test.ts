import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type EffectPreset,
	flicksPerFrame,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const F30 = flicksPerFrame({ num: 30, den: 1 });

function fakeEngine() {
	const ids = createCounterIdSource(7);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Presets', preset: 'hd-1080p-30' });
	let revision = 0;
	const txs: Record<string, unknown>[] = [];
	const apply = (tx: Record<string, unknown>) => {
		txs.push(tx);
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-10-05T00:00:00.000Z',
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
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'clip.addSolid', at: 100, duration: 90, track: 'V1', color: [0, 1, 0, 1], ref: '$b' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.gaussian-blur', ref: '$fx' },
			{ type: 'keyframe.add', target: ['effect', '$fx', 'radius'], at: { frames: 20 }, value: 0 },
			{ type: 'keyframe.add', target: ['effect', '$fx', 'radius'], at: { frames: 29 }, value: 30 },
		],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const lib: { revision: number; folders: unknown[]; presets: EffectPreset[] } = {
		revision: 0,
		folders: [{ id: 'fxb_1', name: 'Mine' }],
		presets: [],
	};
	let n = 0;
	const client = {
		agentQuery: async () => ({ result: doc, revision, via: 'headless' }),
		agentTx: async (req: { transaction: Record<string, unknown> }) => ({
			result: apply(req.transaction),
			appliedBy: 'headless',
		}),
		call: async (
			name: string,
			opts: { body?: Record<string, unknown>; params?: Record<string, string> } = {},
		) => {
			if (name === 'effectPresetsList') return structuredClone(lib);
			if (name === 'effectPresetCreate') {
				const p = {
					...(opts.body!.preset as EffectPreset),
					id: `fxp_${String(++n).padStart(16, '0')}`,
					...(opts.body!.folderId ? { folderId: opts.body!.folderId as string } : {}),
				};
				lib.presets.push(p);
				lib.revision++;
				return p;
			}
			throw new Error(`unexpected call ${name}`);
		},
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return {
		link,
		lib,
		txs,
		doc: () => doc,
		a: setup.refs.$a!,
		b: setup.refs.$b!,
		fx: setup.refs.$fx!,
	};
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'presets-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'presets-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		return { r, text, json: JSON.parse(text) };
	};
	return { engine, client, call };
}

type Solid = {
	sourceIn: number;
	effects: { id: string; effectId: string; params: Record<string, { keyframes: { time: number }[] }> }[];
	opacity: { keyframes: { time: number; value: number }[] };
};
const clip = (doc: ProjectDocument, id: string) =>
	Object.values(doc.sequences)[0]!.clips[id] as unknown as Solid;

describe('effect preset MCP tools (FX-030, AGT-020)', () => {
	it('filters built-in presets by query and reports user library bins', async () => {
		const { call } = await connect();
		const all = (await call('list_effect_presets')).json;
		expect(all.bins).toEqual([{ id: 'fxb_1', path: 'Mine' }]);
		const fades = (await call('list_effect_presets', { query: 'fade' })).json.presets.map(
			(p: { id: string }) => p.id,
		);
		expect(fades).toEqual(['builtin.fade-in', 'builtin.fade-out']);
		const full = (await call('get_effect_preset', { presetId: 'builtin.fade-out' })).json.preset;
		expect(full.format).toBe('jasper-effect-preset');
	});

	it('saves from a clip, applies by id with Anchor to Out, and refuses built-in deletion', async () => {
		const { engine, call } = await connect();
		const saved = await call('save_effect_preset', {
			projectId: 'prj_test',
			clipId: engine.a,
			name: 'Blur Out',
			type: 'anchor-out',
			binId: 'fxb_1',
		});
		expect(saved.r.isError, saved.text).toBeFalsy();
		expect(saved.json.saved).toMatchObject({
			name: 'Blur Out',
			type: 'anchor-out',
			bin: 'Mine',
			effects: ['Gaussian Blur'],
		});
		const id = saved.json.saved.id;
		expect(engine.lib.presets[0]!.effects![0]!.params.radius!.keyframes!.map((k) => k.time / F30)).toEqual([
			20, 29,
		]);

		const applied = await call('apply_effect_preset', {
			projectId: 'prj_test',
			clipIds: [engine.b],
			presetId: id,
		});
		expect(applied.r.isError, applied.text).toBeFalsy();
		const B = clip(engine.doc(), engine.b);
		const blur = B.effects.find((e) => e.effectId === 'jasper.gaussian-blur')!;
		expect(blur.params.radius!.keyframes.map((k) => (k.time - B.sourceIn) / F30)).toEqual([80, 89]);

		const builtin = await call('delete_effect_preset', { presetId: 'builtin.fade-in' });
		expect(builtin.r.isError).toBe(true);
	});

	it('applies inline JSON and a built-in to several clips in one transaction; validates authored presets', async () => {
		const { engine, call } = await connect();
		const before = engine.txs.length;
		const r = await call('apply_effect_preset', {
			projectId: 'prj_test',
			clipIds: [engine.a, engine.b],
			presetId: 'builtin.fade-in',
		});
		expect(r.r.isError, r.text).toBeFalsy();
		expect(engine.txs.length).toBe(before + 1);
		for (const id of [engine.a, engine.b]) {
			const c = clip(engine.doc(), id);
			expect(c.opacity.keyframes.map((k) => [(k.time - c.sourceIn) / F30, k.value])).toEqual([
				[0, 0],
				[30, 100],
			]);
		}
		const bad = await call('save_effect_preset', {
			preset: { format: 'jasper-effect-preset', version: 1, name: 'x' },
		});
		expect(bad.r.isError).toBe(true);
		const good = await call('save_effect_preset', {
			preset: {
				format: 'jasper-effect-preset',
				version: 1,
				name: 'Half',
				type: 'scale',
				source: { duration: 30, frameRate: { num: 30, den: 1 } },
				intrinsic: { opacity: { value: 50 } },
			},
		});
		expect(good.r.isError, good.text).toBeFalsy();
		const both = await call('apply_effect_preset', { projectId: 'prj_test', clipIds: [engine.a] });
		expect(both.r.isError).toBe(true);
	});
});
