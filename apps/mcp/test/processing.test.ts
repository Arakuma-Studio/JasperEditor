// MCP clip-processing tools end to end (S07 §8 test 10, PRA-001/002): a real engine (temp appdir, private port
// MCP_PROCESSING_TEST_PORT = 48555) and jasper-mcp over stdio. process_clip (denoise, local, replace, wait)
// returns the processed media id and the clip references it; use_media_version switches back;
// get_media_info lists the versions; test_remote_executor without settings is a clear "not configured" error.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
	if (!['clip-a.mp4', 'clip-b.mp4'].every((n) => existsSync(join(FIXTURES, n))))
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
