// acknowledge_sound_issue and sound_check {proposalId} (spec 12 §4 P6-E4, P6-E5; wp-note "Phase 6 → WP-E2") through
// jasper-mcp over stdio against a real engine with generated media: the clean Sound Check mix cut at a loud frame
// (ENDING) and a hit nudged 2 frames (OUT_OF_SYNC, an error):
//   - the agent acknowledges the ENDING warning with a reason → the re-check leaves it out of findings and the verdict,
//     lists it under acknowledged, counts it; get_sound_check agrees; unacknowledge brings it back;
//   - acknowledging the error is refused (E_APPROVAL_REQUIRED, nothing written), an unknown key E_NOT_FOUND, no reason
//     E_INVALID_PARAM;
//   - place_sound proposes the same hit again on the next cut (a REPEAT): sound_check {proposalId} reports what it
//     introduces with the item, nothing applied, and get_proposal shows the same summary (soundCheck).
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SoundCheckIssue } from '@jasper/api';
import { type ProjectDocument, soundAcknowledgementsOf } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provenance, writeBedFixture, writeTick } from '../../engine/test/sound-bed-fixture.ts';
import { cleanEnv, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = Number(process.env.MCP_SOUND_ACK_TEST_PORT ?? 49563);

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
	return (await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 })) as CallToolResult;
}
async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('').slice(-2000)}`);
	return JSON.parse(textOf(r)) as T;
}
async function refused(name: string, args: Record<string, unknown>): Promise<{ code: string; text: string }> {
	const r = await call(name, args);
	expect(r.isError, textOf(r)).toBe(true);
	const t = textOf(r);
	const m = /"code":\s*"([A-Z_]+)"/.exec(t) ?? /\b(E_[A-Z_]+)\b/.exec(t);
	return { code: m?.[1] ?? '', text: t };
}
async function documentOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-ack-'));
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
	client = new Client({ name: 'vitest-mcp-sound-ack', version: '1.0.0' });
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
	verdict: string;
	counts: Record<string, number>;
	findings: string[];
	issues: SoundCheckIssue[];
	acknowledged?: { count: number; findings: string[]; notFound?: string[] };
	proposal?: {
		summary: string;
		verdict: string;
		checkedItems: string[];
		fixes: string[];
		introduces: string[];
		perItem: { itemId: string; fixes: string[]; introduces: string[] }[];
	};
	safeFixes: unknown[];
	next: string;
};

describe('acknowledge_sound_issue / sound_check {proposalId}', { timeout: 900_000 }, () => {
	it('acknowledges a warning (not an error), the check agrees; a proposal check reports what it introduces', async () => {
		const files = writeBedFixture(join(work, 'media'));
		files.click = writeTick(join(work, 'media'));
		const { projectId } = await ok<{ projectId: string }>('create_project', {
			name: 'Sound Check acknowledgements',
			preset: 'hd-1080p-30',
		});
		const imp = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [files.music, files.speech, files.hit, files.click],
		});
		const [music, speech, hit, click] = imp.imported.map((m) => m.mediaId) as [string, string, string, string];
		// the Sound Check fixture's clean mix, but the music is cut at a loud frame (no fade-out: ENDING)
		const built = await ok<{ refs: Record<string, string> }>('apply_commands', {
			projectId,
			label: 'Bed and sounds',
			commands: [
				{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
				{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
				{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
				{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'dialogue' },
				{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
				{ type: 'audio.setGain', clipIds: ['$m'], mode: 'set', db: 1.5 },
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
				{ type: 'soundCue.add', cues: [{ frame: 30, kind: 'cut', weight: 'hero', source: 'agent', ref: '$a' }] },
				{
					type: 'soundDesign.place',
					cueId: '$a',
					layers: [{ mediaId: hit, role: 'hero', align: 'peak', ref: '$h' }],
				},
				{
					type: 'soundCue.add',
					cues: [{ frame: 90, kind: 'cut', weight: 'support', source: 'agent', ref: '$b' }],
				},
				{ type: 'soundDesign.place', cueId: '$b', layers: [{ mediaId: click, role: 'support', align: 'peak' }] },
			],
		});
		const hitClip = built.refs.$h!;
		await ok('apply_commands', {
			projectId,
			label: 'Nudge',
			commands: [{ type: 'clip.move', clipIds: [hitClip], deltaFrames: 2 }],
		});

		const first = await ok<Check>('sound_check', { projectId, images: false });
		expect(first.verdict).toBe('fail');
		const ending = first.issues.find((i) => i.code === 'ENDING')!;
		const sync = first.issues.find((i) => i.code === 'OUT_OF_SYNC' && i.severity === 'error')!;
		expect(ending, first.findings.join('\n')).toBeDefined();
		expect(sync, first.findings.join('\n')).toBeDefined();
		expect(first.findings.some((f) => f.includes(`(${ending.id})`))).toBe(true);

		// refusals: the error is the user's call; an unknown key; no reason
		const before = await documentOf(projectId);
		const e1 = await refused('acknowledge_sound_issue', { projectId, key: sync.id, reason: 'Late on purpose' });
		expect(e1.code).toBe('E_APPROVAL_REQUIRED');
		expect(e1.text).toMatch(/Sound Check panel/);
		expect((await refused('acknowledge_sound_issue', { projectId, key: 'MASKED:nope', reason: 'x' })).code).toBe(
			'E_NOT_FOUND',
		);
		expect((await refused('acknowledge_sound_issue', { projectId, key: ending.id })).code).toBe('E_INVALID_PARAM');
		const seqId = Object.keys(before.sequences)[0]!;
		expect(soundAcknowledgementsOf((await documentOf(projectId)).sequences[seqId])).toEqual({});

		// the warning: acknowledged by the agent
		const ack = await ok<{ ok: boolean; key: string; finding: string }>('acknowledge_sound_issue', {
			projectId,
			key: ending.id,
			reason: 'It cuts to black on the hit: the hard stop is the joke',
		});
		expect(ack.ok).toBe(true);
		expect(soundAcknowledgementsOf((await documentOf(projectId)).sequences[seqId])[ending.id]).toMatchObject({
			by: 'agent',
			code: 'ENDING',
			reason: 'It cuts to black on the hit: the hard stop is the joke',
		});
		// the kept report re-read with the acknowledgement (no new check)
		const kept = await ok<Check>('get_sound_check', { projectId });
		expect(kept.acknowledged?.count).toBe(1);
		expect(kept.findings.some((f) => f.includes(ending.id))).toBe(false);
		// the re-check: left out of findings and the counts, listed under acknowledged
		const again = await ok<Check>('sound_check', { projectId, images: false });
		expect(again.counts.acknowledged).toBe(1);
		expect(again.counts.ENDING).toBeUndefined();
		expect(again.findings.some((f) => f.includes(ending.id))).toBe(false);
		expect(again.acknowledged!.findings[0]).toMatch(/ENDING .*acknowledged by agent .*the hard stop is the joke/);
		expect(again.issues.find((i) => i.id === ending.id)!.acknowledged).toMatchObject({ active: true, by: 'agent' });
		expect(again.verdict).toBe('fail'); // the error still counts

		// unacknowledge: it counts again
		await ok('acknowledge_sound_issue', { projectId, key: ending.id, unacknowledge: true });
		const back = await ok<Check>('get_sound_check', { projectId });
		expect(back.findings.some((f) => f.includes(ending.id))).toBe(true);
		expect(back.acknowledged).toBeUndefined();

		// a proposal: the same hit on the next cut (a REPEAT of the hero on cue A)
		const placed = await ok<{ proposalId: string }>('place_sound', {
			projectId,
			at: 60,
			kind: 'cut',
			layers: [{ mediaId: hit, role: 'support', align: 'peak' }],
		});
		expect(placed.proposalId).toMatch(/^prp_/);
		const revBefore = (await ok<{ revision: number }>('get_project', { projectId })).revision;
		const pc = await ok<Check>('sound_check', { projectId, proposalId: placed.proposalId });
		expect(pc.proposal!.summary).toMatch(/^Sound Check of this proposal: fixes \d+ · introduces \d+/);
		const repeat = pc.proposal!.introduces.find((l) => l.startsWith('WARNING REPEAT'));
		expect(repeat, JSON.stringify(pc.proposal, null, 1)).toBeDefined();
		expect(repeat).toMatch(/— item place/);
		expect(pc.proposal!.perItem.some((x) => x.introduces.some((k) => k.startsWith('REPEAT:')))).toBe(true);
		expect(pc.safeFixes).toEqual([]);
		expect(pc.next).toMatch(/introduces/);
		expect((await ok<{ revision: number }>('get_project', { projectId })).revision).toBe(revBefore);
		// get_proposal shows the same summary
		const gp = await ok<{ soundCheck: Check['proposal'] | null }>('get_proposal', {
			projectId,
			proposalId: placed.proposalId,
		});
		expect(gp.soundCheck).toMatchObject({
			summary: pc.proposal!.summary,
			introduces: pc.proposal!.introduces,
			fixes: pc.proposal!.fixes,
		});
		// a proposal check never stores the summary in the sequence
		const r = await refused('sound_check', { projectId, proposalId: placed.proposalId, store: true });
		expect(r.code).toBe('E_INVALID_PARAM');
	});
});
