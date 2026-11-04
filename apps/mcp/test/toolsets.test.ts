// Spec 18 AF-CTX-001…005: toolsets, call_tool / describe_tool, short instructions, per-topic guides, the routing
// table, the edit-video prompt and the agent skill (docs/wp-notes/agent-footage-context.md).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineJob } from '@jasper/api';
import { PROPOSAL_FEATURES, ROUGH_CUT_GROUPS } from '@jasper/project/proposals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
	type CallToolResult,
	type Tool,
	ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { INSTRUCTIONS_MAX_BYTES, ROUTES, routingMarkdown } from '../src/agent-guide.ts';
import { openSession } from '../src/jasper-cli.ts';
import type { EngineConnection } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { CORE_TOOL_BUDGET, parseToolsets, TOOLSET_NAMES, TOOLSETS, toolsetOf } from '../src/toolsets.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SKILL_DIR = join(ROOT, 'skills', 'jasper-editor');

/**
 * Spec 18 tools built by the parallel workstreams (footage, view, proposals, verify, derive, brief). They are mapped
 * in TOOLSETS and named by the instructions, prompt, routing table and skill before their register lines land.
 * Remove each name here when its tool is registered: the test below fails while a pending name is registered.
 */
const PENDING_TOOLS = new Set<string>();

type FakeEngine = {
	jobs: Map<string, EngineJob>;
	cancelled: string[];
	tx: unknown[];
	onCancelled?: () => void;
};

function fakeJob(
	id: string,
	state: EngineJob['state'] = 'running',
	progress: number | null = 0.1,
): EngineJob {
	return {
		id,
		kind: 'export',
		title: 'Export',
		state,
		progress,
		priority: 'user',
		createdAt: new Date().toISOString(),
	} as unknown as EngineJob;
}

/** An engine with jobs, a one-sequence document and transactions the user denies. */
function fakeLink(engine: FakeEngine): EngineConnection {
	const client = {
		getJob: async (id: string) => {
			const j = engine.jobs.get(id);
			if (!j) throw new Error(`no job ${id}`);
			return structuredClone(j);
		},
		cancelJob: async (id: string) => {
			engine.cancelled.push(id);
			engine.onCancelled?.();
			const j = engine.jobs.get(id);
			if (j) j.state = 'cancelled';
			return structuredClone(j ?? fakeJob(id, 'cancelled'));
		},
		agentQuery: async () => ({ result: { sequences: { seq_1: {} } }, revision: 3, via: 'headless' }),
		agentTx: async (body: unknown) => {
			engine.tx.push(body);
			return {
				appliedBy: 'headless',
				result: {
					ok: false,
					revision: 3,
					errors: [{ commandIndex: -1, code: 'E_APPROVAL_DENIED', message: 'The user denied "Remove V3"' }],
				},
			};
		},
	};
	return {
		target: { url: 'http://127.0.0.1:1', token: null, source: 'explicit' },
		client: async () => client as never,
		invalidate() {},
		close: async () => {},
	};
}

type Session = {
	client: Client;
	engine: FakeEngine;
	listChanged: () => number;
	close: () => Promise<void>;
};
const open: Session[] = [];
afterEach(async () => {
	for (const s of open.splice(0)) await s.close();
});

async function connect(toolsets?: string | string[]): Promise<Session> {
	const engine: FakeEngine = { jobs: new Map(), cancelled: [], tx: [] };
	const { server } = createJasperMcpServer({
		link: fakeLink(engine),
		agentName: 'toolsets-test',
		...(toolsets !== undefined ? { toolsets } : {}),
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'toolsets-test', version: '1' });
	let changed = 0;
	client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
		changed++;
	});
	await Promise.all([server.connect(a), client.connect(b)]);
	const s = {
		client,
		engine,
		listChanged: () => changed,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
	open.push(s);
	return s;
}

const textOf = (r: CallToolResult) => (r.content.find((c) => c.type === 'text') as { text: string }).text;
const bodyOf = (r: CallToolResult) => JSON.parse(textOf(r));
const call = async (s: Session, name: string, args: Record<string, unknown> = {}) =>
	(await s.client.callTool({ name, arguments: args })) as CallToolResult;
const names = (tools: Tool[]) => tools.map((t) => t.name).sort();

let allToolsCache: Tool[] | null = null;
async function allTools(): Promise<Tool[]> {
	if (!allToolsCache) allToolsCache = (await (await connect('all')).client.listTools()).tools;
	return allToolsCache;
}

/** Tool-like identifiers (snake_case with at least one underscore) at the start of each `code span`. */
function backtickedToolNames(text: string): string[] {
	return [...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]!);
}

/** How tool names start: every registered tool does, or NOT_TOOLS below lists it. */
const TOOL_VERBS =
	'accept|acknowledge|add|align|analyze|animate|apply|attach|auto|blur|browse|build|call|camera|caption|captions|clean|cleanup|clear|color|connect|convert|copy|create|decorate|delete|derive|describe|detach|detect|disable|duplicate|edit|enable|export|face|fill|find|fit|fix|flatten|frame|freeze|generate|get|grade|group|image|import|insert|install|interpret|join|lay|light|link|list|listen|locate|make|match|measure|merge|move|nest|new|normalize|open|paste|perf|place|plan|prepare|prerender|process|project|propagate|propose|rebalance|reconnect|record|refresh|regenerate|reject|remix|remove|rename|render|replace|rescan|restore|reverse|revert|save|scaffold|scopes|search|set|simplify|slide|sound|source|split|stabilize|start|style|svg|swap|switch|synchronize|test|threed|title|track|transcribe|transcript|transfer|trim|ui|undo|ungroup|unnest|update|use|verify|view|wait|write';
const TOOL_NAME_RE = new RegExp(`\\b(?:${TOOL_VERBS})_[a-z0-9]+(?:_[a-z0-9]+)*\\b`, 'g');

/** Identifiers that read like tools and are not: parameters, fields and values the guides name. */
const NOT_TOOLS = new Set([
	'search_path', // an OCIO config key (import_ocio_config)
	'list_changed', // the MCP notification notifications/tools/list_changed
]);

/** Tool-like identifiers anywhere in a text, in order, without repeats. */
function namedTools(text: string): string[] {
	return [...new Set(text.match(TOOL_NAME_RE) ?? [])];
}

/** Every exported `*_GUIDE` string of the tool modules. */
async function guideConstants(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const dir = join(HERE, '..', 'src', 'tools');
	for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
		const mod = (await import(join(dir, f))) as Record<string, unknown>;
		for (const [k, v] of Object.entries(mod)) if (k.endsWith('_GUIDE') && typeof v === 'string') out[k] = v;
	}
	const server = (await import('../src/server.ts')) as Record<string, unknown>;
	out.EDITING_GUIDE = server.EDITING_GUIDE as string;
	return out;
}

describe('toolset map (AF-CTX-001)', () => {
	it('puts every registered tool in exactly one toolset and maps only registered or pending tools', async () => {
		const registered = new Set(names(await allTools()));
		const count = new Map<string, number>();
		for (const ts of TOOLSETS) for (const t of ts.tools) count.set(t, (count.get(t) ?? 0) + 1);
		const unmapped = [...registered].filter((t) => !count.has(t));
		const doubled = [...count].filter(([, n]) => n > 1).map(([t]) => t);
		const unknown = [...count.keys()].filter((t) => !registered.has(t) && !PENDING_TOOLS.has(t));
		expect({ unmapped, doubled, unknown }).toEqual({ unmapped: [], doubled: [], unknown: [] });
		// A pending tool that is registered now must leave PENDING_TOOLS; every pending one is mapped already.
		expect([...PENDING_TOOLS].filter((t) => registered.has(t))).toEqual([]);
		expect([...PENDING_TOOLS].filter((t) => !count.has(t))).toEqual([]);
		expect(registered.size).toBeGreaterThan(400);
	});

	it('keeps core within its budget, pending tools included, and every toolset described', async () => {
		const core = TOOLSETS.find((t) => t.name === 'core')!;
		expect(core.tools.length).toBeLessThanOrEqual(CORE_TOOL_BUDGET);
		expect(CORE_TOOL_BUDGET).toBe(32);
		for (const name of [
			'list_toolsets',
			'enable_toolsets',
			'call_tool',
			'describe_tool',
			'get_guide',
			'describe_commands',
			'apply_commands',
			'get_timeline',
			'get_project',
		])
			expect(core.tools, name).toContain(name);
		expect(new Set(TOOLSET_NAMES).size).toBe(TOOLSET_NAMES.length);
		for (const ts of TOOLSETS) {
			expect(ts.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(ts.description.length, ts.name).toBeGreaterThan(20);
			expect(ts.description.length, ts.name).toBeLessThanOrEqual(200);
			expect(ts.tools.length, ts.name).toBeGreaterThan(0);
		}
	});

	it('parses --toolsets / JASPER_MCP_TOOLSETS: all, comma lists, core always on, unknown names refused', () => {
		expect([...parseToolsets(undefined)]).toEqual(['core']);
		expect([...parseToolsets('')]).toEqual(['core']);
		expect([...parseToolsets(' color , Audio,,')].sort()).toEqual(['audio', 'color', 'core']);
		expect(parseToolsets('all').size).toBe(TOOLSET_NAMES.length);
		expect(parseToolsets(['color', 'all']).size).toBe(TOOLSET_NAMES.length);
		expect(() => parseToolsets('color,colour,sfx')).toThrow(/Unknown toolsets "colour", "sfx".*color/);
	});
});

describe('advertised toolsets (AF-CTX-001/002)', () => {
	it('advertises exactly the registered core tools by default', async () => {
		const saved = process.env.JASPER_MCP_TOOLSETS;
		delete process.env.JASPER_MCP_TOOLSETS;
		try {
			const s = await connect();
			const all = new Set(names(await allTools()));
			const core = TOOLSETS.find((t) => t.name === 'core')!.tools.filter((t) => all.has(t));
			expect(names((await s.client.listTools()).tools)).toEqual([...core].sort());
		} finally {
			if (saved === undefined) delete process.env.JASPER_MCP_TOOLSETS;
			else process.env.JASPER_MCP_TOOLSETS = saved;
		}
	});

	it('JASPER_MCP_TOOLSETS chooses toolsets, and the explicit option wins over it', async () => {
		const saved = process.env.JASPER_MCP_TOOLSETS;
		process.env.JASPER_MCP_TOOLSETS = 'color';
		try {
			const listed = names((await (await connect()).client.listTools()).tools);
			expect(listed).toContain('grade_clip');
			expect(listed).not.toContain('get_mixer');
			const explicit = names((await (await connect('audio')).client.listTools()).tools);
			expect(explicit).toContain('get_mixer');
			expect(explicit).not.toContain('grade_clip');
		} finally {
			if (saved === undefined) delete process.env.JASPER_MCP_TOOLSETS;
			else process.env.JASPER_MCP_TOOLSETS = saved;
		}
		expect(() =>
			createJasperMcpServer({ link: fakeLink({ jobs: new Map(), cancelled: [], tx: [] }), toolsets: 'nope' }),
		).toThrow(/Unknown toolset "nope"/);
	});

	it('enable_toolsets / disable_toolsets change tools/list and send one list_changed per change', async () => {
		const s = await connect('core');
		const before = names((await s.client.listTools()).tools);
		expect(before).not.toContain('grade_clip');
		const on = bodyOf(await call(s, 'enable_toolsets', { names: ['color', 'audio'] }));
		expect(on).toMatchObject({ changed: true });
		expect(on.enabled.sort()).toEqual(['audio', 'color', 'core']);
		const after = names((await s.client.listTools()).tools);
		expect(s.listChanged()).toBe(1);
		expect(after).toEqual(expect.arrayContaining(['grade_clip', 'get_mixer', ...before]));
		expect(on.advertisedTools).toBe(after.length);
		// Unchanged: no notification.
		expect(bodyOf(await call(s, 'enable_toolsets', { names: ['color'] }))).toMatchObject({ changed: false });
		await s.client.listTools();
		expect(s.listChanged()).toBe(1);
		const disable = (toolsetNames: string[]) =>
			call(s, 'call_tool', { name: 'disable_toolsets', arguments: { names: toolsetNames } });
		expect(bodyOf(await disable(['color']))).toMatchObject({
			changed: true,
			enabled: ['core', 'audio'],
		});
		const afterDisable = names((await s.client.listTools()).tools);
		expect(s.listChanged()).toBe(2);
		expect(afterDisable).not.toContain('grade_clip');
		const core = await disable(['core']);
		expect(core.isError).toBe(true);
		expect(bodyOf(core).error).toMatchObject({ code: 'E_INVALID_PARAM' });
		const bad = await call(s, 'enable_toolsets', { names: ['colour'] });
		expect(bad.isError).toBe(true);
		expect(bodyOf(bad).error.code).toBe('E_INVALID_ARGUMENT');
		expect(bodyOf(await call(s, 'enable_toolsets', { names: ['all'] })).advertisedTools).toBe(
			(await allTools()).length,
		);
		expect(bodyOf(await disable(['all'])).enabled).toEqual(['core']);
	});

	it('list_toolsets reports each toolset, and with names only those, with their tools and guides', async () => {
		const s = await connect('core,ui');
		const r = bodyOf(await call(s, 'list_toolsets'));
		expect(r.toolsets.map((t: { name: string }) => t.name)).toEqual([...TOOLSET_NAMES]);
		const registered = new Set(names(await allTools()));
		for (const t of r.toolsets) {
			const def = TOOLSETS.find((d) => d.name === t.name)!;
			expect(t.tools, t.name).toBe(def.tools.filter((x) => registered.has(x)).length);
			expect(t.enabled, t.name).toBe(t.name === 'core' || t.name === 'ui');
			expect(t.description).toBe(def.description);
		}
		expect(r.toolsets.reduce((n: number, t: { tools: number }) => n + t.tools, 0)).toBe(registered.size);
		const some = bodyOf(await call(s, 'list_toolsets', { names: ['ui'] }));
		expect(some.toolsets).toHaveLength(1);
		expect(some.toolsets[0].tools).toContain('ui_screenshot');
		expect(some.toolsets[0].guides).toEqual(TOOLSETS.find((d) => d.name === 'ui')!.guides);
	});

	it('calling a registered but unadvertised tool by name returns an error naming its toolset', async () => {
		const s = await connect('core');
		const r = await call(s, 'grade_clip', { projectId: 'prj_1', clipId: 'clp_1' });
		expect(r.isError).toBe(true);
		expect(bodyOf(r).error).toMatchObject({
			code: 'E_TOOLSET_NOT_ENABLED',
			message: expect.stringContaining('"color"'),
			hint: expect.stringContaining('describe_tool'),
			details: { tool: 'grade_clip', toolset: 'color' },
		});
		expect(bodyOf(r).error.hint).toContain('call_tool');
	});
});

describe('call_tool and describe_tool (AF-CTX-002)', () => {
	it('runs any tool with the same validation, results and error shapes as a direct call', async () => {
		const direct = await connect('all');
		const proxied = await connect('core');
		const cases: [string, Record<string, unknown>][] = [
			['list_blend_modes', {}],
			['grade_clip', { projectId: 'prj_1', clipId: 'clp_1', bogus: 1 }],
			['grade_clip', { projectId: 'prj_1', clipId: 'clp_1', basic: { exposure: 'bright' } }],
			['get_job', { jobId: 'job_missing' }],
			['set_playhead', { projectId: 'prj_1' }],
		];
		for (const [name, args] of cases) {
			const want = await call(direct, name, args);
			const got = await call(proxied, 'call_tool', { name, arguments: args });
			expect(got, name).toEqual(want);
		}
		expect((await call(direct, 'list_blend_modes')).isError).toBeFalsy();
		expect(
			bodyOf(await call(direct, 'grade_clip', { projectId: 'p', clipId: 'c', bogus: 1 })).error.code,
		).toBe('E_UNKNOWN_ARGUMENT');
		// call_tool's own arguments are strict too.
		const own = await call(proxied, 'call_tool', { name: 'list_blend_modes', args: {} });
		expect(bodyOf(own).error).toMatchObject({ code: 'E_UNKNOWN_ARGUMENT' });
		const missing = await call(proxied, 'call_tool', { name: 'no_such_tool' });
		expect(bodyOf(missing).error).toMatchObject({ code: 'E_NOT_FOUND', details: { tool: 'no_such_tool' } });
		const self = await call(proxied, 'call_tool', { name: 'call_tool', arguments: {} });
		expect(bodyOf(self).error.code).toBe('E_INVALID_PARAM');
	});

	it('keeps approval semantics: the same transaction reaches the engine and the denial comes back', async () => {
		const direct = await connect('all');
		const proxied = await connect('core');
		const args = {
			projectId: 'prj_1',
			label: 'Remove V3',
			commands: [{ type: 'track.remove', trackIds: ['V3'] }],
		};
		const progress: string[] = [];
		const want = await call(direct, 'apply_commands', args);
		const got = (await proxied.client.callTool(
			{ name: 'call_tool', arguments: { name: 'apply_commands', arguments: args } },
			undefined,
			{ onprogress: (p) => progress.push(p.message ?? '') },
		)) as CallToolResult;
		expect(got).toEqual(want);
		expect(bodyOf(got).error.code).toBe('E_APPROVAL_DENIED');
		expect(proxied.engine.tx).toEqual(direct.engine.tx);
		expect(proxied.engine.tx).toHaveLength(1);
		expect(progress[0]).toContain('Waiting for the user to approve "Remove V3"');
	});

	it('forwards progress and cancellation of the tool it runs', async () => {
		const s = await connect('core');
		s.engine.jobs.set('job_7', fakeJob('job_7'));
		const cancelled = new Promise<void>((resolve) => {
			s.engine.onCancelled = resolve;
		});
		let progressed!: () => void;
		const progressReceived = new Promise<void>((resolve) => {
			progressed = resolve;
		});
		const ac = new AbortController();
		const progress: number[] = [];
		const pending = s.client.callTool(
			{ name: 'call_tool', arguments: { name: 'wait_for_job', arguments: { jobId: 'job_7' } } },
			undefined,
			{
				signal: ac.signal,
				onprogress: (p) => {
					progress.push(p.progress);
					progressed();
				},
			},
		);
		await progressReceived;
		expect(progress.length).toBeGreaterThan(0);
		ac.abort();
		await expect(pending).rejects.toThrow();
		await cancelled;
		expect(s.engine.cancelled).toEqual(['job_7']);
	});

	it('describe_tool returns the tools/list definition of any tool with its toolset', async () => {
		const s = await connect('core');
		const listed = (await allTools()).find((t) => t.name === 'grade_clip')!;
		expect(bodyOf(await call(s, 'describe_tool', { name: 'grade_clip' }))).toEqual({
			name: 'grade_clip',
			description: listed.description,
			inputSchema: JSON.parse(JSON.stringify(listed.inputSchema)),
			toolset: 'color',
		});
		const full = bodyOf(await call(s, 'describe_tool', { name: 'grade_clip', full: true }));
		expect(full).toMatchObject({ toolset: 'color', advertised: false });
		expect(full.inputSchema.additionalProperties).toBe(false);
		expect(full.details).toContain('Colour-grades a clip');
		expect(bodyOf(await call(s, 'describe_tool', { name: 'get_timeline', full: true }))).toMatchObject({
			toolset: 'core',
			advertised: true,
		});
		expect(bodyOf(await call(s, 'describe_tool', { name: 'nope_tool' })).error.code).toBe('E_NOT_FOUND');
	});

	it('the jasper CLI reaches every tool', async () => {
		const engine: FakeEngine = { jobs: new Map(), cancelled: [], tx: [] };
		const session = await openSession(fakeLink(engine), 'cli-test', () => {});
		try {
			const r = await session.call('list_blend_modes');
			expect(r.isError).toBeFalsy();
			const sets = bodyOf(await session.call('list_toolsets'));
			expect(sets.toolsets.every((t: { enabled: boolean }) => t.enabled)).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('jasper-mcp --toolsets: listed in --help, unknown names exit 2 with the valid ones', () => {
		const cli = join(ROOT, 'apps', 'mcp', 'src', 'cli.ts');
		const help = spawnSync(process.execPath, ['--import', 'tsx', cli, '--help'], {
			cwd: ROOT,
			encoding: 'utf8',
		});
		expect(help.stderr).toContain('--toolsets');
		expect(help.stderr).toContain('sound-design');
		const bad = spawnSync(process.execPath, ['--import', 'tsx', cli, '--toolsets', 'color,bogus'], {
			cwd: ROOT,
			encoding: 'utf8',
			input: '',
		});
		expect(bad.status).toBe(2);
		expect(bad.stderr).toMatch(/Unknown toolset "bogus".*core, project/);
	});
});

describe('instructions, guides and prompt (AF-CTX-003)', () => {
	it('sends instructions that survive the harness cut: routes, rules, every toolset and guide pointers', async () => {
		const s = await connect('core');
		const text = s.client.getInstructions() ?? '';
		expect(text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_BYTES);
		expect(INSTRUCTIONS_MAX_BYTES).toBe(4096);
		for (const ts of TOOLSETS) if (ts.name !== 'core') expect(text, ts.name).toContain(ts.name);
		for (const ref of ['propose_edits', 'verify_export', 'list_toolsets', 'call_tool', 'get_guide', 'hint'])
			expect(text).toContain(ref);
		const guides = await guideConstants();
		// No domain guide is embedded any more.
		expect(text).not.toContain(guides.SOUND_GUIDE!.slice(0, 200));
		expect(text).not.toContain(guides.EDITING_GUIDE!.slice(0, 200));
	});

	it('serves every domain guide as jasper://guide/<topic> and get_guide, and the full text at jasper://guide', async () => {
		const s = await connect('core');
		const { topics } = bodyOf(await call(s, 'get_guide')) as { topics: string[] };
		expect(topics).toEqual(
			expect.arrayContaining(['routing', 'cleanup', 'transcript-fix', 'editing-automation', 'export']),
		);
		const texts = new Map<string, string>();
		for (const topic of topics) {
			const res = await s.client.readResource({ uri: `jasper://guide/${topic}` });
			expect(res.contents[0], topic).toMatchObject({
				uri: `jasper://guide/${topic}`,
				mimeType: 'text/markdown',
			});
			const text = (res.contents[0] as { text: string }).text;
			expect(textOf(await call(s, 'get_guide', { topic })), topic).toBe(text);
			texts.set(topic, text);
		}
		const full = ((await s.client.readResource({ uri: 'jasper://guide' })).contents[0] as { text: string })
			.text;
		const guides = await guideConstants();
		expect(Object.keys(guides).length).toBeGreaterThanOrEqual(53);
		for (const [name, text] of Object.entries(guides)) {
			if (!text.trim()) continue;
			expect(
				[...texts.values()].some((t) => t.includes(text)),
				`${name} has a topic`,
			).toBe(true);
			expect(full.includes(text), `${name} in jasper://guide`).toBe(true);
		}
		expect(full).toContain('Expression language reference');
		// The older composite guides keep their content.
		expect(texts.get('cleanup')).toContain(guides.VOICE_GUIDE!);
		expect(texts.get('transcript-fix')).toContain(guides.GLOSSARY_GUIDE!);
		expect(texts.get('editing-automation')).toContain(guides.STYLE_GUIDE!);
		for (const ts of TOOLSETS) for (const g of ts.guides) expect(topics, `${ts.name} → ${g}`).toContain(g);
		const bad = await call(s, 'get_guide', { topic: 'colour' });
		expect(bodyOf(bad).error).toMatchObject({ code: 'E_NOT_FOUND', hint: expect.stringContaining('color') });
	});

	it('the edit-video prompt teaches the workflow instead of embedding the guide', async () => {
		const s = await connect('core');
		const p = await s.client.getPrompt({
			name: 'edit-video',
			arguments: { goal: 'a 30 s teaser', projectId: 'prj_9' },
		});
		const text = (p.messages[0]!.content as { text: string }).text;
		expect(text).toContain('a 30 s teaser');
		expect(text).toContain('prj_9');
		const order = [
			'get_brief',
			'get_footage_digest',
			'view_media_range',
			'wait_for_proposal',
			'verify_export',
		];
		const at = order.map((t) => text.indexOf(`\`${t}\``));
		expect(at.every((i) => i >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		for (const part of ['Done', 'Checked', 'Not checked']) expect(text).toContain(part);
		expect(text.length).toBeLessThan(4000);
		const fresh = await s.client.getPrompt({ name: 'edit-video', arguments: { goal: 'x' } });
		expect((fresh.messages[0]!.content as { text: string }).text).toContain('create_project');
	});
});

describe('routing table (AF-CTX-004)', () => {
	it('has at least 60 English and Spanish rows whose tools exist and name their toolsets', async () => {
		expect(ROUTES.length).toBeGreaterThanOrEqual(60);
		const registered = new Set(names(await allTools()));
		const table = routingMarkdown();
		for (const r of ROUTES) {
			expect(r.en.trim().length, r.en).toBeGreaterThan(3);
			expect(r.es.trim().length, r.en).toBeGreaterThan(3);
			expect(r.es, r.en).not.toBe(r.en);
			expect(r.tools.length, r.en).toBeGreaterThan(0);
			for (const t of r.tools) {
				expect(registered.has(t) || PENDING_TOOLS.has(t), `${r.en} → ${t}`).toBe(true);
				expect(toolsetOf(t), t).toBeDefined();
			}
			const row = table.split('\n').find((l) => l.startsWith(`| ${r.en} |`));
			expect(row, r.en).toBeDefined();
			const cells = row!.split(' | ');
			expect(cells.at(-1)!.replace(/ \|$/, '').split(', '), r.en).toEqual([
				...new Set(r.tools.map((t) => toolsetOf(t)!)),
			]);
		}
		const s = await connect('core');
		const res = await s.client.readResource({ uri: 'jasper://guide/routing' });
		expect((res.contents[0] as { text: string }).text).toBe(table);
	});
});

describe('agent skill (AF-CTX-005)', () => {
	const skill = () => readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
	const references = () =>
		readdirSync(join(SKILL_DIR, 'references'))
			.filter((f) => f.endsWith('.md'))
			.map((f) => ({ file: f, text: readFileSync(join(SKILL_DIR, 'references', f), 'utf8') }));

	it('names the rough-cut group ids propose_edits accepts, in the skill and its proposals reference', () => {
		const ids = ROUGH_CUT_GROUPS.map((g) => `\`${g}\``).join(', ');
		const texts = [
			skill(),
			...references()
				.filter((r) => r.file === 'proposals.md')
				.map((r) => r.text),
		];
		expect(texts).toHaveLength(2);
		for (const text of texts) expect(text).toContain(ids);
	});

	it('has valid frontmatter with trigger phrases and the required sections, and stays concise', () => {
		const text = skill();
		const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
		expect(fm).not.toBeNull();
		const fields = Object.fromEntries(
			fm![1]!.split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
		);
		expect(Object.keys(fields).sort()).toEqual(['description', 'name']);
		expect(fields.name).toBe('jasper-editor');
		expect(fields.description!.length).toBeGreaterThan(100);
		expect(fields.description!.length).toBeLessThanOrEqual(1024);
		expect(fields.description).toMatch(/Use when/);
		expect(fields.description).toMatch(/rough cut/);
		expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(12 * 1024);
		for (const part of [
			'## When to use',
			'## Workflow',
			'## Ask or assume',
			'## Report',
			'**Done**',
			'**Checked**',
			'**Not checked**',
			'## Gotchas',
			'cannot hear',
			'three',
		])
			expect(text, part).toContain(part);
	});

	it('links every reference file, and every link resolves', () => {
		const text = skill();
		const linked = [...text.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]!);
		expect(linked.length).toBeGreaterThan(0);
		for (const l of linked) expect(existsSync(join(SKILL_DIR, l)), l).toBe(true);
		for (const { file } of references()) expect(linked, file).toContain(`references/${file}`);
	});
});

describe('tool names in agent-facing text (AF-CTX-003/004/005)', () => {
	it('no guide, tool description or tool details names a tool that does not exist (TL-105, TL-107)', async () => {
		const tools = await allTools();
		const registered = new Set(names(tools));
		// The reference text moved out of `description` into `details` (describe_tool {full}): it names tools too.
		const s = await connect('core');
		const details: [string, string][] = [];
		for (const t of tools) {
			const d = (bodyOf(await call(s, 'describe_tool', { name: t.name, full: true })) as { details?: string })
				.details;
			if (d) details.push([`details ${t.name}`, d]);
		}
		expect(details.length).toBeGreaterThan(50);
		const sources: [string, string][] = [
			...Object.entries(await guideConstants()),
			...tools.map((t) => [`tool ${t.name}`, t.description ?? ''] as [string, string]),
			...details,
			...PROPOSAL_FEATURES.map((f) => [`feature ${f.id}`, f.producers.join(' ')] as [string, string]),
		];
		const missing: string[] = [];
		let total = 0;
		for (const [where, text] of sources)
			for (const name of namedTools(text)) {
				total++;
				if (!registered.has(name) && !NOT_TOOLS.has(name)) missing.push(`${where}: ${name}`);
			}
		expect([...new Set(missing)]).toEqual([]);
		expect(total).toBeGreaterThan(500);
		for (const t of ['list_effects', 'add_effect', 'set_effect_param'])
			expect(registered.has(t), t).toBe(true);
	});

	it('the scan finds an unknown tool name, in plain text and in backticks', () => {
		expect(namedTools('then call list_widgets {a} and `get_widget`; snake_case_word stays out')).toEqual([
			'list_widgets',
			'get_widget',
		]);
	});

	it('every backticked tool name in the instructions, prompt, routing table and skill exists', async () => {
		const registered = new Set(names(await allTools()));
		const s = await connect('core');
		const prompt = await s.client.getPrompt({ name: 'edit-video', arguments: { goal: 'g' } });
		const sources: [string, string][] = [
			['instructions', s.client.getInstructions() ?? ''],
			['edit-video', (prompt.messages[0]!.content as { text: string }).text],
			['routing', routingMarkdown()],
			['SKILL.md', readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')],
			...readdirSync(join(SKILL_DIR, 'references')).map(
				(f) =>
					[`references/${f}`, readFileSync(join(SKILL_DIR, 'references', f), 'utf8')] as [string, string],
			),
		];
		const missing: string[] = [];
		let total = 0;
		for (const [where, text] of sources)
			for (const name of backtickedToolNames(text)) {
				total++;
				if (!registered.has(name) && !PENDING_TOOLS.has(name)) missing.push(`${where}: ${name}`);
			}
		expect(missing).toEqual([]);
		expect(total).toBeGreaterThan(100);
	});
});
