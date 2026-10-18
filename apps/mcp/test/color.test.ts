import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedEngineLink } from '../src/link.ts';
import { createJasperMcpServer } from '../src/server.ts';
import { cleanEnv, testPort } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures', 'media');

const PORT = await testPort(process.env.MCP_COLOR_TEST_PORT);
const URL_BASE = `http://127.0.0.1:${PORT}`;

function ensureFixtures(): void {
	if (
		['clip-a.mp4', 'clip-b.mp4', 'look-33.cube', 'broken-number.cube'].every((n) =>
			existsSync(join(FIXTURES, n)),
		)
	)
		return;
	const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
	if (r.status !== 0) throw new Error('fixture generation failed');
}

function pngPixels(png: Buffer): Buffer {
	const r = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
		{
			input: png,
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (r.status !== 0) throw new Error(`ffmpeg could not decode the PNG: ${r.stderr}`);
	return r.stdout;
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
	expect(a.length).toBe(b.length);
	let s = 0;
	for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
	return s / a.length;
}

/** doc.changed events of a project while `fn` runs (engine NDJSON /events stream). */
async function docChangedDuring(token: string, projectId: string, fn: () => Promise<unknown>) {
	const ac = new AbortController();
	const res = await fetch(`${URL_BASE}/events?projectId=${projectId}`, {
		headers: { authorization: `Bearer ${token}` },
		signal: ac.signal,
	});
	const reader = res.body!.getReader();
	const events: { type: string; payload: { label?: string; revision?: number } }[] = [];
	let buf = '';
	let ready!: () => void;
	const opened = new Promise<void>((r) => {
		ready = r;
	});
	const pump = (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buf += Buffer.from(value).toString('utf8');
				let i = buf.indexOf('\n');
				while (i >= 0) {
					const line = buf.slice(0, i);
					buf = buf.slice(i + 1);
					if (line.trim()) {
						const e = JSON.parse(line);
						if (e.type === 'engine.heartbeat') ready();
						else events.push(e);
					}
					i = buf.indexOf('\n');
				}
			}
		} catch {
			// aborted
		}
	})();
	await Promise.race([
		opened,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`no /events stream (HTTP ${res.status})`)), 15_000),
		),
	]);
	await fn();
	await new Promise((r) => setTimeout(r, 500));
	ac.abort();
	await pump;
	return events.filter((e) => e.type === 'doc.changed');
}

let engine: ChildProcess | null = null;
let appdir = '';
let token = '';
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 300_000,
	})) as CallToolResult;
}
const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
	return JSON.parse(textOf(r)) as T;
}
async function fails(name: string, args: Record<string, unknown>) {
	const r = await call(name, args);
	expect(r.isError, `${name} should fail: ${textOf(r)}`).toBe(true);
	return (JSON.parse(textOf(r)) as { error: { code: string; message: string; hint?: string } }).error;
}
async function frameAt(projectId: string, frame: number, artifact?: string): Promise<Buffer> {
	const r = await call('render_frame', { projectId, at: frame, width: 320 });
	expect(r.isError, textOf(r)).toBeFalsy();
	const img = r.content.find((c) => c.type === 'image') as { data: string };
	const png = Buffer.from(img.data, 'base64');
	if (artifact) {
		const artifacts = join(ROOT, 'test-results', 'mcp');
		mkdirSync(artifacts, { recursive: true });
		writeFileSync(join(artifacts, artifact), png);
	}
	return pngPixels(png);
}

describe('colour tools against a real engine (S06 §9 test 8)', () => {
	beforeAll(async () => {
		ensureFixtures();
		appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-color-'));
		token = randomBytes(16).toString('hex');
		engine = spawn(
			process.execPath,
			['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
			{ cwd: ROOT, env: cleanEnv({ JASPER_LOCAL_TOKEN: token }), stdio: ['ignore', 'pipe', 'pipe'] },
		);
		const log: string[] = [];
		engine.stdout?.on('data', (d: Buffer) => log.push(d.toString()));
		engine.stderr?.on('data', (d: Buffer) => log.push(d.toString()));
		const until = Date.now() + 120_000;
		for (;;) {
			const up = await fetch(`${URL_BASE}/health`)
				.then((r) => r.ok)
				.catch(() => false);
			if (up) break;
			if (Date.now() > until || engine.exitCode !== null)
				throw new Error(`engine did not start: ${log.join('')}`);
			await new Promise((r) => setTimeout(r, 250));
		}
		const { server } = createJasperMcpServer({
			link: new FixedEngineLink(URL_BASE, token),
			agentName: 'color-test',
		});
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		client = new Client({ name: 'color-test', version: '1' });
		await client.connect(b);
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

	let projectId = '';
	let clipA = '';
	let clipB = '';
	let lutId = '';
	let gradeFx = '';

	it('imports a .cube LUT and reports the broken one with its line number', async () => {
		const p = await ok<{ projectId: string }>('create_project', { name: 'Colour MCP' });
		projectId = p.projectId;
		const media = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [join(FIXTURES, 'clip-a.mp4'), join(FIXTURES, 'clip-b.mp4')],
		});
		const placeA = await ok<{ clips: { id: string; kind: string }[] }>('add_clip', {
			projectId,
			media: media.imported[0]!.mediaId,
			at: 0,
			videoOnly: true,
		});
		clipA = placeA.clips.find((c) => c.kind === 'video')!.id;
		const placeB = await ok<{ clips: { id: string; kind: string }[] }>('add_clip', {
			projectId,
			media: media.imported[1]!.mediaId,
			at: 300,
			videoOnly: true,
		});
		clipB = placeB.clips.find((c) => c.kind === 'video')!.id;

		const lut = await ok<{ mediaId: string; size: number; title: string; dimensions: number }>('import_lut', {
			projectId,
			path: join(FIXTURES, 'look-33.cube'),
		});
		expect(lut).toMatchObject({ size: 33, dimensions: 3, title: 'Warm Teal 33' });
		expect(lut.mediaId).toMatch(/^med_/);
		lutId = lut.mediaId;

		const bad = await fails('import_lut', { projectId, path: join(FIXTURES, 'broken-number.cube') });
		expect(bad.code).toBe('INVALID_LUT');
		expect(bad.message).toMatch(/line \d+/i);
		expect((await fails('import_lut', { projectId, path: 'relative.cube' })).code).toBe('NOT_ABSOLUTE');
		expect((await fails('import_lut', { projectId, path: join(FIXTURES, 'still.png') })).code).toBe(
			'NOT_A_LUT',
		);
	});

	it('grade_clip grades in one Agent change and render_frame shows it', async () => {
		const before = await frameAt(projectId, 30);
		let res: Record<string, unknown> = {};
		const changes = await docChangedDuring(token, projectId, async () => {
			res = await ok('grade_clip', {
				projectId,
				clipId: clipA,
				basic: { exposure: 0.8, temperature: 40, contrast: 20, saturation: 140 },
				creative: { look: lutId, intensity: 80 },
				curves: {
					master: [
						[0, 0.05],
						[0.5, 0.55],
						[1, 1],
					],
				},
				wheels: { shadows: [0.4, 0], highlightsLevel: 10 },
			});
		});
		expect(changes).toHaveLength(1);
		gradeFx = res.effectInstanceId as string;

		const after = await frameAt(projectId, 30, 'color-graded.png');
		expect(meanAbsDiff(before, after)).toBeGreaterThan(8);

		const changes2 = await docChangedDuring(token, projectId, async () => {
			res = await ok('grade_clip', { projectId, clipId: clipA, basic: { exposure: 12 } });
		});
		expect(changes2).toHaveLength(1);
		expect(res).toMatchObject({ effectInstanceId: gradeFx, applied: { basic: { exposure: 5 } } });
		await ok('grade_clip', { projectId, clipId: clipA, basic: { exposure: 0.8 } });
		await ok('grade_clip', { projectId, clipId: clipA, creative: { look: 'look-33.cube' } });
		expect(
			(await fails('grade_clip', { projectId, clipId: clipA, creative: { look: 'nope.cube' } })).code,
		).toBe('E_NOT_FOUND');
		for (const bad of [
			{ basic: { exposre: 1 } },
			{ curves: { master: [[0, 0]] } },
			{ wheels: { shadows: [1, 2, 3] } },
		]) {
			const response = await call('grade_clip', { projectId, clipId: clipA, ...bad });
			expect(response.isError).toBe(true);
		}
	});

	it('get_grade returns the evaluated values and LUT names', async () => {
		const g = await ok<{
			evaluatedAt: string;
			frame: number;
			effects: {
				effectInstanceId: string;
				effectId: string;
				basic: Record<string, unknown>;
				creative: Record<string, unknown>;
				curves: Record<string, unknown>;
				wheels: Record<string, unknown>;
				luts: { param: string; mediaId: string; name: string; title: string; size: number }[];
			}[];
		}>('get_grade', { projectId, clipId: clipA });
		expect(g.evaluatedAt).toBe('clip-start');
		expect(g.effects).toHaveLength(1);
		const fx = g.effects[0]!;
		expect(fx).toMatchObject({
			effectInstanceId: gradeFx,
			effectId: 'jasper.lumetri',
			basic: { exposure: 0.8, temperature: 40, saturation: 140 },
			creative: { look: lutId, intensity: 80 },
			curves: {
				master: [
					[0, 0.05],
					[0.5, 0.55],
					[1, 1],
				],
			},
			wheels: { shadows: [0.4, 0], highlightsLevel: 10 },
		});
		expect(fx.luts).toMatchObject([{ param: 'look', mediaId: lutId, title: 'Warm Teal 33' }]);
	});

	it('keyframed params need a time: rejected without one, keyed at `at`', async () => {
		await ok('apply_commands', {
			projectId,
			label: 'Animate temperature',
			commands: [
				{
					type: 'param.setAnimated',
					target: ['effect', gradeFx, 'temperature'],
					animated: true,
					at: { frames: 0 },
				},
			],
		});
		const e = await fails('grade_clip', { projectId, clipId: clipA, basic: { temperature: -30 } });
		expect(e.code).toBe('E_INVALID_PARAM');
		expect(
			(await fails('grade_clip', { projectId, clipId: clipA, basic: { temperature: -30 }, at: 400 })).code,
		).toBe('E_INVALID_PARAM');
		const r = await ok<{ keyframed: { params: string[]; frame: number } }>('grade_clip', {
			projectId,
			clipId: clipA,
			basic: { temperature: -30 },
			at: 60,
		});
		expect(r.keyframed).toMatchObject({ params: ['temperature'], frame: 60 });
		const g = await ok<{ effects: { basic: { temperature: number }; keyframed: string[] }[] }>('get_grade', {
			projectId,
			clipId: clipA,
			at: 60,
		});
		expect(g.effects[0]!.basic.temperature).toBe(-30);
		expect(g.effects[0]!.keyframed).toEqual(['temperature']);
		const g0 = await ok<{ effects: { basic: { temperature: number } }[] }>('get_grade', {
			projectId,
			clipId: clipA,
			at: 0,
		});
		expect(g0.effects[0]!.basic.temperature).toBe(40);
	});

	it('instance "new" stacks a second Lumetri; copy_grade replaces the target grade in one change', async () => {
		await ok('apply_commands', {
			projectId,
			label: 'Old grade on B',
			commands: [{ type: 'effect.add', target: { clipId: clipB }, effectId: 'jasper.black-white' }],
		});
		await ok('grade_clip', {
			projectId,
			clipId: clipA,
			instance: 'new',
			basic: { tint: 10 },
		});
		const beforeB = await frameAt(projectId, 330);
		const changes = await docChangedDuring(token, projectId, async () => {
			await ok('copy_grade', { projectId, fromClipId: clipA, toClipIds: [clipB] });
		});
		expect(changes).toHaveLength(1);
		const g = await ok<{
			effects: {
				effectId: string;
				effectInstanceId: string;
				basic: Record<string, unknown>;
				keyframed?: string[];
			}[];
		}>('get_grade', { projectId, clipId: clipB });
		expect(g.effects).toHaveLength(2);
		expect(g.effects[0]!.effectInstanceId).not.toBe(gradeFx);
		expect(g.effects[0]!.basic).toMatchObject({ exposure: 0.8, saturation: 140, temperature: 40 });
		expect(g.effects[0]!.keyframed).toEqual(['temperature']);
		expect(g.effects[1]!.basic).toMatchObject({ tint: 10 });
		const afterB = await frameAt(projectId, 330);
		expect(meanAbsDiff(beforeB, afterB)).toBeGreaterThan(8);
	});
});
