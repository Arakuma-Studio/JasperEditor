// Sound library MCP tools end to end (spec 12 §2.10, P1-R6, P1-R8; wp-note "WP1.3 MCP tools"): a real engine in a
// temp appdir indexes a subset of the bundled Kenney CC0 starter kit plus one Jasper Synth variant per type, and
// jasper-mcp (stdio) drives it: status, search with a contact sheet, get_sound, view_sounds, import (one undo step),
// peak-aligned insert that never overwrites, credits, and the user's folders behind the approval card (answered by a
// stand-in editor window on the engine's /agent WebSocket). No network.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLICKS_PER_SECOND, flicksPerFrame, type ProjectDocument } from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '../src/png.ts';
import { editorWindow } from './editor-window.ts';
import { cleanEnv, testPort, waitFor } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KIT = join(ROOT, 'apps', 'engine', 'sounds', 'starter');
const PORT = await testPort(process.env.MCP_SOUND_TEST_PORT);
const KIT_FILES = [
	'hit-punch-01.ogg',
	'hit-crunch-01.ogg',
	'hit-metal-light-01.ogg',
	'thump-punch-01.ogg',
	'boom-low-01.ogg',
	'riser-engine-01.ogg',
	'reverse-air-01.ogg',
	'whoosh-air-01.ogg',
	'whoosh-air-03.ogg',
	'ui-confirm-01.ogg',
	'click-ui-02.ogg',
	'chime-bell-01.ogg',
];
// one seed per Jasper Synth recipe: the 19 types and the stingers’ TV static (spec 15 EA-026)
const SYNTH = 20;

const textOf = (r: CallToolResult) =>
	(r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? '';
const imageOf = (r: CallToolResult) => {
	const img = r.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined;
	if (!img) throw new Error('no image in the result');
	expect(img.mimeType).toBe('image/png');
	return decodePng(Buffer.from(img.data, 'base64'));
};

let engine: ChildProcess | null = null;
let appdir = '';
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
	if (r.isError) throw new Error(`${name} failed: ${textOf(r)}\n${logs.join('')}`);
	return { body: JSON.parse(textOf(r)) as T, result: r };
}
async function fails(name: string, args: Record<string, unknown> = {}) {
	const r = await call(name, args);
	expect(r.isError, `${name} should fail: ${textOf(r)}`).toBe(true);
	return (
		JSON.parse(textOf(r)) as { error: { code: string; message: string; hint?: string; details?: unknown } }
	).error;
}
async function revisionOf(projectId: string): Promise<number> {
	return (await ok<{ revision: number }>('get_project', { projectId })).body.revision;
}
async function documentOf(projectId: string): Promise<ProjectDocument> {
	const r = await client.readResource({ uri: `jasper://projects/${projectId}/document` });
	return JSON.parse((r.contents[0] as { text: string }).text) as ProjectDocument;
}

/** A starter kit of real kit files (a subset keeps indexing quick on a shared machine). */
function makeKit(dir: string) {
	const manifest = JSON.parse(readFileSync(join(KIT, 'manifest.json'), 'utf8')) as {
		packs: { id: string }[];
		sounds: { file: string; packId?: string }[];
	};
	const sounds = manifest.sounds.filter((s) => KIT_FILES.includes(s.file));
	expect(sounds).toHaveLength(KIT_FILES.length);
	const packs = manifest.packs.filter((p) => sounds.some((s) => s.packId === p.id));
	mkdirSync(dir, { recursive: true });
	for (const s of sounds) copyFileSync(join(KIT, s.file), join(dir, s.file));
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, packs, sounds }));
}

/** A 16-bit mono WAV: 50 ms of silence, then a decaying 300 Hz + noise burst (a "hit"). */
function writeHitWav(path: string, seconds = 0.6) {
	const sr = 48_000;
	const n = Math.round(seconds * sr);
	const buf = Buffer.alloc(44 + n * 2);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + n * 2, 4);
	buf.write('WAVEfmt ', 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(sr, 24);
	buf.writeUInt32LE(sr * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(n * 2, 40);
	let seed = 7;
	for (let i = 0; i < n; i++) {
		const t = i / sr - 0.05;
		seed = (seed * 1103515245 + 12345) >>> 0;
		const noise = (seed / 0xffffffff) * 2 - 1;
		const v = t < 0 ? 0 : Math.exp(-t * 18) * (0.6 * Math.sin(2 * Math.PI * 300 * t) + 0.3 * noise);
		buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32000), 44 + i * 2);
	}
	writeFileSync(path, buf);
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-sound-'));
	appdir = join(work, 'appdir');
	mkdirSync(appdir);
	makeKit(join(work, 'kit'));
	mkdirSync(join(ROOT, 'test-results'), { recursive: true });
	engine = spawn(
		process.execPath,
		['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', appdir],
		{
			cwd: ROOT,
			env: cleanEnv({
				JASPER_LOCAL_TOKEN: token,
				JASPER_EDITOR_KEY: editorKey,
				JASPER_SOUND_STARTER_DIR: join(work, 'kit'),
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
	client = new Client({ name: 'vitest-mcp-sound', version: '1.0.0' });
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

type Row = {
	rank: number;
	soundId: string;
	title: string;
	types: string[];
	durationSec: number;
	peakSec: number;
	riseMs: number;
	decayMs: number | null;
	centroidHz: number;
	judge: { ok: boolean; score: number; reasons: string[] } | null;
	license: string;
	credit: string | null;
	creditRequired: boolean;
	source: { type: string };
};
type Search = { total: number; results: Row[]; facets: Record<string, Record<string, number>> };
const byTitle = new Map<string, Row>();

describe('sound library MCP tools', { timeout: 900_000 }, () => {
	it('rescan_sound_library indexes the kit and the synth fallback (wait, progress)', async () => {
		const progress: number[] = [];
		const r = (await client.callTool({ name: 'rescan_sound_library', arguments: { wait: true } }, undefined, {
			timeout: 900_000,
			onprogress: (p) => progress.push(p.progress),
		})) as CallToolResult;
		expect(r.isError, textOf(r)).toBeFalsy();
		const job = JSON.parse(textOf(r)) as { state: string; kind: string; result: { sounds: number } };
		expect(job).toMatchObject({ state: 'succeeded', kind: 'sound-index' });
		expect(job.result.sounds).toBe(KIT_FILES.length + SYNTH);
		expect(progress.length).toBeGreaterThan(0);
		// Without wait: the job, joined or new, comes back at once.
		const again = (await ok<{ jobId: string; kind: string }>('rescan_sound_library')).body;
		expect(again.kind).toBe('sound-index');
		await ok('wait_for_job', { jobId: again.jobId });
	});

	it('sound_library_status reports sources, counts and folders', async () => {
		const { body } = await ok<{
			sounds: number;
			bySource: Record<string, number>;
			byType: Record<string, number>;
			byLicense: Record<string, number>;
			starterKit: { status: string; sounds: number };
			folders: unknown[];
			foldersAllowed: boolean;
			synth: boolean;
			needsIndex: boolean;
		}>('sound_library_status');
		expect(body.sounds).toBe(KIT_FILES.length + SYNTH);
		expect(body.bySource).toMatchObject({ starter: KIT_FILES.length, synth: SYNTH });
		expect(body.byLicense).toMatchObject({ cc0: KIT_FILES.length, jasper: SYNTH });
		expect(body.byType.hit).toBe(3 + 1);
		expect(body.byType.riser).toBe(1 + 1);
		expect(body).toMatchObject({
			starterKit: { status: 'ok', sounds: KIT_FILES.length },
			folders: [],
			foldersAllowed: true,
			synth: true,
			needsIndex: false,
		});
	});

	it('search_sounds: rows with descriptors, title words before synonyms, synth last, strict arguments', async () => {
		const all = (await ok<Search>('search_sounds', { limit: 24, license: 'any' })).body;
		expect(all.total).toBe(KIT_FILES.length + SYNTH);
		for (const row of all.results) byTitle.set(row.title, row);
		const punch = (await ok<Search>('search_sounds', { q: 'punch' })).body;
		// The ranking fix: "Punch" (title) before "Crunchy impact" (typed hit; "punch" is a synonym of hit).
		const titles = punch.results.map((r) => r.title);
		expect(titles.slice(0, 2).sort()).toEqual(['Heavy punch thump', 'Punch']);
		expect(titles.indexOf('Punch')).toBeLessThan(titles.indexOf('Crunchy impact'));
		const first = punch.results.find((r) => r.title === 'Punch')!;
		expect(first).toMatchObject({
			types: ['hit'],
			license: 'CC0-1.0',
			credit: null,
			creditRequired: false,
			source: { type: 'starter' },
			judge: { ok: true },
		});
		expect(first.soundId).toMatch(/^snd_[0-9a-f]{16}$/);
		expect(first.peakSec).toBeGreaterThan(0.02);
		expect(first.peakSec).toBeLessThan(0.06);
		expect(first.decayMs).toBeGreaterThan(0);
		expect(first.centroidHz).toBeGreaterThan(0);
		// Real recordings before Jasper Synth.
		const hits = (await ok<Search>('search_sounds', { types: ['hit'] })).body.results;
		expect(hits.map((r) => r.source.type)).toEqual(['starter', 'starter', 'starter', 'synth']);
		expect(hits.at(-1)!.license).toBe('LicenseRef-JasperEditor');
		// Facets.
		expect((await ok<Search>('search_sounds', { q: 'whoosh' })).body.facets.sources).toBeDefined();

		const unknown = await fails('search_sounds', { query: 'punch' });
		expect(unknown.code).toBe('E_UNKNOWN_ARGUMENT');
		expect(unknown.message).toContain('"query"');
		expect(unknown.hint).toContain('search_sounds accepts: q, types');
		expect((await fails('search_sounds', { q: 'punch', limt: 3 })).hint).toContain(
			'did you mean "limt" → "limit"',
		);
		expect((await fails('search_sounds', { limit: 25 })).code).toBe('E_INVALID_ARGUMENT');
		expect((await fails('search_sounds', { similarTo: 'snd_nothex' })).code).toBe('E_INVALID_ARGUMENT');
		expect((await fails('search_sounds', { similarTo: 'snd_0000000000000000' })).code).toMatch(/NOT_FOUND/);
	});

	it('search_sounds contactSheet returns one PNG with numbered cells', async () => {
		const r = await ok<
			Search & {
				contactSheet: {
					columns: number;
					rows: number;
					sheet: { width: number; height: number };
					cells: {
						cell: number;
						soundId: string;
						peakMs: number;
						decayMs: number | null;
						centroidHz: number;
						judge: unknown;
					}[];
				};
			}
		>('search_sounds', { types: ['hit', 'whoosh'], contactSheet: true, limit: 5 });
		const sheet = r.body.contactSheet;
		expect(sheet.cells).toHaveLength(5);
		expect(sheet.cells.map((c) => c.soundId)).toEqual(r.body.results.map((x) => x.soundId));
		expect(sheet.columns).toBe(3);
		expect(sheet.rows).toBe(2);
		const png = imageOf(r.result);
		expect(png.width).toBe(sheet.sheet.width);
		expect(png.height).toBe(sheet.sheet.height);
		expect(png.width).toBe(3 * 360 + 4 * 6);
		writeFileSync(
			join(ROOT, 'test-results', 'mcp-sound-search-sheet.png'),
			Buffer.from((r.result.content.find((c) => c.type === 'image') as { data: string }).data, 'base64'),
		);
		expect(sheet.cells[0]).toMatchObject({
			cell: 1,
			peakMs: expect.any(Number),
			judge: { ok: expect.any(Boolean) },
		});
	});

	it('get_sound gives every descriptor and a larger picture', async () => {
		const id = byTitle.get('Punch')!.soundId;
		const r = await ok<{
			id: string;
			descriptors: Record<string, unknown>;
			defaultAlign: string;
			format: unknown;
		}>('get_sound', { soundId: id, width: 800 });
		expect(r.body).toMatchObject({ id, defaultAlign: 'peak' });
		for (const k of ['peakSec', 'onsetSec', 'decayMs', 'octaveBandsDb', 'truePeakDb', 'headQuietSec'])
			expect(r.body.descriptors).toHaveProperty(k);
		const png = imageOf(r.result);
		expect([png.width, png.height]).toEqual([800, Math.round(800 * 0.42)]);
		const riser = byTitle.get(
			[...byTitle.keys()].find(
				(t) => byTitle.get(t)!.types[0] === 'riser' && byTitle.get(t)!.source.type === 'starter',
			)!,
		)!;
		expect(
			(await ok<{ defaultAlign: string }>('get_sound', { soundId: riser.soundId })).body.defaultAlign,
		).toBe('end');
		expect((await fails('get_sound', { soundId: 'snd_0000000000000000' })).code).toMatch(/NOT_FOUND/);
	});

	it('view_sounds draws the given sounds in order', async () => {
		const ids = [...byTitle.values()].slice(0, 7).map((r) => r.soundId);
		const r = await ok<{
			columns: number;
			rows: number;
			cells: { cell: number; row: number; column: number; soundId: string }[];
		}>('view_sounds', { soundIds: ids, columns: 2 });
		expect(r.body.cells.map((c) => c.soundId)).toEqual(ids);
		expect(r.body.cells[2]).toMatchObject({ cell: 3, row: 2, column: 1 });
		expect(r.body.rows).toBe(4);
		const png = imageOf(r.result);
		expect(png.width).toBe(2 * 360 + 3 * 6);
		writeFileSync(
			join(ROOT, 'test-results', 'mcp-sound-view.png'),
			Buffer.from((r.result.content.find((c) => c.type === 'image') as { data: string }).data, 'base64'),
		);
		expect((await fails('view_sounds', { soundIds: Array(25).fill(ids[0]) })).code).toBe(
			'E_INVALID_ARGUMENT',
		);
	});

	let projectId = '';
	it('import_sounds adds sounds to the "Sound Effects" bin in one undo step and reuses them', async () => {
		projectId = (await ok<{ projectId: string }>('create_project', { name: 'Sounds' })).body.projectId;
		const ids = [byTitle.get('Punch')!.soundId, byTitle.get('Crunchy impact')!.soundId];
		const before = await documentOf(projectId);
		const rev0 = await revisionOf(projectId);
		const r = (
			await ok<{
				revision: number;
				historyLabel: string;
				sounds: { soundId: string; mediaId: string; reused: boolean }[];
			}>('import_sounds', { projectId, soundIds: ids })
		).body;
		expect(r.sounds.map((s) => [s.soundId, s.reused])).toEqual([
			[ids[0], false],
			[ids[1], false],
		]);
		const doc = await documentOf(projectId);
		const bin = Object.values(doc.items).find((i) => i.kind === 'bin' && i.name === 'Sound Effects')!;
		expect(bin).toBeDefined();
		for (const s of r.sounds) {
			const m = doc.media[s.mediaId] as {
				library?: { soundId: string; license: string; source: { type: string } };
			};
			expect(m.library).toMatchObject({
				soundId: s.soundId,
				license: 'CC0-1.0',
				source: { type: 'starter' },
			});
		}
		expect(Object.keys(doc.media)).toHaveLength(Object.keys(before.media).length + 2);
		// ONE transaction (= one "Agent: Import 2 Sounds" History entry in an open editor; headless history.undo
		// needs a session): the revision moved by exactly one.
		expect(r.revision).toBe(rev0 + 1);
		expect(r.historyLabel).toBe('Import 2 Sounds');
		// Again: reused, nothing new.
		const again = (
			await ok<{ sounds: { mediaId: string; reused: boolean }[] }>('import_sounds', {
				projectId,
				soundIds: [ids[0]],
			})
		).body;
		expect(again.sounds[0]).toMatchObject({ mediaId: r.sounds[0]!.mediaId, reused: true });
		// All or nothing.
		const bad = await fails('import_sounds', { projectId, soundIds: [ids[1], 'snd_0000000000000000'] });
		expect(bad.code).toMatch(/NOT_FOUND/);
		expect((await fails('import_sounds', { projectId, soundIds: [] })).code).toBe('E_INVALID_ARGUMENT');
	});

	it('insert_sound puts the peak exactly on the frame, in one undo step, never overwriting', async () => {
		const p = (await ok<{ projectId: string }>('create_project', { name: 'Insert' })).body.projectId;
		const punch = byTitle.get('Punch')!;
		const doc0 = await documentOf(p);
		const seq0 = Object.values(doc0.sequences)[0]!;
		const F = flicksPerFrame(seq0.settings.frameRate);
		type Ins = {
			clipId: string;
			mediaId: string;
			track: string;
			trackCreated: boolean;
			start: { frame: number };
			alignedFrame: { frame: number; timecode: string };
			peakFrame?: number;
			align: string;
			sourceInFlicks: number;
			alignFlicks: number;
			errorFlicks: number;
		};
		const first = (await ok<Ins>('insert_sound', { projectId: p, soundId: punch.soundId, at: 45 })).body;
		// No SFX track yet: a new "SFX 1" (A4); the free A1–A3 are not sound-effect tracks (spec 12 §2.3).
		expect(first).toMatchObject({
			align: 'peak',
			peakFrame: 45,
			alignedFrame: { frame: 45 },
			track: 'A4',
			trackCreated: true,
		});
		const check = async (ins: Ins, cue: number) => {
			const doc = await documentOf(p);
			const clip = Object.values(doc.sequences)[0]!.clips[ins.clipId] as {
				start: number;
				sourceIn: number;
				mediaId: string;
				essentialSound?: { type?: string };
			};
			expect(clip.start).toBe(ins.start.frame);
			// The aligned point plays at start + (align − In): exactly on the cue frame. Library sounds whose head is not
			// quiet are registered with 50 ms of lead silence, so the sub-frame rest always comes out of silence.
			const playsAt = clip.start * F + (ins.alignFlicks - clip.sourceIn);
			expect(ins.errorFlicks).toBe(0);
			expect(Math.abs(playsAt - cue * F)).toBeLessThanOrEqual(2);
			return { doc, clip };
		};
		const { doc: d1, clip } = await check(first, 45);
		const exact = (await ok<{ descriptors: { peakSec: number } }>('get_sound', { soundId: punch.soundId }))
			.body;
		// The media is the padded copy: its peak is the library peak + the lead silence the provenance records.
		const lib = (d1.media[first.mediaId] as { library?: { leadSilenceSec?: number } }).library;
		expect(lib?.leadSilenceSec).toBe(0.05);
		expect(first.alignFlicks).toBe(Math.round((exact.descriptors.peakSec + 0.05) * FLICKS_PER_SECOND));
		expect(JSON.stringify(clip)).toContain('sfx');
		expect(Object.values(d1.items).some((i) => i.kind === 'bin' && i.name === 'Sound Effects')).toBe(true);

		// The same spot again: SFX 1 is taken, so a new SFX 2, SFX 3 — nothing is overwritten, A1–A3 stay empty.
		const tracks: string[] = [first.track];
		for (let i = 0; i < 2; i++) {
			const r = (await ok<Ins>('insert_sound', { projectId: p, soundId: punch.soundId, at: 45 })).body;
			tracks.push(r.track);
			await check(r, 45);
			expect(r.trackCreated).toBe(true);
			expect(r.mediaId).toBe(first.mediaId);
		}
		expect(tracks).toEqual(['A4', 'A5', 'A6']);
		const d2 = await documentOf(p);
		const s2 = Object.values(d2.sequences)[0]!;
		expect(s2.audioTracks.slice(3).map((t) => t.name)).toEqual(['SFX 1', 'SFX 2', 'SFX 3']);
		expect(Object.values(s2.clips).filter((c) => c.start === first.start.frame)).toHaveLength(3);
		expect(Object.values(s2.clips).some((c) => s2.audioTracks.findIndex((t) => t.id === c.trackId) < 3)).toBe(
			false,
		);
		// Later on the timeline the SFX track is preferred over A1.
		const later = (
			await ok<Ins>('insert_sound', { projectId: p, soundId: punch.soundId, at: { seconds: 10 } })
		).body;
		expect(later.track).toBe('A4');
		await check(later, 300);
		// An explicit busy track is refused.
		const busy = await fails('insert_sound', { projectId: p, soundId: punch.soundId, at: 45, track: 'A4' });
		expect(busy.code).toBe('E_OVERLAP');
		expect(
			(await fails('insert_sound', { projectId: p, soundId: punch.soundId, at: 45, track: 'V1' })).code,
		).toBe('E_TRACK_KIND');
		// A riser lands its END on the frame (align auto by type), in the given free track.
		const riser = [...byTitle.values()].find((r) => r.types[0] === 'riser' && r.source.type === 'starter')!;
		const rs = (
			await ok<Ins & { end: { frame: number } }>('insert_sound', {
				projectId: p,
				soundId: riser.soundId,
				at: '00:00:20:00',
				track: 'A2',
				gainDb: -6,
			})
		).body;
		expect(rs).toMatchObject({ align: 'end', track: 'A2', alignedFrame: { frame: 600 } });
		const { clip: rclip } = await check(rs, 600);
		expect(rs.end.frame).toBeLessThanOrEqual(600);
		expect(rs.end.frame).toBeGreaterThanOrEqual(599);
		expect((rclip as { gainDb?: number }).gainDb).toBe(-6);
		// Near frame 0 the head is trimmed instead of starting before the sequence.
		const crunchy = byTitle.get('Crunchy impact')!;
		const early = (
			await ok<Ins & { trimmedHeadSec?: number }>('insert_sound', {
				projectId: p,
				soundId: crunchy.soundId,
				at: 2,
			})
		).body;
		expect(early.start.frame).toBe(0);
		expect(early.trimmedHeadSec).toBeGreaterThan(0);
		await check(early, 2);
		// "playhead" needs an editor window.
		expect((await fails('insert_sound', { projectId: p, soundId: punch.soundId, at: 'playhead' })).code).toBe(
			'E_NO_SESSION',
		);
		// Each insert is ONE transaction (one undo step in an open editor): the revision moves by one, and a refused
		// insert (busy track above) changed nothing.
		const rev = await revisionOf(p);
		await ok('insert_sound', { projectId: p, soundId: crunchy.soundId, at: { seconds: 30 } });
		expect(await revisionOf(p)).toBe(rev + 1);
	});

	it('list_sound_credits lists the used sounds in md, txt and csv', async () => {
		const p = (await ok<{ projectId: string }>('create_project', { name: 'Credits' })).body.projectId;
		const empty = (await ok<{ count: number; text: string }>('list_sound_credits', { projectId: p })).body;
		expect(empty.count).toBe(0);
		await ok('insert_sound', { projectId: p, soundId: byTitle.get('Punch')!.soundId, at: 30 });
		const md = (
			await ok<{
				count: number;
				rows: { title: string; license: string; usedIn: string[] }[];
				text: string;
				format: string;
			}>('list_sound_credits', { projectId: p })
		).body;
		expect(md).toMatchObject({ count: 1, format: 'md' });
		expect(md.rows[0]).toMatchObject({ title: 'Punch', license: 'CC0-1.0' });
		expect(md.rows[0]!.usedIn).toHaveLength(1);
		expect(md.text).toContain('Punch');
		const txt = (await ok<{ text: string }>('list_sound_credits', { projectId: p, format: 'txt' })).body.text;
		expect(txt).toContain('"Punch" by Kenney');
		const csv = (await ok<{ text: string }>('list_sound_credits', { projectId: p, format: 'csv' })).body.text;
		expect(csv.split('\n')[0]).toContain('title');
		expect((await fails('list_sound_credits', { projectId: p, sequenceId: 'seq_nope' })).code).toBe(
			'E_NOT_FOUND',
		);
		expect((await fails('list_sound_credits', { projectId: p, format: 'pdf' })).code).toBe(
			'E_INVALID_ARGUMENT',
		);
	});

	it("detect_sound_peak gives project audio its peak (the editor's Detect Peak), one undo step", async () => {
		const p = (await ok<{ projectId: string }>('create_project', { name: 'Detect Peak' })).body.projectId;
		const wav = join(work, 'door-hit.wav');
		writeHitWav(wav, 1.2);
		const imp = (
			await ok<{ imported: { mediaId: string }[] }>('import_media', { projectId: p, paths: [wav] })
		).body;
		const placed = (
			await ok<{ refs: Record<string, string> }>('apply_commands', {
				projectId: p,
				label: 'place',
				commands: [
					{
						type: 'clip.place',
						source: { mediaId: imp.imported[0]!.mediaId },
						at: 30,
						tracks: { audio: 'A1' },
						ref: '$a',
					},
				],
			})
		).body;
		const clipId = placed.refs.$a!;
		// measure only: nothing changes
		const rev = await revisionOf(p);
		const m = (
			await ok<{ applied: boolean; peakSec: number; peakFlicks: number; playsAt: { frame: number } }>(
				'detect_sound_peak',
				{ projectId: p, clipId, apply: false },
			)
		).body;
		expect(m.applied).toBe(false);
		expect(await revisionOf(p)).toBe(rev);
		// the hit file peaks ≈ 50 ms in (writeHitWav)
		expect(m.peakSec).toBeGreaterThan(0.04);
		expect(m.peakSec).toBeLessThan(0.07);
		expect(m.playsAt.frame).toBeGreaterThan(31);
		expect(m.playsAt.frame).toBeLessThan(32.2);
		// apply: soundDesign.setPeak, one undo step "Detect Peak"
		const a = (
			await ok<{ applied: boolean; historyLabel: string; peakFlicks: number }>('detect_sound_peak', {
				projectId: p,
				clipId,
			})
		).body;
		expect(a).toMatchObject({ applied: true, historyLabel: 'Detect Peak', peakFlicks: m.peakFlicks });
		expect(await revisionOf(p)).toBe(rev + 1);
		const doc = await documentOf(p);
		const clip = Object.values(doc.sequences)[0]!.clips[clipId] as unknown as {
			sfx?: { soundId: string | null; placement: { peakFlicks: number } };
		};
		expect(clip.sfx?.soundId).toBeNull();
		expect(clip.sfx?.placement.peakFlicks).toBe(m.peakFlicks);
		// align_peak now moves it by that peak
		const al = (
			await ok<{ exact: string; clips: { alignedFrame: number }[] }>('align_peak', {
				projectId: p,
				clipId,
				to: 60,
			})
		).body;
		expect(al.exact).toBe('frame');
		expect(Math.floor(al.clips[0]!.alignedFrame)).toBe(60);
		expect((await fails('detect_sound_peak', { projectId: p, clipId: 'clp_nope' })).code).toBe('E_NOT_FOUND');
		expect((await fails('detect_sound_peak', { projectId: p, clipId, sequenceId: 'seq_nope' })).code).toBe(
			'E_NOT_FOUND',
		);
	});

	it('export_sound_credits writes the credits file (never overwriting) like File ▸ Export ▸ Sound Credits…', async () => {
		const p = (await ok<{ projectId: string }>('create_project', { name: 'Credits File' })).body.projectId;
		const out = join(work, 'credits-out');
		// Nothing used yet: nothing to write.
		expect((await fails('export_sound_credits', { projectId: p, path: out })).code).toBe('E_INVALID_PARAM');
		expect((await fails('export_sound_credits', { projectId: p, path: 'relative/credits.md' })).code).toBe(
			'E_INVALID_PARAM',
		);
		await ok('insert_sound', { projectId: p, soundId: byTitle.get('Punch')!.soundId, at: 30 });
		const listed = (await ok<{ text: string }>('list_sound_credits', { projectId: p })).body.text;
		// A folder: named after the project, Markdown by default.
		mkdirSync(out, { recursive: true });
		const a = (
			await ok<{ path: string; format: string; count: number }>('export_sound_credits', {
				projectId: p,
				path: out,
			})
		).body;
		expect(a).toMatchObject({ path: join(out, 'Credits_File-sound-credits.md'), format: 'md', count: 1 });
		expect(readFileSync(a.path, 'utf8')).toBe(listed);
		// The same name again: a free name, the first file untouched.
		const b = (await ok<{ path: string }>('export_sound_credits', { projectId: p, path: out })).body;
		expect(b.path).toBe(join(out, 'Credits_File-sound-credits (2).md'));
		expect(readFileSync(a.path, 'utf8')).toBe(listed);
		// A file path: the format follows its extension.
		const csvPath = join(out, 'sub', 'list.csv');
		const c = (
			await ok<{ path: string; format: string }>('export_sound_credits', { projectId: p, path: csvPath })
		).body;
		expect(c).toMatchObject({ path: csvPath, format: 'csv' });
		expect(readFileSync(csvPath, 'utf8').split('\n')[0]).toContain('title');
		// CC0 needs no credit: attributionOnly has nothing to write, and list_sound_credits says the same.
		expect(
			(await ok<{ count: number }>('list_sound_credits', { projectId: p, attributionOnly: true })).body.count,
		).toBe(0);
		expect(
			(await fails('export_sound_credits', { projectId: p, path: out, attributionOnly: true })).code,
		).toBe('E_INVALID_PARAM');
		expect(
			(await fails('export_sound_credits', { projectId: p, path: out, sequenceId: 'seq_nope' })).code,
		).toBe('E_NOT_FOUND');
	});

	it('sound folders need the user: refused without a window, denied, approved; CC-BY credits', async () => {
		const folder = join(work, 'my sounds');
		mkdirSync(folder);
		writeHitWav(join(folder, 'door slam.wav'));
		const args = { path: folder, license: 'CC-BY-4.0', author: 'Test Author', wait: true };
		// No editor window to ask in.
		const refused = await fails('add_sound_folder', args);
		expect(refused.code).toBe('E_APPROVAL_DENIED');
		expect(refused.hint).toContain('Do not retry');
		// A window that says no, then yes.
		const other = (await ok<{ projectId: string }>('create_project', { name: 'Window' })).body.projectId;
		const editor = await editorWindow({ port: PORT, token, editorKey, projectId: other });
		try {
			const denied = call('add_sound_folder', args);
			const c1 = await editor.card(1);
			expect(c1.label).toBe('Add a sound folder');
			expect(c1.summary).toContain(folder);
			expect(c1.summary).toContain('CC-BY-4.0');
			editor.answer(c1, 'denied');
			const d = await denied;
			expect(d.isError).toBe(true);
			expect(JSON.parse(textOf(d)).error.code).toBe('E_APPROVAL_DENIED');
			expect((await ok<{ folders: unknown[] }>('sound_library_status')).body.folders).toEqual([]);

			const approved = call('add_sound_folder', args);
			editor.answer(await editor.card(2), 'approved');
			const a = await approved;
			expect(a.isError, textOf(a)).toBeFalsy();
			const added = JSON.parse(textOf(a)) as {
				folder: { rootId: string; license: string };
				job: { state: string; result: { added: number } };
			};
			expect(added.folder).toMatchObject({ license: 'CC-BY-4.0' });
			expect(added.job).toMatchObject({ state: 'succeeded', result: { added: 1 } });
			const found = (await ok<Search>('search_sounds', { q: 'door slam', sources: ['folder'] })).body.results;
			expect(found).toHaveLength(1);
			expect(found[0]).toMatchObject({ types: ['hit'], license: 'CC-BY-4.0', creditRequired: true });
			expect(found[0]!.credit).toContain('Test Author');

			// Used in a project: the credits require attribution.
			const p = (await ok<{ projectId: string }>('create_project', { name: 'CC-BY' })).body.projectId;
			const ins = (
				await ok<{ notes?: string[]; credit?: string }>('insert_sound', {
					projectId: p,
					soundId: found[0]!.soundId,
					at: 30,
				})
			).body;
			expect(ins.credit).toContain('Test Author');
			const credits = (
				await ok<{ attributionRequired: number; text: string }>('list_sound_credits', {
					projectId: p,
					format: 'txt',
				})
			).body;
			expect(credits.attributionRequired).toBe(1);
			expect(credits.text).toContain('CC-BY-4.0');

			// Removing asks too.
			expect((await fails('remove_sound_folder', { rootId: 'root_000000000000' })).code).toBe('E_NOT_FOUND');
			const removing = call('remove_sound_folder', { rootId: added.folder.rootId });
			const c3 = await editor.card(3);
			expect(c3.label).toBe('Remove a sound folder');
			editor.answer(c3, 'approved');
			const rm = await removing;
			expect(rm.isError, textOf(rm)).toBeFalsy();
			expect(JSON.parse(textOf(rm))).toMatchObject({ removedSounds: 1, folders: [] });
			expect(
				(await ok<Search>('search_sounds', { q: 'door slam', sources: ['folder'], license: 'any' })).body
					.total,
			).toBe(0);
		} finally {
			editor.close();
		}
	});
});
