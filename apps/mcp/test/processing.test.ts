// MCP clip-processing tools end to end (S07 §8 test 10, PRA-001/002): a real engine (temp appdir, private port
// MCP_PROCESSING_TEST_PORT = 48555) and jasper-mcp over stdio. process_clip (denoise, local, replace, wait)
// returns the processed media id and the clip references it; use_media_version switches back;
// get_media_info lists the versions; test_remote_executor without settings is a clear "not configured" error.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures', 'media');
const PORT = Number(process.env.MCP_PROCESSING_TEST_PORT ?? 48555);

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

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

let engine: ChildProcess | null = null;
let appdir = '';
let client: Client;
const logs: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 600_000,
	})) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('')}`);
	return JSON.parse(textOf(r)) as T;
}
async function fails(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	expect(r.isError, `${name} should fail: ${textOf(r)}`).toBe(true);
	return (JSON.parse(textOf(r)) as { error: { code: string; message: string; hint?: string } }).error;
}

beforeAll(async () => {
	if (!['clip-a.mp4', 'clip-b.mp4', 'frame-code.mp4'].every((n) => existsSync(join(FIXTURES, n))))
		spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
	appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-proc-'));
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{ cwd: ROOT, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
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
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), '--appdir', appdir],
		cwd: ROOT,
		env: cleanEnv(),
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
	client = new Client({ name: 'vitest-mcp-processing', version: '1.0.0' });
	await client.connect(transport);
}, 180_000);

afterAll(async () => {
	await client?.close().catch(() => {});
	if (engine && engine.exitCode === null) {
		const exited = new Promise((r) => engine!.once('exit', r));
		engine.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
	}
	if (appdir) rmSync(appdir, { recursive: true, force: true });
}, 30_000);

describe('clip-processing MCP tools', () => {
	let projectId = '';
	let mediaId = '';
	let clipId = '';

	it('advertises the processing tools and guide', async () => {
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		for (const n of [
			'list_processing_models',
			'install_processing_model',
			'process_clip',
			'use_media_version',
			'get_processing_settings',
			'set_processing_settings',
			'test_remote_executor',
			'replace_footage',
			'set_media_source_range',
		])
			expect(names).toContain(n);
		expect(tools.find((t) => t.name === 'set_processing_settings')!.annotations?.destructiveHint).toBe(true);
		expect(client.getInstructions()).toMatch(/process_clip/);
	});

	it('lists the bundled SPAN model with its licence', async () => {
		const r = await ok<{
			models: Array<{ id: string; installed: boolean; license: string; attribution: string }>;
		}>('list_processing_models');
		const span = r.models.find((m) => m.id === 'span-2x-nomosuni-multijpg')!;
		expect(span.installed).toBe(true);
		expect(span.license).toBe('CC-BY-4.0');
		expect(span.attribution).toMatch(/Philip Hofmann/);
	});

	it('test_remote_executor without settings is a clear "not configured" error', async () => {
		const e = await fails('test_remote_executor');
		expect(e.code).toBe('REMOTE_NOT_CONFIGURED');
		expect(e.message).toMatch(/not configured/i);
		expect((await ok<{ remote: unknown }>('get_processing_settings')).remote).toBeNull();
	});

	it('set_processing_settings needs the user in an open editor', async () => {
		const p = await ok<{ projectId: string }>('create_project', { name: 'MCP processing' });
		projectId = p.projectId;
		const e = await fails('set_processing_settings', {
			projectId,
			remote: { enabled: true, host: 'gpu.example', user: 'me', remoteDir: '/srv/jasper' },
		});
		expect(e.code).toBe('E_NO_SESSION');
		expect((await ok<{ remote: unknown }>('get_processing_settings')).remote).toBeNull();
	});

	it('process_clip (denoise, local, replace, wait) swaps the clip to the processed version', async () => {
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [join(FIXTURES, 'clip-b.mp4')],
		});
		mediaId = imp.imported[0]!.mediaId;
		const add = await ok<{ clips: { id: string; track: string }[] }>('add_clip', {
			projectId,
			media: mediaId,
			at: 0,
		});
		clipId = add.clips.find((c) => c.track.startsWith('V'))!.id;
		const r = await ok<{
			processedMediaId: string;
			replacedClips: string[];
			executor: string;
			state: string;
		}>('process_clip', {
			projectId,
			clipId,
			steps: [{ op: 'denoise', method: 'atadenoise', strength: 0.4 }],
			executor: 'local',
			replace: true,
			wait: true,
		});
		expect(r.state).toBe('succeeded');
		expect(r.executor).toBe('local');
		expect(r.processedMediaId).toMatch(/^med_/);
		expect(r.replacedClips).toEqual([clipId]);
		const timeline = await call('get_timeline', { projectId });
		expect(textOf(timeline)).toMatch(/Denoised/);
		const info = await ok<{
			derivation: { fromMediaId: string } | null;
			versions: { mediaId: string; original: boolean }[];
		}>('get_media_info', { projectId, mediaId: r.processedMediaId });
		expect(info.derivation?.fromMediaId).toBe(mediaId);
		expect(info.versions.map((v) => v.mediaId)).toEqual([mediaId, r.processedMediaId]);
		expect(info.versions[0]!.original).toBe(true);
		// Back to the original.
		await ok('use_media_version', { projectId, clipIds: [clipId], mediaId });
		expect(textOf(await call('get_timeline', { projectId }))).not.toMatch(/Denoised/);
	}, 600_000);
});

// M3 (wp-m3-inpoint, S07:PRA-003): source ranges over MCP.
describe('source ranges (process_clip handles, use_media_version fit, sidecars, replace_footage)', () => {
	let projectId = '';
	let codeId = '';
	let clipId = '';
	let versionId = '';
	type Clip = { id: string; mediaId?: string; sourceIn: number; start: number; duration: number };
	const F = 23_520_000; // flicks per frame at 30 fps

	/** A clip from get_timeline's table: "start–end frames" and "name [med_…] a–b s" → media id and sourceIn. */
	async function clip(id: string): Promise<Clip> {
		const table = textOf(await call('get_timeline', { projectId }));
		const row = table.split('\n').find((l) => l.split(' | ')[1] === id);
		if (!row) throw new Error(`clip ${id} not in the timeline:\n${table}`);
		const cells = row.split(' | ');
		const [a, b] = cells[5]!.split('–').map(Number) as [number, number];
		const m = /\[(med_\w+)\] ([\d.]+)–/.exec(cells[6]!);
		return {
			id,
			mediaId: m?.[1],
			sourceIn: Math.round(Number(m?.[2]) * 30) * F,
			start: a,
			duration: b - a,
		};
	}

	it('process_clip with handles processes only the clip range (+ handles) and keeps the source frames', async () => {
		projectId = (await ok<{ projectId: string }>('create_project', { name: 'MCP ranges' })).projectId;
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [join(FIXTURES, 'frame-code.mp4')],
		});
		codeId = imp.imported[0]!.mediaId;
		const add = await ok<{ clips: { id: string; track: string }[] }>('add_clip', {
			projectId,
			media: codeId,
			at: 0,
			sourceInFrame: 20,
			sourceOutFrame: 40,
			videoOnly: true,
		});
		clipId = add.clips[0]!.id;
		const r = await ok<{
			processedMediaId: string;
			range: { startFrame: number; endFrame: number };
			sourceFrames: { of: string; start: number; end: number };
			replacedClips: string[];
		}>('process_clip', {
			projectId,
			clipId,
			steps: [{ op: 'deblock', filter: 'weak' }],
			executor: 'local',
			handles: 6,
			replace: true,
			wait: true,
		});
		versionId = r.processedMediaId;
		expect(r.range).toEqual({ startFrame: 14, endFrame: 46 });
		expect(r.sourceFrames).toEqual({ of: codeId, start: 14, end: 46 });
		expect(r.replacedClips).toEqual([clipId]);
		const c = await clip(clipId);
		expect(c.mediaId).toBe(versionId);
		expect([c.start, c.duration, c.sourceIn]).toEqual([0, 20, 6 * F]);
		const info = await ok<{
			sourceRange: { firstFrame: number; frames: number } | null;
			versions: { mediaId: string; sourceFrames?: { start: number; end: number } }[];
		}>('get_media_info', { projectId, mediaId: versionId });
		expect(info.sourceRange).toMatchObject({ firstFrame: 14, frames: 32 });
		expect(info.versions).toEqual([
			expect.objectContaining({ mediaId: codeId, sourceFrames: { start: 0, end: 64 } }),
			expect.objectContaining({ mediaId: versionId, sourceFrames: { start: 14, end: 46 } }),
		]);
		// Back to the original: the in-point is the original's again.
		await ok('use_media_version', { projectId, clipIds: [clipId], mediaId: codeId });
		expect((await clip(clipId)).sourceIn).toBe(20 * F);
	}, 600_000);

	it('use_media_version refuses a version that does not cover a clip, or trims with fit: "trim"', async () => {
		const add = await ok<{ clips: { id: string }[] }>('add_clip', {
			projectId,
			media: codeId,
			at: 100,
			sourceInFrame: 0,
			sourceOutFrame: 30,
			videoOnly: true,
		});
		const wide = add.clips[0]!.id;
		const e = await fails('use_media_version', { projectId, clipIds: [wide], mediaId: versionId });
		expect(e.code).toBe('E_OUT_OF_MEDIA');
		expect(e.message).toMatch(
			/holds frames 14–45 of frame-code\.mp4; clip clp_\w+ shows frames 0–29 \(14 before its first frame\)/,
		);
		const r = await ok<{ clips: { clipId: string; trimmed?: { head: number; tail: number } }[] }>(
			'use_media_version',
			{
				projectId,
				clipIds: [wide],
				mediaId: versionId,
				fit: 'trim',
			},
		);
		expect(r.clips[0]!.trimmed).toEqual({ head: 14, tail: 0 });
		const c = await clip(wide);
		expect([c.start, c.duration, c.sourceIn]).toEqual([114, 16, 0]);
	}, 120_000);

	it('import_media links a render with a sidecar to its source; set_media_source_range; replace_footage keeps timing', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-sidecar-'));
		try {
			const render = join(dir, 'grade.mp4');
			copyFileSync(join(FIXTURES, 'clip-a.mp4'), render);
			writeFileSync(
				join(dir, 'grade.json'),
				JSON.stringify({ first_src_frame: 5, source: 'frame-code.mp4' }),
			);
			const imp = await ok<{
				imported: { mediaId: string; sourceRange?: { mediaId: string; firstFrame: number } }[];
			}>('import_media', { projectId, paths: [render] });
			const gradeId = imp.imported[0]!.mediaId;
			expect(imp.imported[0]!.sourceRange).toMatchObject({ mediaId: codeId, firstFrame: 5 });
			const info = await ok<{ versions: { mediaId: string }[] }>('get_media_info', {
				projectId,
				mediaId: codeId,
			});
			expect(info.versions.map((v) => v.mediaId)).toEqual([codeId, versionId, gradeId]);
			await ok('use_media_version', { projectId, clipIds: [clipId], mediaId: gradeId });
			expect((await clip(clipId)).sourceIn).toBe(15 * F);
			// Declared by hand: grade.mp4 starts at frame 10 instead. Re-declaring moves no clip, so the clip (at
			// grade frame 15) now stands for source frame 25 and goes back to the original there.
			await ok('set_media_source_range', {
				projectId,
				mediaId: gradeId,
				sourceMediaId: codeId,
				firstFrame: 10,
			});
			await ok('use_media_version', { projectId, clipIds: [clipId], mediaId: codeId });
			expect((await clip(clipId)).sourceIn).toBe(25 * F);

			// replace_footage: the frame-code clips' media becomes a render starting at source frame 12.
			const replacement = join(dir, 'frame-code-graded.mp4');
			copyFileSync(join(FIXTURES, 'clip-a.mp4'), replacement);
			writeFileSync(
				join(dir, 'frame-code-graded.json'),
				JSON.stringify({ first_src_frame: 12, frames: 300, source: 'frame-code.mp4' }),
			);
			const rep = await ok<{ shiftFrames: number; basis: string; clipIds: string[]; sidecar: string }>(
				'replace_footage',
				{
					projectId,
					mediaId: codeId,
					path: replacement,
					fit: 'trim',
				},
			);
			expect(rep).toMatchObject({
				shiftFrames: -12,
				basis: 'range-of-current',
				sidecar: 'frame-code-graded.json',
			});
			expect((await clip(clipId)).sourceIn).toBe(13 * F);
			const e = await fails('replace_footage', { projectId, mediaId: versionId, path: replacement });
			expect(e.message).toMatch(/processed version/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 300_000);
});
