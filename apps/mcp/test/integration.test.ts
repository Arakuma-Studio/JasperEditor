// jasper-mcp end to end (docs/wp-notes/wp-mcp.md): a real engine (token mode, temp appdir, port
// MCP_TEST_PORT = 48551) and an MCP SDK Client talking to `jasper-mcp` over stdio. The server finds the
// engine through `<appdir>/engine/runtime.json`. Flow: create project → import fixture media → add and
// edit clips → render_frame returns a PNG → start_export + wait_for_job → the output file is verified with
// ffprobe. Plus the error paths, resources, prompts, every describe_commands example (dry run) and
// `--start-engine`.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMAND_EXAMPLES, TRANSACTION_EXAMPLE } from '../src/examples.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures', 'media');
const PORT = Number(process.env.MCP_TEST_PORT ?? 48551);
const AUTOSTART_PORT = Number(process.env.MCP_TEST_AUTOSTART_PORT ?? PORT + 1);

function ensureFixtures(): void {
	if (['clip-a.mp4', 'clip-b.mp4'].every((n) => existsSync(join(FIXTURES, n)))) return;
	const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
	if (r.status !== 0) throw new Error('fixture generation failed');
}

/** process.env without JASPER_* (a developer's shell must not redirect the test). */
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined && !k.startsWith('JASPER_')) out[k] = v;
	return { ...out, ...extra };
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, what: string) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (
			await Promise.resolve()
				.then(check)
				.catch(() => false)
		)
			return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`timed out waiting for ${what}`);
}

function mcpClient(args: string[], env: Record<string, string> = {}) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), ...args],
		cwd: ROOT,
		env: cleanEnv(env),
		stderr: 'pipe',
	});
	const logs: string[] = [];
	transport.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
	const client = new Client({ name: 'vitest-mcp', version: '1.0.0' });
	return { client, transport, logs };
}

function textOf(r: CallToolResult): string {
	return (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
}
function json<T = Record<string, unknown>>(r: CallToolResult): T {
	return JSON.parse(textOf(r)) as T;
}

let engine: ChildProcess | null = null;
let appdir = '';
let client: Client;
let serverLogs: string[] = [];
let engineToken = '';

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 300_000,
	})) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${serverLogs.join('')}`);
	return json<T>(r);
}
async function fails(name: string, args: Record<string, unknown>) {
	const r = await call(name, args);
	expect(r.isError, `${name} should fail: ${textOf(r)}`).toBe(true);
	return json<{ error: { code: string; message: string; hint?: string } }>(r).error;
}

beforeAll(async () => {
	ensureFixtures();
	appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-it-'));
	const token = randomBytes(16).toString('hex');
	engineToken = token;
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{ cwd: ROOT, env: cleanEnv({ JASPER_LOCAL_TOKEN: token }), stdio: ['ignore', 'pipe', 'pipe'] },
	);
	const engineLog: string[] = [];
	engine.stdout?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	engine.stderr?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	await waitFor(
		async () =>
			existsSync(join(appdir, 'engine', 'runtime.json')) &&
			(await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
		90_000,
		`the engine on ${PORT}: ${engineLog.join('')}`,
	);
	// Token mode: the API refuses requests without it, so discovery must pick it up from runtime.json.
	expect((await fetch(`http://127.0.0.1:${PORT}/api/projects`)).status).toBe(401);
	const c = mcpClient(['--appdir', appdir]);
	client = c.client;
	serverLogs = c.logs;
	await client.connect(c.transport);
}, 180_000);

afterAll(async () => {
	// Everything the server logged during the whole run (stderr) stays free of the engine token.
	expect(serverLogs.join('')).not.toContain(engineToken || 'no-token');
	await client?.close().catch(() => {});
	if (engine && engine.exitCode === null) {
		const exited = new Promise((r) => engine!.once('exit', r));
		engine.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
	}
	if (appdir) rmSync(appdir, { recursive: true, force: true });
}, 30_000);

describe('jasper-mcp over stdio against a real engine', () => {
	let projectId = '';
	let exportFrames = 0;

	it('advertises tools, resources and prompts', async () => {
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		for (const n of [
			'list_projects',
			'create_project',
			'get_project',
			'open_project_in_editor',
			'import_media',
			'list_media',
			'get_media_info',
			'describe_commands',
			'apply_commands',
			'undo',
			'redo',
			'add_clip',
			'move_clip',
			'trim_clip',
			'split_at',
			'delete_clips',
			'add_text',
			'add_marker',
			'add_motion_graphic',
			'add_transition',
			'list_transitions',
			'update_transition',
			'remove_transitions',
			'apply_default_transitions',
			'get_timeline',
			'render_frame',
			'get_playhead',
			'set_playhead',
			'list_motion_templates',
			'render_motion_graphic_preview',
			'list_export_presets',
			'start_export',
			'get_job',
			'cancel_job',
			'wait_for_job',
		])
			expect(names).toContain(n);
		for (const t of tools) {
			expect(t.description?.length, t.name).toBeGreaterThan(40);
			expect(t.inputSchema.type).toBe('object');
		}
		const apply = tools.find((t) => t.name === 'apply_commands')!;
		expect(JSON.stringify(apply.inputSchema)).toContain('clip.place');
		expect(apply.annotations?.destructiveHint).toBe(true);
		expect(tools.find((t) => t.name === 'get_timeline')!.annotations?.readOnlyHint).toBe(true);
		const { resourceTemplates } = await client.listResourceTemplates();
		expect(resourceTemplates.map((r) => r.uriTemplate)).toEqual(
			expect.arrayContaining([
				'jasper://projects/{projectId}/document',
				'jasper://projects/{projectId}/timeline',
			]),
		);
		const { prompts } = await client.listPrompts();
		expect(prompts.map((p) => p.name)).toContain('edit-video');
		expect(client.getInstructions()).toMatch(/JasperEditor/);
	});

	it('finds the token-mode engine through runtime.json', async () => {
		const s = await ok<{ engine: { url: string; foundBy: string }; agentName: string }>('engine_status');
		expect(s.engine).toMatchObject({ url: `http://127.0.0.1:${PORT}`, foundBy: 'runtime-file' });
		expect(s.agentName).toBe('vitest-mcp');
	});

	it('never shows the engine token to the agent or in its log', async () => {
		expect(engineToken).toHaveLength(32);
		const outputs = [
			textOf(await call('engine_status')),
			textOf(await call('list_projects')),
			textOf(await call('get_project', { projectId: 'prj_NOPE' })),
			textOf(await call('open_project_in_editor', { projectId: 'prj_NOPE' })),
			serverLogs.join(''),
		];
		for (const o of outputs) expect(o).not.toContain(engineToken);
	});

	it('creates a project and imports fixture media', async () => {
		const p = await ok<{ projectId: string; sequences: { tracks: { label: string }[] }[] }>(
			'create_project',
			{
				name: 'MCP integration',
			},
		);
		projectId = p.projectId;
		expect(projectId).toMatch(/^prj_/);
		expect(p.sequences[0]!.tracks.map((t) => t.label)).toEqual(['V1', 'V2', 'V3', 'A1', 'A2', 'A3']);
		expect((await ok<{ projects: { projectId: string }[] }>('list_projects')).projects[0]!.projectId).toBe(
			projectId,
		);
		const imp = await ok<{ imported: { mediaId: string; name: string; durationSeconds: number }[] }>(
			'import_media',
			{ projectId, paths: [join(FIXTURES, 'clip-a.mp4'), join(FIXTURES, 'clip-b.mp4')] },
		);
		expect(imp.imported.map((m) => m.name)).toEqual(['clip-a.mp4', 'clip-b.mp4']);
		expect(imp.imported[0]!.mediaId).toMatch(/^med_/);
		expect(imp.imported[0]!.durationSeconds).toBeCloseTo(10, 1);
		const bad = await fails('import_media', { projectId, paths: ['relative/clip.mp4'] });
		expect(bad.code).toBe('NO_FILES');
		const media = await ok<{ media: { mediaId: string; clips: number }[] }>('list_media', { projectId });
		expect(media.media).toHaveLength(2);
		const info = await ok<{ probe: { streams: unknown[] }; engine: { status: string } }>('get_media_info', {
			projectId,
			mediaId: imp.imported[1]!.mediaId,
		});
		expect(info.probe.streams.length).toBeGreaterThanOrEqual(2);
		expect(info.engine.status).toBeDefined();
	});

	it('edits the timeline with the helper tools', async () => {
		const a = await ok<{
			appliedBy: string;
			clips: { id: string; track: string; start: number; end: number }[];
		}>('add_clip', { projectId, media: 'clip-a.mp4', at: 0 });
		expect(a.appliedBy).toBe('headless');
		expect(a.clips.map((c) => [c.track, c.start, c.end])).toEqual([
			['V1', 0, 300],
			['A1', 0, 300],
		]);
		const b = await ok<{ clips: { id: string; track: string; start: number; end: number }[] }>('add_clip', {
			projectId,
			media: 'clip-b.mp4',
			at: { seconds: 10 },
			sourceIn: 1,
			sourceOut: 4,
		});
		expect(b.clips.find((c) => c.track === 'V1')).toMatchObject({ start: 300, end: 390 });
		// Razor at 5 s, then ripple-trim the tail of the right half by 1 s, then move clip-b 10 frames later.
		const split = await ok<{ created: string[] }>('split_at', { projectId, at: '00:00:05:00' });
		expect(split.created.length).toBeGreaterThanOrEqual(2);
		const tl1 = await ok<{
			sequences: { clips: { id: string; track: string; start: number; end: number }[] }[];
		}>('get_project', { projectId });
		const right = tl1.sequences[0]!.clips.find((c) => c.track === 'V1' && c.start === 150)!;
		await ok('trim_clip', { projectId, clipId: right.id, edge: 'out', deltaFrames: -30, mode: 'ripple' });
		const bV = tl1.sequences[0]!.clips.find((c) => c.track === 'V1' && c.start === 300)!;
		const moved = await ok<{ clips: { id: string; start: number }[] }>('move_clip', {
			projectId,
			clipIds: [bV.id],
			to: 280,
		});
		expect(moved.clips.find((c) => c.id === bV.id)?.start).toBe(280);
		const text = await client.callTool({ name: 'get_timeline', arguments: { projectId } });
		const table = textOf(text as CallToolResult);
		expect(table).toMatch(/duration 00:00:12:10 \(370 frames\)/);
		expect(table).toMatch(
			/V1 \| clp_\w+ \| video \| clip-b\.mp4 \| 00:00:09:10–00:00:12:10 \| 280–370 \| clip-b\.mp4 \[med_\w+\] 1–4 s/,
		);
		exportFrames = 370;
	});

	it('places clips frame-exactly on any track and adds transitions', async () => {
		// Media frames 12…57 of clip-b (25 fps) on a new track V4 at frame 400: 45 media frames = 54 at 30 fps.
		const r = await ok<{ clips: { id: string; track: string; start: number; end: number }[] }>('add_clip', {
			projectId,
			media: 'clip-b.mp4',
			at: 400,
			track: 'V4',
			sourceInFrame: 12,
			sourceOutFrame: 57,
			videoOnly: true,
		});
		expect(r.clips).toEqual([expect.objectContaining({ track: 'V4', start: 400, end: 454 })]);
		const bad = await call('add_clip', {
			projectId,
			media: 'clip-b.mp4',
			at: 0,
			sourceIn: 1,
			sourceInFrame: 3,
			sourceOutFrame: 9,
		});
		expect(bad.isError).toBe(true);
		const fade = await ok<{ results: { transitionId: string; duration: number; alignment: string }[] }>(
			'add_transition',
			{ projectId, clipId: r.clips[0]!.id, edge: 'out', type: 'dip-to-black', durationFrames: 12 },
		);
		expect(fade.results[0]).toMatchObject({ duration: 12, alignment: 'end-at-cut' });
		const table = textOf((await call('get_timeline', { projectId })) as CallToolResult);
		expect(table).toMatch(/V4 \| clp_\w+ \| video \| clip-b\.mp4 \| [\d:]+–[\d:]+ \| 400–454/);
		// Remove it again so the export below keeps its length.
		await ok('delete_clips', { projectId, clipIds: [r.clips[0]!.id] });
	});

	it('lists, updates, applies and removes transitions (S10:TUI-060)', async () => {
		type T = {
			id: string;
			type: string;
			label: string;
			track: string;
			cut: number;
			span: { start: number; end: number };
			duration: number;
			alignment: string;
			oneSided: boolean;
			outgoingClipId: string | null;
			incomingClipId: string | null;
			handles: { outgoingTail?: number; incomingHead?: number };
		};
		const list = async (range?: { from: number; to: number }) =>
			(await ok<{ transitions: T[] }>('list_transitions', { projectId, ...(range ? { range } : {}) }))
				.transitions;
		const p = await ok<{ sequences: { clips: { id: string; track: string; start: number }[] }[] }>(
			'get_project',
			{ projectId },
		);
		// V1: clip-a 0–150 | clip-a 150–270 | gap | clip-b 280–370 (see the helper-tool test above).
		const left = p.sequences[0]!.clips.find((c) => c.track === 'V1' && c.start === 0)!;
		const right = p.sequences[0]!.clips.find((c) => c.track === 'V1' && c.start === 150)!;
		const add = await ok<{ results: { transitionId: string }[] }>('add_transition', {
			projectId,
			track: 'V1',
			at: 150,
			type: 'cross-dissolve',
			durationFrames: 10,
		});
		const id = add.results[0]!.transitionId;
		const [t] = await list();
		expect(t).toMatchObject({
			id,
			type: 'cross-dissolve',
			label: 'Cross Dissolve',
			track: 'V1',
			cut: 150,
			span: { start: 145, end: 155 },
			duration: 10,
			alignment: 'center',
			oneSided: false,
			outgoingClipId: left.id,
			incomingClipId: right.id,
		});
		expect(t!.handles.outgoingTail).toBeGreaterThan(100);
		expect(t!.handles.incomingHead).toBeGreaterThan(100);
		const table = textOf(await call('get_timeline', { projectId }));
		expect(table).toContain(`V1 ${id} Cross Dissolve 00:00:04:25–00:00:05:05 (145–155) center, 10 frames`);

		// Length + type in one History entry; then the alignment.
		const up = await ok<{ changed: string[]; transition: T }>('update_transition', {
			projectId,
			transitionId: id,
			duration: 20,
			effectId: 'dip-to-black',
		});
		expect(up.changed).toContain(id);
		expect(up.transition).toMatchObject({ id, type: 'dip-to-black', duration: 20, span: { start: 140 } });
		const aligned = await ok<{ transition: T }>('update_transition', {
			projectId,
			transitionId: id,
			alignment: 'start-at-cut',
		});
		expect(aligned.transition).toMatchObject({ alignment: 'start-at-cut', span: { start: 150, end: 170 } });
		expect(
			(await fails('update_transition', { projectId, transitionId: id, effectId: 'constant-power' })).code,
		).toBe('E_TRACK_KIND');
		const unknown = await fails('update_transition', { projectId, transitionId: id, effectId: 'swirl' });
		expect(unknown.code).toBe('E_UNKNOWN_EFFECT');
		expect(unknown.hint).toMatch(/cross-dissolve/);
		expect((await fails('update_transition', { projectId, transitionId: id })).code).toBe('E_INVALID_PARAM');

		// Defaults on both edges of the right half, with its linked audio: the dip at 150 is replaced.
		const applied = await ok<{ clipIds: string[]; transitions: T[] }>('apply_default_transitions', {
			projectId,
			clipIds: [right.id],
			media: ['video', 'audio'],
			durationFrames: 8,
		});
		expect(applied.clipIds).toHaveLength(2);
		const v = applied.transitions.filter((x) => x.track === 'V1');
		expect(v.map((x) => [x.type, x.cut, x.oneSided, x.duration])).toEqual([
			['cross-dissolve', 150, false, 8],
			['cross-dissolve', 270, true, 8],
		]);
		expect(applied.transitions.some((x) => x.track === 'A1')).toBe(true);
		const all = await list();
		expect(all.map((x) => x.id)).not.toContain(id);
		expect((await list({ from: 260, to: 275 })).every((x) => x.cut === 270)).toBe(true);

		// Remove them all again: the export below renders plain cuts.
		const removed = await ok<{ removed: string[]; deleted: string[] }>('remove_transitions', {
			projectId,
			transitionIds: all.map((x) => x.id),
		});
		expect(removed.removed.sort()).toEqual(all.map((x) => x.id).sort());
		expect(await list()).toEqual([]);
		expect((await fails('remove_transitions', { projectId, transitionIds: [id] })).code).toBe('E_NOT_FOUND');
		expect(textOf(await call('get_timeline', { projectId }))).not.toMatch(/Transitions:/);
	});

	it('render_frame returns a downscaled PNG of the Program output', async () => {
		const r = await call('render_frame', { projectId, at: { seconds: 1 }, width: 320 });
		expect(r.isError, textOf(r)).toBeFalsy();
		const meta = json<{ frame: number; timecode: string; renderedBy: string }>(r);
		expect(meta).toMatchObject({ frame: 30, timecode: '00:00:01:00' });
		const img = r.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
		expect(img.mimeType).toBe('image/png');
		const png = Buffer.from(img.data, 'base64');
		expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
		expect(png.readUInt32BE(16)).toBe(320); // IHDR width
		expect(png.readUInt32BE(20)).toBe(180);
	});

	it('exports with start_export + wait_for_job and the output passes ffprobe', async () => {
		const out = join(appdir, 'exports', 'mcp-draft.mp4');
		const job = await ok<{ jobId: string; plan: { path: string } }>('start_export', {
			projectId,
			preset: 'draft-720p-h264',
			outputPath: out,
		});
		expect(job.plan.path).toBe('native');
		const done = await ok<{ state: string; result: { path: string; frames: number; downloadUrl: string } }>(
			'wait_for_job',
			{ jobId: job.jobId, timeoutSeconds: 240 },
		);
		expect(done.state).toBe('succeeded');
		expect(done.result.path).toBe(out);
		expect(done.result.downloadUrl).toMatch(new RegExp(`^http://127.0.0.1:${PORT}/renders/`));
		expect(existsSync(out)).toBe(true);
		const probe = spawnSync(
			'ffprobe',
			[
				'-v',
				'error',
				'-count_frames',
				'-select_streams',
				'v:0',
				'-show_entries',
				'stream=width,height,nb_read_frames',
				'-of',
				'json',
				out,
			],
			{ encoding: 'utf8' },
		);
		expect(probe.status).toBe(0);
		const s = JSON.parse(probe.stdout).streams[0];
		expect({ w: s.width, h: s.height, frames: Number(s.nb_read_frames) }).toEqual({
			w: 1280,
			h: 720,
			frames: exportFrames,
		});
		expect((await ok<{ state: string }>('get_job', { jobId: job.jobId })).state).toBe('succeeded');
	});

	it('cancel_job stops an export; wait_for_job then reports it as a tool error; existing files are kept', async () => {
		// Same destination as the finished export above: the engine must never overwrite it.
		const out = join(appdir, 'exports', 'mcp-draft.mp4');
		const sizeBefore = statSync(out).size;
		const job = await ok<{ jobId: string }>('start_export', {
			projectId,
			preset: 'high-quality-h264',
			outputPath: out,
		});
		const cancelled = await call('cancel_job', { jobId: job.jobId });
		expect(cancelled.isError, textOf(cancelled)).toBeFalsy();
		const end = await call('wait_for_job', { jobId: job.jobId, timeoutSeconds: 120 });
		const state = (await ok<{ state: string }>('get_job', { jobId: job.jobId })).state;
		if (state === 'succeeded') {
			// The render won the race against the cancel: it went to a new file next to the old one.
			expect(json<{ result: { path: string } }>(end).result.path).toBe(
				join(appdir, 'exports', 'mcp-draft (2).mp4'),
			);
		} else {
			expect(state).toBe('cancelled');
			expect(end.isError).toBe(true);
			expect(json<{ error: { code: string } }>(end).error.code).toMatch(/CANCEL/i);
		}
		expect(statSync(out).size).toBe(sizeBefore);
		// An unknown job is an actionable error, not a hang.
		expect((await fails('wait_for_job', { jobId: 'job_nope', timeoutSeconds: 5 })).code).toMatch(/NOT_FOUND/);
	});

	it('adds text, markers and motion graphics, and deletes clips', async () => {
		const t = await ok<{ clips: { kind: string; track: string }[] }>('add_text', {
			projectId,
			text: 'Hello from MCP',
			at: 0,
			duration: { seconds: 2 },
			sizePx: 80,
			color: '#ffcc00',
		});
		expect(t.clips[0]).toMatchObject({ kind: 'text', track: 'V2' });
		await ok('add_marker', { projectId, at: '00:00:02:00', name: 'Beat', comment: 'from MCP' });
		const mg = await ok<{ clips: { kind: string; track: string; end: number }[] }>('add_motion_graphic', {
			projectId,
			template: 'lower-third',
			params: { name: 'Jane Doe', title: 'Director' },
			at: 0,
			track: 'V3',
		});
		expect(mg.clips[0]).toMatchObject({ kind: 'motion-graphic', track: 'V3', end: 150 });
		const table = textOf(await call('get_timeline', { projectId }));
		expect(table).toMatch(/text "Hello from MCP"/);
		expect(table).toMatch(/motion graphic lower-third@1/);
		expect(table).toMatch(/00:00:02:00 \(60\) "Beat" mrk_\w+ — from MCP/);
		const p = await ok<{ sequences: { clips: { id: string; kind: string }[] }[] }>('get_project', {
			projectId,
		});
		const textClip = p.sequences[0]!.clips.find((c) => c.kind === 'text')!;
		const del = await ok<{ deleted: string[] }>('delete_clips', { projectId, clipIds: [textClip.id] });
		expect(del.deleted).toContain(textClip.id);
	});

	it('apply_commands: transactions, dry runs and every describe_commands example', async () => {
		const cat = await ok<{ commands: { type: string }[]; exampleTransaction: unknown }>('describe_commands');
		expect(cat.commands.length).toBeGreaterThan(40);
		const full = await ok<{ commands: { type: string; schema: unknown; example?: unknown }[] }>(
			'describe_commands',
			{ types: ['clip.place', 'clip.addText'] },
		);
		expect(full.commands[0]!.schema).toHaveProperty('properties.source');
		expect(full.commands[1]!.example).toEqual(COMMAND_EXAMPLES['clip.addText']);
		// Every example validates against the live project (dry run changes nothing).
		const before = (await ok<{ revision: number }>('get_project', { projectId })).revision;
		for (const [type, example] of Object.entries(COMMAND_EXAMPLES)) {
			const commands =
				type !== 'clip.place' && JSON.stringify(example).includes('$clip')
					? [COMMAND_EXAMPLES['clip.place'], example]
					: [example];
			const r = await call('apply_commands', { projectId, label: `example ${type}`, commands, dryRun: true });
			expect(r.isError, `${type}: ${textOf(r)}`).toBeFalsy();
			expect(json(r)).toMatchObject({ ok: true, dryRun: true });
		}
		const tx = await call('apply_commands', { projectId, ...TRANSACTION_EXAMPLE, dryRun: true });
		expect(tx.isError, textOf(tx)).toBeFalsy();
		expect((await ok<{ revision: number }>('get_project', { projectId })).revision).toBe(before);
		// A real transaction with a temp ref.
		const applied = await ok<{ revision: number; refs: Record<string, string>; created: string[] }>(
			'apply_commands',
			{
				projectId,
				label: 'Solid + marker',
				expectedRevision: before,
				commands: [
					{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [0, 0, 0, 1], ref: '$bg' },
					{ type: 'marker.add', frame: 10, name: 'Solid start' },
				],
			},
		);
		expect(applied.revision).toBe(before + 1);
		expect(applied.created).toContain(applied.refs.$bg);
	});

	it('returns actionable tool errors', async () => {
		const schema = await fails('apply_commands', {
			projectId,
			label: 'bad',
			commands: [{ type: 'clip.move', clipIds: 5 }],
		});
		expect(schema.code).toBe('E_SCHEMA');
		expect(schema.hint).toMatch(/describe_commands/);
		const destructive = await fails('apply_commands', {
			projectId,
			label: 'Remove V3',
			commands: [{ type: 'track.remove', trackIds: ['V3'] }],
		});
		expect(destructive.code).toBe('E_APPROVAL_DENIED');
		expect((await fails('undo', { projectId })).code).toBe('E_NO_SESSION');
		expect((await fails('get_playhead', { projectId })).code).toBe('E_NO_SESSION');
		expect((await fails('set_playhead', { projectId, at: 10 })).code).toBe('E_NO_SESSION');
		const stale = await fails('apply_commands', {
			projectId,
			label: 'stale',
			expectedRevision: 0,
			commands: [{ type: 'marker.update', markerId: { markerByName: 'Beat' }, name: 'Beat 2' }],
		});
		expect(stale.code).toBe('E_REVISION_MISMATCH');
		expect((await fails('get_project', { projectId: 'prj_NOPE' })).code).toMatch(/NOT_FOUND/);
		expect((await fails('add_motion_graphic', { projectId, template: 'nope', at: 0 })).code).toBe(
			'E_NOT_FOUND',
		);
		const noEditor = await ok<{ editorOpen: boolean; url: string; note: string }>('open_project_in_editor', {
			projectId,
			waitSeconds: 0,
		});
		expect(noEditor).toMatchObject({
			editorOpen: false,
			url: `http://127.0.0.1:${PORT}/project/${projectId}`,
		});
	});

	it('serves resources and the edit-video prompt', async () => {
		const tl = await client.readResource({ uri: `jasper://projects/${projectId}/timeline` });
		expect((tl.contents[0] as { text: string }).text).toMatch(/^Sequence "Sequence 01"/);
		const doc = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
		expect(JSON.parse((doc.contents[0] as { text: string }).text).projectId).toBe(projectId);
		const { resources } = await client.listResources();
		expect(resources.map((r) => r.uri)).toContain(`jasper://projects/${projectId}/document`);
		const prompt = await client.getPrompt({ name: 'edit-video', arguments: { goal: 'a teaser', projectId } });
		expect((prompt.messages[0]!.content as { text: string }).text).toMatch(/Task: a teaser/);
	});

	it('lists motion templates and previews one (native renderer permitting)', async () => {
		const cat = await ok<{ renderer: { status: string }; templates: { id: string }[] }>(
			'list_motion_templates',
		);
		expect(cat.templates.map((t) => t.id)).toEqual(expect.arrayContaining(['lower-third', 'title-card']));
		const r = await call('render_motion_graphic_preview', {
			template: 'lower-third@1',
			params: { name: 'MCP' },
		});
		if (cat.renderer.status !== 'ready') {
			expect(json<{ error: { code: string } }>(r).error.code).toBe('RENDERER_UNAVAILABLE');
			return;
		}
		expect(r.isError, textOf(r)).toBeFalsy();
		const img = r.content.find((c) => c.type === 'image') as { data: string } | undefined;
		expect(img).toBeDefined();
		expect(Buffer.from(img!.data, 'base64').readUInt32BE(16)).toBe(960);
		const presets = await ok<{ presets: { id: string }[] }>('list_export_presets');
		expect(presets.presets.map((p) => p.id)).toContain('draft-720p-h264');
	});
});

describe('jasper-mcp --start-engine', () => {
	it('starts a headless engine when none is running and stops it on exit', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-auto-'));
		const c = mcpClient(
			[
				'--appdir',
				dir,
				'--start-engine',
				'--engine-entry',
				join(ROOT, 'apps/engine/src/cli.ts'),
				'--engine-port',
				String(AUTOSTART_PORT),
			],
			// Isolate discovery: no platform/desktop appdir runtime files, no default port probe hit.
			{ XDG_DATA_HOME: join(dir, 'data'), XDG_CONFIG_HOME: join(dir, 'config'), JASPER_ENGINE_URL: '' },
		);
		try {
			await c.client.connect(c.transport);
			const r = (await c.client.callTool({ name: 'engine_status', arguments: {} }, undefined, {
				timeout: 120_000,
			})) as CallToolResult;
			expect(r.isError, `${textOf(r)}\n${c.logs.join('')}`).toBeFalsy();
			const s = json<{ engine: { url: string; foundBy: string } }>(r);
			// A dev engine on 47900 (another checkout) would be found first; only assert when we started ours.
			if (s.engine.foundBy === 'default-port') return;
			expect(s.engine).toMatchObject({ foundBy: 'started', url: `http://127.0.0.1:${AUTOSTART_PORT}` });
			const p = (await c.client.callTool({
				name: 'create_project',
				arguments: { name: 'Auto' },
			})) as CallToolResult;
			expect(p.isError, textOf(p)).toBeFalsy();
			expect(existsSync(join(dir, 'engine', 'runtime.json'))).toBe(true);
		} finally {
			await c.client.close().catch(() => {});
		}
		await waitFor(
			() => !existsSync(join(dir, 'engine', 'runtime.json')),
			15_000,
			'the started engine to stop',
		);
		rmSync(dir, { recursive: true, force: true });
	}, 180_000);
});
