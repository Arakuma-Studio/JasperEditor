// listen_to_sequence and the annotated view_sound_timeline (spec 12 §4 P6-E6, P6-E7; wp-note "Phase 6 → WP-E3")
// through jasper-mcp over stdio against a real engine with generated media: music, dialogue with a knock in it, a hit
// and a click on cues, three colour mattes on V1 (a cut on the click's cue, a cut with no sound). The transcript comes
// first and equals the job's lines (the Log tab prints the same); the JSON names the cut with no sound; the sheet PNG
// decodes and `cells` locates every lane, cue, mark and thumbnail; strict arguments and typed refusals.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoundListenResultSchema } from '@jasper/api';
import type { ProjectDocument } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	hitSamples,
	provenance,
	SR,
	speechSamples,
	writeBedFixture,
	writeTick,
} from '../../engine/test/sound-bed-fixture.ts';
import { decodePng } from '../src/png.ts';
import type { RgbaImage } from '../src/sound-sheet.ts';
import type { TimelineCells } from '../src/sound-timeline.ts';
import { cleanEnv, engineReady, stopEngine, testPort } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = await testPort(process.env.MCP_SOUND_LISTEN_TEST_PORT);

const texts = (r: CallToolResult) =>
	r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
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
async function ok(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
	const r = await call(name, args);
	if (r.isError) throw new Error(`${name} failed: ${texts(r).join('\n')}\n${logs.join('').slice(-2000)}`);
	return r;
}
const json = <T = Record<string, unknown>>(r: CallToolResult, i = 0) => JSON.parse(texts(r)[i]!) as T;
async function documentOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}
const px = (img: RgbaImage, x: number, y: number) => {
	const o = (y * img.width + x) * 4;
	return [img.data[o]!, img.data[o + 1]!, img.data[o + 2]!] as const;
};
/** 16-bit PCM WAV of planar channels. */
function wav16(ch: Float32Array[], sr: number): Buffer {
	const n = ch[0]!.length;
	const c = ch.length;
	const b = Buffer.alloc(44 + n * c * 2);
	b.write('RIFF', 0);
	b.writeUInt32LE(36 + n * c * 2, 4);
	b.write('WAVEfmt ', 8);
	b.writeUInt32LE(16, 16);
	b.writeUInt16LE(1, 20);
	b.writeUInt16LE(c, 22);
	b.writeUInt32LE(sr, 24);
	b.writeUInt32LE(sr * c * 2, 28);
	b.writeUInt16LE(c * 2, 32);
	b.writeUInt16LE(16, 34);
	b.write('data', 36);
	b.writeUInt32LE(n * c * 2, 40);
	for (let i = 0; i < n; i++)
		for (let k = 0; k < c; k++)
			b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(ch[k]![i]! * 32767))), 44 + (i * c + k) * 2);
	return b;
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-listen-'));
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
	client = new Client({ name: 'vitest-mcp-sound-listen', version: '1.0.0' });
	await client.connect(transport);
});

afterAll(async () => {
	await client?.close().catch(() => {});
	await stopEngine(engine);
	if (work) rmSync(work, { recursive: true, force: true });
});

type Compact = {
	jobId: string;
	counts: { events: number; unanswered: number; lanes: number };
	unanswered: { frame: number; kind: string; label: string }[];
	placed: { clipId: string; heard: boolean; ownOffsetMs: number | null }[];
	sync: { cuts: { n: number; okPct: number; okChancePct: number } | null };
	sheet?: { strips: { start: number; end: number }[]; pictureLane: string[] };
	next: string;
};

describe('listen_to_sequence / view_sound_timeline sheet', () => {
	it('gives the transcript, the compact JSON and the annotated sheet; cells locate every lane, cue and thumbnail', async () => {
		const media = join(work, 'media');
		const files = writeBedFixture(media);
		files.click = writeTick(media);
		// the interview with a knock at 6.5 s
		const speech = speechSamples();
		const hit = hitSamples();
		const at = Math.round(6.45 * SR);
		for (let c = 0; c < 2; c++) for (let i = 0; i < hit[c]!.length; i++) speech[c]![at + i]! += hit[c]![i]!;
		const interview = join(media, 'interview.wav');
		writeFileSync(interview, wav16(speech, SR));
		const created = json<{ projectId: string }>(
			await ok('create_project', { name: 'Listen', preset: 'hd-1080p-30' }),
		);
		const projectId = created.projectId;
		const imp = json<{ imported: { mediaId: string }[] }>(
			await ok('import_media', { projectId, paths: [files.music, interview, files.hit, files.click] }),
		);
		const [music, talk, hitM, click] = imp.imported.map((m) => m.mediaId) as [string, string, string, string];
		const built = json<{ refs: Record<string, string> }>(
			await ok('apply_commands', {
				projectId,
				label: 'Bed, sounds, picture',
				commands: [
					{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
					{ type: 'clip.place', source: { mediaId: talk }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
					{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
					{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'dialogue' },
					{ type: 'audio.setGain', clipIds: ['$m'], mode: 'set', db: 1.5 },
					{
						type: 'transition.add',
						clipId: '$m',
						edge: 'out',
						effectId: 'jasper.exponential-fade',
						duration: 60,
					},
					{ type: 'media.setLibraryInfo', mediaId: hitM, library: provenance('hit') },
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
						layers: [{ mediaId: hitM, role: 'hero', align: 'peak' }],
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
					{ type: 'synthetic.create', kind: 'color-matte', params: { color: [0.9, 0.2, 0.2, 1] }, ref: '$r' },
					{ type: 'synthetic.create', kind: 'color-matte', params: { color: [0.2, 0.8, 0.3, 1] }, ref: '$g' },
					{ type: 'synthetic.create', kind: 'color-matte', params: { color: [0.2, 0.3, 0.9, 1] }, ref: '$u' },
				],
			}),
		);
		// the mattes on V1 (red, green, blue): cuts at 3 s (on cue B) and 9.3 s (nothing there)
		const all = Object.values((await documentOf(projectId)).items);
		const items = ['$r', '$g', '$u'].map(
			(ref) => all.find((i) => (i as { syntheticId?: string }).syntheticId === built.refs[ref])!,
		);
		expect(items.every(Boolean)).toBe(true);
		const shots = [
			[0, 90],
			[90, 279],
			[279, 300],
		] as const;
		for (const [k, [a, b]] of shots.entries()) {
			const placed = json<{ refs: Record<string, string> }>(
				await ok('apply_commands', {
					projectId,
					label: `Shot ${k + 1}`,
					commands: [
						{
							type: 'clip.place',
							source: { projectItemId: items[k]!.id },
							at: a,
							tracks: { video: 'V1' },
							ref: '$v',
						},
					],
				}),
			);
			const doc = await documentOf(projectId);
			const seq = Object.values(doc.sequences)[0]!;
			const clip = seq.clips[placed.refs.$v!]!;
			if (clip.duration !== b - a)
				await ok('apply_commands', {
					projectId,
					label: 'Trim',
					commands: [{ type: 'clip.trim', clipId: clip.id, edge: 'out', deltaFrames: b - a - clip.duration }],
				});
		}

		// the transcript first, then the compact JSON
		const r = await ok('listen_to_sequence', { projectId });
		expect(imagesOf(r)).toHaveLength(0);
		const [transcript] = texts(r);
		expect(transcript).toMatch(/^00:00:00:00 {2}Listened 00:00:00:00/);
		expect(transcript).toMatch(/SFX A\d "Test hit 0" \(hero, cue cut\)/);
		expect(transcript).toMatch(/dialogue, A2 "interview\.wav"/);
		expect(transcript).toMatch(/NO SOUND for Cut on V1/);
		expect(transcript).toMatch(/Sync, cuts: 1\/2 have a sound within 1 frame \(50 %; chance \d+ %\)/);
		const c = json<Compact>(r, 1);
		expect(c.unanswered.map((u) => [u.frame, u.kind])).toContainEqual([279, 'cut']);
		expect(c.placed).toHaveLength(2);
		for (const p of c.placed) {
			expect(p.heard).toBe(true);
			expect(Math.abs(p.ownOffsetMs!)).toBeLessThanOrEqual(1);
		}
		expect(c.sync.cuts).toMatchObject({ n: 2, okPct: 50 });
		expect(c.next).toMatch(/chance/);
		// the same lines the editor's Log tab prints (the job's result)
		const job = json<{ result: unknown }>(await ok('get_job', { jobId: c.jobId }));
		const result = SoundListenResultSchema.parse(job.result);
		expect(transcript).toBe(result.text);
		expect(transcript.split('\n')).toEqual(result.lines.map((l) => `${l.timecode}  ${l.text}`));

		// with images: the annotated sheet of the whole (10 s) range
		const ri = await ok('listen_to_sequence', { projectId, images: true, detail: 'low' });
		expect(texts(ri)).toHaveLength(2);
		const ci = json<Compact>(ri, 1);
		expect(ci.sheet!.strips).toEqual([expect.objectContaining({ start: 0, end: 300 })]);
		expect(ci.sheet!.pictureLane[0]).toMatch(/frame\(s\) rendered/);
		const sheet = decodePng(Buffer.from(imagesOf(ri)[0]!.data, 'base64'));
		expect(sheet.width).toBe(1200);
		// kept to be looked at (test-results is not committed)
		const out = join(ROOT, 'test-results', 'mcp-sound-listen');
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, 'listen-sheet.png'), Buffer.from(imagesOf(ri)[0]!.data, 'base64'));
		writeFileSync(join(out, 'transcript.txt'), transcript);

		// view_sound_timeline with that listen: every lane, cue, mark and thumbnail located
		const v = await ok('view_sound_timeline', {
			projectId,
			range: { start: 0, end: 300 },
			listenJobId: ci.jobId,
		});
		const view = json<{ cells: TimelineCells; listen: string; pictureLane: string }>(v);
		expect(view.listen).toBe('from the given listen job');
		const cells = view.cells;
		const lanes = cells.lanes.map((l) => l.name);
		expect(lanes).toEqual([
			'picture',
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
		for (let i = 1; i < cells.lanes.length; i++)
			expect(cells.lanes[i]!.y).toBeGreaterThanOrEqual(cells.lanes[i - 1]!.y + cells.lanes[i - 1]!.height);
		const img = decodePng(Buffer.from(imagesOf(v)[0]!.data, 'base64'));
		writeFileSync(join(out, 'view-sound-timeline.png'), Buffer.from(imagesOf(v)[0]!.data, 'base64'));
		writeFileSync(join(out, 'cells.json'), JSON.stringify(cells, null, 1));
		expect(img.height).toBeGreaterThan(cells.lanes.at(-1)!.y + cells.lanes.at(-1)!.height);
		// thumbnails at the cuts (and cues), each box holding its shot's colour
		expect(cells.thumbs.length).toBeGreaterThanOrEqual(3);
		expect(cells.thumbs.length).toBeLessThanOrEqual(12);
		const thumbAt = (f: number) => cells.thumbs.find((t) => t.frame === f);
		for (const [f, colour] of [
			[90, 'green'],
			[279, 'blue'],
		] as const) {
			const t = thumbAt(f)!;
			expect(t, JSON.stringify(cells.thumbs)).toBeDefined();
			const [r0, g0, b0] = px(img, t.x + Math.floor(t.width / 2), t.y + Math.floor(t.height / 2));
			if (colour === 'green') expect(g0).toBeGreaterThan(Math.max(r0, b0) + 60);
			else expect(b0).toBeGreaterThan(Math.max(r0, g0) + 60);
		}
		// cues located with their answer marks; the sync lane names the cut with no sound
		expect(cells.cues.map((q) => [q.frame, q.status])).toEqual([
			[30, 'ok'],
			[90, 'ok'],
		]);
		const cut = (f: number) => cells.sync.find((s) => s.kind === 'cut' && s.frame === f)!;
		expect(cut(90)).toMatchObject({ status: 'ok', shape: 'filled circle' });
		expect(cut(279)).toMatchObject({ status: 'none', shape: 'cross' });
		const sync = cells.lanes.find((l) => l.name === 'sync')!;
		const markPixels = (frame: number) =>
			Array.from({ length: sync.height }, (_, y) => px(img, cut(frame).x, sync.y + y));
		expect(markPixels(90).some(([r, g, b]) => g > r + 50 && g > b + 50)).toBe(true);
		expect(markPixels(279).some(([r, g, b]) => r > g + 50 && r > b + 50)).toBe(true);
		expect(cells.sections.length).toBeGreaterThanOrEqual(2);
		expect(cells.sections.some((s) => s.classes.includes('dialogue'))).toBe(true);
		expect(cells.spectrogram).toMatchObject({ bands: 96 });

		// a range listened to by view_sound_timeline itself, without frames
		const v2 = await ok('view_sound_timeline', {
			projectId,
			range: { start: 60, end: 120 },
			thumbnails: false,
		});
		const view2 = json<{ cells: TimelineCells; listen: string; listenJobId: string }>(v2);
		expect(view2.listen).toBe('listened to the range');
		expect(view2.cells.lanes.map((l) => l.name)).not.toContain('picture');
		expect(view2.cells.sync.find((s) => s.frame === 90)?.status).toBe('ok');

		// strict arguments and typed refusals
		const unknown = await call('listen_to_sequence', { projectId, bogus: 1 });
		expect(unknown.isError).toBe(true);
		expect(texts(unknown)[0]).toMatch(/E_UNKNOWN_ARGUMENT/);
		const empty = await call('listen_to_sequence', { projectId, range: { start: 600, end: 700 } });
		expect(empty.isError).toBe(true);
		expect(texts(empty)[0]).toMatch(/RANGE_EMPTY/);
		const notJob = await call('view_sound_timeline', {
			projectId,
			range: { start: 0, end: 60 },
			listenJobId: 'job_nope',
		});
		expect(notJob.isError).toBe(true);
		expect(texts(notJob)[0]).toMatch(/JOB_NOT_FOUND/);
	});
});
