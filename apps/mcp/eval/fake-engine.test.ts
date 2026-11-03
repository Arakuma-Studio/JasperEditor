// The fake engine answers what the titles and delivery cases reach (spec 19 TL-100…TL-116), through the stub a sample
// talks to: a core session, tools run with call_tool, the call log the grader reads. A call the fake does not model
// would mark a sample invalid, so every call here must log none. Results are parsed with the engine's own schemas.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

async function session(name: string) {
	const log = join(dir, `${name}.jsonl`);
	const { server, engine } = await buildStub({
		sourceRoot: root,
		engine: { project: 'interview' },
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
	return { client, run, ok, calls, project: engine.vars.project!, close: () => client.close() };
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
