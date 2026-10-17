// Takes through MCP (spec 12 P6-E9; wp-note "Phase 6 → WP-E5"): a real engine indexes a starter kit holding a
// generated typing run (8 key presses, down- and up-strokes) and a wooden hit; jasper-mcp (stdio) searches with
// `takes`, lists a recording's takes in get_sound, draws take ids in view_sounds and imports a take as a sample-exact
// copy with the recording's licence; `material` filters. No network.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ProjectDocument, parseTakeId } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '../src/png.ts';
import { cleanEnv, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.MCP_TAKES_TEST_PORT ?? 49031);
const SR = 48_000;

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

let engine: ChildProcess | null = null;
let work = '';
let client: Client;
const token = randomBytes(16).toString('hex');
const logs: string[] = [];
const engineLog: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 600_000,
	})) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('')}`);
	return { body: JSON.parse(textOf(r)) as T, result: r };
}
async function fails(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	expect(r.isError, `${name} should fail: ${textOf(r)}`).toBe(true);
	return (JSON.parse(textOf(r)) as { error: { code: string; message: string } }).error;
}

/** 16-bit PCM WAV of planar float channels. */
function encodeWav(channels: Float32Array[], sr: number, _fmt: 's16'): Buffer {
	const n = channels[0]!.length;
	const ch = channels.length;
	const data = Buffer.alloc(n * ch * 2);
	for (let i = 0; i < n; i++)
		for (let c = 0; c < ch; c++)
			data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels[c]![i]!)) * 32767), (i * ch + c) * 2);
	const h = Buffer.alloc(44);
	h.write('RIFF', 0, 'ascii');
	h.writeUInt32LE(36 + data.length, 4);
	h.write('WAVEfmt ', 8, 'ascii');
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(ch, 22);
	h.writeUInt32LE(sr, 24);
	h.writeUInt32LE(sr * ch * 2, 28);
	h.writeUInt16LE(ch * 2, 32);
	h.writeUInt16LE(16, 34);
	h.write('data', 36, 'ascii');
	h.writeUInt32LE(data.length, 40);
	return Buffer.concat([h, data]);
}

function lcg(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x80000000 - 1;
	};
}
function addClick(x: Float32Array, at: number, amp: number, tauMs: number, seed: number) {
	const r = lcg(seed);
	const tau = (tauMs / 1000) * SR;
	for (let i = 0; i < 0.06 * SR && at + i < x.length; i++)
		x[at + i] =
			x[at + i]! + amp * Math.exp(-i / tau) * (0.6 * r() + 0.4 * Math.sin((2 * Math.PI * 3000 * i) / SR));
}

/** A starter kit of two generated sounds: a typing run (8 key presses) and a wooden hit. */
function makeKit(dir: string) {
	mkdirSync(dir, { recursive: true });
	const r = lcg(3);
	const typing = Float32Array.from({ length: Math.round(4.6 * SR) }, () => 3e-4 * r());
	for (let k = 0; k < 8; k++) {
		const down = Math.round((0.25 + k * 0.5) * SR);
		addClick(typing, down, 0.6, 5, 10 + k);
		addClick(typing, down + Math.round(0.08 * SR), 0.3, 4, 20 + k);
	}
	writeFileSync(join(dir, 'typing.wav'), encodeWav([typing, typing], SR, 's16'));
	const hit = new Float32Array(Math.round(0.6 * SR));
	addClick(hit, 2400, 0.8, 30, 99);
	writeFileSync(join(dir, 'hit.wav'), encodeWav([hit], SR, 's16'));
	const sound = (file: string, title: string, types: string[]) => ({
		file,
		title,
		types,
		tags: ['test'],
		author: 'Test Author',
		license: 'CC0-1.0',
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [],
			sounds: [
				sound('typing.wav', 'Keyboard typing run', ['key']),
				sound('hit.wav', 'Wooden block hit', ['hit']),
			],
		}),
	);
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-takes-'));
	const appdir = join(work, 'appdir');
	mkdirSync(appdir);
	makeKit(join(work, 'kit'));
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{
			cwd: ROOT,
			env: cleanEnv({
				JASPER_LOCAL_TOKEN: token,
				JASPER_SOUND_STARTER_DIR: join(work, 'kit'),
				JASPER_SOUND_SYNTH_VARIANTS: '0',
				JASPER_SOUND_AUTO_INDEX: '0',
			}),
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	engine.stdout?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	engine.stderr?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	await waitFor(
		async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
		120_000,
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
	client = new Client({ name: 'vitest-mcp-takes', version: '1.0.0' });
	await client.connect(transport);
	await ok('rescan_sound_library', { wait: true });
}, 300_000);

afterAll(async () => {
	await client?.close().catch(() => {});
	if (engine && engine.exitCode === null) {
		const exited = new Promise((r) => engine!.once('exit', r));
		engine.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
	}
	if (work) rmSync(work, { recursive: true, force: true });
}, 30_000);

type Row = {
	soundId: string;
	title: string;
	takes?: number;
	materials?: string[];
	take?: { recordingId: string; index: number; startSec: number; endSec: number; strokes: number };
	judge: { ok: boolean; reasons: string[] } | null;
};
type Search = { total: number; results: Row[]; facets: Record<string, Record<string, number>> };

describe('takes through MCP', { timeout: 600_000 }, () => {
	let recording = '';
	it('search_sounds: a recording row says how many takes it has; takes: true returns them as rows', async () => {
		const plain = (await ok<Search>('search_sounds', { types: ['key'] })).body;
		const rec = plain.results.find((r) => r.title === 'Keyboard typing run')!;
		expect(rec.takes).toBe(8);
		expect(rec.judge?.reasons).toContain('multi-hit');
		recording = rec.soundId;
		const rows = (await ok<Search>('search_sounds', { types: ['key'], takes: true, limit: 24 })).body.results;
		const takes = rows.filter((r) => parseTakeId(r.soundId));
		expect(takes).toHaveLength(8);
		for (const t of takes) {
			expect(t.take).toMatchObject({ recordingId: recording, strokes: 2 });
			expect(t.judge?.reasons ?? []).not.toContain('multi-hit');
		}
		// the takes rank above their multi-hit recording
		expect(rows.findIndex((r) => parseTakeId(r.soundId))).toBeLessThan(
			rows.findIndex((r) => r.soundId === recording),
		);
		expect((await fails('search_sounds', { takes: 'yes' })).code).toBe('E_INVALID_ARGUMENT');
	});

	it('search_sounds material filters by the words; the facet counts it', async () => {
		const wood = (await ok<Search>('search_sounds', { material: 'wood' })).body;
		expect(wood.results.map((r) => r.title)).toEqual(['Wooden block hit']);
		expect(wood.results[0]!.materials).toEqual(['wood']);
		expect(wood.facets.materials).toEqual({ wood: 1 });
		expect((await fails('search_sounds', { material: 'lava' })).code).toBe('E_INVALID_ARGUMENT');
	});

	it('get_sound lists the takes of a recording; a take id gives the take alone', async () => {
		const r = (
			await ok<{
				takes: {
					takeId: string;
					index: number;
					offered: boolean;
					flags: string[];
					startSec: number;
					endSec: number;
				}[];
			}>('get_sound', { soundId: recording })
		).body;
		expect(r.takes.map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(r.takes.every((t) => t.offered && t.flags.length === 0)).toBe(true);
		const one = (
			await ok<{
				id: string;
				take: { soundId: string; index: number };
				descriptors: { durationSec: number };
			}>('get_sound', { soundId: r.takes[2]!.takeId })
		).body;
		expect(one).toMatchObject({ id: `${recording}~t3`, take: { soundId: recording, index: 3 } });
		expect(one.descriptors.durationSec).toBeCloseTo(r.takes[2]!.endSec - r.takes[2]!.startSec, 3);
		expect((await fails('get_sound', { soundId: `${recording}~t9` })).code).toMatch(/NOT_FOUND/);
		expect((await fails('get_sound', { soundId: `${recording}~t0` })).code).toBe('E_INVALID_ARGUMENT');
	});

	it('view_sounds draws takes next to their recording', async () => {
		const ids = [recording, `${recording}~t1`, `${recording}~t2`];
		const r = await ok<{ cells: { soundId: string; durationSec: number }[] }>('view_sounds', {
			soundIds: ids,
		});
		expect(r.body.cells.map((c) => c.soundId)).toEqual(ids);
		expect(r.body.cells[1]!.durationSec).toBeLessThan(0.5);
		const img = r.result.content.find((c) => c.type === 'image') as { data: string };
		const png = decodePng(Buffer.from(img.data, 'base64'));
		expect(png.width).toBeGreaterThan(0);
		mkdirSync(join(ROOT, 'test-results'), { recursive: true });
		writeFileSync(join(ROOT, 'test-results', 'mcp-takes-view.png'), Buffer.from(img.data, 'base64'));
	});

	it('import_sounds imports a take as a copy of its range with the recording’s licence', async () => {
		const projectId = (await ok<{ projectId: string }>('create_project', { name: 'Takes' })).body.projectId;
		const id = `${recording}~t4`;
		const res = (
			await ok<{ sounds: { soundId: string; mediaId: string }[] }>('import_sounds', {
				projectId,
				soundIds: [id],
			})
		).body;
		const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
		const doc = JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
		const m = doc.media[res.sounds[0]!.mediaId]! as {
			library?: { soundId: string; license: string; take?: { soundId: string; index: number } };
			originalName: string;
		};
		expect(m.library).toMatchObject({
			soundId: id,
			license: 'CC0-1.0',
			take: { soundId: recording, index: 4 },
		});
		expect(m.originalName).toContain('take 4');
	});
});
