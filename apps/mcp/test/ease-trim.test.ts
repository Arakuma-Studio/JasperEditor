// Easing and Trim Paths MCP tools (docs/wp-notes/mcp-cli.md § Easing and Trim Paths): every tool against an
// in-process engine stand-in that applies transactions with the real command system and answers queries with the
// real agent queries, plus an undo stack of the agent's transactions (what the editor's History does).
import type { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	runAgentQuery,
	type ShapeItem,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors.ts';
import { COMMAND_EXAMPLES } from '../src/examples.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { parseCubicCurveArg, parseCurveArg } from '../src/tools/ease.ts';

const P = 'prj_ease';
const registries = defaultRegistries();

function fakeEngine() {
	const ids = createCounterIdSource(11);
	let doc: ProjectDocument = createEmptyProject({ ids, name: 'Ease', preset: 'hd-1080p-30' });
	let revision = 0;
	const undo: { label: string; before: ProjectDocument }[] = [];
	const apply = (tx: Record<string, unknown>) => {
		const cmds = tx.commands as { type: string }[];
		if (cmds.length === 1 && cmds[0]!.type === 'history.undo') {
			const top = undo.pop();
			if (!top)
				return {
					ok: false,
					revision,
					errors: [{ commandIndex: 0, code: 'E_NOT_FOUND', message: 'Nothing to undo' }],
				};
			doc = top.before;
			revision++;
			return {
				ok: true,
				revision,
				refs: {},
				created: [],
				changed: [],
				deleted: [],
				warnings: [],
				results: [{ 'history.undo': top.label }],
			};
		}
		const r = applyTransaction(doc, { protocol: 'jasper.tx/1', ...tx, origin: 'user' } as never, {
			ids,
			now: () => '2026-10-20T00:00:00.000Z',
			revision,
			registries,
		});
		if (r.result.ok && !tx.dryRun) {
			undo.push({ label: String(tx.label), before: doc });
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
	return { link, doc: () => doc };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
type Json = Record<string, any>;

async function connect() {
	const engine = fakeEngine();
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'ease-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'ease-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({
			name,
			arguments: Object.fromEntries(
				Object.entries({ projectId: P, ...args }).filter(([, v]) => v !== undefined),
			),
		})) as CallToolResult;
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
		return out.json.error as { code: string; message: string; hint?: string };
	};
	return { engine, client, call, ok, fail };
}

/** A title clip with opacity keys 0 → 100 → 20 at frames 0, 30, 60 and position keys at 0, 30, 60. */
async function animatedTitle(t: Awaited<ReturnType<typeof connect>>) {
	const keys = (prop: string[], values: unknown[], prefix: string) =>
		values.map((value, i) => ({
			type: 'keyframe.add',
			target: ['clip', '$t', ...prop],
			at: { sequenceFrame: i * 30 },
			value,
			ref: `$${prefix}${i}`,
		}));
	const r = await t.ok('apply_commands', {
		label: 'Setup',
		commands: [
			{
				type: 'clip.addText',
				at: 0,
				duration: { seconds: 4 },
				track: 'V2',
				content: { text: 'Ease' },
				ref: '$t',
			},
			...keys(['opacity'], [0, 100, 20], 'k'),
			...keys(
				['transform', 'position'],
				[
					[200, 540],
					[960, 300],
					[1700, 540],
				],
				'p',
			),
		],
	});
	const refs = r.refs as Record<string, string>;
	return { clipId: refs.$t!, k: [refs.$k0!, refs.$k1!, refs.$k2!], p: [refs.$p0!, refs.$p1!, refs.$p2!] };
}

const prop = (eases: Json, label: RegExp) =>
	(eases.properties ?? eases.eases).find((p: Json) => label.test(p.label)) as Json;

describe('ease read-back', () => {
	it('get_clip_properties lists the ease leaving every key; get_keyframe_eases gives the detail', async () => {
		const t = await connect();
		const { clipId, k } = await animatedTitle(t);
		await t.ok('apply_ease', { keyframeIds: [k[0], k[1]], curve: 'basic.easy-ease' });
		const props = await t.ok('get_clip_properties', { clipId, keys: ['opacity'] });
		const keys = props.properties[0].keyframes as Json[];
		expect(keys.map((x) => x.ease)).toEqual(['cubic-bezier(0.3333, 0, 0.6667, 1)', 'linear', undefined]);
		expect(keys[0]!.easePreset).toBe('basic.easy-ease');
		expect(keys[1]!.easePreset).toBeUndefined();

		const view = await t.ok('get_keyframe_eases', { clipId, properties: ['opacity'] });
		expect(view.selected).toBe(3);
		const op = prop(view, /opacity/i);
		expect(op.clipId).toBe(clipId);
		expect(op.keys.map((x: Json) => [x.frame, x.timecode])).toEqual([
			[0, '00:00:00:00'],
			[30, '00:00:01:00'],
			[60, '00:00:02:00'],
		]);
		expect(op.segments.map((s: Json) => [s.section, s.ease, s.preset])).toEqual([
			['middle', 'cubic-bezier(0.3333, 0, 0.6667, 1)', 'basic.easy-ease'],
			['middle', 'linear', 'basic.linear'],
		]);
		// Easy Ease leaves key 0 at speed 0 with ⅓ influence; the linear segment 30 → 60 runs at (20 − 100) / 1 s.
		expect(op.keys[0].out).toMatchObject({ influence: 33.3333, speed: 0 });
		expect(op.keys[1].out.speed).toBeCloseTo(-80, 6);
		expect(op.segments[1].averageSpeed).toBeCloseTo(-80, 6);
	});

	it('apply preset → read back the same preset id, for cubic segments and multi-point runs', async () => {
		const t = await connect();
		const { clipId, k } = await animatedTitle(t);
		for (const id of [
			'basic.ease',
			'penner.cubic-out',
			'material.standard',
			'overshoot.overshoot-out-light',
		]) {
			await t.ok('apply_ease', { keyframeIds: [k[0], k[1]], curve: id });
			const v = await t.ok('get_keyframe_eases', { keyframeIds: [k[0], k[1]] });
			expect(prop(v, /opacity/i).segments.find((s: Json) => s.section === 'middle').preset, id).toBe(id);
		}
		const bounce = await t.ok('apply_ease', {
			clipId,
			properties: ['opacity'],
			from: 30,
			to: 60,
			curve: 'bounce.out-3',
		});
		expect(bounce.curve).toEqual({ name: 'Bounce Out: 3 Bounces', presetId: 'bounce.out-3' });
		expect(bounce.results[0].created.length).toBeGreaterThan(3);
		const run = await t.ok('get_keyframe_eases', { clipId, properties: ['opacity'], from: 30, to: 60 });
		const op = prop(run, /opacity/i);
		expect(op.keys.length).toBe(bounce.results[0].created.length + 2);
		expect(op.span).toEqual({ fromId: k[1], toId: k[2], preset: 'bounce.out-3' });
		// The keys before the run are untouched.
		const first = await t.ok('get_keyframe_eases', { keyframeIds: [k[0], k[1]] });
		expect(prop(first, /opacity/i).segments[0].preset).toBe('overshoot.overshoot-out-light');
	});

	it('cubic-bezier strings, handle objects, keywords and custom points are applied exactly', async () => {
		const t = await connect();
		const { k } = await animatedTitle(t);
		const segment = async () =>
			prop(await t.ok('get_keyframe_eases', { keyframeIds: [k[0], k[1]] }), /opacity/i).segments[0];
		await t.ok('apply_ease', { keyframeIds: [k[0], k[1]], curve: 'cubic-bezier(0.1, 0.7, 0.2, 1)' });
		expect((await segment()).ease).toBe('cubic-bezier(0.1, 0.7, 0.2, 1)');
		await t.ok('apply_ease', { keyframeIds: [k[0], k[1]], curve: { x1: 0.42, y1: 0, x2: 1, y2: 1 } });
		expect((await segment()).preset).toBe('basic.ease-in');
		await t.ok('apply_ease', { keyframeIds: [k[0], k[1]], curve: 'ease-in-out' });
		expect((await segment()).preset).toBe('basic.ease-in-out');
		await t.ok('apply_ease', { keyframeIds: [k[0], k[1]], curve: 'Easy Ease' });
		expect((await segment()).preset).toBe('basic.easy-ease');
		const custom = await t.ok('apply_ease', {
			keyframeIds: [k[0], k[1]],
			curve: {
				points: [
					{ x: 0, y: 0 },
					{ x: 0.5, y: 0.8 },
					{ x: 1, y: 1 },
				],
			},
		});
		expect(custom.results[0].created).toHaveLength(1);
	});

	it('sections: one key gets its in and out segments by default', async () => {
		const t = await connect();
		const { k } = await animatedTitle(t);
		await t.ok('apply_ease', { keyframeIds: [k[1]], curve: 'basic.easy-ease' });
		const v = prop(await t.ok('get_keyframe_eases', { keyframeIds: [k[1]] }), /opacity/i);
		expect(v.segments.map((s: Json) => s.section)).toEqual(['in', 'out']);
		expect(v.keys[0].in).toMatchObject({ speed: 0 });
		expect(v.keys[0].out).toMatchObject({ speed: 0 });
		await t.ok('apply_ease', { keyframeIds: [k[0]], curve: 'linear', sections: ['out'] });
		const after = prop(await t.ok('get_keyframe_eases', { keyframeIds: [k[0]] }), /opacity/i);
		expect(after.segments.map((s: Json) => s.ease)).toEqual(['linear']);
	});

	it('transfer_ease, transfer_keyframe_values and set_keyframe_velocity round-trip', async () => {
		const t = await connect();
		const { clipId, k, p } = await animatedTitle(t);
		await t.ok('apply_ease', { keyframeIds: [k[0], k[1]], curve: 'material.standard' });
		const pasted = await t.ok('transfer_ease', {
			fromKeyframeIds: [k[0], k[1]],
			toKeyframeIds: [k[1], k[2]],
		});
		expect(pasted.copied).toEqual({ kind: 'segments', segments: ['cubic-bezier(0.2, 0, 0, 1)'] });
		expect(prop(pasted, /opacity/i).segments.find((s: Json) => s.fromId === k[1]).preset).toBe(
			'material.standard',
		);

		const one = await t.ok('transfer_ease', { fromKeyframeIds: [k[0]], toKeyframeIds: [p[1]] });
		expect(one.copied.kind).toBe('key');

		const values = await t.ok('transfer_keyframe_values', { fromKeyframeIds: [k[2]], toKeyframeIds: [k[0]] });
		expect(values.results[0].pasted).toBe(1);
		const props = await t.ok('get_clip_properties', { clipId, keys: ['opacity'] });
		expect(props.properties[0].keyframes[0].value).toBe(20);

		const vel = await t.ok('set_keyframe_velocity', {
			keyframeId: k[1],
			side: 'out',
			speed: -40,
			influence: 50,
		});
		const out = prop(vel, /opacity/i).keys[0].out;
		expect(out.speed).toBeCloseTo(-40, 4);
		expect(out.influence).toBeCloseTo(50, 4);
		const none = await t.fail('set_keyframe_velocity', { keyframeId: k[1], side: 'out' });
		expect(none.code).toBe('E_INVALID_PARAM');
	});

	it('create_path_controller and cleanup_motion_path on position keys', async () => {
		const t = await connect();
		const { clipId, p } = await animatedTitle(t);
		const ctl = await t.ok('create_path_controller', { clipId });
		expect(ctl.results[0].rovingKeyframeIds).toEqual([p[1]]);
		expect(ctl.sliderTarget).toEqual(['clip', clipId, 'effects', ctl.results[0].effectInstanceId, 'slider']);
		const props = await t.ok('get_clip_properties', { clipId, keys: ['transform.position'] });
		const keys = props.properties[0].keyframes as Json[];
		expect(keys[1]).toMatchObject({ id: p[1], roving: true });
		expect(keys[1].ease).toBeUndefined();
		expect(keys[0].ease).toBe('linear');
		const again = await t.fail('create_path_controller', { clipId });
		expect(again.message).toMatch(/expression/);

		const t2 = await connect();
		const b = await animatedTitle(t2);
		const clean = await t2.ok('cleanup_motion_path', { clipId: b.clipId, tolerance: 2000 });
		expect(clean.results[0].properties[0]).toMatchObject({ before: 3, after: 2 });
		const simplified = await t2.ok('get_clip_properties', { clipId: b.clipId, keys: ['transform.position'] });
		expect(simplified.properties[0].keyframes.map((key: Json) => [key.frame, key.value])).toEqual([
			[0, [200, 540]],
			[60, [1700, 540]],
		]);
	});

	it('refusals and argument errors are error results with hints, applying nothing', async () => {
		const t = await connect();
		const { clipId, k } = await animatedTitle(t);
		const before = structuredClone(t.engine.doc());
		const unknownKey = await t.fail('apply_ease', { keyframeIds: ['kf_nope'], curve: 'basic.ease' });
		expect(unknownKey.code).toBe('E_NOT_FOUND');
		expect(unknownKey.hint).toBeTruthy();
		expect((await t.fail('apply_ease', { keyframeIds: k, clipId, curve: 'basic.ease' })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await t.fail('apply_ease', { keyframeIds: k, from: 0, curve: 'basic.ease' })).code).toBe(
			'E_INVALID_PARAM',
		);
		const noProp = await t.fail('apply_ease', { clipId, properties: ['opacty'], curve: 'basic.ease' });
		expect(noProp.code).toBe('E_NOT_FOUND');
		expect(noProp.hint).toContain('get_clip_properties');
		const range = await t.fail('get_keyframe_eases', { clipId, from: 100, to: 110 });
		expect(range.code).toBe('E_NOT_FOUND');
		const typo = await t.fail('apply_ease', { keyframeIds: k, curve: 'bounce.ot-3' });
		expect(typo.code).toBe('E_INVALID_PARAM');
		const bad = await t.fail('apply_ease', { keyframeIds: k, curve: 'cubic-bezier(1.5, 0, 0.5, 1)' });
		expect(bad.message).toMatch(/x1/);
		expect(t.engine.doc()).toEqual(before);
		// A multi curve needs different end values: k0 → k2 after making them equal is refused by the command.
		await t.ok('transfer_keyframe_values', { fromKeyframeIds: [k[0]], toKeyframeIds: [k[2]] });
		const afterValid = structuredClone(t.engine.doc());
		const flat = await t.fail('apply_ease', { keyframeIds: [k[0], k[2]], curve: 'bounce.out-2' });
		expect(flat.code).toBe('E_INVALID_PARAM');
		expect(t.engine.doc()).toEqual(afterValid);
		// Strict arguments: unknown keys, also inside the curve object.
		const strict = await t.call('apply_ease', { keyframeIds: k, curve: 'basic.ease', section: ['in'] });
		expect(strict.json.error.code).toBe('E_UNKNOWN_ARGUMENT');
		expect(strict.text).toContain('sections');
		const nested = await t.call('apply_ease', {
			keyframeIds: k,
			curve: { x1: 0, y1: 0, x2: 1, y2: 1, x3: 1 },
		});
		expect(nested.json.error.code).toBe('E_UNKNOWN_ARGUMENT');
		const groupless = await t.fail('list_ease_presets', { projectId: undefined, group: 'bouncy' });
		expect(groupless.hint).toContain('bounce');
	});

	it('every edit is one undoable History entry', async () => {
		const t = await connect();
		const { clipId, k } = await animatedTitle(t);
		const before = JSON.stringify(t.engine.doc().sequences);
		await t.ok('apply_ease', { keyframeIds: [k[1], k[2]], curve: 'elastic.out-2-medium' });
		expect(JSON.stringify(t.engine.doc().sequences)).not.toBe(before);
		await t.ok('undo');
		expect(JSON.stringify(t.engine.doc().sequences)).toBe(before);
		const props = await t.ok('get_clip_properties', { clipId, keys: ['opacity'] });
		expect(props.properties[0].keyframes).toHaveLength(3);
	});
});

describe('list_ease_presets', () => {
	it('lists CSS cubic values and filters multi-point presets by group', async () => {
		const t = await connect();
		const all = await t.ok('list_ease_presets', { projectId: undefined });
		expect(all.presets.find((p: Json) => p.id === 'basic.ease')).toEqual({
			id: 'basic.ease',
			name: 'Ease (CSS)',
			group: 'basic',
			kind: 'cubic',
			cubicBezier: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
		});
		const bounce = await t.ok('list_ease_presets', { projectId: undefined, group: 'bounce' });
		expect(bounce.groups).toEqual([{ id: 'bounce', name: 'Bounce' }]);
		expect(bounce.presets.every((p: Json) => p.kind === 'multi' && p.points >= 3)).toBe(true);
	});
});

describe('Trim Paths tools', () => {
	const shapeOf = (doc: ProjectDocument, id: string) =>
		Object.values(doc.sequences)[0]!.clips[id] as unknown as { shape: { contents: ShapeItem[] } };

	it('add_line → animate_trim_paths with a tracer is one transaction; re-running replaces; undo removes both', async () => {
		const t = await connect();
		const line = await t.ok('add_line', {
			orientation: 'horizontal',
			duration: { seconds: 3 },
			color: '#ffcc00',
		});
		const lineId = line.created.find((id: string) => id.startsWith('clp_')) as string;
		expect(line.results[0].clipId).toBe(lineId);
		const before = JSON.stringify(t.engine.doc().sequences);
		const r = await t.ok('animate_trim_paths', {
			clipIds: [lineId],
			style: 'inOut',
			duration: { seconds: 1 },
			curve: 'basic.ease-in-out',
			tracer: { orient: true },
		});
		const c = r.clips[0];
		const trim = shapeOf(t.engine.doc(), lineId).shape.contents.at(-1)!;
		expect(trim).toMatchObject({ id: c.trimId, type: 'trim' });
		const end = c.keys.find((p: Json) => p.key.endsWith('.end'));
		expect(end.keyframes.map((x: Json) => [x.frame, x.value, x.timecode])).toEqual([
			[0, 0, '00:00:00:00'],
			[30, 100, '00:00:01:00'],
		]);
		expect(end.keyframes[0].easePreset).toBe('basic.ease-in-out');
		const start = c.keys.find((p: Json) => p.key.endsWith('.start'));
		expect(start.keyframes.map((x: Json) => x.frame)).toEqual([15, 45]);
		expect(c.tracer.tip).toBe('end');

		// Re-running replaces the animation (same trim, never a second one).
		await t.ok('animate_trim_paths', { clipIds: [lineId], style: 'in', reverse: true, duration: 12 });
		const items = shapeOf(t.engine.doc(), lineId).shape.contents.filter((i) => i.type === 'trim');
		expect(items.map((i) => i.id)).toEqual([c.trimId]);

		await t.ok('undo');
		await t.ok('undo');
		expect(JSON.stringify(t.engine.doc().sequences)).toBe(before);
	});

	it('skipped clips get no tracer; curve must be cubic; refusals are error results', async () => {
		const t = await connect();
		const line = await t.ok('add_line', { orientation: 'vertical' });
		const lineId = line.results[0].clipId as string;
		const title = await t.ok('apply_commands', {
			label: 'Title',
			commands: [
				{ type: 'clip.addText', at: 0, duration: 30, track: 'V3', content: { text: 'x' }, ref: '$x' },
			],
		});
		const textId = title.refs.$x as string;
		const r = await t.ok('animate_trim_paths', {
			clipIds: [lineId, textId],
			style: 'divideIn',
			copies: 3,
			tracer: true,
		});
		expect(r.skipped).toEqual([textId]);
		expect(r.warnings.map((w: Json) => w.code)).toContain('W_TRIM_SKIPPED');
		expect(r.clips).toHaveLength(1);
		expect(r.clips[0].partIds).toHaveLength(3);
		expect(r.clips[0].tracer).toBeTruthy();

		const multi = await t.fail('animate_trim_paths', {
			clipIds: [lineId],
			style: 'in',
			curve: 'bounce.out-2',
		});
		expect(multi.code).toBe('E_INVALID_PARAM');
		expect(multi.hint).toContain('cubic');
		const none = await t.fail('animate_trim_paths', { clipIds: [textId], style: 'in', tracer: true });
		expect(none.code).toBe('E_INVALID_PARAM');
		const lag = await t.call('animate_trim_paths', { clipIds: [lineId], style: 'inOut', inOutLag: 0 });
		expect(lag.r.isError).toBe(true);
		const strict = await t.call('animate_trim_paths', {
			clipIds: [lineId],
			style: 'in',
			tracer: { orientation: true },
		});
		expect(strict.json.error.code).toBe('E_UNKNOWN_ARGUMENT');
	});

	it('reverse_path_direction and add_trim_tracer (default master trim, existing follower)', async () => {
		const t = await connect();
		const lineId = (await t.ok('add_line', { orientation: 'horizontal' })).results[0].clipId as string;
		const noTrim = await t.fail('add_trim_tracer', { clipId: lineId });
		expect(noTrim.code).toBe('E_INVALID_PARAM');
		expect(noTrim.message).toMatch(/trimItemId/);
		await t.ok('reverse_path_direction', { clipIds: [lineId] });
		const path = shapeOf(t.engine.doc(), lineId).shape.contents[0] as { direction?: string };
		expect(path.direction).toBe('reversed');
		const anim = await t.ok('animate_trim_paths', { clipIds: [lineId], style: 'out' });
		const title = await t.ok('apply_commands', {
			label: 'Title',
			commands: [
				{ type: 'clip.addText', at: 0, duration: 60, track: 'V4', content: { text: 'o' }, ref: '$o' },
			],
		});
		const tr = await t.ok('add_trim_tracer', { clipId: lineId, followerClipId: title.refs.$o });
		expect(tr.results[0]).toMatchObject({
			clipId: title.refs.$o,
			created: false,
			trimItemId: anim.clips[0].trimId,
			tip: 'start',
		});
	});
});

describe('curve argument parser', () => {
	it('parses presets, names, keywords, cubic-bezier strings, handles and points', () => {
		expect(parseCurveArg('basic.easy-ease').presetId).toBe('basic.easy-ease');
		expect(parseCurveArg('  EASE-OUT ').presetId).toBe('basic.ease-out');
		expect(parseCurveArg('Bounce Out: 3 Bounces').presetId).toBe('bounce.out-3');
		expect(parseCurveArg('cubic-bezier(.25,.1,.25,1)').curve).toEqual({
			kind: 'cubic',
			x1: 0.25,
			y1: 0.1,
			x2: 0.25,
			y2: 1,
		});
		expect(parseCurveArg('CUBIC-BEZIER( 0 , -0.5e0 , 1 , 1.5 )').curve).toEqual({
			kind: 'cubic',
			x1: 0,
			y1: -0.5,
			x2: 1,
			y2: 1.5,
		});
		expect(parseCurveArg({ x1: 0, y1: 0, x2: 1, y2: 1 }).name).toBe('cubic-bezier(0, 0, 1, 1)');
		expect(
			parseCurveArg({
				points: [
					{ x: 0, y: 0 },
					{ x: 0.3, y: 1.2 },
					{ x: 1, y: 1 },
				],
			}).curve.kind,
		).toBe('multi');
		for (const bad of [
			'cubic-bezier(0, 0, 1)',
			'cubic-bezier(0, 0, 1, 1, 1)',
			'cubic-bezier(a, 0, 1, 1)',
			'cubic-bezier(0, 0, 1, 1',
			'cubic-bezier(-0.1, 0, 1, 1)',
			'cubic-bezier(0, 11, 1, 1)',
			'cubic-bezier(0x1, 0, 1, 1)',
			'cubic-bezier(Infinity, 0, 1, 1)',
			'cubic-bezier(NaN, 0, 1, 1)',
			'no-such-preset',
		])
			expect(() => parseCurveArg(bad), bad).toThrowError(ToolError);
		expect(() =>
			parseCurveArg({
				points: [
					{ x: 0, y: 0 },
					{ x: 0, y: 1 },
					{ x: 1, y: 1 },
				],
			}),
		).toThrowError(/increase/);
		expect(() => parseCubicCurveArg('elastic.out-3-soft')).toThrowError(/multi-point/);
	});

	it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
		'refuses the Object.prototype name %j with E_INVALID_PARAM (regression: id.trim is not a function)',
		(s) => {
			expect(() => parseCurveArg(s)).toThrowError(ToolError);
			try {
				parseCurveArg(s);
			} catch (e) {
				expect((e as ToolError).code).toBe('E_INVALID_PARAM');
			}
		},
	);

	it('fuzz: any string either parses to a valid curve or is an E_INVALID_PARAM ToolError', () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string({ maxLength: 60 }),
					fc
						.array(fc.oneof(fc.double(), fc.string({ maxLength: 6 }), fc.integer()), { maxLength: 6 })
						.map((xs) => `cubic-bezier(${xs.join(',')})`),
				),
				(s) => {
					try {
						const p = parseCurveArg(s);
						expect(['cubic', 'multi']).toContain(p.curve.kind);
					} catch (e) {
						expect(e).toBeInstanceOf(ToolError);
						expect((e as ToolError).code).toBe('E_INVALID_PARAM');
					}
				},
			),
			{ numRuns: 400 },
		);
	});

	it('fuzz: cubic-bezier strings round-trip their numbers; out-of-range x is refused', () => {
		const unit = fc.double({ min: 0, max: 1, noNaN: true });
		const y = fc.double({ min: -10, max: 10, noNaN: true });
		fc.assert(
			fc.property(unit, y, unit, y, (x1, y1, x2, y2) => {
				const c = parseCurveArg(`cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`).curve as Json;
				// −0 prints as "0": compare as numbers.
				expect([c.x1, c.y1, c.x2, c.y2].map((v: number) => v + 0)).toEqual(
					[x1, y1, x2, y2].map((v) => v + 0),
				);
			}),
			{ numRuns: 300 },
		);
		fc.assert(
			fc.property(fc.double({ min: 1.000001, max: 1e6, noNaN: true }), (x) => {
				expect(() => parseCurveArg(`cubic-bezier(${x}, 0, 0.5, 1)`)).toThrowError(ToolError);
			}),
			{ numRuns: 100 },
		);
	});
});

describe('describe_commands examples and the guide resource', () => {
	it('the easing and Trim Paths examples apply to a real document', () => {
		const ids = createCounterIdSource(3);
		const doc = createEmptyProject({ ids, name: 'Examples', preset: 'hd-1080p-30' });
		const key = (prop: string[], i: number, value: unknown, ref: string) => ({
			type: 'keyframe.add',
			target: ['clip', '$title', ...prop],
			at: { sequenceFrame: i * 30 },
			value,
			ref,
		});
		const setup = [
			COMMAND_EXAMPLES['clip.addText'],
			key(['opacity'], 1, 0, '$k0'),
			key(['opacity'], 2, 100, '$k1'),
			key(['opacity'], 3, 20, '$k2'),
			key(['transform', 'position'], 1, [200, 500], '$p0'),
			key(['transform', 'position'], 2, [900, 300], '$p1'),
			key(['transform', 'position'], 3, [1600, 500], '$p2'),
			COMMAND_EXAMPLES['shape.addLine'],
			COMMAND_EXAMPLES['shape.animateTrim'],
		];
		for (const type of [
			'keyframe.applyEase',
			'keyframe.pasteEase',
			'keyframe.pasteValues',
			'keyframe.setVelocity',
			'keyframe.createPathController',
			'keyframes.cleanupPath',
			'shape.addTrimTracer',
			'shape.reversePathDirection',
		]) {
			expect(COMMAND_EXAMPLES[type], type).toBeTruthy();
			const r = applyTransaction(
				doc,
				{
					protocol: 'jasper.tx/1',
					label: type,
					origin: 'user',
					commands: [...setup, COMMAND_EXAMPLES[type]],
				} as never,
				{ ids, now: () => '', revision: 0, registries },
			);
			expect(r.result.ok, `${type}: ${JSON.stringify(r.result.ok ? null : r.result.errors)}`).toBe(true);
		}
	});

	it('jasper://guide carries the easing and Trim Paths guides', async () => {
		const t = await connect();
		const g = await t.client.readResource({ uri: 'jasper://guide' });
		const text = (g.contents[0] as { text: string }).text;
		expect(text).toContain('apply_ease');
		expect(text).toContain('animate_trim_paths');
	});
});
