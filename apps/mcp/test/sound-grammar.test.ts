// The cue grammar through MCP (spec 12 P6-E10; wp-note "Phase 6 → WP-E6"): a real engine indexes a generated kit
// (a typing run of 8 key presses, two clicks, wooden and metal hits); jasper-mcp (stdio) place_sound {sound: {type}}
// picks follow the shared policy — every click cue gets the ONE click voice at one level and speed 1, keys are takes
// at speed 1, a hit pick prefers the material of the hits already placed —, swap_sound next walks a take's sibling
// takes, plan_sound_design takes the style options and reports what the grammar did, and the guide teaches it.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AudioClip, type ClipSfx, type ProjectDocument, parseTakeId } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOUND_GUIDE } from '../src/tools/sound.ts';
import { cleanEnv, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.MCP_GRAMMAR_TEST_PORT ?? 52411);
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
function lcg(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x80000000 - 1;
	};
}
/** Noise + a tone under an exponential decay τ, added at sample `at`. */
function addBurst(
	x: Float32Array,
	at: number,
	amp: number,
	tauMs: number,
	hz: number,
	seed: number,
	lenSec = 0.06,
) {
	const r = lcg(seed);
	const tau = (tauMs / 1000) * SR;
	for (let i = 0; i < lenSec * SR && at + i < x.length; i++)
		x[at + i] =
			x[at + i]! + amp * Math.exp(-i / tau) * (0.6 * r() + 0.4 * Math.sin((2 * Math.PI * hz * i) / SR));
}

function makeKit(dir: string) {
	mkdirSync(dir, { recursive: true });
	const r = lcg(3);
	const typing = Float32Array.from({ length: Math.round(4.6 * SR) }, () => 3e-4 * r());
	for (let k = 0; k < 8; k++) {
		const down = Math.round((0.25 + k * 0.5) * SR);
		addBurst(typing, down, 0.6, 5, 3000, 10 + k);
		addBurst(typing, down + Math.round(0.08 * SR), 0.3, 4, 3000, 20 + k);
	}
	writeFileSync(join(dir, 'typing.wav'), encodeWav([typing, typing], SR));
	const one = (file: string, amp: number, tau: number, hz: number, seed: number, len = 0.3, burst = 0.06) => {
		const x = new Float32Array(Math.round(len * SR));
		addBurst(x, 2400, amp, tau, hz, seed, burst);
		writeFileSync(join(dir, file), encodeWav([x], SR));
	};
	one('click_a.wav', 0.7, 2, 4000, 31);
	one('click_b.wav', 0.6, 2, 3500, 32);
	one('hit_wood_a.wav', 0.8, 40, 400, 41, 0.9, 0.5);
	one('hit_wood_b.wav', 0.78, 42, 420, 42, 0.9, 0.5);
	one('hit_metal_a.wav', 0.8, 40, 900, 43, 0.9, 0.5);
	one('hit_metal_b.wav', 0.79, 41, 950, 44, 0.9, 0.5);
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
				sound('click_a.wav', 'Mouse click', ['click']),
				sound('click_b.wav', 'Switch click', ['click']),
				sound('hit_wood_a.wav', 'Wooden block hit', ['hit']),
				sound('hit_wood_b.wav', 'Wood knock hit', ['hit']),
				sound('hit_metal_a.wav', 'Metal pipe hit', ['hit']),
				sound('hit_metal_b.wav', 'Steel plate hit', ['hit']),
			],
		}),
	);
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-grammar-'));
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
	client = new Client({ name: 'vitest-mcp-grammar', version: '1.0.0' });
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

type Placed = {
	clips: {
		clipId: string;
		soundId: string;
		title: string;
		rate: number;
		gainDb: number;
		picked?: { variation: string; voice?: string; from: string[] };
	}[];
};

async function docOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}

describe('the guide teaches the grammar', () => {
	it('names every rule and the style options', () => {
		const g = SOUND_GUIDE.toLowerCase();
		for (const phrase of [
			'you cannot hear: these rules encode the craft',
			'one click voice',
			'vary the take, not the pitch',
			'runs climb',
			'+1 st per step',
			'one key per word',
			'music carries the cuts',
			'music_carries_cut',
			'one material family per film',
			'personality',
			'calm',
			'mechanical',
			'duckundertyping',
			'soundDesign.setSettings {style'.toLowerCase(),
			'explicit rates and pitches you give are never changed',
		])
			expect(g, phrase).toContain(phrase);
	});
});

describe('place_sound type picks follow the grammar', { timeout: 600_000 }, () => {
	let projectId = '';
	beforeAll(async () => {
		projectId = (await ok<{ projectId: string }>('create_project', { name: 'Grammar' })).projectId;
	});

	it('every click cue plays the one click voice at one level, speed 1, no jitter', async () => {
		const placed: Placed['clips'] = [];
		for (const at of [30, 90, 150]) {
			const r = await ok<Placed>('place_sound', {
				projectId,
				at,
				kind: 'appear',
				layers: [{ sound: { type: 'click' } }],
				mode: 'apply',
			});
			placed.push(r.clips[0]!);
		}
		expect(new Set(placed.map((c) => c.soundId)).size).toBe(1);
		expect(new Set(placed.map((c) => c.gainDb)).size).toBe(1);
		for (const c of placed) {
			expect(c.rate).toBe(1);
			expect(c.picked?.variation).toBe('voice');
		}
		expect(placed[0]!.picked?.voice).toBe('best');
		expect(placed[1]!.picked?.voice).toBe('placed');
	});

	it('keys are takes of one recording at speed 1; swap_sound next walks the sibling takes', async () => {
		const keys: Placed['clips'] = [];
		for (const at of [200, 206, 212]) {
			const r = await ok<Placed>('place_sound', {
				projectId,
				at,
				kind: 'appear',
				layers: [{ sound: { type: 'key' } }],
				mode: 'apply',
			});
			keys.push(r.clips[0]!);
		}
		const parents = keys.map((k) => parseTakeId(k.soundId)?.parentId);
		expect(new Set(parents).size).toBe(1);
		expect(parents[0]).toBeTruthy();
		for (let i = 1; i < keys.length; i++) expect(keys[i]!.soundId).not.toBe(keys[i - 1]!.soundId);
		for (const k of keys) {
			expect(k.rate).toBe(1);
			expect(k.picked?.variation).toBe('takes');
		}
		const swapped = await ok<{ to: { soundId: string }; cycle: { from: string } }>('swap_sound', {
			projectId,
			clipId: keys[0]!.clipId,
			to: 'next',
		});
		expect(parseTakeId(swapped.to.soundId)?.parentId).toBe(parents[0]);
		expect(swapped.cycle.from).toBe('takes');
		const doc = await docOf(projectId);
		const seq = Object.values(doc.sequences)[0]!;
		const clip = seq.clips[keys[0]!.clipId] as AudioClip & { sfx: ClipSfx };
		expect(clip.speed.rate).toBe(1);
	});

	it('a hit pick prefers the material of the hits already placed (wood)', async () => {
		const search = await ok<{ results: { soundId: string; title: string; materials?: string[] }[] }>(
			'search_sounds',
			{ types: ['hit'] },
		);
		const woodBlock = search.results.find((r) => r.title === 'Wooden block hit')!;
		expect(woodBlock.materials).toEqual(['wood']);
		await ok<Placed>('place_sound', {
			projectId,
			at: 300,
			layers: [{ soundId: woodBlock.soundId }],
			mode: 'apply',
		});
		const r = await ok<Placed>('place_sound', {
			projectId,
			at: 400,
			layers: [{ sound: { type: 'hit' } }],
			mode: 'apply',
		});
		const titles = new Map(search.results.map((x) => [x.soundId, x.title]));
		// the wooden ones rank first (the placed one second: used nearby), and the pick is the other wooden hit
		expect(titles.get(r.clips[0]!.picked!.from[0]!)).toMatch(/Wood/);
		expect(r.clips[0]!.title).toBe('Wood knock hit');
		expect(Math.abs(r.clips[0]!.rate - 1)).toBeLessThanOrEqual(0.02);
		// a picture of what was placed (clicks at one level, the keys, the hits) to look at
		const view = await call('view_sound_timeline', { projectId, range: { start: 0, end: 450 } });
		expect(view.isError, textOf(view)).toBeFalsy();
		const img = view.content.find((c) => c.type === 'image') as { data: string } | undefined;
		expect(img).toBeDefined();
		mkdirSync(join(ROOT, 'test-results', 'sd-grammar'), { recursive: true });
		writeFileSync(
			join(ROOT, 'test-results', 'sd-grammar', 'mcp-timeline.png'),
			Buffer.from(img!.data, 'base64'),
		);
	});

	it('plan_sound_design takes the style options and reports what the grammar did', async () => {
		await ok('apply_commands', {
			projectId,
			label: 'Style',
			commands: [{ type: 'soundDesign.setSettings', style: { personality: 'precise' } }],
		});
		const r = await ok<{
			proposalId: string | null;
			grammar?: { personality: string | null; runs: string; voices: Record<string, string> };
		}>('plan_sound_design', { projectId, style: { runs: 'flat', typing: 'words', musicCarriesCuts: false } });
		expect(r.grammar).toMatchObject({
			personality: 'precise',
			runs: 'flat',
			typing: 'words',
			musicCarriesCuts: false,
		});
		const cues = await ok<{ cues: unknown[]; stats: { musicCarriesCuts?: number } }>('find_sound_cues', {
			projectId,
			typing: 'silent',
			musicCarriesCuts: true,
			personality: 'calm',
		});
		expect(Array.isArray(cues.cues)).toBe(true);
	});
});
