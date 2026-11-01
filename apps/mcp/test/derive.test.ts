// spec 18 AF-OPS-002: derive_media against a real engine (LGPL-only mode) with lavfi-generated media.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, stopEngine, testPort, waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const PORT = await testPort(process.env.MCP_DERIVE_TEST_PORT);
const FLICKS = 705_600_000;

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

let engine: ChildProcess | null = null;
let appdir = '';
let dir = '';
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

function ff(args: string[]) {
	const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(r.stderr);
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-derive-'));
	ff([
		...['-f', 'lavfi', '-i', 'testsrc=s=96x64:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2'],
		...['-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-f', 'mov', join(dir, 'take.mov')],
	]);
	ff(['-f', 'lavfi', '-i', 'testsrc=s=96x64:r=25:d=1', '-c:v', 'ffv1', join(dir, 'silent.mkv')]);
	appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-derive-app-'));
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{ cwd: ROOT, env: cleanEnv({ JASPER_FFMPEG_LGPL_ONLY: '1' }), stdio: ['ignore', 'pipe', 'pipe'] },
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
	client = new Client({ name: 'vitest-mcp-derive', version: '1.0.0' });
	await client.connect(transport);
}, 180_000);

afterAll(async () => {
	await client?.close().catch(() => {});
	await stopEngine(engine);
	if (appdir) rmSync(appdir, { recursive: true, force: true });
	if (dir) rmSync(dir, { recursive: true, force: true });
}, 30_000);

describe('derive_media (AF-OPS-002)', { timeout: 300_000 }, () => {
	let projectId = '';
	let mediaId = '';
	let silentId = '';

	it('is advertised as an idempotent edit with the recipe schema', async () => {
		const { tools } = await client.listTools();
		const t = tools.find((x) => x.name === 'derive_media');
		expect(t?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
		});
		expect(JSON.stringify(t?.inputSchema)).toContain('time-stretch');
	});

	it('reverses a media into the bin "Processed" (one transaction; reused when asked again)', async () => {
		projectId = (await ok<{ projectId: string }>('create_project', { name: 'MCP derive' })).projectId;
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [join(dir, 'take.mov'), join(dir, 'silent.mkv')],
		});
		mediaId = imp.imported[0]!.mediaId;
		silentId = imp.imported[1]!.mediaId;
		const r = await ok<{
			derivedMediaId: string;
			op: string;
			streams: string[];
			durationSec: number;
			reused: boolean;
			notes: string[];
		}>('derive_media', { projectId, mediaId, recipe: { op: 'reverse' } });
		expect(r.op).toBe('reverse');
		expect(r.derivedMediaId).toMatch(/^med_/);
		expect(r.streams).toEqual(['video', 'audio']);
		expect(Math.abs(r.durationSec - 2)).toBeLessThan(0.05);
		expect(r.notes[0]).toContain('reversed in 1 segment');
		const info = await ok<{ derivation: { fromMediaId: string; recipe: { op: string } } | null }>(
			'get_media_info',
			{ projectId, mediaId: r.derivedMediaId },
		);
		expect(info.derivation).toMatchObject({ fromMediaId: mediaId, recipe: { op: 'reverse' } });
		// Undo needs an editor session (history is per session; covered by the web dialog test). Again: the finished
		// file is reused and the derivation is not added twice.
		const again = await ok<{ reused: boolean; derivedMediaId: string }>('derive_media', {
			projectId,
			mediaId,
			recipe: { op: 'reverse' },
		});
		expect(again.derivedMediaId).toBe(r.derivedMediaId);
		expect(again.reused).toBe(true);
	});

	it('extracts an audio stream and makes a frame-accurate range', async () => {
		const ex = await ok<{ derivedMediaId: string; streams: string[]; name: string }>('derive_media', {
			projectId,
			mediaId,
			recipe: { op: 'extract-audio', streamIndex: 1, format: 'flac' },
		});
		expect(ex.streams).toEqual(['audio']);
		expect(ex.name).toBe('take [Audio stream 1].flac');
		const rg = await ok<{ sourceFrames: { startFrame: number; endFrame: number }; durationSec: number }>(
			'derive_media',
			{ projectId, mediaId, recipe: { op: 'range', inFlicks: FLICKS / 2, outFlicks: FLICKS } },
		);
		expect(rg.sourceFrames).toEqual({ startFrame: 13, endFrame: 25 });
		expect(Math.abs(rg.durationSec - 12 / 25)).toBeLessThan(0.01);
	});

	it('refuses with coded errors', async () => {
		expect(
			(
				await fails('derive_media', {
					projectId,
					mediaId: silentId,
					recipe: { op: 'denoise-audio', strength: 0.5 },
				})
			).code,
		).toBe('NO_AUDIO');
		expect(
			(
				await fails('derive_media', {
					projectId,
					mediaId,
					recipe: { op: 'time-stretch', rate: 9, preservePitch: true },
				})
			).code,
		).toBe('UNSUPPORTED_RATE');
		expect(
			(
				await fails('derive_media', {
					projectId,
					mediaId,
					recipe: { op: 'range', inFlicks: 0, outFlicks: 9 * FLICKS },
				})
			).code,
		).toBe('OUT_OF_RANGE');
		expect(
			(
				await fails('derive_media', {
					projectId,
					mediaId,
					recipe: { op: 'reverse' },
					replaceInClips: ['clp_x'],
				})
			).code,
		).toBe('E_INVALID_PARAM');
	});
});
