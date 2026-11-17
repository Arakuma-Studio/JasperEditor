// The fake engine answers what the titles and delivery cases reach (spec 19 TL-100…TL-116), through the stub a sample
// talks to: a core session, tools run with call_tool, the call log the grader reads. A call the fake does not model
// would mark a sample invalid, so every call here must log none. Results are parsed with the engine's own schemas.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	AlphaDeliveryResultSchema,
	GamutCheckResultSchema,
	PsdPlanSchema,
	PsdResultSchema,
} from '@jasper/api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '../src/png.ts';
import type { McpCall } from './grade.ts';
import { buildStub } from './stub.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = mkdtempSync(join(tmpdir(), 'jasper-eval-fake-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
type Json = Record<string, any>;

async function session(name: string, engine: Record<string, unknown> = { project: 'interview' }) {
	const log = join(dir, `${name}.jsonl`);
	const { server, engine: fake } = await buildStub({
		sourceRoot: root,
		engine,
		toolsets: 'core',
		log,
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'eval-fake-test', version: '1' });
	await client.connect(b);
	/** A tool outside core, as agents run it. */
	const run = async (tool: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({
			name: 'call_tool',
			arguments: { name: tool, arguments: args },
		})) as CallToolResult;
		const text = (r.content.find((c) => c.type === 'text') as { text: string }).text;
		return {
			isError: r.isError === true,
			json: JSON.parse(text) as Json,
			images: r.content.filter((c) => c.type === 'image') as { data: string }[],
		};
	};
	const ok = async (tool: string, args: Record<string, unknown>) => {
		const r = await run(tool, args);
		expect(r.isError, `${tool}: ${JSON.stringify(r.json)}`).toBe(false);
		return r;
	};
	const calls = () =>
		readFileSync(log, 'utf8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l) as McpCall);
	return {
		client,
		run,
		ok,
		calls,
		vars: fake.vars,
		project: fake.vars.project!,
		close: () => client.close(),
	};
}

describe('the eval fake engine (spec 19 cases)', () => {
	let s: Awaited<ReturnType<typeof session>>;
	/** The title `title_propose` applied. */
	let titleClip = '';
	beforeAll(async () => {
		s = await session('titles');
	});
	afterAll(() => s.close());

	it('title_look_find: the library on one numbered sheet the fake rendered, user looks read', async () => {
		const r = await s.ok('title_look_find', { query: 'gold' });
		expect(r.json.rows.length).toBeGreaterThan(0);
		expect(r.json.userLooksError).toBeUndefined();
		expect(r.json.timedOut).toBe(false);
		expect(r.images).toHaveLength(1);
		expect(decodePng(Buffer.from(r.images[0]!.data, 'base64')).width).toBeLessThanOrEqual(640);
	});

	it('title_propose: refused headless, stored once an editor has the project, with measured rows', async () => {
		const { rows } = (await s.ok('title_look_find', { query: 'gold' })).json;
		const brief = { projectId: s.project, text: 'GAME NIGHT', at: 0, lookId: rows[0].lookId };
		const headless = await s.run('title_propose', brief);
		expect(headless.isError).toBe(true);
		expect(headless.json.error.code).toBe('E_NO_EDITOR');
		await s.ok('open_project_in_editor', { projectId: s.project });
		const r = await s.ok('title_propose', { ...brief, alternatives: 2, seed: 7 });
		expect(r.json.proposalId).toMatch(/^prp_/);
		expect(r.images).toHaveLength(1);
		const byId = new Map((r.json.check.rows as Json[]).map((x) => [x.id, x]));
		// The fake draws a light box on grey footage: real alpha bounds, centred, and readable.
		for (const id of ['safe-area', 'off-frame', 'contrast', 'font-available', 'export-path'])
			expect(byId.get(id)?.status, id).toBe('pass');
	});

	it('title_propose apply, then title_check on the clip it made', async () => {
		const { rows } = (await s.ok('title_look_find', { query: 'gold' })).json;
		const applied = await s.ok('title_propose', {
			projectId: s.project,
			text: 'GAME NIGHT',
			at: 10,
			lookId: rows[0].lookId,
			mode: 'apply',
		});
		titleClip = applied.json.clipIds[0];
		const check = await s.ok('title_check', { projectId: s.project, clipId: titleClip });
		expect(check.json.stale).toBeUndefined();
		const contrast = (check.json.rows as Json[]).find((x) => x.id === 'contrast');
		expect(contrast?.status).toBe('pass');
	});

	it('export_psd: a plan, then a PSD job, both in the engine’s shapes', async () => {
		const plan = await s.ok('export_psd', { projectId: s.project, at: 20, dryRun: true });
		expect(plan.json.written).toBe(false);
		const { written: _w, next: _n, ...planBody } = plan.json;
		expect(PsdPlanSchema.parse(planBody).layers.map((l) => l.name)).toContain('GAME NIGHT');
		const psd = await s.ok('export_psd', { projectId: s.project, at: 20, splitTitles: true });
		const { written, jobId: _j, ...result } = psd.json;
		expect(written).toBe(true);
		const parsed = PsdResultSchema.parse(result);
		expect(parsed.layers.map((l) => l.name)).toEqual(expect.arrayContaining(['rim 1', 'face', 'fx']));
	});

	it('export_frame {alpha}: one PNG, a trimmed title, and a sequence', async () => {
		const still = await s.ok('export_frame', { projectId: s.project, at: 2, alpha: true });
		const { jobId: _a, ...one } = still.json;
		expect(AlphaDeliveryResultSchema.parse(one)).toMatchObject({ format: 'png', frames: 1, width: 1920 });
		const trimmed = await s.ok('export_frame', {
			projectId: s.project,
			at: 10,
			alpha: true,
			end: 12,
			clipIds: [titleClip],
			trimMarginPx: 16,
		});
		const { jobId: _b, ...seq } = trimmed.json;
		const r = AlphaDeliveryResultSchema.parse(seq);
		expect(r).toMatchObject({ format: 'zip', frames: 2 });
		expect(r.width).toBeLessThan(1920);
		expect(r.origin.x).toBeGreaterThan(0);
	});

	it('color_gamut_check: a measurement against the working space or the one asked for', async () => {
		const working = await s.ok('color_gamut_check', { projectId: s.project, at: 3 });
		const { jobId: _a, ...w } = working.json;
		expect(GamutCheckResultSchema.parse(w)).toMatchObject({
			output: 'rec709',
			outputLabel: expect.any(String),
		});
		const p3 = await s.ok('color_gamut_check', { projectId: s.project, at: 3, output: 'p3d65' });
		expect(p3.json.output).toBe('p3d65');
	});

	it('logged every call without an unmodelled engine call', () => {
		const calls = s.calls();
		expect(calls.length).toBeGreaterThan(8);
		expect(calls.filter((c) => c.unmodelled)).toEqual([]);
	});
});

describe('the eval fake engine: looks, effects, 3D and stills (AGENTS.md §10 cases)', () => {
	let s: Awaited<ReturnType<typeof session>>;
	let files = '';
	beforeAll(async () => {
		s = await session('looks', { project: 'interview', logo: true });
		files = mkdtempSync(join(tmpdir(), 'jasper-eval-styles-'));
		writeFileSync(join(files, 'brand.asl'), 'styles');
	});
	afterAll(() => {
		rmSync(files, { recursive: true, force: true });
		return s.close();
	});

	it('a title with a look: save it, add a generator, set the global light, read its recipe', async () => {
		const applied = await s.ok('title_propose', {
			projectId: s.project,
			text: 'LAUNCH DAY',
			at: 0,
			lookId: 'look.impact-burn',
			mode: 'apply',
		});
		const clipId = applied.json.clipIds[0] as string;
		const saved = await s.ok('title_look_save', { projectId: s.project, clipId, name: 'Launch' });
		expect(saved.json.lookId).toMatch(/^tlk_/);
		const recipe = await s.ok('title_look_find', { projectId: s.project, lookId: saved.json.lookId });
		expect(recipe.json.recipe.layers.length).toBeGreaterThan(0);
		await s.ok('title_generator_add', { projectId: s.project, generator: 'fire', clipId });
		await s.ok('title_light_set', { projectId: s.project, angle: 135, altitude: 40 });
	});

	it('effects: find one, add it, key a param', async () => {
		const found = await s.ok('list_effects', { query: 'gaussian blur' });
		const effectId = found.json.effects[0].id as string;
		const added = await s.ok('add_effect', { projectId: s.project, clipId: s.vars.clip, effectId });
		const fx = (added.json.results?.[0]?.effectInstanceId ?? added.json.created[0]) as string;
		const one = await s.ok('list_effects', { effectId });
		const param = one.json.params.find((p: Json) => p.type === 'number')?.name as string;
		await s.ok('set_effect_param', {
			projectId: s.project,
			effectInstanceId: fx,
			param,
			value: 4,
			at: 0,
			keyframe: true,
		});
	});

	it('a 3D title: the switch, the solid, a band, a plate and gold', async () => {
		const text = await s.ok('add_text', { projectId: s.project, text: 'GOLD', at: 0, duration: 90 });
		const clipId = (text.json.clipId ??
			text.json.created.find((id: string) => id.startsWith('clp_'))) as string;
		await s.ok('set_3d_layer', { projectId: s.project, clipIds: [clipId], enabled: true });
		await s.ok('set_3d_renderer', { projectId: s.project, renderer: 'advanced' });
		await s.ok('threed_solid_edit', {
			projectId: s.project,
			clipIds: [clipId],
			extrusionDepth: 30,
			band: { width: 4, profile: 'round' },
			plate: { shape: 'box' },
		});
		await s.ok('set_material', { projectId: s.project, clipIds: [clipId], preset: 'gold' });
	});

	it('image_split: the parts of the logo, then the split', async () => {
		const dry = await s.ok('image_split', { projectId: s.project, clipId: s.vars.still, dryRun: true });
		expect(dry.json.parts).toHaveLength(3);
		const split = await s.ok('image_split', { projectId: s.project, clipId: s.vars.still });
		expect(split.json.created.length).toBeGreaterThanOrEqual(3);
	});

	it('import_layer_styles: a report, then project looks', async () => {
		const path = join(files, 'brand.asl');
		const dry = await s.ok('import_layer_styles', { projectId: s.project, path, dryRun: true });
		expect(dry.json.styles.map((x: Json) => x.name)).toEqual(['Brand Gold', 'Brand Outline']);
		expect(dry.json.styles[0].report.unsupported.join()).toContain('Bricks');
		const saved = await s.ok('import_layer_styles', { projectId: s.project, path, refPx: 120 });
		expect(saved.json.styles.every((x: Json) => /^tlk_/.test(x.lookId))).toBe(true);
	});

	it('logged every call without an unmodelled engine call', () => {
		expect(s.calls().filter((c) => c.unmodelled)).toEqual([]);
	});
});

describe('the eval fake engine: hidden video tracks', () => {
	let s: Awaited<ReturnType<typeof session>>;
	beforeAll(async () => {
		// reported: a Shift+click on a track eye hid every video track; renders came back black with nothing saying why
		s = await session('hidden', {
			project: 'interview',
			seed: [{ type: 'track.update', trackId: 'V1', patch: { output: false } }],
		});
	});
	afterAll(() => s.close());

	it('get_timeline flags the track, render_frame and render_frames name it', async () => {
		const table = (await s.client.callTool({
			name: 'get_timeline',
			arguments: { projectId: s.project },
		})) as CallToolResult;
		expect((table.content[0] as { text: string }).text).toMatch(/^V1 \(output off\) \| clp_/m);
		const project = await s.ok('get_project', { projectId: s.project });
		expect(project.json.sequences[0].tracks[0]).toMatchObject({ label: 'V1', output: false });
		const frame = await s.ok('render_frame', { projectId: s.project, at: 30 });
		expect(frame.json.warnings).toEqual([
			expect.stringMatching(/^Frame 30 has no picture because video track V1 has output off/),
		]);
		const sheet = await s.ok('render_frames', { projectId: s.project, times: [10, 20] });
		expect(sheet.json.warnings).toEqual([
			expect.stringMatching(/^Frames 10, 20 have no picture .*output: true/),
		]);
	});

	it('logged every call without an unmodelled engine call', () => {
		expect(s.calls().filter((c) => c.unmodelled)).toEqual([]);
	});
});
