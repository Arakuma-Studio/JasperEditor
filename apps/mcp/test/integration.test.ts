// The stdio MCP client drives a token-protected engine through a real edit and export.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.MCP_TEST_PORT ?? 48551);
const AUTOSTART_PORT = Number(process.env.MCP_TEST_AUTOSTART_PORT ?? PORT + 1);
const fixture = join(ROOT, 'fixtures', 'media', 'clip-a.mp4');

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined && !key.startsWith('JASPER_')) env[key] = value;
	return { ...env, ...extra };
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, description: string) {
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		if (
			await Promise.resolve()
				.then(check)
				.catch(() => false)
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`timed out waiting for ${description}`);
}

function connect(args: string[], env: Record<string, string> = {}) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), ...args],
		cwd: ROOT,
		env: cleanEnv(env),
		stderr: 'pipe',
	});
	const logs: string[] = [];
	transport.stderr?.on('data', (data: Buffer) => logs.push(data.toString('utf8')));
	return { client: new Client({ name: 'vitest-mcp', version: '1.0.0' }), transport, logs };
}

function textOf(result: CallToolResult): string {
	return (result.content.find((part) => part.type === 'text') as { text: string } | undefined)?.text ?? '';
}
function json<T>(result: CallToolResult): T {
	return JSON.parse(textOf(result)) as T;
}

let engine: ChildProcess | null = null;
let appdir = '';
let token = '';
let session: ReturnType<typeof connect>;
let projectId = '';

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await session.client.callTool({ name, arguments: args }, undefined, {
		timeout: 300_000,
	})) as CallToolResult;
}
async function ok<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const result = await call(name, args);
	if (result.isError) throw new Error(`${name}: ${textOf(result)}\n${session.logs.join('')}`);
	return json<T>(result);
}

beforeAll(async () => {
	if (!existsSync(fixture)) {
		const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], {
			stdio: 'inherit',
		});
		if (result.status !== 0) throw new Error('fixture generation failed');
	}
	appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-it-'));
	token = randomBytes(16).toString('hex');
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{ cwd: ROOT, env: cleanEnv({ JASPER_LOCAL_TOKEN: token }), stdio: ['ignore', 'pipe', 'pipe'] },
	);
	const logs: string[] = [];
	engine.stdout?.on('data', (data: Buffer) => logs.push(data.toString()));
	engine.stderr?.on('data', (data: Buffer) => logs.push(data.toString()));
	await waitFor(
		async () =>
			existsSync(join(appdir, 'engine', 'runtime.json')) &&
			(await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
		90_000,
		`engine on ${PORT}: ${logs.join('')}`,
	);
	expect((await fetch(`http://127.0.0.1:${PORT}/api/projects`)).status).toBe(401);
	session = connect(['--appdir', appdir]);
	await session.client.connect(session.transport);
}, 180_000);

afterAll(async () => {
	await session?.client.close().catch(() => {});
	if (engine && engine.exitCode === null) {
		const exited = new Promise((resolve) => engine!.once('exit', resolve));
		engine.kill('SIGTERM');
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))]);
	}
	if (appdir) rmSync(appdir, { recursive: true, force: true });
}, 30_000);

describe('MCP over stdio with a token-protected engine', () => {
	it('discovers the engine, edits media, renders a frame, and exports a playable video', async () => {
		const status = await ok<{ engine: { url: string; foundBy: string } }>('engine_status');
		expect(status.engine).toMatchObject({
			url: `http://127.0.0.1:${PORT}`,
			foundBy: 'runtime-file',
		});
		projectId = (await ok<{ projectId: string }>('create_project', { name: 'MCP integration' })).projectId;
		const imported = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [fixture],
		});
		expect(imported.imported).toHaveLength(1);
		const added = await ok<{ clips: { id: string; track: string; start: number; end: number }[] }>(
			'add_clip',
			{ projectId, media: 'clip-a.mp4', at: 0, sourceOut: 1 },
		);
		expect(added.clips.map((clip) => [clip.track, clip.start, clip.end])).toEqual([
			['V1', 0, 30],
			['A1', 0, 30],
		]);
		const frame = await call('render_frame', { projectId, at: { seconds: 0.5 }, width: 320 });
		expect(frame.isError, textOf(frame)).toBeFalsy();
		const image = frame.content.find((part) => part.type === 'image') as
			| { mimeType: string; data: string }
			| undefined;
		expect(image?.mimeType).toBe('image/png');
		const png = Buffer.from(image!.data, 'base64');
		expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
		expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([320, 180]);

		const output = join(appdir, 'exports', 'mcp-draft.mp4');
		const job = await ok<{ jobId: string }>('start_export', {
			projectId,
			preset: 'draft-720p-h264',
			outputPath: output,
		});
		const done = await ok<{ state: string; result: { path: string } }>('wait_for_job', {
			jobId: job.jobId,
			timeoutSeconds: 240,
		});
		expect(done).toMatchObject({ state: 'succeeded', result: { path: output } });
		expect(existsSync(output)).toBe(true);
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
				output,
			],
			{ encoding: 'utf8' },
		);
		expect(probe.status, probe.stderr).toBe(0);
		const stream = JSON.parse(probe.stdout).streams[0];
		expect([stream.width, stream.height, Number(stream.nb_read_frames)]).toEqual([1280, 720, 30]);
	}, 300_000);

	it('keeps the engine token out of MCP responses and stderr', async () => {
		for (const response of [
			await call('engine_status'),
			await call('list_projects'),
			await call('get_project', { projectId: 'prj_NOPE' }),
		])
			expect(textOf(response)).not.toContain(token);
		expect(session.logs.join('')).not.toContain(token);
	});

	it('serves project resources and the edit-video prompt through MCP', async () => {
		const doc = await session.client.readResource({ uri: `jasper://projects/${projectId}/document` });
		expect(JSON.parse((doc.contents[0] as { text: string }).text).projectId).toBe(projectId);
		const prompt = await session.client.getPrompt({
			name: 'edit-video',
			arguments: { goal: 'a teaser', projectId },
		});
		expect((prompt.messages[0]!.content as { text: string }).text).toContain('a teaser');
	});

	it('dry runs leave the project unchanged and destructive edits require approval', async () => {
		const before = (await ok<{ revision: number }>('get_project', { projectId })).revision;
		const dry = await ok<{ ok: boolean; dryRun: boolean }>('apply_commands', {
			projectId,
			label: 'Preview marker',
			commands: [{ type: 'marker.add', frame: 10, name: 'Beat' }],
			dryRun: true,
		});
		expect(dry).toMatchObject({ ok: true, dryRun: true });
		expect((await ok<{ revision: number }>('get_project', { projectId })).revision).toBe(before);
		const denied = await call('apply_commands', {
			projectId,
			label: 'Remove V3',
			commands: [{ type: 'track.remove', trackIds: ['V3'] }],
		});
		expect(denied.isError).toBe(true);
		expect(json<{ error: { code: string } }>(denied).error.code).toBe('E_APPROVAL_DENIED');
	});

	it('creates, edits, applies defaults, and removes transitions through MCP', async () => {
		const clips = (
			await ok<{ sequences: { clips: { id: string; track: string; start: number }[] }[] }>('get_project', {
				projectId,
			})
		).sequences[0]!.clips;
		const first = clips.find((clip) => clip.track === 'V1' && clip.start === 0)!;
		await ok('add_clip', { projectId, media: 'clip-a.mp4', at: 30, sourceIn: 1, sourceOut: 2 });
		const created = await ok<{ results: { transitionId: string }[] }>('add_transition', {
			projectId,
			track: 'V1',
			at: 30,
			type: 'cross-dissolve',
			durationFrames: 10,
		});
		const id = created.results[0]!.transitionId;
		const list = () =>
			ok<{ transitions: { id: string; type: string; duration: number }[] }>('list_transitions', {
				projectId,
			});
		expect((await list()).transitions).toEqual([
			expect.objectContaining({ id, type: 'cross-dissolve', duration: 10 }),
		]);
		await ok('update_transition', { projectId, transitionId: id, effectId: 'dip-to-black', duration: 20 });
		expect((await list()).transitions).toEqual([
			expect.objectContaining({ id, type: 'dip-to-black', duration: 20 }),
		]);
		await ok('remove_transitions', { projectId, transitionIds: [id] });
		expect((await list()).transitions).toEqual([]);
		await ok('apply_default_transitions', { projectId, clipIds: [first.id], media: ['video'] });
		const defaults = (await list()).transitions;
		expect(defaults.some((transition) => transition.type === 'cross-dissolve')).toBe(true);
		await ok('remove_transitions', { projectId, transitionIds: defaults.map((transition) => transition.id) });
	});

	it('persists text animation changes and returns a PNG contact sheet', async () => {
		const sheet = await call('render_frames', { projectId, times: [0, 15, 29], width: 160 });
		expect(sheet.isError, textOf(sheet)).toBeFalsy();
		expect(json<{ cells: { frame: number }[] }>(sheet).cells.map((cell) => cell.frame)).toEqual([0, 15, 29]);
		const image = sheet.content.find((part) => part.type === 'image') as { mimeType: string; data: string };
		expect(image.mimeType).toBe('image/png');
		expect(Buffer.from(image.data, 'base64').subarray(1, 4).toString('latin1')).toBe('PNG');
		const added = await ok<{ clips: { id: string }[] }>('add_text', {
			projectId,
			text: 'Animated title',
			at: 0,
			duration: { seconds: 2 },
			animateIn: 'slide-up',
		});
		const clipId = added.clips[0]!.id;
		await ok('set_text_animation', { projectId, clipId, out: { preset: 'fade', durationFrames: 15 } });
		const resource = await session.client.readResource({ uri: `jasper://projects/${projectId}/document` });
		const sequences = JSON.parse((resource.contents[0] as { text: string }).text).sequences as Record<
			string,
			{
				clips: Record<
					string,
					{ textAnimation?: { in?: { preset: string }; out?: { preset: string; durationFrames: number } } }
				>;
			}
		>;
		expect(Object.values(sequences)[0]!.clips[clipId]!.textAnimation).toMatchObject({
			in: { preset: 'slide-up' },
			out: { preset: 'fade', durationFrames: 15 },
		});
		const fasterProject = (
			await ok<{ projectId: string }>('create_project', {
				name: '50 fps animation',
				preset: 'hd-1080p-50',
			})
		).projectId;
		const fasterClip = (
			await ok<{ clips: { id: string }[] }>('add_text', {
				projectId: fasterProject,
				text: '50 fps',
				at: 0,
				duration: { seconds: 2 },
			})
		).clips[0]!.id;
		await ok('set_text_animation', {
			projectId: fasterProject,
			clipId: fasterClip,
			in: { preset: 'fade', durationSeconds: 1 },
		});
		const fasterDoc = await session.client.readResource({
			uri: `jasper://projects/${fasterProject}/document`,
		});
		const fasterSequences = JSON.parse((fasterDoc.contents[0] as { text: string }).text).sequences as Record<
			string,
			{ clips: Record<string, { textAnimation?: { in?: { durationFrames: number } } }> }
		>;
		expect(Object.values(fasterSequences)[0]!.clips[fasterClip]!.textAnimation?.in?.durationFrames).toBe(50);
	});

	it('stores a shape with the requested geometry and rejects invalid ellipse corners', async () => {
		const added = await ok<{ clips: { id: string }[] }>('add_shape', {
			projectId,
			type: 'rect',
			at: 0,
			track: 'V3',
			size: [640, 160],
			fill: '#202020cc',
			cornerRadius: 24,
		});
		const resource = await session.client.readResource({ uri: `jasper://projects/${projectId}/document` });
		const sequences = JSON.parse((resource.contents[0] as { text: string }).text).sequences as Record<
			string,
			{ clips: Record<string, { shape?: { type: string; size: unknown; cornerRadius: unknown } }> }
		>;
		expect(Object.values(sequences)[0]!.clips[added.clips[0]!.id]!.shape).toMatchObject({
			type: 'rect',
			size: { value: [640, 160] },
			cornerRadius: { value: 24 },
		});
		const invalid = await call('add_shape', { projectId, type: 'ellipse', at: 0, cornerRadius: 5 });
		expect(invalid.isError).toBe(true);
		expect(json<{ error: { code: string } }>(invalid).error.code).toBe('E_INVALID_PARAM');
	});
});

describe('jasper-mcp --start-engine', () => {
	it('starts an engine and stops it when the MCP client closes', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-auto-'));
		const started = connect(
			[
				'--appdir',
				dir,
				'--start-engine',
				'--engine-entry',
				join(ROOT, 'apps/engine/src/cli.ts'),
				'--engine-port',
				String(AUTOSTART_PORT),
			],
			{ XDG_DATA_HOME: join(dir, 'data'), XDG_CONFIG_HOME: join(dir, 'config'), JASPER_ENGINE_URL: '' },
		);
		try {
			await started.client.connect(started.transport);
			const result = (await started.client.callTool({ name: 'engine_status', arguments: {} }, undefined, {
				timeout: 120_000,
			})) as CallToolResult;
			expect(result.isError, `${textOf(result)}\n${started.logs.join('')}`).toBeFalsy();
			expect(json<{ engine: { url: string; foundBy: string } }>(result).engine).toMatchObject({
				foundBy: 'started',
				url: `http://127.0.0.1:${AUTOSTART_PORT}`,
			});
			expect(existsSync(join(dir, 'engine', 'runtime.json'))).toBe(true);
		} finally {
			await started.client.close().catch(() => {});
			try {
				await waitFor(() => !existsSync(join(dir, 'engine', 'runtime.json')), 15_000, 'engine shutdown');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	}, 180_000);
});
