// rebalance_sfx (spec 12 §2.10, P4-R2; wp-note "Phase 4 → WP4.1b") through jasper-mcp over stdio against a real engine:
// generated media (a music bed on A1, dialogue without a transcript on A2 from 4 s to 8 s, a hero hit at 1 s, a click
// under the speech at 5 s). Propose by default (nothing changes, a proposal is stored); apply = one undo step with the
// solved gains in sfx.level; idempotent; the table names the dialogue track; strict arguments and typed refusals.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioClip, ClipSfx, ProjectDocument } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provenance, writeBedFixture } from '../../engine/test/sound-bed-fixture.ts';
import { cleanEnv, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.MCP_SOUND_REBALANCE_TEST_PORT ?? 49533);

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
type SfxClip = AudioClip & { sfx?: ClipSfx };

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-rebal-'));
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
	client = new Client({ name: 'vitest-mcp-rebalance', version: '1.0.0' });
	await client.connect(transport);
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

describe('rebalance_sfx', { timeout: 600_000 }, () => {
	it('proposes by default, applies as one undo step, is idempotent; strict arguments', async () => {
		const files = writeBedFixture(join(work, 'media'));
		const { projectId } = await ok<{ projectId: string }>('create_project', {
			name: 'Rebalance',
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
		const built = await ok<{ refs?: Record<string, string> }>('apply_commands', {
			projectId,
			label: 'Bed and sounds',
			commands: [
				{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
				{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
				{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
				{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'dialogue' },
				{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
				{ type: 'media.setLibraryInfo', mediaId: click, library: provenance('click') },
				{ type: 'soundDesign.place', frame: 30, layers: [{ mediaId: hit, role: 'hero', align: 'peak' }] },
				{
					type: 'soundDesign.place',
					frame: 150,
					layers: [{ mediaId: click, role: 'support', align: 'peak' }],
				},
			],
		});
		expect(built).toBeDefined();
		const before = await documentOf(projectId);
		const seq0 = Object.values(before.sequences)[0]!;
		const sfxIds = Object.values(seq0.clips)
			.filter((c) => (c as SfxClip).sfx)
			.map((c) => c.id);
		expect(sfxIds).toHaveLength(2);
		const musicClip = Object.values(seq0.clips).find(
			(c) => c.kind === 'audio' && !(c as SfxClip).sfx && c.trackId === seq0.audioTracks[0]!.id,
		)!;

		// default: a proposal, nothing changed
		const proposed = await ok<{
			mode: string;
			applied: boolean;
			proposalId: string;
			table: string;
			counts: { solved: number };
		}>('rebalance_sfx', { projectId });
		expect(proposed.mode).toBe('propose');
		expect(proposed.applied).toBe(false);
		expect(proposed.proposalId).toMatch(/^prp_/);
		expect(proposed.counts.solved).toBe(2);
		expect(proposed.table).toMatch(/^clip \| timecode \| sound/);
		expect(proposed.table).toMatch(/limited by dialogue A2/);
		const same = await documentOf(projectId);
		expect(JSON.stringify(same.sequences)).toBe(JSON.stringify(before.sequences));

		// apply: one transaction; the solved gains recorded
		const applied = await ok<{ applied: boolean; revision: number; table: string }>('rebalance_sfx', {
			projectId,
			mode: 'apply',
		});
		expect(applied.applied).toBe(true);
		const after = await documentOf(projectId);
		const seq = Object.values(after.sequences)[0]!;
		for (const id of sfxIds) expect((seq.clips[id] as SfxClip).sfx!.level).toMatchObject({ by: 'solver' });
		// again: nothing to change (idempotent)
		const again = await ok<{ applied: boolean; next: string }>('rebalance_sfx', { projectId, mode: 'apply' });
		expect(again.applied).toBe(false);
		expect(again.next).toMatch(/Nothing to change/);

		// autoGain (WP6.5b): an Auto-gain-off clip handed back and solved in the rebalance's own transaction
		const off = await ok<unknown>('apply_commands', {
			projectId,
			label: 'Auto gain off',
			commands: [{ type: 'soundDesign.setAutoGain', clipIds: [sfxIds[0]], auto: false }],
		});
		expect(off).toBeDefined();
		const offDoc = await documentOf(projectId);
		expect(
			((Object.values(offDoc.sequences)[0]!.clips[sfxIds[0]!] as SfxClip).sfx!.level as { manual?: boolean })
				.manual,
		).toBe(true);
		const handed = await ok<{ applied: boolean; autoGain?: { clipIds: string[] } }>('rebalance_sfx', {
			projectId,
			mode: 'apply',
			clipIds: [sfxIds[0]],
			autoGain: true,
		});
		expect(handed.applied).toBe(true);
		expect(handed.autoGain).toEqual({ clipIds: [sfxIds[0]] });
		const handedDoc = await documentOf(projectId);
		expect(
			(
				(Object.values(handedDoc.sequences)[0]!.clips[sfxIds[0]!] as SfxClip).sfx!.level as {
					manual?: boolean;
				}
			).manual,
		).toBeUndefined();
		const noApply = await call('rebalance_sfx', { projectId, clipIds: [sfxIds[0]], autoGain: true });
		expect(noApply.isError).toBe(true);
		expect(textOf(noApply)).toMatch(/E_INVALID_PARAM.*autoGain needs mode/);

		// strict arguments and typed refusals
		const bad = await call('rebalance_sfx', { projectId, mode: 'yes' });
		expect(bad.isError).toBe(true);
		const unknown = await call('rebalance_sfx', { projectId, bogus: 1 });
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toMatch(/E_UNKNOWN_ARGUMENT/);
		const notSfx = await call('rebalance_sfx', { projectId, clipIds: [musicClip.id] });
		expect(notSfx.isError).toBe(true);
		expect(textOf(notSfx)).toMatch(/NOT_SFX/);
	});
});
