// Ambience beds and room tone on a real engine (spec 12 §4 P6-E12 "Done when"; wp-note "Phase 6 → WP-E8"):
//   beds       a 3-scene, 20 s sequence (three stills on V1) gets a 4 s library ambience looped per scene with
//              crossfades: the Sound Check of the result has no CLICK, EDGE, DIP or SILENCE, the native export is level
//              at every joint (100 ms RMS within 1.5 dB of the body) with no click; one transaction; an agent proposes
//              it and the editor accepts it; the read-only plan and its refusals.
//   room tone  a dialogue recording with a −52 dBFS pink noise floor cut into two clips with a 1 s hole between them:
//              Sound Check reports SILENCE there with the fix "Fill it with room tone", the closest of three library
//              room tones to the floor (pink, not hum or hiss); applying it clears the SILENCE; the fill route chooses
//              the same tone and puts it at the floor's level.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type SoundBedsPlan,
	SoundBedsResultSchema,
	type SoundCheckReport,
	SoundCheckResultSchema,
	SoundRoomToneResultSchema,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { detectClicks } from '@jasper/audio-fx';
import { appdirPaths } from '@jasper/config';
import {
	type AudioClip,
	isSetupItem,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
	readClipBed,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	makeApp,
	ROOT,
	register,
	TEST_FFMPEG,
	type TestApp,
	tempAppdir,
} from './helpers.ts';

const SR = 48_000;
const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_beds_0123456789abcdef0123';
const KEY = 'key_beds_0123456789abcdef0123';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'beds-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const OUT = join(ROOT, 'test-results', 'sd-beds');

function prng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
	};
}
const scaleTo = (x: Float32Array, dbfs: number) => {
	let e = 0;
	for (const v of x) e += v * v;
	const g = 10 ** (dbfs / 20) / Math.sqrt(e / x.length);
	for (let i = 0; i < x.length; i++) x[i]! *= g;
	return x;
};
function pink(seconds: number, seed: number, dbfs: number): Float32Array {
	const r = prng(seed);
	const x = new Float32Array(Math.round(seconds * SR));
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	for (let i = 0; i < x.length; i++) {
		const w = r();
		b0 = 0.99765 * b0 + w * 0.099046;
		b1 = 0.963 * b1 + w * 0.2965164;
		b2 = 0.57 * b2 + w * 1.0526913;
		x[i] = b0 + b1 + b2 + w * 0.1848;
	}
	return scaleTo(x, dbfs);
}
function white(seconds: number, seed: number, dbfs: number): Float32Array {
	const r = prng(seed);
	return scaleTo(
		Float32Array.from({ length: Math.round(seconds * SR) }, () => r()),
		dbfs,
	);
}
/** Brown noise with a 60 Hz hum and its harmonics: a ventilation room tone. */
function hum(seconds: number, seed: number, dbfs: number): Float32Array {
	const r = prng(seed);
	let b = 0;
	const x = Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => {
		b = 0.995 * b + 0.05 * r();
		const t = i / SR;
		return (
			b +
			0.3 * Math.sin(2 * Math.PI * 60 * t) +
			0.15 * Math.sin(2 * Math.PI * 120 * t) +
			0.08 * Math.sin(2 * Math.PI * 180 * t)
		);
	});
	return scaleTo(x, dbfs);
}
/** 10 s of dialogue: a −52 dBFS pink floor (the room) and syllables of a 1.5 kHz tone at 0.5–3.5 s and 5.5–8.5 s. */
function dialogue(): Float32Array {
	const x = pink(10, 21, -52);
	for (let i = 0; i < x.length; i++) {
		const t = i / SR;
		const on = (t >= 0.5 && t < 3.5) || (t >= 5.5 && t < 8.5);
		if (!on) continue;
		const env = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t);
		x[i]! += 0.15 * env * Math.sin(2 * Math.PI * 1500 * t);
	}
	return x;
}

function makeKit(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const w = (name: string, l: Float32Array, r: Float32Array = l) =>
		writeFileSync(join(dir, name), encodeWav([l, r], SR, 's16'));
	w('amb4.wav', pink(4, 1, -30), pink(4, 2, -30));
	w('rt-pink.wav', pink(20, 3, -45));
	w('rt-hum.wav', hum(20, 4, -45));
	w('rt-hiss.wav', white(20, 5, -45));
	const s = (file: string, title: string, types: string[]) => ({
		file,
		title,
		types,
		tags: ['test'],
		author: 'Test Author',
		license: 'CC0-1.0',
	});
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [],
			sounds: [
				s('amb4.wav', 'Test ambience 4 s', ['ambience']),
				s('rt-hum.wav', 'Room tone hum', ['roomtone']),
				s('rt-hiss.wav', 'Room tone hiss', ['roomtone']),
				s('rt-pink.wav', 'Room tone pink', ['roomtone']),
			],
		}),
	);
	return dir;
}

let app: TestApp;
let mediaDir = '';
const ids: Record<string, string> = {};
let projects = 0;

const post = (url: string, body: unknown, headers: Record<string, string> = EDITOR_H) =>
	app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string> = EDITOR_H) =>
	app.inject({ method: 'GET', url, headers });
async function waitJob(r: { statusCode: number; body: string; json(): unknown }): Promise<EngineJob> {
	expect(r.statusCode, r.body).toBe(202);
	return coreServices(app).queue.wait((r.json() as EngineJob).id);
}
function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(++projects + 800).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...doc, projectId },
				{ revision: 3, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}
async function liveDoc(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
	const q = await post('/api/agent/query', { projectId, query: 'doc.get', args: {} });
	expect(q.statusCode, q.body).toBe(200);
	const live = q.json() as { result: ProjectDocument; revision: number };
	return { doc: live.result, revision: live.revision };
}
async function check(projectId: string): Promise<SoundCheckReport> {
	const job = await waitJob(await post('/api/sound-design/check', { projectId }, AGENT_H));
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return SoundCheckResultSchema.parse(job.result).report;
}
const describeIssues = (r: SoundCheckReport) =>
	r.issues.map((i) => `${i.severity} ${i.code} ${i.timecode ?? ''} ${i.message.text}`).join('\n');
const auth = { authorization: `Bearer ${TOKEN}` };

/** Three stills on V1 (0–200, 200–400, 400–600 at 30 fps: 20 s). */
async function threeScenes(): Promise<DocBuilder> {
	const b = new DocBuilder('hd-1080p-30', 91 + projects);
	for (const [i, c] of ['red', 'green', 'blue'].entries()) {
		const png = join(mediaDir, `${c}.png`);
		execFileSync(TEST_FFMPEG, [
			'-v',
			'error',
			'-y',
			'-f',
			'lavfi',
			'-i',
			`color=c=${c}:s=320x180`,
			'-frames:v',
			'1',
			png,
		]);
		const m = b.addMedia(await register(app, png, auth));
		const r = b.tx([
			{ type: 'clip.place', source: { mediaId: m }, at: i * 200, tracks: { video: 'V1' }, ref: '$v' },
		]);
		const clip = b.doc.sequences[b.seqId]!.clips[r.refs.$v!]!;
		b.tx([{ type: 'clip.trim', clipId: clip.id, edge: 'out', deltaFrames: 200 - clip.duration }]);
	}
	return b;
}

function decode(file: string): Float32Array[] {
	const out = execFileSync(
		TEST_FFMPEG,
		['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '2', '-f', 'f32le', '-'],
		{
			maxBuffer: 1 << 30,
		},
	);
	const f = new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
	const n = f.length / 2;
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		l[i] = f[2 * i]!;
		r[i] = f[2 * i + 1]!;
	}
	return [l, r];
}
const rmsDb = (x: Float32Array, a: number, b: number) => {
	let e = 0;
	for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) e += x[i]! ** 2;
	return 10 * Math.log10(e / Math.max(1, b - a) + 1e-20);
};

async function exportAudio(projectId: string, name: string): Promise<Float32Array[]> {
	const { doc, revision } = await liveDoc(projectId);
	const seqId = Object.keys(doc.sequences)[0]!;
	const start = await post('/api/exports', {
		envelope: makeEnvelope(doc, { revision, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' }),
		sequenceId: seqId,
		settings: {
			sequenceId: seqId,
			range: { type: 'entire' },
			container: 'mov',
			video: {
				codec: 'h264',
				width: 320,
				height: 180,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 35 },
				encoderSpeed: 'fast',
			},
			audio: { codec: 'pcm', sampleRate: SR, channels: 2 },
			engine: 'native',
		},
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	const file = (await coreServices(app).exports.outputFile(start.json().id))!;
	try {
		execFileSync(TEST_FFMPEG, [
			...['-v', 'error', '-y', '-i', file],
			...['-filter_complex', '[0:a]showwavespic=s=1600x300:split_channels=1', '-frames:v', '1'],
			join(OUT, `${name}-wave.png`),
		]);
		execFileSync(TEST_FFMPEG, [
			...['-v', 'error', '-y', '-i', file],
			...['-lavfi', 'showspectrumpic=s=1600x400:legend=1', '-frames:v', '1'],
			join(OUT, `${name}-spectrum.png`),
		]);
	} catch {
		// the pictures are for looking at
	}
	return decode(file);
}

beforeAll(async () => {
	process.env.JASPER_SOUND_STARTER_DIR = makeKit(tempAppdir('jasper-beds-kit-'));
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '0';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	mkdirSync(OUT, { recursive: true });
	mediaDir = mkdtempSync(join(tmpdir(), 'jasper-beds-media-'));
	const idx = await post('/api/sounds/index', {});
	expect((await waitJob(idx)).state).toBe('succeeded');
	const found = await get('/api/sounds?limit=50&license=any');
	for (const r of (found.json() as { results: { sound: { id: string; title: string } }[] }).results)
		ids[r.sound.title] = r.sound.id;
	expect(Object.keys(ids)).toEqual(
		expect.arrayContaining(['Test ambience 4 s', 'Room tone pink', 'Room tone hum', 'Room tone hiss']),
	);
}, 600_000);

afterAll(async () => {
	await closeApps();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('ambience beds (real engine)', { timeout: 900_000 }, () => {
	it('3 scenes × a 4 s ambience over 20 s: looped pieces with crossfades, one edit, a clean Sound Check, a seamless export', async () => {
		const pid = seed((await threeScenes()).doc);
		const before = await liveDoc(pid);
		const job = await waitJob(
			await post('/api/sound-design/beds', {
				projectId: pid,
				soundId: ids['Test ambience 4 s'],
				mode: 'apply',
			}),
		);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const r = SoundBedsResultSchema.parse(job.result);
		expect(r.applied).toBe(true);
		const plan = r.plan;
		console.info(
			`[beds] ${plan.scenes.map((s) => `${s.timecode}–${s.endTimecode} ${s.reason} "${s.sound.title}" window ${s.sound.window.startSec}–${s.sound.window.endSec} s (std ${s.sound.window.levelStdDb} dB) loop ${s.sound.loop.inSec}–${s.sound.loop.outSec} s xf ${s.sound.loop.crossfadeSec} s ${s.sound.loop.fade} ΔL ${s.sound.loop.levelDiffDb} D ${s.sound.loop.spectralDistanceDb} ρ ${s.sound.loop.correlation}; ${s.sound.loudnessLufs} LUFS → ${s.gainDb} dB`).join('\n')}`,
		);
		expect(plan.scenes.map((s) => [s.start, s.end, s.reason])).toEqual([
			[0, 200, 'start'],
			[200, 400, 'edit'],
			[400, 600, 'edit'],
		]);
		expect(plan.scenes.every((s) => s.sound.window.clean && s.sound.loop.crossfadeSec >= 1.5)).toBe(true);
		// the ambience level of the web delivery: −30 LUFS
		expect(plan.scenes[0]!.gainDb).toBeCloseTo(-30 - plan.scenes[0]!.sound.loudnessLufs!, 0);
		// one transaction
		const { doc, revision } = await liveDoc(pid);
		expect(revision).toBe(before.revision + 1);
		const seq = Object.values(doc.sequences)[0]!;
		const pieces = Object.values(seq.clips).filter((c) =>
			readClipBed((c as { bed?: unknown }).bed),
		) as AudioClip[];
		const track = seq.audioTracks.find((t) => t.id === pieces[0]!.trackId)!;
		expect(track.name).toBe('Ambience');
		expect(pieces.length).toBeGreaterThanOrEqual(6);
		const tr = Object.values(seq.transitions);
		const loops = tr.filter((t) => t.outgoingClipId && t.incomingClipId && t.duration === 45);
		const scenes = tr.filter((t) => t.outgoingClipId && t.incomingClipId && t.duration === 15);
		expect(loops.length).toBe(pieces.length - 3);
		expect(scenes).toHaveLength(2);
		console.info(
			`[beds] ${pieces.length} pieces, ${loops.length} loop crossfades of 1.5 s, ${scenes.length} scene crossfades of 0.5 s`,
		);
		// Sound Check of the result: no CLICK, EDGE, DIP or SILENCE
		const report = await check(pid);
		console.info(`[beds] Sound Check:\n${describeIssues(report)}`);
		for (const code of ['CLICK', 'EDGE', 'DIP', 'SILENCE'])
			expect(
				report.issues.filter((i) => i.code === code),
				describeIssues(report),
			).toEqual([]);
		// the export: level at every joint, no click
		const [l, rr] = await exportAudio(pid, 'beds');
		const mono = Float32Array.from(l!, (v, i) => 0.5 * (v + rr![i]!));
		const frame = SR / 10;
		const body: number[] = [];
		for (let i = Math.round(1.2 * SR); i + frame < Math.round(18.8 * SR); i += frame)
			body.push(rmsDb(mono, i, i + frame));
		const median = [...body].sort((a, b) => a - b)[body.length >> 1]!;
		const joints = [...loops, ...scenes].map((t) => seq.clips[t.incomingClipId!]!.start / 30);
		const at = joints.map(
			(t) => rmsDb(mono, Math.round((t - 0.05) * SR), Math.round((t + 0.05) * SR)) - median,
		);
		console.info(
			`[beds] export: body median ${median.toFixed(2)} dBFS, 100 ms frames ${Math.min(...body).toFixed(2)}…${Math.max(...body).toFixed(2)}; at the joints ${at.map((d) => d.toFixed(2)).join(', ')} dB`,
		);
		expect(Math.max(...at.map(Math.abs))).toBeLessThan(1.5);
		expect(Math.max(...body.map((b) => Math.abs(b - median)))).toBeLessThan(2);
		const clicks = detectClicks([l!, rr!], SR);
		expect(clicks, JSON.stringify(clicks.slice(0, 5))).toHaveLength(0);
	});

	it('an agent proposes it, the user accepts it; the plan route and its refusals', async () => {
		const pid = seed((await threeScenes()).doc);
		const plan = await post(
			'/api/sound-design/beds/plan',
			{ projectId: pid, soundId: ids['Test ambience 4 s'] },
			AGENT_H,
		);
		expect(plan.statusCode, plan.body).toBe(200);
		const p = plan.json() as SoundBedsPlan;
		expect(p.scenes).toHaveLength(3);
		expect(p.commands.at(-1)!.type).toBe('soundDesign.layBed');
		expect(p.commands.some((c) => c.type === 'media.register')).toBe(true);
		const job = await waitJob(
			await post('/api/sound-design/beds', { projectId: pid, soundId: ids['Test ambience 4 s'] }, AGENT_H),
		);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const r = SoundBedsResultSchema.parse(job.result);
		expect(r.applied).toBe(false);
		expect(r.proposalId).toMatch(/^prp_/);
		const before = await liveDoc(pid);
		const pr = (await get(`/api/projects/${pid}/proposals/${r.proposalId}`, AGENT_H)).json() as {
			proposal: Proposal;
		};
		const bed = pr.proposal.items.find((i) => i.id === 'bed')!;
		expect(bed.requires?.length).toBeGreaterThan(0);
		expect(pr.proposal.items.filter((i) => isSetupItem(i)).length).toBeGreaterThan(0);
		// nothing changed until the user accepts
		expect(Object.values(before.doc.sequences)[0]!.audioTracks.some((t) => t.name === 'Ambience')).toBe(
			false,
		);
		// an agent may not accept it (agentsMayApply off); the user does
		const refused = await post(
			`/api/projects/${pid}/proposals/${r.proposalId}/accept`,
			{ itemIds: ['bed'] },
			AGENT_H,
		);
		expect(refused.statusCode).toBe(403);
		const accept = await post(`/api/projects/${pid}/proposals/${r.proposalId}/accept`, { itemIds: ['bed'] });
		expect(accept.statusCode, accept.body).toBe(200);
		const after = await liveDoc(pid);
		const seq = Object.values(after.doc.sequences)[0]!;
		expect(
			Object.values(seq.clips).filter((c) => readClipBed((c as { bed?: unknown }).bed)).length,
		).toBeGreaterThanOrEqual(6);
		expect(after.revision).toBe(before.revision + 1);
		// refusals
		const unknown = await post(
			'/api/sound-design/beds/plan',
			{ projectId: pid, soundId: 'snd_00000000deadbeef' },
			AGENT_H,
		);
		expect(unknown.statusCode, unknown.body).toBe(404);
		const none = await post('/api/sound-design/beds/plan', { projectId: pid }, AGENT_H);
		expect(none.statusCode).toBe(422);
		expect((none.json() as { code: string }).code).toBe('BED_SOUND_REQUIRED');
		const overlap = await post(
			'/api/sound-design/beds/plan',
			{
				projectId: pid,
				soundId: ids['Test ambience 4 s'],
				scenes: [
					{ start: 0, end: 100 },
					{ start: 50, end: 150 },
				],
			},
			AGENT_H,
		);
		expect(overlap.statusCode).toBe(400);
		const bad = await post('/api/sound-design/beds', { projectId: pid, scenes: 'some' }, AGENT_H);
		expect(bad.statusCode).toBe(400);
		const noSeq = await post('/api/sound-design/beds', { projectId: pid, sequenceId: 'seq_nope' }, AGENT_H);
		expect(noSeq.statusCode).toBe(404);
	});
});

describe('room tone (real engine)', { timeout: 900_000 }, () => {
	/** Two dialogue clips of one recording (media 0–4 s at 0–4 s, 5–9 s at 5–9 s): a 1 s hole at 4–5 s. */
	async function dialogueGap(): Promise<string> {
		const b = new DocBuilder('hd-1080p-30', 191 + projects);
		const file = join(mediaDir, 'dialogue.wav');
		const x = dialogue();
		writeFileSync(file, encodeWav([x, x], SR, 's16'));
		const m = b.addMedia(await register(app, file, auth));
		const r = b.tx([
			{
				type: 'clip.place',
				source: { mediaId: m },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
				at: 0,
				tracks: { audio: 'A1' },
				ref: '$a',
			},
			{
				type: 'clip.place',
				source: { mediaId: m },
				sourceRange: { in: { seconds: 5 }, out: { seconds: 9 } },
				at: 150,
				tracks: { audio: 'A1' },
				ref: '$b',
			},
		]);
		b.tx([{ type: 'essentialSound.setType', clipIds: [r.refs.$a!, r.refs.$b!], audioType: 'dialogue' }]);
		const clips = Object.values(b.doc.sequences[b.seqId]!.clips).map((c) => [c.start, c.start + c.duration]);
		expect(clips.sort((p, q) => p[0]! - q[0]!)).toEqual([
			[0, 120],
			[150, 270],
		]);
		return seed(b.doc);
	}

	it('Sound Check: SILENCE in the dialogue gap → "Fill it with room tone" (pink, the floor match) → gone', async () => {
		const pid = await dialogueGap();
		const first = await check(pid);
		const silence = first.issues.find(
			(i) => i.code === 'SILENCE' && i.range!.start >= 110 && i.range!.end <= 160,
		);
		expect(silence, describeIssues(first)).toBeDefined();
		const fix = silence!.fix!;
		console.info(`[room tone] ${silence!.message.text} → ${fix.label.text} (${fix.why})`);
		expect(fix.kind).toBe('commands');
		expect(fix.safe).toBe(false);
		expect(fix.label.text).toContain('Room tone pink');
		const lay = fix.commands!.find((c) => c.type === 'soundDesign.layBed') as unknown as {
			purpose: string;
			shots: { start: number; end: number }[];
		};
		expect(lay.purpose).toBe('roomtone');
		const before = await liveDoc(pid);
		const tx = await post('/api/agent/tx', {
			projectId: pid,
			transaction: {
				label: fix.label.text.slice(0, 200),
				origin: { agent: 'beds-test' },
				commands: fix.commands,
			},
		});
		expect(tx.statusCode, tx.body).toBe(200);
		expect((tx.json() as { result: { ok: boolean } }).result.ok, tx.body).toBe(true);
		const after = await liveDoc(pid);
		expect(after.revision).toBe(before.revision + 1);
		const again = await check(pid);
		console.info(`[room tone] after the fix:\n${describeIssues(again)}`);
		expect(
			again.issues.filter((i) => i.code === 'SILENCE' && i.range!.start < 160 && i.range!.end > 110),
			describeIssues(again),
		).toEqual([]);
		for (const code of ['CLICK', 'EDGE'])
			expect(
				again.issues.filter((i) => i.code === code && i.severity !== 'info'),
				describeIssues(again),
			).toEqual([]);
		const [l] = await exportAudio(pid, 'room-tone');
		const gap = rmsDb(l!, Math.round(4.1 * SR), Math.round(4.9 * SR));
		const floor = rmsDb(l!, Math.round(0.05 * SR), Math.round(0.45 * SR));
		console.info(
			`[room tone] export: the gap ${gap.toFixed(2)} dBFS, the dialogue's floor before the speech ${floor.toFixed(2)} dBFS`,
		);
		expect(gap).toBeGreaterThan(-60);
		expect(Math.abs(gap - floor)).toBeLessThan(3);
	});

	it('the fill route: the gaps, the floor, the candidates by spectral distance, the gain', async () => {
		const pid = await dialogueGap();
		const job = await waitJob(await post('/api/sound-design/room-tone', { projectId: pid, mode: 'apply' }));
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const r = SoundRoomToneResultSchema.parse(job.result);
		const p = r.plan;
		console.info(
			`[room tone] floor ${p.floor?.levelDb} dBFS; candidates ${p.candidates.map((c) => `${c.title} ${c.distanceDb} dB`).join(', ')}; chosen ${p.chosen?.sound.title} (${p.chosen?.why}) gain ${p.chosen?.gainDb} dB`,
		);
		expect(r.applied).toBe(true);
		expect(p.gaps.map((g) => [g.start, g.end])).toEqual([[120, 150]]);
		expect(p.gaps[0]!.fill).toEqual({ start: 112, end: 158 });
		expect(Math.abs(p.floor!.levelDb - -52)).toBeLessThan(2.5);
		expect(p.chosen!.source).toBe('library');
		expect(p.chosen!.sound.title).toBe('Room tone pink');
		const dist = Object.fromEntries(p.candidates.map((c) => [c.title, c.distanceDb!]));
		expect(dist['Room tone pink']!).toBeLessThan(dist['Room tone hum']!);
		expect(dist['Room tone pink']!).toBeLessThan(dist['Room tone hiss']!);
		expect(dist['Room tone pink']!).toBeLessThan(6);
		// the dialogue's own quiet stretch is a candidate too
		expect(p.candidates.some((c) => c.source === 'dialogue')).toBe(true);
		// at the floor: the tone's window level + gain ≈ −52 dBFS
		expect(Math.abs(p.chosen!.sound.window.levelDb + p.chosen!.gainDb - -52)).toBeLessThan(2.5);
		const { doc } = await liveDoc(pid);
		const seq = Object.values(doc.sequences)[0]!;
		const fill = Object.values(seq.clips).filter(
			(c) => readClipBed((c as { bed?: unknown }).bed)?.purpose === 'roomtone',
		);
		expect(fill.length).toBeGreaterThanOrEqual(1);
		expect(seq.audioTracks.find((t) => t.id === fill[0]!.trackId)!.name).toBe('Room Tone');
		// source "dialogue": the recording's own room tone, looped
		const own = await post(
			'/api/sound-design/room-tone/plan',
			{ projectId: pid, source: 'dialogue' },
			AGENT_H,
		);
		expect(own.statusCode, own.body).toBe(200);
		const op = own.json() as {
			chosen: { source: string; sound: { loop: { inSec: number; outSec: number } } };
		};
		expect(op.chosen.source).toBe('dialogue');
		expect(op.chosen.sound.loop.outSec - op.chosen.sound.loop.inSec).toBeGreaterThan(0.4);
	});
});
