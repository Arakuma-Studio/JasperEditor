// spec 13 AS-033: style_text, list/create/apply/update/delete_text_style against an in-process engine stand-in that
// applies transactions with the real command system; and the describe_commands examples of the new commands.
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	type Clip,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type EffectInstance,
	type ProjectDocument,
	runAgentQuery,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_EXAMPLES } from '../src/examples.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const P = 'prj_styles';
const registries = defaultRegistries();
type TextClip = Extract<Clip, { kind: 'text' }> & { styleId?: string; effects: EffectInstance[] };

function fakeEngine() {
	const ids = createCounterIdSource(21);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Styles', preset: 'hd-1080p-30' });
	let revision = 0;
	const labels: string[] = [];
	const apply = (tx: Record<string, unknown>) => {
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-10-25T00:00:00.000Z',
			revision,
			registries,
		});
		if (r.result.ok && !tx.dryRun) {
			labels.push(String(tx.label));
			doc = r.document;
			revision++;
		}
		return r.result;
	};
	const client = {
		agentQuery: async (req: { query: string; args?: unknown }) => ({
			result: runAgentQuery({ doc, revision, effects: registries.effects }, req.query, req.args ?? {}),
			revision,
			via: 'headless',
		}),
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
	return { link, doc: () => doc, labels, apply };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
type Json = Record<string, any>;

async function connect(clips = 4) {
	const engine = fakeEngine();
	engine.apply({
		label: 'Subtitles',
		commands: [
			...Array.from({ length: clips }, (_, i) => ({
				type: 'clip.addText',
				at: i * 30,
				duration: 30,
				track: 'V2',
				content: { text: `word ${i}` },
			})),
			{ type: 'clip.addSolid', at: 0, duration: 200, track: 'V1', color: [0, 0, 0, 1] },
		],
	});
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'styles-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'styles-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: { projectId: P, ...args } })) as CallToolResult;
		const text = (r.content[0] as { text: string }).text;
		let json: Json = {};
		try {
			json = JSON.parse(text);
		} catch {}
		return { r, text, json };
	};
	const ok = async (name: string, args: Record<string, unknown> = {}) => {
		const out = await call(name, args);
		expect(out.r.isError, `${name}: ${out.text}`).toBeFalsy();
		return out.json;
	};
	const fail = async (name: string, args: Record<string, unknown> = {}) => {
		const out = await call(name, args);
		expect(out.r.isError, `${name} should fail: ${out.text}`).toBe(true);
		return out.json.error as { code: string; message: string };
	};
	const seq = () => Object.values(engine.doc().sequences)[0]!;
	const textIds = () =>
		Object.values(seq().clips)
			.filter((c) => c.kind === 'text')
			.sort((a, b) => a.start - b.start)
			.map((c) => c.id);
	const solidId = () => Object.values(seq().clips).find((c) => c.kind === 'solid')!.id;
	const clip = (id: string) => seq().clips[id] as TextClip;
	return { engine, call, ok, fail, textIds, solidId, clip };
}

describe('style_text (AS-033)', () => {
	it('restyles every clip and adds an effect with keys from each In, in one transaction', async () => {
		const t = await connect();
		const ids = t.textIds();
		const before = t.engine.labels.length;
		await t.ok('style_text', {
			clipIds: ids,
			style: { strokes: [{ color: [0.68, 0, 1, 1], widthPx: 11.5, position: 'outside' }], shadow: { blurPx: 9 } },
			effects: [
				{
					op: 'add',
					effectId: 'jasper.gaussian-blur',
					keyframes: { radius: [{ offset: { frames: 0 }, value: 20 }, { offset: { frames: 5 }, value: 0 }] },
				},
			],
		});
		expect(t.engine.labels.length).toBe(before + 1);
		expect(t.engine.labels.at(-1)).toBe('Style Text');
		for (const id of ids) {
			const c = t.clip(id);
			expect(c.content.style.strokes[0]!.widthPx).toBe(11.5);
			expect(c.content.style.shadow!.blurPx).toBe(9);
			expect(c.effects[0]!.params.radius!.keyframes.map((k) => k.time / 23_520_000)).toEqual([0, 5]);
		}
		await t.ok('style_text', {
			clipIds: ids,
			effects: [{ op: 'set', effectId: 'jasper.gaussian-blur', param: 'radius', value: 3, at: { frames: 5 } }],
		});
		expect(ids.map((id) => t.clip(id).effects[0]!.params.radius!.keyframes[1]!.value)).toEqual([3, 3, 3, 3]);
		await t.ok('style_text', { clipIds: ids, effects: [{ op: 'remove', effectId: 'jasper.gaussian-blur' }] });
		expect(ids.every((id) => t.clip(id).effects.length === 0)).toBe(true);
	});

	it('refuses non-text clips by id and unknown style fields', async () => {
		const t = await connect(2);
		const solid = t.solidId();
		const e = await t.fail('style_text', { clipIds: [...t.textIds(), solid], style: { sizePx: 40 } });
		expect(e.message).toContain(solid);
		const u = await t.fail('style_text', { clipIds: t.textIds(), style: { sizze: 40 } });
		expect(u.code).toBe('E_UNKNOWN_ARGUMENT');
		expect((await t.fail('style_text', { clipIds: t.textIds() })).code).toBe('E_INVALID_PARAM');
	});
});

describe('linked text style tools (AS-033)', () => {
	it('create (applyTo) → list → update → apply by name → reset / detach → delete', async () => {
		const t = await connect(3);
		const ids = t.textIds();
		const created = await t.ok('create_text_style', {
			name: 'Pixel Pop',
			fromClipId: ids[0],
			style: { sizePx: 98 },
			applyTo: ids.slice(0, 2),
		});
		const styleId = created.refs.$style as string;
		expect(styleId).toMatch(/^tsy_/);
		let list = await t.ok('list_text_styles');
		expect(list.styles).toEqual([
			expect.objectContaining({ styleId, name: 'Pixel Pop', linkedClips: 2, summary: expect.objectContaining({ sizePx: 98 }) }),
		]);
		await t.ok('style_text', { clipIds: [ids[1]], style: { italic: true } });
		await t.ok('update_text_style', { name: 'pixel pop', style: { sizePx: 120 }, rename: 'Pop' });
		expect([t.clip(ids[0]!).content.style.sizePx, t.clip(ids[1]!).content.style.sizePx]).toEqual([120, 120]);
		expect(t.clip(ids[1]!).content.style.italic).toBe(true);
		expect(t.clip(ids[2]!).content.style.sizePx).not.toBe(120);
		await t.ok('apply_text_style', { name: 'Pop', clipIds: [ids[2]] });
		expect(t.clip(ids[2]!).styleId).toBe(styleId);
		await t.ok('apply_text_style', { clipIds: [ids[1]], action: 'reset' });
		expect(t.clip(ids[1]!).content.style.italic).toBe(false);
		await t.ok('apply_text_style', { clipIds: [ids[0]], action: 'detach' });
		expect(t.clip(ids[0]!).styleId).toBeUndefined();
		list = await t.ok('list_text_styles', { full: true });
		expect(list.styles[0].style.sizePx).toBe(120);
		expect(list.styles[0].linkedClips).toBe(2);
		await t.ok('delete_text_style', { styleId });
		expect(ids.every((id) => t.clip(id).styleId === undefined)).toBe(true);
		expect((await t.fail('apply_text_style', { name: 'Pop', clipIds: ids })).code).toBe('E_NOT_FOUND');
	});
});

describe('describe_commands examples of the batch styling commands', () => {
	it('apply in order to a real document', () => {
		const ids = createCounterIdSource(5);
		const doc = createEmptyProject({ ids, name: 'Examples', preset: 'hd-1080p-30' });
		const order = [
			'clip.addText',
			'text.setStyle',
			'effect.addMany',
			'effect.setParamMany',
			'effect.removeMany',
			'textStyle.create',
			'textStyle.apply',
			'textStyle.update',
			'textStyle.rename',
			'textStyle.reset',
			'textStyle.detach',
			'textStyle.delete',
		];
		for (const type of order) expect(COMMAND_EXAMPLES[type], type).toBeTruthy();
		const r = applyTransaction(
			doc,
			{ protocol: 'jasper.tx/1', label: 'examples', origin: 'user', commands: order.map((x) => COMMAND_EXAMPLES[x]) } as never,
			{ ids, now: () => '', revision: 0, registries },
		);
		expect(r.result.ok, JSON.stringify(r.result.ok ? null : r.result.errors)).toBe(true);
	});
});
