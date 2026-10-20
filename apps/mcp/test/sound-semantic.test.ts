// Describe-it search MCP tools end to end (spec 12 P6-E14, WP-E9): a real engine (temp appdir, a generated starter kit
// of badly named tones and a long field recording, the tiny stand-in model of @jasper/testkit as its catalogue) driven
// by jasper-mcp over stdio: describe_search_status before and after install, search_sounds {describe} in keyword
// fallback and in semantic mode (rows with match), prepare_describe_search, match_sound, find_sound_moment on the
// recording, and
// insert_sound_moment placing that range in one transaction (its undo is covered by packages/project's
// sound-moment.test.ts: undo needs an editor session). No network.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLICKS_PER_SECOND, type ProjectDocument } from '@jasper/project';
import { writeTinyClapCatalog } from '@jasper/testkit/tiny-clap';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, testPort, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.MCP_SEMANTIC_TEST_PORT);
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
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('')}\n${engineLog.join('')}`);
	return JSON.parse(textOf(r)) as T;
}

function tone(seconds: number, freq: number, amp = 0.4): Float32Array {
	const x = new Float32Array(Math.round(seconds * SR));
	for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
	return x;
}
/** A 16-bit mono WAV of `x`. */
function wav(path: string, x: Float32Array) {
	mkdirSync(dirname(path), { recursive: true });
	const buf = Buffer.alloc(44 + x.length * 2);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + x.length * 2, 4);
	buf.write('WAVEfmt ', 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(SR, 24);
	buf.writeUInt32LE(SR * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(x.length * 2, 40);
	for (let i = 0; i < x.length; i++)
		buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32000), 44 + i * 2);
	writeFileSync(path, buf);
}

function makeKit(dir: string) {
	wav(join(dir, 'SFX_0001.wav'), tone(1, 7000));
	wav(join(dir, 'SFX_0002.wav'), tone(1, 120));
	const field = tone(30, 110, 0.2);
	field.set(tone(1, 7000, 0.5), 17 * SR);
	wav(join(dir, 'field.wav'), field);
	const pack = {
		id: 'test-tones',
		title: 'Test tones',
		url: 'https://example.invalid/tones.zip',
		sha256: 'a'.repeat(64),
		license: 'CC0-1.0',
		licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
		author: 'Test Author',
	};
	const sound = (file: string, title: string) => ({
		file,
		title,
		types: [],
		tags: [],
		author: 'Test Author',
		license: 'CC0-1.0',
		sourceUrl: 'https://example.invalid/sounds',
		packId: pack.id,
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [pack],
			sounds: [
				sound('SFX_0001.wav', 'SFX_0001'),
				sound('SFX_0002.wav', 'SFX_0002'),
				sound('field.wav', 'Field recording'),
			],
		}),
	);
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-clap-'));
	const appdir = join(work, 'appdir');
	mkdirSync(appdir);
	makeKit(join(work, 'kit'));
	const catalog = writeTinyClapCatalog(join(work, 'models'));
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
				JASPER_MODEL_CATALOG: catalog,
			}),
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	engine.stdout?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	engine.stderr?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	await waitFor(
		async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
		120_000,
		`the engine on ${PORT}`,
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), '--appdir', appdir],
		cwd: ROOT,
		env: cleanEnv(),
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
	client = new Client({ name: 'vitest-mcp-clap', version: '1.0.0' });
	await client.connect(transport);
}, 240_000);

afterAll(async () => {
	await client?.close().catch(() => {});
	if (engine && engine.exitCode === null) {
		const exited = new Promise((r) => engine!.once('exit', r));
		engine.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
	}
	if (work) rmSync(work, { recursive: true, force: true });
}, 30_000);

async function documentOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}

type Row = { soundId: string; title: string; match?: { z: number; verdict: string } };
type Search = {
	results: Row[];
	describe?: { mode: string; reason?: string; embedded: number; pending: number };
};

describe('Describe-it search over MCP', { timeout: 900_000 }, () => {
	it('falls back to keywords without the model, installs it, ranks by sound, finds and places a moment', async () => {
		await ok('rescan_sound_library', { wait: true });
		const before = await ok<{
			status: string;
			models: { modelId: string; license: string; installed: boolean }[];
		}>('describe_search_status');
		expect(before.status).toBe('not-installed');
		expect(before.models[0]).toMatchObject({ modelId: 'clap-test', license: 'Apache-2.0', installed: false });
		const kw = await ok<Search>('search_sounds', { describe: 'field', license: 'any' });
		expect(kw.describe).toMatchObject({ mode: 'keywords' });
		expect(kw.results.map((r) => r.title)).toEqual(['Field recording']);
		const noModel = await call('find_sound_moment', { soundId: kw.results[0]!.soundId, description: 'high' });
		expect(noModel.isError).toBe(true);
		expect(textOf(noModel)).toContain('MODEL_NOT_INSTALLED');

		const inst = await ok<{ state: string; model: { license: string } }>('install_describe_search_model', {
			wait: true,
		});
		expect(inst).toMatchObject({ state: 'succeeded', model: { license: 'Apache-2.0' } });
		await waitFor(
			async () => {
				const s = await ok<{ embedded: number; total: number; job: unknown }>('describe_search_status');
				return s.job === null && s.embedded === s.total;
			},
			300_000,
			'the library embedded after install',
		);
		const prep = await ok<{ state: string; embedded: number; reused: number }>('prepare_describe_search', {
			wait: true,
		});
		expect(prep).toMatchObject({ state: 'succeeded', embedded: 0, reused: 3 });

		const high = await ok<Search>('search_sounds', { describe: 'high', license: 'any' });
		expect(high.describe).toMatchObject({ mode: 'semantic', embedded: 3, pending: 0 });
		expect(high.results[0]!.title).toBe('SFX_0001');
		expect(high.results[0]!.match?.verdict).toMatch(/^(strong|plausible|weak|none)$/);

		const matched = await ok<{ matches: { text: string; share: number }[]; best: string }>('match_sound', {
			soundId: high.results[0]!.soundId,
			description: 'high',
			alternatives: ['low'],
		});
		expect(matched.best).toBe('high');
		expect(matched.matches.map((x) => x.text)).toEqual(['high', 'low']);
		const field = kw.results[0]!.soundId;
		const found = await ok<{ moments: { startSec: number; endSec: number; verdict: string }[] }>(
			'find_sound_moment',
			{
				soundId: field,
				description: 'high',
				lengthSec: 1,
				count: 1,
			},
		);
		expect(found.moments).toHaveLength(1);
		const m = found.moments[0]!;
		expect(m.startSec).toBeGreaterThanOrEqual(16.5);
		expect(m.endSec).toBeLessThanOrEqual(18.6);

		const { projectId } = await ok<{ projectId: string }>('create_project', { name: 'Moments' });
		const placed = await ok<{
			clipId: string;
			trackCreated: boolean;
			start: { frame: number };
			historyLabel: string;
		}>('insert_sound_moment', { projectId, soundId: field, startSec: m.startSec, endSec: m.endSec, at: 30 });
		expect(placed).toMatchObject({ trackCreated: true, start: { frame: 30 } });
		expect(placed.historyLabel).toContain('Add Sound Moment');
		const doc = await documentOf(projectId);
		const clip = Object.values(doc.sequences)
			.map((q) => q.clips[placed.clipId])
			.find(Boolean) as { sourceIn: number; start: number } | undefined;
		expect(clip?.start).toBe(30);
		// the registered copy has 50 ms of lead silence in front: the range starts that much later in it
		expect(
			Math.abs(clip!.sourceIn - Math.round((m.startSec + 0.05) * FLICKS_PER_SECOND)),
		).toBeLessThanOrEqual(1);
		const bad = await call('insert_sound_moment', {
			projectId,
			soundId: field,
			startSec: 5,
			endSec: 4,
			at: 0,
		});
		expect(bad.isError).toBe(true);
	});
});
