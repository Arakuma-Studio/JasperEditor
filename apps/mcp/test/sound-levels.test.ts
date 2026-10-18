// Default insert level (spec 12 §2.3; wp-note "Phase 2 verification B"): the Phase 2 fixture filled through jasper-mcp
// the way an agent fills it (find_sound_cues → set_sound_cues → place_sound with picks by type on every cue, two layers
// on hero cues), against a real engine with starter-kit recordings and Jasper Synth. Every placed clip gets the
// default level of its sound and role (`sfx.level`, the gain recomputed here from the media's descriptors), and the
// mix stays under full scale WITHOUT loudness normalisation: measured by the engine's export mixer
// (measure_loudness) and on a real native export decoded by ffmpeg (its own BS.1770 true-peak meter). The same export
// with every clip gain at 0 dB (what placement did before) is measured too, for the record. No network.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type AudioClip,
	type ClipSfx,
	defaultSfxLevel,
	type LibraryProvenance,
	type ProjectDocument,
	type Sequence,
	type SoundDesign,
	soundDesignSettingsOf,
} from '@jasper/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanEnv, testPort, waitFor } from './helpers.ts';
import { FIXTURE_COMMANDS } from './sound-cues-fixture.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const KIT = join(ROOT, 'apps', 'engine', 'sounds', 'starter');
const PORT = await testPort(process.env.MCP_SOUND_LEVELS_TEST_PORT);
const FFMPEG = process.env.JASPER_FFMPEG ?? 'ffmpeg';
const KIT_FILES = [
	'hit-punch-01.ogg',
	'hit-crunch-01.ogg',
	'hit-metal-light-01.ogg',
	'thump-punch-01.ogg',
	'boom-low-01.ogg',
	'riser-engine-01.ogg',
	'whoosh-air-01.ogg',
	'whoosh-air-03.ogg',
	'ui-confirm-01.ogg',
];

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
const seqOf = (doc: ProjectDocument) => Object.values(doc.sequences)[0]!;
const cuesOf = (seq: Sequence) => Object.values((seq.soundDesign as SoundDesign | undefined)?.cues ?? {});
type SfxClip = AudioClip & { sfx?: ClipSfx };

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

const H = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

/** Exports `doc` (audio only: the picture is not what is measured) natively to MOV/PCM; returns the file. */
async function exportAudio(doc: ProjectDocument, sequenceId: string, name: string): Promise<string> {
	const settings = {
		sequenceId,
		range: { type: 'entire' },
		container: 'mov',
		video: {
			codec: 'h264',
			width: 320,
			height: 180,
			frameRate: seqOf(doc).settings.frameRate,
			scaling: 'fit',
			quality: { mode: 'crf', value: 35 },
			encoderSpeed: 'fast',
		},
		audio: { codec: 'pcm', sampleRate: 48_000, channels: 2 },
		engine: 'native',
	};
	const envelope = JSON.parse(
		readFileSync(join(work, 'appdir', 'projects', doc.projectId, 'project.jasper'), 'utf8'),
	) as { document: ProjectDocument };
	envelope.document = doc;
	const start = await fetch(`http://127.0.0.1:${PORT}/api/exports`, {
		method: 'POST',
		headers: H(),
		body: JSON.stringify({ envelope, sequenceId, settings }),
	});
	expect(start.status, await start.clone().text()).toBe(202);
	const { id } = (await start.json()) as { id: string };
	await waitFor(
		async () => {
			const j = (await (await fetch(`http://127.0.0.1:${PORT}/api/jobs/${id}`, { headers: H() })).json()) as {
				state: string;
				error?: unknown;
			};
			if (j.state === 'failed' || j.state === 'cancelled' || j.state === 'interrupted')
				throw new Error(`export ${name}: ${JSON.stringify(j)}`);
			return j.state === 'succeeded';
		},
		600_000,
		`export ${name}`,
	);
	const out = await fetch(`http://127.0.0.1:${PORT}/renders/${id}/output`, { headers: H() });
	expect(out.status).toBe(200);
	const file = join(work, name);
	writeFileSync(file, Buffer.from(await out.arrayBuffer()));
	return file;
}

/** True peak (dBTP) and sample peak of a file's audio, by ffmpeg's ebur128 meter (4× oversampled true peak). */
function ffmpegPeaks(file: string): { truePeak: number; samplePeak: number } {
	const r = spawnSync(
		FFMPEG,
		[
			'-hide_banner',
			'-nostats',
			'-i',
			file,
			'-map',
			'0:a:0',
			'-af',
			'ebur128=peak=true+sample',
			'-f',
			'null',
			'-',
		],
		{
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	expect(r.status, r.stderr).toBe(0);
	const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
	const tp = /True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)/.exec(summary);
	const sp = /Sample peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)/.exec(summary);
	expect(tp, summary).toBeTruthy();
	const num = (s: string) => (s === '-inf' ? Number.NEGATIVE_INFINITY : Number(s));
	return { truePeak: num(tp![1]!), samplePeak: sp ? num(sp[1]!) : Number.NaN };
}

beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), 'jasper-mcp-levels-'));
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
	client = new Client({ name: 'vitest-mcp-levels', version: '1.0.0' });
	await client.connect(transport);
	await ok('rescan_sound_library', { wait: true });
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

describe('default insert levels on the Phase 2 fixture', { timeout: 1_200_000 }, () => {
	it('every fill gets its role level; the mix stays under 0 dBTP without normalisation', async () => {
		const { projectId } = await ok<{ projectId: string }>('create_project', {
			name: 'Levels',
			preset: 'hd-1080p-30',
		});
		await ok('apply_commands', { projectId, label: 'Fixture', commands: FIXTURE_COMMANDS });
		const found = await ok<{ revision: number; cues: unknown[] }>('find_sound_cues', { projectId });
		await ok('set_sound_cues', { projectId, add: found.cues, expectedRevision: found.revision });
		const stored = cuesOf(seqOf(await documentOf(projectId))).sort((a, b) => a.frame - b.frame);
		expect(stored.length).toBeGreaterThanOrEqual(10);
		// Fill every cue as an agent would: picks by the cue's first type (two layers on hero cues); a type the small
		// kit has nothing of falls back to a hit.
		const placedIds: string[] = [];
		for (const cue of stored) {
			const types = cue.types?.length ? cue.types : ['hit'];
			const layers =
				cue.weight === 'hero'
					? [{ sound: { type: types[0]! } }, { sound: { type: types[1] ?? types[0]! } }]
					: [{ sound: { type: types[0]! } }];
			let r = await call('place_sound', {
				projectId,
				mode: 'apply',
				cueId: cue.id,
				layers,
				clampStart: true,
			});
			if (r.isError)
				r = await call('place_sound', {
					projectId,
					mode: 'apply',
					cueId: cue.id,
					layers: layers.map(() => ({ sound: { type: 'hit' } })),
					clampStart: true,
				});
			if (r.isError) throw new Error(textOf(r));
			const placed = JSON.parse(textOf(r)) as {
				clips: { clipId: string; gainDb: number; level?: unknown }[];
			};
			for (const c of placed.clips) {
				expect(c.level, JSON.stringify(c)).toBeTruthy();
				placedIds.push(c.clipId);
			}
		}
		const doc = await documentOf(projectId);
		const seq = seqOf(doc);
		const delivery = soundDesignSettingsOf(seq as { soundDesign?: unknown }).delivery;
		const report: Record<string, unknown>[] = [];
		for (const id of placedIds) {
			const c = seq.clips[id] as SfxClip;
			const prov = (doc.media[c.mediaId] as { library?: LibraryProvenance }).library!;
			const d = prov.descriptors as LibraryProvenance['descriptors'] & { truePeakDb?: number | null };
			// the registered provenance carries the true peak now
			expect(typeof d?.truePeakDb === 'number' || d?.truePeakDb === null, JSON.stringify(d)).toBe(true);
			const level = c.sfx!.level!;
			const want = defaultSfxLevel({
				role: c.sfx!.role,
				types: prov.types,
				maxMomentaryLufs: d?.maxMomentaryLufs ?? null,
				truePeakDb: d?.truePeakDb ?? null,
				delivery,
			});
			expect(level).toMatchObject({ by: 'default', targetLufs: want.targetLufs, limitedBy: want.limitedBy });
			expect(c.gainDb).toBeCloseTo(want.gainDb + (level.offsetDb ?? 0), 2);
			expect(Math.abs(level.offsetDb ?? 0)).toBeLessThanOrEqual(1);
			report.push({
				title: prov.title,
				role: c.sfx!.role,
				maxMomentaryLufs: d?.maxMomentaryLufs,
				truePeakDb: d?.truePeakDb,
				gainDb: c.gainDb,
				limitedBy: level.limitedBy,
			});
		}
		console.log('placed levels', JSON.stringify(report));
		expect(new Set(report.map((r) => r.role))).toEqual(new Set(['hero', 'support', 'layer']));
		// the export mixer's measurement (no normalisation is set on this sequence)
		const m = await ok<{ loudness: { truePeakDbtp: number | null; integratedLufs: number | null } }>(
			'measure_loudness',
			{ projectId },
		);
		console.log('measure_loudness', JSON.stringify(m.loudness));
		expect(m.loudness.truePeakDbtp).not.toBeNull();
		expect(m.loudness.truePeakDbtp!).toBeLessThan(0);
		// a real export, decoded and metered by ffmpeg: the audio clips alone (the picture is not measured)
		const audioOnly = structuredClone(doc);
		const s2 = seqOf(audioOnly);
		for (const [id, c] of Object.entries(s2.clips)) if (c.kind !== 'audio') delete s2.clips[id];
		s2.transitions = {} as never;
		const file = exportAudio(audioOnly, s2.id, 'levels.mov');
		const withDefaults = ffmpegPeaks(await file);
		// the same sounds at 0 dB clip gain (placement before default levels)
		const zero = structuredClone(audioOnly);
		for (const id of placedIds) (seqOf(zero).clips[id] as SfxClip).gainDb = 0;
		const atZero = ffmpegPeaks(await exportAudio(zero, s2.id, 'levels-0db.mov'));
		console.log('export true peak (dBTP)', JSON.stringify({ withDefaults, atZero }));
		// the measurements, for the wp-note (test-results/ is not tracked)
		mkdirSync(join(ROOT, 'test-results'), { recursive: true });
		writeFileSync(
			join(ROOT, 'test-results', 'sound-levels.json'),
			JSON.stringify({ placed: report, mix: m.loudness, export: { withDefaults, atZero } }, null, 1),
		);
		expect(withDefaults.truePeak).toBeLessThan(0);
		expect(withDefaults.samplePeak).toBeLessThan(0);
	});
});
