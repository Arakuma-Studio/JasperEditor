// Each spec 19 case can pass: its intended route, run through the stub with the case's own setup, grades as a pass
// and reaches no engine call the fake leaves unmodelled. A case that no route can pass, or whose right answer marks
// the sample invalid, would prove nothing about the text it is there for (AGENTS.md §10).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, describe, expect, it } from 'vitest';
import { type EvalCase, fillVars, loadCases } from './case.ts';
import { grade, type McpCall } from './grade.ts';
import { buildStub } from './stub.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = mkdtempSync(join(tmpdir(), 'jasper-eval-cases-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Vars = Record<string, string>;
type Route = { calls: (v: Vars) => [string, Record<string, unknown>][]; reply?: string };

/** The intended route of each case: the calls a good sample makes (ids from the setup's vars; `{{text}}` is the clip add_text made). */
const ROUTES: Record<string, Route> = {
	'titles-effect-by-name': {
		calls: (v) => [
			['list_effects', { query: 'gaussian blur' }],
			[
				'add_effect',
				{ projectId: v.project, clipId: v.clip, effectId: 'jasper.gaussian-blur', params: { radius: 8 } },
			],
		],
	},
	'titles-styled-title': { calls: () => [['title_look_find', { query: 'gold flashy' }]] },
	'titles-template-insert': {
		calls: (v) => [
			['title_look_find', { query: 'lower third' }],
			[
				'apply_commands',
				{
					projectId: v.project,
					label: 'Lower third',
					commands: [
						{
							type: 'title.insertTemplate',
							templateId: 'template.lower-third-clean',
							at: '00:00:05:00',
							texts: { name: 'Ana Ruiz', role: 'Director' },
						},
					],
				},
			],
		],
	},
	'titles-animated-lower-third-control': {
		calls: (v) => [
			[
				'add_motion_graphic',
				{
					projectId: v.project,
					template: 'lower-third',
					at: '5s',
					params: { name: 'Ana Ruiz', title: 'Director' },
				},
			],
		],
	},
	'titles-propose-on-footage': {
		calls: (v) => [
			['title_look_find', { query: 'bold' }],
			[
				'title_propose',
				{ projectId: v.project, text: 'FINAL SALE', at: '2s', lookId: 'look.impact-burn', mode: 'dryRun' },
			],
		],
	},
	'titles-plain-text-control': {
		calls: (v) => [['add_text', { projectId: v.project, text: 'Chapter 2', at: 300, duration: 90 }]],
	},
	'titles-check-readable': {
		calls: (v) => [['title_check', { projectId: v.project, clipId: v.seed_t, target: 'tiktok' }]],
	},
	'titles-look-recipe': { calls: () => [['title_look_find', { lookId: 'look.impact-burn' }]] },
	'titles-save-look': {
		calls: (v) => [['title_look_save', { projectId: v.project, clipId: v.seed_t, name: 'Launch Night' }]],
	},
	'titles-generator-behind': {
		calls: (v) => [
			['list_effects', { category: 'Generate', query: 'fire' }],
			['title_generator_add', { projectId: v.project, generator: 'fire', clipId: v.seed_t }],
		],
	},
	'titles-fire-sound-control': { calls: () => [] },
	'titles-global-light': {
		calls: (v) => [['title_light_set', { projectId: v.project, angle: 225, altitude: 45 }]],
	},
	'titles-3d-light-control': {
		calls: (v) => [['add_light', { projectId: v.project, at: 0, duration: 150, lightType: 'spot' }]],
	},
	'effects-keyframe-param': {
		calls: (v) => [
			[
				'set_effect_param',
				{
					projectId: v.project,
					effectInstanceId: v.seed_fx,
					param: 'radius',
					value: 0,
					at: 0,
					keyframe: true,
				},
			],
			[
				'set_effect_param',
				{
					projectId: v.project,
					effectInstanceId: v.seed_fx,
					param: 'radius',
					value: 20,
					at: '2s',
					keyframe: true,
				},
			],
		],
	},
	'three-d-extruded-title': {
		calls: (v) => [
			['add_text', { projectId: v.project, text: 'LAUNCH DAY', at: 0, duration: 90 }],
			['set_3d_layer', { projectId: v.project, clipIds: ['{{text}}'], enabled: true }],
			['set_3d_renderer', { projectId: v.project, renderer: 'advanced' }],
			[
				'threed_solid_edit',
				{ projectId: v.project, clipIds: ['{{text}}'], extrusionDepth: 40, band: { profile: 'round' } },
			],
			['set_material', { projectId: v.project, clipIds: ['{{text}}'], preset: 'gold' }],
		],
	},
	'three-d-backplate': {
		calls: (v) => [
			['threed_solid_edit', { projectId: v.project, clipIds: [v.seed_t], plate: { shape: 'box', grow: 12 } }],
		],
	},
	'three-d-flat-title-control': { calls: () => [['title_look_find', { query: 'gold' }]] },
	'delivery-psd': { calls: (v) => [['export_psd', { projectId: v.project, at: '5s', dryRun: true }]] },
	'delivery-alpha-png': { calls: (v) => [['export_frame', { projectId: v.project, at: '2s', alpha: true }]] },
	'delivery-title-alpha': {
		calls: (v) => [
			[
				'export_frame',
				{ projectId: v.project, at: 0, end: '2s', alpha: true, clipIds: [v.seed_t], trimMarginPx: 24 },
			],
		],
	},
	'delivery-jpeg-control': {
		calls: (v) => [['export_frame', { projectId: v.project, at: '5s', format: 'jpeg', folder: v.cwd }]],
	},
	'delivery-gamut': {
		calls: (v) => [['color_gamut_check', { projectId: v.project, at: '3s', output: 'rec709' }]],
	},
	'delivery-levels-control': {
		calls: (v) => [['scopes_read', { projectId: v.project, at: '3s', scopes: ['waveform'] }]],
	},
	'delivery-layer-styles': {
		calls: (v) => [['import_layer_styles', { projectId: v.project, path: `${v.cwd}/styles/brand.asl` }]],
		reply: 'Both styles are looks now; the Bricks pattern overlay did not carry over.',
	},
	'delivery-split-logo': {
		calls: (v) => [
			['image_split', { projectId: v.project, clipId: v.still, dryRun: true }],
			['image_split', { projectId: v.project, clipId: v.still }],
		],
	},
	'delivery-split-clip-control': {
		calls: (v) => [['split_at', { projectId: v.project, clipIds: [v.clip], at: '10s' }]],
	},
};

const SPEC_19_PREFIXES = ['titles-', 'effects-', 'three-d-', 'delivery-'];
const cases = loadCases().filter((c) => SPEC_19_PREFIXES.some((p) => c.id.startsWith(p)));

async function runRoute(c: EvalCase, route: Route) {
	const cwd = mkdtempSync(join(dir, `${c.id}-`));
	for (const [rel, text] of Object.entries(c.setup?.files ?? {})) {
		const path = join(cwd, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	}
	const log = join(cwd, 'calls.jsonl');
	writeFileSync(log, '');
	const { server, engine } = await buildStub({
		sourceRoot: root,
		engine: c.setup ?? {},
		...(c.setup?.toolsets ? { toolsets: c.setup.toolsets } : { toolsets: 'core' }),
		log,
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(a);
	const client = new Client({ name: 'eval-cases-test', version: '1' });
	await client.connect(b);
	const vars: Vars = { ...engine.vars, cwd };
	try {
		for (const [tool, args] of route.calls(vars)) {
			const r = (await client.callTool({
				name: 'call_tool',
				arguments: { name: tool, arguments: fillVars(args, vars) },
			})) as CallToolResult;
			const text = (r.content.find((x) => x.type === 'text') as { text: string }).text;
			expect(r.isError, `${c.id} ${tool}: ${text.slice(0, 400)}`).not.toBe(true);
			if (tool === 'add_text') {
				const made = JSON.parse(text) as { clipId?: string; created: string[] };
				vars.text = made.clipId ?? made.created.find((id) => id.startsWith('clp_'))!;
			}
		}
	} finally {
		await client.close();
	}
	const calls = readFileSync(log, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as McpCall);
	return { calls, checks: fillVars(c.checks, vars) };
}

describe('spec 19 eval cases pass on their intended route', () => {
	it('names a route for every spec 19 case', () => {
		expect(cases.map((c) => c.id).sort()).toEqual(Object.keys(ROUTES).sort());
	});

	for (const c of cases)
		it(c.id, async () => {
			const route = ROUTES[c.id]!;
			const { calls, checks } = await runRoute(c, route);
			const g = grade({ calls, shell: [], reply: route.reply ?? '' }, checks);
			expect(g.invalid).toBeUndefined();
			expect(g.failures).toEqual([]);
		});
});
