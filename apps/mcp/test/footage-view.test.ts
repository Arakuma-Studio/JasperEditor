// view_media_range against a real engine and jasper-mcp over stdio (spec 18 AF-VIEW-001…003): raw media with video and
// audio (filmstrip at the slot centres, waveform, silence bands, transcript words), video without audio (no audio
// rows), audio without video (audio rows only), a sequence range (Program frames through the still render path, the
// mix's levels, the sequence transcript), clamping, and coded errors for every refusal (ids, ranges, still images,
// unknown and offline media). Fixture media come from `pnpm fixtures`.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '../src/png.ts';
import { clampRange, secondsArg } from '../src/tools/footage-view.ts';
import { cleanEnv, stopEngine, testPort, waitFor } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const FIXTURES = join(ROOT, 'fixtures', 'media');
const PORT = await testPort(process.env.MCP_FOOTAGE_VIEW_TEST_PORT);
const F = 705_600_000;

let engine: ChildProcess | null = null;
let appdir = '';
let client: Client;
const logs: string[] = [];

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
const imageOf = (r: CallToolResult) => {
	const c = r.content.find((x) => x.type === 'image') as { data: string; mimeType: string } | undefined;
	if (!c) throw new Error(`no image: ${textOf(r)}`);
	expect(c.mimeType).toBe('image/png');
	return decodePng(Buffer.from(c.data, 'base64'));
};

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
async function view(args: Record<string, unknown>): Promise<CallToolResult> {
	const r = await call('view_media_range', args);
	if (r.isError) throw new Error(`view_media_range failed: ${textOf(r)}\n${logs.join('')}`);
	return r;
}
async function fails(args: Record<string, unknown>) {
	const r = await call('view_media_range', args);
	expect(r.isError, `should fail: ${textOf(r)}`).toBe(true);
	return (JSON.parse(textOf(r)) as { error: { code: string; message: string; hint?: string } }).error;
}

/**
 * A mono 16-bit WAV: a 440 Hz tone (pitch offset by `seed`, so every file is new media) where `on(t)`, a −70 dBFS noise
 * floor elsewhere.
 */
function wav(path: string, seconds: number, seed: number, on: (t: number) => boolean = () => true): void {
	const sr = 16_000;
	const n = sr * seconds;
	const b = Buffer.alloc(44 + n * 2);
	b.write('RIFF', 0, 'ascii');
	b.writeUInt32LE(36 + n * 2, 4);
	b.write('WAVEfmt ', 8, 'ascii');
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(1, 22);
	b.writeUInt32LE(sr, 24);
	b.writeUInt32LE(sr * 2, 28);
	b.writeUInt16LE(2, 32);
	b.writeUInt16LE(16, 34);
	b.write('data', 36, 'ascii');
	b.writeUInt32LE(n * 2, 40);
	let r = 12345 + seed;
	for (let i = 0; i < n; i++) {
		r = (r * 1103515245 + 12345) % 2147483648;
		const noise = (r / 2147483648 - 0.5) * 2 * 32768 * 10 ** (-70 / 20) * Math.sqrt(3);
		const tone = on(i / sr) ? 8000 * Math.sin((2 * Math.PI * (440 + seed) * i) / sr) : 0;
		b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(tone + noise))), 44 + i * 2);
	}
	writeFileSync(path, b);
}

beforeAll(async () => {
	if (!['clip-a.mp4', 'box-move.mp4', 'tone.wav', 'still.png'].every((n) => existsSync(join(FIXTURES, n))))
		spawnSync(process.execPath, [join(ROOT, 'scripts', 'make-fixtures.mjs')], { stdio: 'inherit' });
	appdir = mkdtempSync(join(tmpdir(), 'jasper-mcp-view-'));
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
	client = new Client({ name: 'vitest-mcp-footage-view', version: '1.0.0' });
	await client.connect(transport);
}, 180_000);

afterAll(async () => {
	await client?.close().catch(() => {});
	await stopEngine(engine);
	if (appdir) rmSync(appdir, { recursive: true, force: true });
}, 30_000);

describe('argument helpers', () => {
	it('reads seconds and friendly times, and clamps ranges to the media', () => {
		expect(secondsArg(12.5, 'start')).toBe(12.5);
		expect(secondsArg('1:02', 'start')).toBe(62);
		expect(secondsArg('250ms', 'start')).toBe(0.25);
		expect(() => secondsArg('soon', 'start')).toThrow(/not a time/);
		expect(clampRange(5, 50, 20, 'media')).toEqual({ start: 5, end: 20 });
		expect(() => clampRange(5, 5, 20, 'media')).toThrow(/after start/);
		expect(() => clampRange(30, 40, 20, 'media')).toThrow(/outside the media/);
		expect(() => clampRange(0, 700, 1000, 'media')).toThrow(/at most 600 s/);
		expect(clampRange(0, 700, 600, 'media')).toEqual({ start: 0, end: 600 });
	});
});

describe('view_media_range', () => {
	let projectId = '';
	const media: Record<string, string> = {};

	it('is a read-only tool', async () => {
		const { tools } = await client.listTools();
		const t = tools.find((x) => x.name === 'view_media_range');
		expect(t?.annotations?.readOnlyHint).toBe(true);
		const p = await ok<{ projectId: string }>('create_project', { name: 'MCP view' });
		projectId = p.projectId;
		for (const name of ['clip-a.mp4', 'box-move.mp4', 'tone.wav', 'still.png']) {
			const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', {
				projectId,
				paths: [join(FIXTURES, name)],
			});
			media[name] = imp.imported[0]!.mediaId;
		}
	});

	it('shows a video with audio: frames at the slot centres, waveform, silences and the words', async () => {
		const id = media['clip-a.mp4']!;
		const words = ['alpha', 'bravo', 'charlie', 'delta'].map((text, i) => ({
			text,
			start: Math.round((2.2 + i) * F),
			end: Math.round((2.6 + i) * F),
		}));
		await ok('apply_commands', {
			projectId,
			label: 'Transcript',
			commands: [{ type: 'transcript.create', mediaId: id, language: 'en', origin: 'manual', words }],
		});
		const r = await view({ projectId, mediaId: id, start: 2, end: '6s', frames: 4, width: 960 });
		const text = textOf(r);
		expect(text).toContain('clip-a.mp4');
		expect(text).toContain('2.00-6.00 s (4.00 s, media time)');
		expect(text).toContain('frames (4, slot centres): 2.50, 3.50, 4.50, 5.50');
		expect(text).toMatch(/audio: RMS waveform, 10 ms levels from an analysis of this range/);
		expect(text).toMatch(/silences >= 0.4 s \(\d+\)/);
		expect(text).toContain('words (4): [2.20] alpha [3.20] bravo [4.20] charlie [5.20] delta');
		const img = imageOf(r);
		expect(img.width).toBe(960);
		// the first slot holds a picture (testsrc2), not the background
		const o = ((26 + 60) * img.width + 8 + 2 + 110) * 4;
		expect([img.data[o], img.data[o + 1], img.data[o + 2]]).not.toEqual([18, 18, 22]);
	});

	it('clamps the range and leaves out the audio rows of a video without audio', async () => {
		const r = await view({ projectId, mediaId: media['box-move.mp4'], start: 1, end: 100 });
		const text = textOf(r);
		expect(text).toContain('1.00-4.00 s');
		expect(text).toContain('audio: none');
		expect(text).not.toContain('silences');
		expect(text).toContain('frames (8, slot centres)');
		expect(imageOf(r).width).toBe(1280);
	});

	it('draws only the audio rows of audio without video', async () => {
		const r = await view({ projectId, mediaId: media['tone.wav'], start: 0, end: 5, width: 480 });
		const text = textOf(r);
		expect(text).toContain('frames: none (no video)');
		expect(text).toMatch(/audio: RMS waveform/);
		expect(text).toContain('words: no transcript');
		const img = imageOf(r);
		expect(img.width).toBe(480);
		expect(img.height).toBeLessThan(200);
	});

	it('lists and shades the silences of at least 0.4 s', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-view-gap-'));
		try {
			const file = join(dir, 'gaps.wav');
			// sound 0–1 s, a 1 s pause, sound 2–3 s, a 0.2 s pause (too short), sound 3.2–4 s
			wav(file, 4, 3, (t) => t < 1 || (t >= 2 && t < 3) || t >= 3.2);
			const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', { projectId, paths: [file] });
			const r = await view({ projectId, mediaId: imp.imported[0]!.mediaId, start: 0, end: 4, width: 480 });
			const m = /silences >= 0.4 s \((\d+)\): (\S+)-(\S+) /.exec(textOf(r));
			expect(m, textOf(r)).not.toBeNull();
			expect(Number(m![1])).toBe(1);
			expect(Number(m![2])).toBeCloseTo(1, 1);
			expect(Number(m![3])).toBeCloseTo(2, 1);
			const img = imageOf(r);
			// the band's top edge over the waveform row at t = 1.5 s (x = 8 + 1.5 / 4 · 464 = 182; header 17 px)
			const o = (17 * img.width + 182) * 4;
			expect([img.data[o], img.data[o + 1], img.data[o + 2]]).toEqual([255, 170, 60]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('shows a sequence range: Program frames, the mix and the sequence transcript', async () => {
		await ok('add_clip', { projectId, media: media['clip-a.mp4'], at: 0 });
		const r = await view({
			projectId,
			sequenceId: (await firstSequence(projectId)) ?? undefined,
			start: 2,
			end: 6,
			frames: 2,
			width: 480,
		});
		const text = textOf(r);
		expect(text).toContain('sequence time');
		expect(text).toContain('frames (2, slot centres): 3.00, 5.00');
		expect(text).toContain('the sequence mix');
		expect(text).toContain('[2.20] alpha');
		expect(imageOf(r).width).toBe(480);
	});

	it('refuses with coded errors', async () => {
		const both = await fails({
			projectId,
			mediaId: media['clip-a.mp4'],
			sequenceId: 'seq_x',
			start: 0,
			end: 1,
		});
		expect(both.code).toBe('E_INVALID_PARAM');
		expect((await fails({ projectId, start: 0, end: 1 })).code).toBe('E_INVALID_PARAM');
		const reversed = await fails({ projectId, mediaId: media['clip-a.mp4'], start: 4, end: 2 });
		expect([reversed.code, reversed.message]).toEqual([
			'E_INVALID_PARAM',
			'end (2 s) must be after start (4 s)',
		]);
		const outside = await fails({ projectId, mediaId: media['clip-a.mp4'], start: 50, end: 60 });
		expect(outside.message).toMatch(/outside the media/);
		expect((await fails({ projectId, mediaId: media['clip-a.mp4'], start: 'soon', end: 2 })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await fails({ projectId, mediaId: 'med_missing', start: 0, end: 1 })).code).toBe('E_NOT_FOUND');
		expect((await fails({ projectId, mediaId: media['still.png'], start: 0, end: 1 })).code).toBe(
			'E_UNSUPPORTED',
		);
		expect((await fails({ projectId, sequenceId: 'seq_missing', start: 0, end: 1 })).code).toBe(
			'E_NOT_FOUND',
		);
		const frames = await call('view_media_range', {
			projectId,
			mediaId: media['tone.wav'],
			start: 0,
			end: 1,
			frames: 17,
		});
		expect(frames.isError).toBe(true);
		// offline: the file is gone after the import
		const dir = mkdtempSync(join(tmpdir(), 'jasper-mcp-view-off-'));
		const file = join(dir, 'gone.wav');
		wav(file, 2, 7);
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', { projectId, paths: [file] });
		rmSync(dir, { recursive: true, force: true });
		const offline = await fails({ projectId, mediaId: imp.imported[0]!.mediaId, start: 0, end: 1 });
		expect(offline.code).toBe('MEDIA_OFFLINE');
	});
});

async function firstSequence(projectId: string): Promise<string | null> {
	const p = await ok<{ sequences: { sequenceId: string }[] }>('get_project', { projectId });
	return p.sequences[0]?.sequenceId ?? null;
}
