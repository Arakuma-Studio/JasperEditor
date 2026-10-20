// sound_check and view_sound_timeline (spec 12 §2.10, P5-R2; wp-note "Phase 5 → WP5.1") through jasper-mcp over stdio
// against a real engine with generated media: a hit placed on a cut cue and then nudged 2 frames late is found
// (OUT_OF_SYNC, offset in ms) with a safe fix whose tool call resolves it; the re-check passes and stores its summary;
// the pictures decode; strict arguments and typed refusals.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SoundCheckIssue } from '@jasper/api';
import { type ProjectDocument, soundCheckStatus } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provenance, writeBedFixture, writeTick } from '../../engine/test/sound-bed-fixture.ts';
import { decodePng } from '../src/png.ts';
import { cleanEnv, testPort, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.MCP_SOUND_CHECK_TEST_PORT);

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
const imagesOf = (r: CallToolResult) =>
	r.content.filter((c) => c.type === 'image') as { type: 'image'; data: string; mimeType: string }[];

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
	return { json: JSON.parse(textOf(r)) as T, result: r };
}
async function documentOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-check-'));
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
				JASPER_SOUND_SYNTH_VARIANTS: '1',
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
	client = new Client({ name: 'vitest-mcp-sound-check', version: '1.0.0' });
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

type Check = {
	jobId: string;
	verdict: string;
	listen: string[];
	findings: string[];
	issues: SoundCheckIssue[];
	table: string;
	stored: boolean;
	next: string;
	loudness: { integratedLufs: number | null; measurable: boolean };
};

describe('sound_check / view_sound_timeline', { timeout: 900_000 }, () => {
	it('finds a 2-frame late hit, its safe fix resolves it, the re-check passes and is stored; pictures decode', async () => {
		const files = writeBedFixture(join(work, 'media'));
		// the clean mix of the engine's Sound Check fixture (wp-note "Phase 6 → WP-E1"): a 1 kHz click (the 3 kHz one is
		// harsh over this music, P6-E2), the music 1.5 dB up and faded out over its last 2 s (P6-E3 ENDING)
		files.click = writeTick(join(work, 'media'));
		const { json: created } = await ok<{ projectId: string }>('create_project', {
			name: 'Sound Check',
			preset: 'hd-1080p-30',
		});
		const projectId = created.projectId;
		const { json: imp } = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [files.music, files.speech, files.hit, files.click],
		});
		const [music, speech, hit, click] = imp.imported.map((m) => m.mediaId) as [
			string,
			string,
			string,
			string,
		];
		const { json: built } = await ok<{ refs: Record<string, string> }>('apply_commands', {
			projectId,
			label: 'Bed and sounds',
			commands: [
				{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
				{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
				{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
				{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'dialogue' },
				{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
				{ type: 'audio.setGain', clipIds: ['$m'], mode: 'set', db: 1.5 },
				{
					type: 'transition.add',
					clipId: '$m',
					edge: 'out',
					effectId: 'jasper.exponential-fade',
					duration: 60,
				},
				{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
				{
					type: 'media.setLibraryInfo',
					mediaId: click,
					library: {
						...provenance('click'),
						descriptors: {
							...provenance('click').descriptors,
							octaveBandsDb: [-80, -70, -40, -14, -24, -50, -70],
							centroidHz: 1000,
						},
					},
				},
				{
					type: 'soundCue.add',
					cues: [{ frame: 30, kind: 'cut', weight: 'hero', source: 'agent', ref: '$a' }],
				},
				{
					type: 'soundDesign.place',
					cueId: '$a',
					layers: [{ mediaId: hit, role: 'hero', align: 'peak', ref: '$h' }],
				},
				{
					type: 'soundCue.add',
					cues: [{ frame: 90, kind: 'cut', weight: 'support', source: 'agent', ref: '$b' }],
				},
				{
					type: 'soundDesign.place',
					cueId: '$b',
					layers: [{ mediaId: click, role: 'support', align: 'peak' }],
				},
			],
		});
		const hitClip = built.refs.$h!;
		await ok('apply_commands', {
			projectId,
			label: 'Nudge',
			commands: [{ type: 'clip.move', clipIds: [hitClip], deltaFrames: 2 }],
		});

		const { json: first, result: r1 } = await ok<Check>('sound_check', { projectId });
		expect(first.verdict).toBe('fail');
		const sync = first.issues.find((i) => i.code === 'OUT_OF_SYNC')!;
		expect(sync, first.findings.join('\n')).toBeDefined();
		expect(sync.timecode).toBe('00:00:01:00');
		expect(Math.abs((sync.measured!.offsetMs as number) - 66.7)).toBeLessThan(2);
		expect(sync.fix).toMatchObject({ safe: true, tool: 'align_peak', kind: 'commands' });
		expect(first.findings.some((f) => f.startsWith('ERROR OUT_OF_SYNC @ 00:00:01:00'))).toBe(true);
		expect(first.listen[0]).toMatch(/^00:00:01:00 — Worst finding: /);
		expect(first.table).toMatch(/^clip \| timecode \| sound/);
		expect(first.next).toMatch(/safe fix/);
		// one PNG of the worst moment(s)
		const imgs = imagesOf(r1);
		expect(imgs).toHaveLength(1);
		const png = decodePng(Buffer.from(imgs[0]!.data, 'base64'));
		expect(png.width).toBeGreaterThan(900);
		expect(png.height).toBeGreaterThan(300);

		// apply the safe fixes exactly as given (tool + args)
		for (const i of first.issues.filter((x) => x.fix?.safe)) await ok(i.fix!.tool, i.fix!.args);
		const { json: again, result: r2 } = await ok<Check>('sound_check', {
			projectId,
			store: true,
			images: false,
		});
		expect(again.verdict, again.findings.join('\n')).toBe('pass');
		expect(again.stored).toBe(true);
		expect(imagesOf(r2)).toHaveLength(0);
		expect(again.next).toMatch(/verbatim/);
		const doc = await documentOf(projectId);
		const seqId = Object.keys(doc.sequences)[0]!;
		expect(soundCheckStatus(doc, seqId)).toMatchObject({ state: 'current', summary: { verdict: 'pass' } });

		// the timeline picture over the first 4 s with the first check's flags
		const { json: view, result: rv } = await ok<{
			cells: { cues: { frame: number; x: number }[]; issues: { code: string }[]; lanes: unknown[] };
		}>('view_sound_timeline', {
			projectId,
			range: { start: 0, end: { seconds: 4 } },
			checkJobId: first.jobId,
		});
		expect(view.cells.cues.map((c) => c.frame)).toEqual([30, 90]);
		expect(view.cells.issues.map((i) => i.code)).toContain('OUT_OF_SYNC');
		// the annotated sheet (WP-E3): no picture lane without video; spectrogram, sections and the sync lane added
		expect((view.cells.lanes as { name: string }[]).map((l) => l.name)).toEqual([
			'curves',
			'spectrogram',
			'wave',
			'sections',
			'sfx',
			'cues',
			'sync',
			'move',
			'check',
		]);
		const pic = decodePng(Buffer.from(imagesOf(rv)[0]!.data, 'base64'));
		expect(pic.width).toBe(1200);

		// strict arguments and typed refusals
		const unknown = await call('sound_check', { projectId, bogus: 1 });
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toMatch(/E_UNKNOWN_ARGUMENT/);
		const bad = await call('sound_check', { projectId, preset: 'loud' });
		expect(bad.isError).toBe(true);
		const long = await call('view_sound_timeline', { projectId, range: { start: 0, end: { seconds: 130 } } });
		expect(long.isError).toBe(true);
		expect(textOf(long)).toMatch(/RANGE_TOO_LONG/);
		const empty = await call('view_sound_timeline', { projectId, range: { start: 600, end: 700 } });
		expect(empty.isError).toBe(true);
		expect(textOf(empty)).toMatch(/RANGE_EMPTY/);
	});
});
