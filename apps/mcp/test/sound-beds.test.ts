// Ambience beds and room tone through MCP (spec 12 P6-E12; wp-note "Phase 6 → WP-E8"): a real engine and jasper-mcp
// (stdio). A 20 s dialogue recording with a −52 dBFS pink floor sits on A1 cut into two clips around a 1 s hole, with
// "Scene 2" / "Scene 3" markers at 200 and 400: lay_ambience_bed previews the three scenes (window, loop, crossfade),
// proposes them (nothing changes) and applies them (one edit); fill_room_tone ranks the library's room tones against the
// dialogue's floor, picks the pink one and fills the hole; refusals are typed.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ProjectDocument, readClipBed } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, testPort, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.MCP_BEDS_TEST_PORT);
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
	return JSON.parse(textOf(r)) as T;
}
function encodeWav(channels: Float32Array[], sr: number): Buffer {
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
function prng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
	};
}
const scaleTo = (x: Float32Array, dbfs: number) => {
	let e = 0;
	for (const v of x) e += v * v;
	const g = 10 ** (dbfs / 20) / Math.sqrt(e / x.length);
	for (let i = 0; i < x.length; i++) x[i]! *= g;
	return x;
};
function pink(seconds: number, seed: number, dbfs: number): Float32Array {
	const r = prng(seed);
	const x = new Float32Array(Math.round(seconds * SR));
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	for (let i = 0; i < x.length; i++) {
		const w = r();
		b0 = 0.99765 * b0 + w * 0.099046;
		b1 = 0.963 * b1 + w * 0.2965164;
		b2 = 0.57 * b2 + w * 1.0526913;
		x[i] = b0 + b1 + b2 + w * 0.1848;
	}
	return scaleTo(x, dbfs);
}
const white = (seconds: number, seed: number, dbfs: number) => {
	const r = prng(seed);
	return scaleTo(
		Float32Array.from({ length: Math.round(seconds * SR) }, () => r()),
		dbfs,
	);
};

async function docOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-beds-'));
	const appdir = join(work, 'appdir');
	mkdirSync(appdir);
	const kit = join(work, 'kit');
	mkdirSync(kit);
	const w = (name: string, x: Float32Array) => writeFileSync(join(kit, name), encodeWav([x, x], SR));
	w('amb.wav', pink(6, 1, -30));
	w('rt-pink.wav', pink(20, 3, -45));
	w('rt-hiss.wav', white(20, 5, -45));
	const sound = (file: string, title: string, types: string[]) => ({
		file,
		title,
		types,
		tags: ['test'],
		author: 'Test',
		license: 'CC0-1.0',
	});
	writeFileSync(
		join(kit, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [],
			sounds: [
				sound('amb.wav', 'Test street ambience', ['ambience']),
				sound('rt-hiss.wav', 'Room tone hiss', ['roomtone']),
				sound('rt-pink.wav', 'Room tone pink', ['roomtone']),
			],
		}),
	);
	// 20 s of dialogue: a −52 dBFS pink floor, syllables everywhere but 9.5–10.5 s
	const d = pink(20, 21, -52);
	for (let i = 0; i < d.length; i++) {
		const t = i / SR;
		if (t < 0.5 || (t > 3.5 && t < 5.5) || t > 19) continue;
		d[i]! += 0.15 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t)) * Math.sin(2 * Math.PI * 1500 * t);
	}
	writeFileSync(join(work, 'dialogue.wav'), encodeWav([d, d], SR));
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{
			cwd: ROOT,
			env: cleanEnv({
				JASPER_LOCAL_TOKEN: token,
				JASPER_SOUND_STARTER_DIR: kit,
				JASPER_SOUND_SYNTH_VARIANTS: '0',
				JASPER_SOUND_AUTO_INDEX: '0',
			}),
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	engine.stdout?.on('data', (b: Buffer) => engineLog.push(b.toString()));
	engine.stderr?.on('data', (b: Buffer) => engineLog.push(b.toString()));
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
	transport.stderr?.on('data', (b: Buffer) => logs.push(b.toString('utf8')));
	client = new Client({ name: 'vitest-mcp-beds', version: '1.0.0' });
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

describe('beds and room tone through MCP', { timeout: 900_000 }, () => {
	let projectId = '';
	let ambience = '';
	const seqOf = (d: ProjectDocument) => Object.values(d.sequences)[0]!;

	beforeAll(async () => {
		projectId = (await ok<{ projectId: string }>('create_project', { name: 'Beds' })).projectId;
		const media = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [join(work, 'dialogue.wav')],
		});
		const m = media.imported[0]!.mediaId;
		await ok('apply_commands', {
			projectId,
			label: 'Dialogue',
			commands: [
				{
					type: 'clip.place',
					source: { mediaId: m },
					sourceRange: { in: { seconds: 0 }, out: { seconds: 9.5 } },
					at: 0,
					tracks: { audio: 'A1' },
					ref: '$a',
				},
				{
					type: 'clip.place',
					source: { mediaId: m },
					sourceRange: { in: { seconds: 10.5 }, out: { seconds: 20 } },
					at: 315,
					tracks: { audio: 'A1' },
					ref: '$b',
				},
				{ type: 'essentialSound.setType', clipIds: ['$a', '$b'], audioType: 'dialogue' },
				{ type: 'marker.add', frame: 200, name: 'Scene 2' },
				{ type: 'marker.add', frame: 400, name: 'Scene 3' },
			],
		});
		const found = await ok<{ results: { soundId: string; title: string }[] }>('search_sounds', {
			types: ['ambience'],
		});
		ambience = found.results.find((r) => r.title === 'Test street ambience')!.soundId;
	});

	it('lay_ambience_bed: preview, propose (nothing changes), apply (one edit)', async () => {
		const preview = await ok<{ scenes: number; table: string; transaction: { type: string }[] }>(
			'lay_ambience_bed',
			{
				projectId,
				soundId: ambience,
				preview: true,
			},
		);
		console.info(`[mcp beds] preview\n${preview.table}`);
		expect(preview.scenes).toBe(3);
		expect(preview.table).toContain('Test street ambience');
		expect(preview.transaction.at(-1)!.type).toBe('soundDesign.layBed');
		const before = await docOf(projectId);
		const proposed = await ok<{ proposalId: string; applied: boolean; next: string }>('lay_ambience_bed', {
			projectId,
			soundId: ambience,
			duckUnder: 'dialogue',
		});
		expect(proposed.applied).toBe(false);
		expect(proposed.proposalId).toMatch(/^prp_/);
		expect(proposed.next).toContain('sound_check');
		expect(Object.keys(seqOf(await docOf(projectId)).clips)).toEqual(Object.keys(seqOf(before).clips));
		const prop = await ok<{ items: { itemId: string; setup: boolean }[] }>('get_proposal', {
			projectId,
			proposalId: proposed.proposalId,
		});
		expect(prop.items.some((i) => i.itemId === 'bed' && !i.setup)).toBe(true);
		expect(prop.items.some((i) => i.setup)).toBe(true);
		const applied = await ok<{ applied: boolean; revision: number }>('lay_ambience_bed', {
			projectId,
			soundId: ambience,
			duckUnder: 'dialogue',
			mode: 'apply',
		});
		expect(applied.applied).toBe(true);
		const seq = seqOf(await docOf(projectId));
		const bed = Object.values(seq.clips).filter(
			(c) => readClipBed((c as { bed?: unknown }).bed)?.purpose === 'ambience',
		);
		expect(bed.length).toBeGreaterThanOrEqual(3);
		expect(seq.audioTracks.find((t) => t.id === bed[0]!.trackId)!.name).toBe('Ambience');
		// ducked: Volume keyframes on the pieces under the dialogue
		expect(
			bed.some((c) => ((c as { volumeDb?: { keyframes?: unknown[] } }).volumeDb?.keyframes ?? []).length > 0),
		).toBe(true);
	});

	it('fill_room_tone: the floor, the ranked tones (pink closest), the fill', async () => {
		const preview = await ok<{
			gaps: { start: number; end: number }[];
			floor: { levelDb: number } | null;
			candidates: string;
			chosen: { title: string; source: string; distanceDb: number; gainDb: number; why: string } | null;
		}>('fill_room_tone', { projectId, preview: true });
		console.info(
			`[mcp room tone] floor ${preview.floor?.levelDb} dBFS\n${preview.candidates}\nchosen ${preview.chosen?.title}: ${preview.chosen?.why}`,
		);
		expect(preview.gaps.map((g) => [g.start, g.end])).toEqual([[285, 315]]);
		expect(preview.chosen?.title).toBe('Room tone pink');
		expect(preview.candidates).toContain('Room tone hiss');
		const applied = await ok<{ applied: boolean }>('fill_room_tone', { projectId, mode: 'apply' });
		expect(applied.applied).toBe(true);
		const seq = seqOf(await docOf(projectId));
		const fill = Object.values(seq.clips).filter(
			(c) => readClipBed((c as { bed?: unknown }).bed)?.purpose === 'roomtone',
		);
		expect(fill.length).toBeGreaterThanOrEqual(1);
		expect(Math.min(...fill.map((c) => c.start))).toBe(277);
	});

	it('typed refusals', async () => {
		const none = await call('lay_ambience_bed', { projectId, mode: 'apply', replace: false });
		expect(none.isError).toBe(true);
		expect(textOf(none)).toContain('BED_SOUND_REQUIRED');
		const bad = await call('lay_ambience_bed', {
			projectId,
			soundId: ambience,
			range: { start: 50, end: 10 },
		});
		expect(bad.isError).toBe(true);
		expect(textOf(bad)).toContain('E_INVALID_PARAM');
		const unknown = await call('fill_room_tone', { projectId, nope: 1 });
		expect(unknown.isError).toBe(true);
	});
});
