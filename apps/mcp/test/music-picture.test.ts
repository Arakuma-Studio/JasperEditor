// Music to picture through MCP (spec 12 P6-E11; wp-note "Phase 6 → WP-E7"): a real engine and jasper-mcp (stdio).
// Generated C-major music with a drop at bar 17 (32 s) sits on A1, a hero cue at 00:00:20:15: find_music_drops names
// the drop, the key and where they play; remix_audio {landDropAt: "hero"} lands the drop there (within 1 ms, recorded
// as the remix's anchor); a later remix to another length keeps it; fit_music_to_picture end-on-bar ends the music on a
// bar line; plan_sound_design reports tuneToMusic / stopOnBar and tunes a chime; refusals are typed.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AudioClip, type ProjectDocument, readRemixAnchors, soundCuesOf } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropMusic } from '../../../packages/audio-fx/test/music.ts';
import { cleanEnv, engineReady, stopEngine, testPort } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.MCP_MUSIC_TEST_PORT);
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
function encodeWav(channels: Float32Array[], sr: number, _fmt?: string): Buffer {
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

async function docOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-music-'));
	const appdir = join(work, 'appdir');
	mkdirSync(appdir);
	const kit = join(work, 'kit');
	mkdirSync(kit);
	const chime = Float32Array.from({ length: Math.round(1.2 * SR) }, (_, i) => {
		const t = i / SR;
		return 0.5 * Math.min(1, t / 0.003) * Math.exp(-t / 0.6) * Math.sin(2 * Math.PI * 466.1638 * t);
	});
	writeFileSync(join(kit, 'chime.wav'), encodeWav([chime, chime], SR, 's16'));
	writeFileSync(
		join(kit, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [],
			sounds: [
				{
					file: 'chime.wav',
					title: 'Glass chime',
					types: ['chime'],
					tags: ['test'],
					author: 'Test',
					license: 'CC0-1.0',
				},
			],
		}),
	);
	writeFileSync(join(work, 'drop.wav'), encodeWav(dropMusic(SR, 120, 32, 17).audio, SR, 'f32'));
	const tone = Float32Array.from({ length: SR * 12 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR));
	writeFileSync(join(work, 'tone.wav'), encodeWav([tone, tone], SR, 'f32'));
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
	client = new Client({ name: 'vitest-mcp-music', version: '1.0.0' });
	await client.connect(transport);
	await ok('rescan_sound_library', { wait: true });
});

afterAll(async () => {
	await client?.close().catch(() => {});
	await stopEngine(engine);
	if (work) rmSync(work, { recursive: true, force: true });
});

describe('music to picture through MCP', () => {
	let projectId = '';
	let clipId = '';
	let cueId = '';
	const seqOf = (d: ProjectDocument) => Object.values(d.sequences)[0]!;

	beforeAll(async () => {
		projectId = (await ok<{ projectId: string }>('create_project', { name: 'Music to picture' })).projectId;
		const media = await ok<{ imported: { mediaId: string }[] }>('import_media', {
			projectId,
			paths: [join(work, 'drop.wav'), join(work, 'tone.wav')],
		});
		const placed = await ok<{ clips: { id: string; kind: string }[] }>('add_clip', {
			projectId,
			media: media.imported[0]!.mediaId,
			at: 0,
		});
		clipId = placed.clips[0]!.id;
		await ok('set_essential_sound', { projectId, clipIds: [clipId], audioType: 'music' });
		const tone = await ok<{ clips: { id: string }[] }>('add_clip', {
			projectId,
			media: media.imported[1]!.mediaId,
			at: 0,
			audioTrack: 'A3',
		});
		const r = await ok<{ results: { cueIds?: string[] }[] }>('apply_commands', {
			projectId,
			label: 'Hero',
			commands: [
				{
					type: 'soundCue.add',
					cues: [{ frame: 615, kind: 'emphasis', weight: 'hero', types: ['chime'], source: 'user' }],
				},
			],
		});
		cueId = soundCuesOf(seqOf(await docOf(projectId)))[0]!.id;
		void r;
		void tone;
	});

	it('find_music_drops names the drop at bar 17, where it plays now, the key and tempo', async () => {
		const r = await ok<{
			drops: { bar: number; mediaSeconds: number; playsAt: { frame: number } | null }[];
			key: { name: string; confidence: number } | null;
			bpm: number;
			summary: string;
		}>('find_music_drops', { projectId, clipId });
		console.info(`[mcp music] ${r.summary}`);
		expect(r.drops[0]!.bar).toBe(17);
		expect(Math.abs(r.drops[0]!.mediaSeconds - 32)).toBeLessThan(0.005);
		expect(r.drops[0]!.playsAt?.frame).toBe(960);
		expect(r.key?.name).toMatch(/^(C major|A minor)$/);
		expect(r.key!.confidence).toBeGreaterThanOrEqual(0.6);
		expect(Math.abs(r.bpm - 120)).toBeLessThan(1);
	});

	it('remix_audio {landDropAt: "hero"} lands the drop on the hero; a later remix keeps it', async () => {
		const r = await ok<{ drop: { landsAt: { frame: number }; errorMs: number }; lengthSeconds: number }>(
			'remix_audio',
			{ projectId, clipId, landDropAt: 'hero' },
		);
		expect(r.drop.landsAt.frame).toBe(615);
		expect(Math.abs(r.drop.errorMs)).toBeLessThanOrEqual(1);
		expect(Math.abs(r.lengthSeconds - 64)).toBeLessThanOrEqual(1.01);
		let seq = seqOf(await docOf(projectId));
		let pieces = Object.values(seq.clips).filter((c) => (c as AudioClip).remix) as AudioClip[];
		expect(pieces.length).toBeGreaterThan(1);
		expect(readRemixAnchors(pieces[0]!.remix)).toEqual([{ sourceSeconds: expect.any(Number), frame: 615 }]);
		const again = await ok<{ note?: string }>('remix_audio', {
			projectId,
			clipId: pieces[pieces.length - 1]!.id,
			targetDuration: { seconds: 50 },
		});
		expect(again.note).toMatch(/kept the landed drop at 00:00:20:15/);
		seq = seqOf(await docOf(projectId));
		pieces = Object.values(seq.clips).filter((c) => (c as AudioClip).remix) as AudioClip[];
		expect(readRemixAnchors(pieces[0]!.remix)[0]!.frame).toBe(615);
		clipId = pieces.sort((a, b) => a.start - b.start)[pieces.length - 1]!.id;
	});

	it('fit_music_to_picture end-on-bar ends the music just before a bar line, faded', async () => {
		const r = await ok<{ endsAt: { frame: number }; barLine: { frame: number }; fadeFrames: number }>(
			'fit_music_to_picture',
			{ projectId, clipId, mode: 'end-on-bar' },
		);
		expect(r.barLine.frame - r.endsAt.frame).toBeGreaterThan(0);
		// the latest frame ≥ 3 ms (0.09 frame) before the attack: within a frame and 3 ms of it
		expect(r.barLine.frame - r.endsAt.frame).toBeLessThan(1.09 + 1e-6);
		expect(r.fadeFrames).toBe(15);
		const seq = seqOf(await docOf(projectId));
		const c = seq.clips[clipId]!;
		expect(c.start + c.duration).toBe(r.endsAt.frame);
	});

	it('plan_sound_design takes tuneToMusic / stopOnBar and tunes the chime', async () => {
		const r = await ok<{
			grammar?: { tuneToMusic?: boolean; stopOnBar?: boolean; tuned?: number };
			table?: string;
		}>('plan_sound_design', { projectId, cues: [cueId], style: { stopBefore: true } });
		expect(r.grammar).toMatchObject({ tuneToMusic: true, stopOnBar: true, tuned: 1 });
		const off = await ok<{ grammar?: { tuneToMusic?: boolean; tuned?: number } }>('plan_sound_design', {
			projectId,
			cues: [cueId],
			style: { tuneToMusic: false, stopOnBar: false },
		});
		expect(off.grammar).toMatchObject({ tuneToMusic: false, tuned: 0 });
	});

	it('set_sound_cues {stopBefore: true} ends on the bar line the plan picks for the same cue; plain with stopOnBar off', async () => {
		// final carry-over cleanup, item 5: set_sound_cues kept the plain 0.25 s (only the plan read the beats). The
		// plan above analysed the music's beats (cached). A hero 9 frames after the landed drop (a downbeat at 615):
		// the plan's stop and set_sound_cues' are the same, by the same rule
		const added = await ok<{ added: { cueId: string }[] }>('set_sound_cues', {
			projectId,
			add: [{ frame: 624, kind: 'emphasis', weight: 'hero', types: ['chime'] }],
		});
		const hero = added.added[0]!.cueId;
		const plan = await ok<{ proposalId: string }>('plan_sound_design', {
			projectId,
			cues: [hero],
			style: { stopBefore: true },
		});
		const proposal = textOf(await call('get_proposal', { projectId, proposalId: plan.proposalId }));
		const m = /Stop before \S+ on the (bar line|beat): music -24 dB for ([\d.]+) s/.exec(proposal);
		expect(m, proposal.slice(0, 3000)).not.toBeNull();
		expect(m![1]).toBe('bar line');
		expect(Math.abs(Number(m![2]) - 0.3)).toBeLessThan(0.01);
		const set = await ok<{ stopsOnBar?: { update?: number; on: string }[] }>('set_sound_cues', {
			projectId,
			update: [{ cueId: hero, stopBefore: true }],
		});
		expect(set.stopsOnBar).toEqual([{ update: 0, on: 'downbeat' }]);
		const stopOf = async (id: string) =>
			soundCuesOf(seqOf(await docOf(projectId))).find((c) => c.id === id)!.stopBefore;
		const stored = (await stopOf(hero))!;
		expect(Math.round(stored.seconds * 1000) / 1000).toBe(Number(m![2]));
		expect(stored.depthDb).toBe(-24);
		// add with stopBefore: the same rule (the downbeat at 615 is 10 frames before 625)
		const more = await ok<{ added: { cueId: string }[]; stopsOnBar?: unknown }>('set_sound_cues', {
			projectId,
			add: [{ frame: 625, kind: 'cut', weight: 'support', stopBefore: true }],
		});
		expect(more.stopsOnBar).toEqual([{ add: 0, on: 'downbeat' }]);
		expect(Math.abs((await stopOf(more.added[0]!.cueId))!.seconds - 10 / 30)).toBeLessThan(0.01);
		// the style switched off: the plain 0.25 s
		await ok('apply_commands', {
			projectId,
			label: 'Style',
			commands: [{ type: 'soundDesign.setSettings', style: { stopOnBar: false } }],
		});
		const off = await ok<{ stopsOnBar?: unknown }>('set_sound_cues', {
			projectId,
			update: [{ cueId: hero, stopBefore: true }],
		});
		expect(off.stopsOnBar).toBeUndefined();
		expect(await stopOf(hero)).toEqual({ seconds: 0.25, depthDb: -24 });
		await ok('set_sound_cues', { projectId, remove: { cueIds: [hero, more.added[0]!.cueId] } });
		await ok('apply_commands', {
			projectId,
			label: 'Style',
			commands: [{ type: 'soundDesign.setSettings', style: { stopOnBar: true } }],
		});
	});

	it('refusals are typed', async () => {
		const code = async (name: string, args: Record<string, unknown>) => {
			const r = await call(name, args);
			expect(r.isError, `${name} ${JSON.stringify(args)}: ${textOf(r)}`).toBe(true);
			return textOf(r);
		};
		expect(await code('remix_audio', { projectId, clipId })).toMatch(/E_INVALID_PARAM/);
		expect(await code('remix_audio', { projectId, clipId, landDropAt: { cueId: 'cue_nope' } })).toMatch(
			/E_NOT_FOUND/,
		);
		expect(await code('remix_audio', { projectId, clipId, landDropAt: 300, dropSec: 500 })).toMatch(
			/E_INVALID_PARAM/,
		);
		expect(await code('fit_music_to_picture', { projectId, clipId, mode: 'bounce' })).toMatch(/mode/);
		const toneClip = Object.values(seqOf(await docOf(projectId)).clips).find(
			(c) => c.kind === 'audio' && !(c as AudioClip).remix && (c as AudioClip).essential === undefined,
		)!;
		const t = await ok<{ drops: unknown[]; reason?: string }>('find_music_drops', {
			projectId,
			clipId: toneClip.id,
		});
		expect(t.drops).toEqual([]);
		expect(t.reason).toBe('NO_BEAT');
		expect(
			await code('fit_music_to_picture', { projectId, clipId: toneClip.id, mode: 'end-on-bar' }),
		).toMatch(/no steady beat/);
		expect(await code('remix_audio', { projectId, clipId: toneClip.id, landDropAt: 30 })).toMatch(
			/REMIX_NO_BEAT/,
		);
	});
});
