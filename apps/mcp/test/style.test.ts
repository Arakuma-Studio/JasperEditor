// Style recipe tools (spec 15 EA-010…EA-013, EA-041): list_style_recipes, get_style_recipe, save_style_recipe,
// apply_style, style_check: strict arguments, engine requests (times as frames / seconds / timecode), dry runs,
// waited proposals, E_TOO_LARGE, and the project copy through one transaction.
import type { ApplyStyleResult, EngineJob, StyleCheckResponse } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	builtinStyleRecipe,
	createCounterIdSource,
	createEmptyProject,
	type ProjectDocument,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';

const P = 'prj_style';
const doc: ProjectDocument = createEmptyProject({
	ids: createCounterIdSource(3),
	name: 'S',
	preset: 'hd-1080p-30',
});
const SEQ = Object.keys(doc.sequences)[0]!;

const applyResult = (mode: 'propose' | 'dryRun', proposalId: string | null): ApplyStyleResult => ({
	mode,
	projectId: P,
	sequenceId: SEQ,
	recipe: { id: 'builtin:fast-long-form', name: 'Fast Long-form', revision: 1 },
	stages: [
		{
			stage: 'cleanup',
			name: 'Voice cleanup',
			status: 'planned',
			count: 12,
			items: 1,
			dropped: [],
			cost: 'native',
			warnings: [],
			cleanup: { ranges: 12, removedFrames: 240, findings: 20 },
		},
		{
			stage: 'subtitles',
			name: 'Subtitles',
			status: 'planned',
			count: 80,
			items: 1,
			dropped: [],
			cost: 'hybrid',
			warnings: [],
		},
		{
			stage: 'music',
			name: 'Music beds',
			status: 'skipped',
			count: 0,
			items: 0,
			reason: '“Fast Long-form” places music beds from your songs, but the project has no bin named “Music”',
			dropped: [],
			cost: null,
			warnings: [{ code: 'W_ROLE_MISSING', message: 'no bin named “Music”' }],
		},
	],
	cost: 'remotion',
	budget: { fits: true, items: 120, commands: 600 },
	proposalId,
	revision: proposalId ? 5 : null,
	itemCount: 120,
	invalid: [],
	warnings: [{ code: 'W_ROLE_MISSING', message: 'no bin named “Music”' }],
});

const checkResult: StyleCheckResponse = {
	projectId: P,
	sequenceId: SEQ,
	recipe: { id: 'builtin:fast-long-form', name: 'Fast Long-form' },
	durationSeconds: 60,
	metrics: [
		{
			id: 'kitCoverage',
			label: 'Cuts with a kit',
			unit: 'share',
			value: 0.5,
			target: { value: 0.951, tolerance: 0.06 },
			status: 'off',
			message: '9 of 18 cuts have a kit',
			count: 9,
			of: 18,
			lookHere: [{ frame: 90, timecode: '00:00:03:00', note: 'a cut without a kit' }],
		},
	],
	counts: { ok: 0, off: 1, unmeasured: 0, unchecked: 7 },
	warnings: [],
};

function fakeEngine(opts: { jobState?: 'succeeded' | 'failed'; error?: EngineJob['error'] } = {}) {
	const calls: { name: string; args: unknown[] }[] = [];
	const job = (state: string, res?: unknown): EngineJob =>
		({
			id: 'job_1',
			kind: 'apply-style',
			title: 'Apply Style',
			origin: { type: 'agent', agentRunId: 'style-test' },
			state,
			progress: state === 'succeeded' ? 1 : 0,
			createdAt: '2026-10-26T00:00:00.000Z',
			...(res !== undefined ? { result: res } : {}),
			...(opts.error ? { error: opts.error } : {}),
		}) as unknown as EngineJob;
	const fast = builtinStyleRecipe('builtin:fast-long-form')!;
	const client = {
		agentQuery: async () => ({ result: doc, revision: 3, via: 'headless' }),
		agentTx: async (req: unknown) => {
			calls.push({ name: 'agentTx', args: [req] });
			return {
				result: {
					ok: true,
					revision: 4,
					refs: {},
					created: [],
					changed: [],
					deleted: [],
					warnings: [],
					results: [{ recipeId: 'rcp_0000000000000007' }],
				},
				via: 'headless',
			};
		},
		styleRecipes: async () => ({
			revision: 2,
			recipes: [
				{ id: fast.id, name: fast.name, source: 'builtin', readOnly: true, recipe: fast },
				{ id: 'rcp_0000000000000008', name: 'Future', source: 'library', readOnly: true, newer: true },
			],
			repairs: [{ action: 'adopt', entity: 'rcp_0000000000000009', detail: 'added back' }],
			readOnly: false,
		}),
		styleRecipe: async (id: string) => {
			calls.push({ name: 'styleRecipe', args: [id] });
			if (id === fast.id) return { id, name: fast.name, source: 'builtin', readOnly: true, recipe: fast };
			throw Object.assign(new Error(`Style recipe not found: ${id}`), { code: 'RECIPE_NOT_FOUND' });
		},
		createStyleRecipe: async (req: { recipe: Record<string, unknown> }) => {
			calls.push({ name: 'createStyleRecipe', args: [req] });
			return {
				id: 'rcp_0000000000000007',
				name: req.recipe.name,
				source: 'library',
				readOnly: false,
				recipe: { ...req.recipe, id: 'rcp_0000000000000007', revision: 1 },
			};
		},
		updateStyleRecipe: async () => {
			throw new Error('not expected');
		},
		applyStyle: async (projectId: string, req: { mode?: string }) => {
			calls.push({ name: 'applyStyle', args: [projectId, req] });
			if (req.mode === 'dryRun') return applyResult('dryRun', null);
			return job('queued');
		},
		styleCheck: async (projectId: string, req: unknown) => {
			calls.push({ name: 'styleCheck', args: [projectId, req] });
			return checkResult;
		},
		getJob: async () =>
			job(
				opts.jobState ?? 'succeeded',
				(opts.jobState ?? 'succeeded') === 'succeeded'
					? applyResult('propose', 'prp_0000000000000009')
					: undefined,
			),
	};
	const link: EngineConnection = {
		target: { url: 'http://engine.test', token: null, source: 'explicit' },
		client: async () => client as unknown as EngineClient,
		invalidate: () => {},
		close: async () => {},
	};
	return { link, calls };
}

let open: Client[] = [];
afterEach(async () => {
	for (const c of open) await c.close().catch(() => {});
	open = [];
});

async function connect(opts: Parameters<typeof fakeEngine>[0] = {}) {
	const engine = fakeEngine(opts);
	const { server } = createJasperMcpServer({ link: engine.link, agentName: 'style-test' });
	const [x, y] = InMemoryTransport.createLinkedPair();
	await server.connect(x);
	const client = new Client({ name: 'style-test', version: '1' });
	await client.connect(y);
	open.push(client);
	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
		// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
		return { r, json: JSON.parse((r.content[0] as { text: string }).text) as Record<string, any> };
	};
	return { engine, client, call };
}

describe('style recipe tools', () => {
	it('apply_style dry run: recipe, seed, stages and the range in frames; nothing waited for', async () => {
		const t = await connect();
		const { r, json } = await t.call('apply_style', {
			projectId: P,
			mode: 'dryRun',
			recipeId: 'builtin:fast-long-form',
			seed: 4,
			passes: { stingers: true, cleanup: false },
			range: { start: { seconds: 1 }, end: '00:00:10:00' },
		});
		expect(r.isError).toBeFalsy();
		expect(t.engine.calls[0]).toEqual({
			name: 'applyStyle',
			args: [
				P,
				{
					sequenceId: SEQ,
					mode: 'dryRun',
					recipeId: 'builtin:fast-long-form',
					seed: 4,
					range: { start: 30, end: 300 },
					passes: { stingers: true, cleanup: false },
				},
			],
		});
		expect(json).toMatchObject({ export: { cost: 'remotion' }, proposalId: null, budget: { fits: true } });
		expect(json.stages.find((s: { stage: string }) => s.stage === 'music')).toMatchObject({
			status: 'skipped',
			reason: expect.stringContaining('Music'),
		});
		expect(json.next).toContain('mode "propose"');
	});

	it('apply_style propose: the job is waited for and the proposal named; failures are tool errors with the range', async () => {
		const t = await connect();
		const p = await t.call('apply_style', { projectId: P, recipeId: 'builtin:fast-long-form' });
		expect(p.r.isError).toBeFalsy();
		expect(p.json.proposalId).toBe('prp_0000000000000009');
		expect(p.json.next).toContain('style_check');
		const big = await connect({
			jobState: 'failed',
			error: {
				code: 'PROPOSAL_TOO_LARGE',
				message: 'too big',
				detail: { code: 'E_TOO_LARGE', suggestedRange: { start: 0, end: 900 } },
			} as never,
		});
		const f = await big.call('apply_style', { projectId: P, recipeId: 'builtin:fast-long-form' });
		expect(f.r.isError).toBe(true);
		expect(JSON.stringify(f.r.content)).toContain('E_TOO_LARGE');
	});

	it('strict arguments at any depth: unknown keys and stage names are refused before the engine is called', async () => {
		const t = await connect();
		const a = await t.call('apply_style', { projectId: P, recipeID: 'x' });
		expect(a.r.isError).toBe(true);
		expect(a.json.error.code).toBe('E_UNKNOWN_ARGUMENT');
		const b = await t.call('apply_style', { projectId: P, passes: { kits: true } });
		expect(b.r.isError).toBe(true);
		expect(b.json.error.code).toBe('E_INVALID_ARGUMENT');
		const c = await t.call('save_style_recipe', {
			name: 'x',
			basedOn: 'builtin:fast-long-form',
			passes: { 'ken-burns': { enabled: true, params: { shre: 1 } } },
		});
		expect(c.r.isError).toBe(true);
		expect(c.json.error.code).toBe('E_UNKNOWN_ARGUMENT');
		expect(t.engine.calls.filter((x) => x.name !== 'styleRecipe')).toEqual([]);
	});

	it('list / get / save: the library with repairs and newer recipes; a saved recipe copied into the project in one step', async () => {
		const t = await connect();
		const l = await t.call('list_style_recipes', { projectId: P });
		expect(l.json.recipes.map((r: { name: string }) => r.name)).toEqual(['Fast Long-form', 'Future']);
		expect(l.json.recipes[0].stages).toEqual(
			expect.arrayContaining(['cleanup', 'subtitles', 'decorate-cuts', 'punch-ins']),
		);
		expect(l.json.recipes[1]).toMatchObject({ newer: true, readOnly: true });
		expect(l.json.repairs).toHaveLength(1);
		expect(l.json.project).toMatchObject({ active: null, recipes: [] });
		const g = await t.call('get_style_recipe', { recipeId: 'builtin:fast-long-form' });
		expect(g.json.recipe.passes['punch-ins'].params.scale).toBe(180);
		const missing = await t.call('get_style_recipe', { recipeId: 'rcp_000000000000000X' });
		expect(missing.r.isError).toBe(true);
		const s = await t.call('save_style_recipe', {
			name: 'Mine',
			basedOn: 'builtin:fast-long-form',
			passes: { 'ken-burns': { enabled: true, params: { share: 0.2 } } },
			projectId: P,
			activate: true,
		});
		expect(s.r.isError).toBeFalsy();
		expect(s.json).toMatchObject({ recipeId: 'rcp_0000000000000007', name: 'Mine', revision: 1 });
		const created = t.engine.calls.find((x) => x.name === 'createStyleRecipe')!.args[0] as {
			// biome-ignore lint/suspicious/noExplicitAny: the recipe JSON is read loosely by the assertions
			recipe: Record<string, any>;
		};
		expect(created.recipe.passes['ken-burns']).toEqual({ enabled: true, params: { share: 0.2 } });
		expect(created.recipe.passes['punch-ins'].params.scale).toBe(180);
		expect(created.recipe.id).toBe('builtin:fast-long-form');
		const tx = t.engine.calls.find((x) => x.name === 'agentTx')!.args[0] as {
			transaction: { commands: { type: string; activate?: boolean }[] };
		};
		expect(tx.transaction.commands).toEqual([
			expect.objectContaining({ type: 'styleRecipe.add', activate: true }),
		]);
	});

	it('style_check: measures with look-here timecodes', async () => {
		const t = await connect();
		const { json } = await t.call('style_check', {
			projectId: P,
			recipeId: 'builtin:fast-long-form',
			deadAir: false,
		});
		expect(t.engine.calls[0]!.args[1]).toEqual({
			sequenceId: SEQ,
			recipeId: 'builtin:fast-long-form',
			deadAir: false,
		});
		expect(json.metrics[0]).toMatchObject({
			id: 'kitCoverage',
			status: 'off',
			lookHere: [{ timecode: '00:00:03:00', frame: 90 }],
		});
		expect(json.next).toContain('set_playhead');
	});
});
