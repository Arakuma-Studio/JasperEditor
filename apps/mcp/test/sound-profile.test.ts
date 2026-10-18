// Reference sound profiles through jasper-mcp (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4") over stdio against a real
// engine: build_sound_profile from three generated soundtracks (by path), list / get, set_sound_profile (one undo step),
// sound_check's Reference rows (the same rows, statuses and advice as the job's report, which the editor's panel shows),
// a mismatching soundtrack flagged, export → import through a file, a hostile file refused, delete refused without an
// editor window, strict arguments.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoundCheckResultSchema } from '@jasper/api';
import { type ProjectDocument, soundDesignSettingsOf } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.MCP_SOUND_PROFILE_TEST_PORT ?? 49587);
const SR = 48_000;

const textOf = (r: CallToolResult) =>
	r.content
		.filter((c) => c.type === 'text')
		.map((c) => (c as { text: string }).text)
		.join('\n');

let engine: ChildProcess | null = null;
let work = '';
let client: Client;
const token = randomBytes(16).toString('hex');
const editorKey = randomBytes(16).toString('hex');
const logs: string[] = [];
const engineLog: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 900_000,
	})) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('').slice(-2000)}`);
	return JSON.parse((r.content[0] as { text: string }).text) as T;
}
async function refused(name: string, args: Record<string, unknown>): Promise<{ code: string; text: string }> {
	const r = await call(name, args);
	expect(r.isError, textOf(r)).toBe(true);
	const t = textOf(r);
	const m = /"code":\s*"([A-Z_]+)"/.exec(t) ?? /\b(E_[A-Z_]+|[A-Z]+_[A-Z_]+)\b/.exec(t);
	return { code: m?.[1] ?? '', text: t };
}
async function documentOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		return (s / 2 ** 32) * 2 - 1;
	};
}
/** 12 s: quiet stereo noise, a 3 kHz click every second; `lowpass` dulls the noise (no air). */
function soundtrack(seed: number, lowpass = false): Buffer {
	const n = 12 * SR;
	const r = rng(seed);
	const ch = [new Float32Array(n), new Float32Array(n)];
	let y0 = 0;
	let y1 = 0;
	for (let i = 0; i < n; i++) {
		const a = r() * 0.02;
		const b = r() * 0.02;
		y0 = lowpass ? y0 + 0.05 * (a - y0) : a;
		y1 = lowpass ? y1 + 0.05 * (b - y1) : b;
		ch[0]![i] = y0 * (lowpass ? 4 : 1);
		ch[1]![i] = y1 * (lowpass ? 4 : 1);
	}
	for (let t = 0.5; t < 12; t += 1)
		for (const c of ch) {
			const at = Math.round(t * SR);
			for (let i = 0; i < 0.02 * SR; i++)
				c[at + i]! += 0.5 * Math.exp(-i / (SR * 0.003)) * Math.sin((2 * Math.PI * 3000 * i) / SR);
		}
	const b = Buffer.alloc(44 + n * 4);
	b.write('RIFF', 0);
	b.writeUInt32LE(36 + n * 4, 4);
	b.write('WAVEfmt ', 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(2, 22);
	b.writeUInt32LE(SR, 24);
	b.writeUInt32LE(SR * 4, 28);
	b.writeUInt16LE(4, 32);
	b.writeUInt16LE(16, 34);
	b.write('data', 36);
	b.writeUInt32LE(n * 4, 40);
	for (let i = 0; i < n; i++)
		for (let k = 0; k < 2; k++)
			b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(ch[k]![i]! * 32767))), 44 + (i * 2 + k) * 2);
	return b;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-profile-'));
	const appdir = join(work, 'appdir');
	mkdirSync(appdir);
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{
			cwd: ROOT,
			env: cleanEnv({
				JASPER_LOCAL_TOKEN: token,
				JASPER_EDITOR_KEY: editorKey,
				JASPER_SOUND_AUTO_INDEX: '0',
			}),
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	engine.stdout?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	engine.stderr?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	await waitFor(
		async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).ok,
		300_000,
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
	client = new Client({ name: 'vitest-mcp-sound-profile', version: '1.0.0' });
	await client.connect(transport);
}, 600_000);

afterAll(async () => {
	await client?.close().catch(() => {});
	if (engine && engine.exitCode === null) {
		const exited = new Promise((r) => engine!.once('exit', r));
		engine.kill('SIGTERM');
		await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
	}
	if (work) rmSync(work, { recursive: true, force: true });
}, 30_000);

describe('reference sound profiles through MCP', { timeout: 900_000 }, () => {
	it('build, list, get, set, sound_check rows (as the report), export → import, refusals', async () => {
		const media = join(work, 'media');
		mkdirSync(media);
		const refs = [1, 2, 3].map((s) => {
			const p = join(media, `ref${s}.wav`);
			writeFileSync(p, soundtrack(s));
			return p;
		});
		const none = await ok<{ profiles: unknown[]; next: string }>('list_sound_profiles');
		expect(none.profiles).toEqual([]);
		expect(none.next).toMatch(/no bundled profile/i);
		const built = await ok<{ profile: { profileId: string; references: number }; next: string }>(
			'build_sound_profile',
			{ name: 'Clicks', paths: refs },
		);
		expect(built.profile.references).toBe(3);
		const profileId = built.profile.profileId;
		const got = await ok<{ metrics: string[]; references: { title: string }[] }>('get_sound_profile', {
			profileId,
		});
		expect(got.references.map((r) => r.title)).toEqual(['ref1.wav', 'ref2.wav', 'ref3.wav']);
		expect(
			got.metrics.find((l) => l.startsWith('Onset density (onset_rate): median ')),
			got.metrics.join('\n'),
		).toBeDefined();

		// a project with a matching soundtrack and one without air
		const { projectId } = await ok<{ projectId: string }>('create_project', {
			name: 'Profile',
			preset: 'hd-1080p-30',
		});
		const same = join(media, 'same.wav');
		writeFileSync(same, soundtrack(4));
		const dull = join(media, 'dull.wav');
		writeFileSync(dull, soundtrack(5, true));
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [same, dull],
		});
		const [a, b] = imp.imported.map((m) => m.mediaId) as [string, string];
		await ok('apply_commands', {
			projectId,
			label: 'Soundtrack',
			commands: [{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { audio: 'A1' } }],
		});
		const set = await ok<{ referenceProfile: string; name: string }>('set_sound_profile', {
			projectId,
			profileId,
		});
		expect(set).toMatchObject({ referenceProfile: profileId, name: 'Clicks' });
		const doc = await documentOf(projectId);
		expect(soundDesignSettingsOf(Object.values(doc.sequences)[0]!).referenceProfile).toBe(profileId);
		const listed = await ok<{ selected: string }>('list_sound_profiles', { projectId });
		expect(listed.selected).toBe(profileId);

		type Check = {
			jobId: string;
			reference: { rows: string[]; counts: { low: number; high: number }; profileId: string };
			findings: string[];
		};
		const c1 = await ok<Check>('sound_check', { projectId, images: false });
		expect(c1.reference.profileId).toBe(profileId);
		expect(c1.reference.counts.low + c1.reference.counts.high, c1.reference.rows.join('\n')).toBe(0);
		// MCP's rows are the report's rows (the panel draws the report), in order, with the same statuses
		const job = await ok<{ result: unknown }>('get_job', { jobId: c1.jobId });
		const report = SoundCheckResultSchema.parse(job.result).report;
		expect(c1.reference.rows).toHaveLength(report.reference!.rows.length);
		report.reference!.rows.forEach((r, i) => {
			expect(
				c1.reference.rows[i]!.startsWith(r.status === 'ok' ? 'ok ' : `${r.status.toUpperCase()} ${r.label}`),
			).toBe(true);
			expect(c1.reference.rows[i]).toContain(`(${r.metric}, ${r.weight})`);
		});
		// the dull soundtrack: air flagged (an info), its advice in the finding line
		await ok('apply_commands', {
			projectId,
			label: 'Dull soundtrack',
			commands: [{ type: 'clip.place', source: { mediaId: b }, at: 0, tracks: { audio: 'A2' } }],
		});
		const d = await ok<{ jobId: string; findings: string[] }>('sound_check', {
			projectId,
			images: false,
			profileId,
		});
		const air = d.findings.find((f) => f.includes('REFERENCE:band_air'));
		expect(air, d.findings.join('\n')).toBeDefined();
		expect(air).toMatch(/^INFO REFERENCE/);
		expect(air).toMatch(/what to do: No air/);
		const off = await ok<{ reference?: unknown }>('sound_check', {
			projectId,
			images: false,
			profileId: null,
		});
		expect(off.reference).toBeUndefined();

		// export → import through a file; a hostile file is refused
		const file = join(work, 'shared', 'clicks.json');
		await ok('export_sound_profile', { profileId, path: file });
		expect(readFileSync(file, 'utf8')).not.toContain(media);
		expect((await refused('export_sound_profile', { profileId, path: file })).code).toBe('E_EXISTS');
		const back = await ok<{ profile: { profileId: string; name: string } }>('import_sound_profile', {
			path: file,
			name: 'Clicks (shared)',
		});
		expect(back.profile.profileId).not.toBe(profileId);
		expect(back.profile.name).toBe('Clicks (shared)');
		const junk = join(work, 'junk.json');
		writeFileSync(
			junk,
			JSON.stringify({ format: 'jasper-sound-profile', version: 1, references: 'all of them' }),
		);
		expect((await refused('import_sound_profile', { path: junk })).code).toBe('SOUND_PROFILE_INVALID');
		writeFileSync(junk, 'not json');
		expect((await refused('import_sound_profile', { path: junk })).code).toBe('SOUND_PROFILE_INVALID');
		// delete is the user's: no editor window here
		const del = await refused('delete_sound_profile', { profileId });
		expect(del.text).toMatch(/E_APPROVAL_DENIED|APPROVAL_DENIED/);
		expect((await ok<{ profiles: unknown[] }>('list_sound_profiles')).profiles).toHaveLength(2);
		// strict arguments and typed refusals
		expect((await refused('get_sound_profile', { profileId: 'nope' })).text).toMatch(/profile id/);
		expect((await refused('build_sound_profile', { name: 'x' })).code).toBe('E_INVALID_PARAM');
		expect((await refused('build_sound_profile', { name: 'x', paths: ['relative.wav'] })).code).toBe(
			'E_INVALID_PARAM',
		);
		expect((await refused('get_sound_profile', { profileId: 'sprf_00000000000000ff' })).code).toBe(
			'SOUND_PROFILE_NOT_FOUND',
		);
		expect((await refused('set_sound_profile', { projectId, profileId, extra: 1 })).text).toMatch(/extra/);
	});
});
