// Phase 4 mixing tools (spec 12 §2.4 / §2.10; wp-note "Phase 4 → WP4.2a") through jasper-mcp over stdio against a real
// engine with generated media (music A1, dialogue 4–8 s on A2, a hit and a click): set_sound_cues stopBefore / build on a
// filled cue (written into the mix, removed with null), set_room_glue (on, idempotent, off), apply_delivery (propose by
// default, apply as one undo step with the measured numbers); strict arguments.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, type ProjectDocument, type SoundDesign } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provenance, writeBedFixture } from '../../engine/test/sound-bed-fixture.ts';
import { cleanEnv, engineReady, stopEngine, testPort } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.MCP_SOUND_MIX_TEST_PORT);

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';

let engine: ChildProcess | null = null;
let work = '';
let client: Client;
const token = randomBytes(16).toString('hex');
const editorKey = randomBytes(16).toString('hex');
const logs: string[] = [];
const engineLog: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args }, undefined, {
		timeout: 600_000,
	})) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('').slice(-2000)}`);
	return JSON.parse(textOf(r)) as T;
}
async function documentOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-mix-'));
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
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		},
	);
	engine.stdout?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	engine.stderr?.on('data', (d: Buffer) => engineLog.push(d.toString()));
	await engineReady(engine, PORT, engineLog);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--import', 'tsx', join(ROOT, 'apps/mcp/src/cli.ts'), '--appdir', appdir],
		cwd: ROOT,
		env: cleanEnv(),
		stderr: 'pipe',
	});
	transport.stderr?.on('data', (d: Buffer) => logs.push(d.toString('utf8')));
	client = new Client({ name: 'vitest-mcp-mix', version: '1.0.0' });
	await client.connect(transport);
});

afterAll(async () => {
	await client?.close().catch(() => {});
	await stopEngine(engine);
	if (work) rmSync(work, { recursive: true, force: true });
});

describe('Phase 4 mixing tools', () => {
	it('stop-before / build on a filled cue, room glue, delivery; strict arguments', async () => {
		const files = writeBedFixture(join(work, 'media'));
		const { projectId } = await ok<{ projectId: string }>('create_project', {
			name: 'Mix',
			preset: 'hd-1080p-30',
		});
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [files.music, files.speech, files.hit, files.click],
		});
		const [music, speech, hit, click] = imp.imported.map((m) => m.mediaId) as [
			string,
			string,
			string,
			string,
		];
		await ok('apply_commands', {
			projectId,
			label: 'Bed and sounds',
			commands: [
				{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
				{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
				{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
				{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'dialogue' },
				{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
				{ type: 'media.setLibraryInfo', mediaId: click, library: provenance('click') },
				{
					type: 'soundDesign.place',
					frame: 150,
					layers: [{ mediaId: click, role: 'support', align: 'peak' }],
				},
			],
		});
		// a hero cue with a stop-before and a build; filled with the hit → both written into the mix
		const added = await ok<{ added: { cueId: string }[] }>('set_sound_cues', {
			projectId,
			add: [{ frame: 90, kind: 'land', weight: 'hero', stopBefore: true, build: true }],
		});
		const cueId = added.added[0]!.cueId;
		await ok('apply_commands', {
			projectId,
			label: 'Fill',
			commands: [
				{ type: 'soundDesign.place', cueId, layers: [{ mediaId: hit, role: 'hero', align: 'peak' }] },
			],
		});
		let doc = await documentOf(projectId);
		let seq = Object.values(doc.sequences)[0]!;
		const a1 = () => seq.audioTracks[0]!;
		const T = 3 * 705_600_000;
		expect(evaluate(a1().volumeDb!, T - 0.1 * 705_600_000)).toBeCloseTo(-24, 6);
		expect(a1().effects?.[0]?.effectId).toBe('jasper.audio.scientific-filter');
		// cleared → removed exactly
		await ok('set_sound_cues', { projectId, update: [{ cueId, stopBefore: null, build: null }] });
		doc = await documentOf(projectId);
		seq = Object.values(doc.sequences)[0]!;
		expect(a1().volumeDb?.keyframes ?? []).toEqual([]);
		expect(a1().effects ?? []).toEqual([]);

		// room glue: on (sends from the SFX track), again (nothing new), off
		const on = await ok<{ busId: string; created: boolean; sends: { track: string }[] }>('set_room_glue', {
			projectId,
		});
		expect(on.created).toBe(true);
		expect(on.sends.length).toBe(1);
		const again = await ok<{ created: boolean; sends: { added: boolean }[] }>('set_room_glue', { projectId });
		expect(again.created).toBe(false);
		expect(again.sends.every((s) => !s.added)).toBe(true);
		doc = await documentOf(projectId);
		seq = Object.values(doc.sequences)[0]!;
		expect((seq.soundDesign as SoundDesign).mix!.room!.busId).toBe(on.busId);
		await ok('set_room_glue', { projectId, enabled: false });
		doc = await documentOf(projectId);
		seq = Object.values(doc.sequences)[0]!;
		expect(seq.submixTracks ?? []).toEqual([]);

		// delivery: propose by default (nothing changes), then apply
		const before = JSON.stringify((await documentOf(projectId)).sequences);
		const proposed = await ok<{
			mode: string;
			proposalId: string;
			table: string;
			measure: { musicUnderVoiceLu: number };
		}>('apply_delivery', { projectId, delivery: 'web' });
		expect(proposed.mode).toBe('propose');
		expect(proposed.proposalId).toMatch(/^prp_/);
		expect(proposed.table).toMatch(/^clip \| track \| type \| measured/);
		expect(JSON.stringify((await documentOf(projectId)).sequences)).toBe(before);
		const applied = await ok<{
			applied: boolean;
			measure: { musicUnderVoiceLu: number; expectedLufs: number };
		}>('apply_delivery', { projectId, delivery: 'web', mode: 'apply' });
		expect(applied.applied).toBe(true);
		expect(applied.measure.expectedLufs).toBe(-14);
		expect(applied.measure.musicUnderVoiceLu).toBeGreaterThanOrEqual(8);
		doc = await documentOf(projectId);
		seq = Object.values(doc.sequences)[0]!;
		expect(seq.master.loudness).toMatchObject({ enabled: true, targetLufs: -14, truePeakDb: -1 });

		// strict arguments
		const unknown = await call('apply_delivery', { projectId, delivery: 'web', bogus: 1 });
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toMatch(/E_UNKNOWN_ARGUMENT/);
		const badPreset = await call('apply_delivery', { projectId, delivery: 'cinema' });
		expect(badPreset.isError).toBe(true);
		const badSend = await call('set_room_glue', { projectId, sendDb: 99 });
		expect(badSend.isError).toBe(true);
	});
});
