// Tune to the key and stop on the bar MEASURED in an export (spec 12 P6-E11 "Done when": "a chime of MIDI 70 over a
// C-major track is pitched to an in-key note within ±1 st"; "the stop ramp ends on the downbeat"). A real engine indexes
// a generated kit with one chime (a decaying B♭4, MIDI 70); a 32 s C-major music clip (`dropMusic`, 120 BPM: downbeats
// every 2 s) sits on A1; a stored hero cue asks for a chime at 6.3 s (frame 189), 0.3 s after the downbeat at 6.0 s.
// The plan job (Auto Sound Pass / plan_sound_design, style `stopBefore`, `tuneToMusic` and `stopOnBar` on their
// defaults) proposes the chime and a stop-before; the editor accepts; the sequence is exported (native, PCM) twice —
// with the music (the dip measured against the source music) and with the music track muted (the chime's pitch by
// zero crossings). With `tuneToMusic: false` / `stopOnBar: false` the plan leaves both alone.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type EngineJob, type SoundDesignPlanResult, SoundDesignPlanResultSchema } from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import {
	type AudioClip,
	clipPitchOf,
	inKey,
	isSetupItem,
	makeEnvelope,
	type ProjectDocument,
	type Proposal,
	soundCuesOf,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropMusic } from '../../../packages/audio-fx/test/music.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	JSON_H,
	makeApp,
	ROOT,
	register,
	TEST_FFMPEG,
	type TestApp,
	tempAppdir,
} from './helpers.ts';

const SR = 48_000;
const CHIME_HZ = 440 * 2 ** (1 / 12); // B♭4 = MIDI 70
const CHIME2_MIDI = 71.3; // B4 + 30 cents: its own nearest scale note is B (−0.3 st)
const HERO = 189;
const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const OUT = join(ROOT, 'test-results', 'sd-music-plan');

/** A chime: a tone with a soft 3rd partial, 3 ms attack, 0.6 s decay, 1.2 s long (B♭4 by default). */
function chime(hz = CHIME_HZ): Float32Array {
	return Float32Array.from({ length: Math.round(1.2 * SR) }, (_, i) => {
		const t = i / SR;
		const env = Math.min(1, t / 0.003) * Math.exp(-t / 0.6);
		return 0.5 * env * (Math.sin(2 * Math.PI * hz * t) + 0.1 * Math.sin(2 * Math.PI * 3 * hz * t));
	});
}

function makeKit(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const x = chime();
	writeFileSync(join(dir, 'chime.wav'), encodeWav([x, x], SR, 's16'));
	const y = chime(440 * 2 ** ((CHIME2_MIDI - 69) / 12));
	writeFileSync(join(dir, 'chime2.wav'), encodeWav([y, y], SR, 's16'));
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			version: 1,
			packs: [],
			sounds: [
				{
					file: 'chime.wav',
					title: 'Glass chime',
					types: ['chime'],
					tags: ['test'],
					author: 'Test Author',
					license: 'CC0-1.0',
				},
				{
					file: 'chime2.wav',
					title: 'Bell chime',
					types: ['chime'],
					tags: ['test'],
					author: 'Test Author',
					license: 'CC0-1.0',
				},
			],
		}),
	);
	return dir;
}

function decode(file: string): Float32Array {
	const out = execFileSync(
		TEST_FFMPEG,
		['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-f', 'f32le', '-'],
		{
			maxBuffer: 1 << 30,
		},
	);
	return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

/** Frequency of a tone in `x[from, from + n)` by upward zero crossings over whole periods. */
function frequencyOf(x: Float32Array, from: number, n: number): number {
	const ups: number[] = [];
	for (let i = from + 1; i < from + n && i < x.length; i++)
		if (x[i - 1]! < 0 && x[i]! >= 0) ups.push(i - 1 + x[i - 1]! / (x[i - 1]! - x[i]!));
	if (ups.length < 3) return Number.NaN;
	return ((ups.length - 1) * SR) / (ups[ups.length - 1]! - ups[0]!);
}

const rmsDb = (x: Float32Array, a: number, b: number) => {
	let e = 0;
	for (let i = a; i < b; i++) e += x[i]! ** 2;
	return 10 * Math.log10(e / Math.max(1, b - a) + 1e-20);
};

let app: TestApp;
let musicSrc: Float32Array;
let musicMediaKey = '';
let musicClipId = '';
let glassId = '';
const PID = 'prj_0000000000000001';

async function waitJob(id: string): Promise<EngineJob> {
	return coreServices(app).queue.wait(id);
}
const inject = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
	app.inject({ method, url, headers: JSON_H, ...(payload !== undefined ? { payload } : {}) });

beforeAll(async () => {
	process.env.JASPER_SOUND_STARTER_DIR = makeKit(tempAppdir('jasper-music-kit-'));
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '0';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
	app = await makeApp();
	mkdirSync(OUT, { recursive: true });
	const idx = await inject('POST', '/api/sounds/index', {});
	expect(idx.statusCode, idx.body).toBe(202);
	expect((await waitJob((idx.json() as EngineJob).id)).state).toBe('succeeded');
	const found = await inject('GET', '/api/sounds?q=Glass%20chime');
	glassId = (found.json() as { results: { sound: { id: string; title: string } }[] }).results.find(
		(r) => r.sound.title === 'Glass chime',
	)!.sound.id;
	const m = dropMusic(SR, 120, 16, 9);
	musicSrc = m.audio[0]!;
	const dir = tempAppdir('jasper-music-media-');
	writeFileSync(join(dir, 'music.wav'), encodeWav(m.audio, SR, 'f32'));
	const reg = await register(app, join(dir, 'music.wav'));
	musicMediaKey = reg.mediaKey;
	const b = new DocBuilder('hd-1080p-30', 71);
	const mid = b.addMedia(reg);
	const r = b.tx([{ type: 'clip.place', source: { mediaId: mid }, at: 0, ref: '$m' }]);
	musicClipId = r.refs.$m!;
	b.tx([
		{ type: 'essentialSound.setType', clipIds: [r.refs.$m!], audioType: 'music' },
		{
			type: 'soundCue.add',
			cues: [{ frame: HERO, kind: 'emphasis', weight: 'hero', types: ['chime'], source: 'user', ref: '$c' }],
		},
	]);
	const doc = { ...b.doc, projectId: PID };
	const file = appdirPaths(app.appdir).projectFile(PID);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(makeEnvelope(doc, { revision: 3, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' })),
	);
}, 900_000);

afterAll(async () => {
	await closeApps();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

async function liveDoc(): Promise<{ doc: ProjectDocument; revision: number }> {
	const q = await inject('POST', '/api/agent/query', { projectId: PID, query: 'doc.get', args: {} });
	const live = q.json() as { result: ProjectDocument; revision: number };
	return { doc: live.result, revision: live.revision };
}

async function plan(
	style: Record<string, unknown>,
): Promise<{ result: SoundDesignPlanResult; proposal: Proposal }> {
	const { doc } = await liveDoc();
	const seqId = Object.keys(doc.sequences)[0]!;
	const cueId = soundCuesOf(doc.sequences[seqId]!)[0]!.id;
	const res = await inject('POST', '/api/sound-design/plan', {
		projectId: PID,
		sequenceId: seqId,
		cues: [cueId],
		// the palette puts the MIDI-70 chime first (the spec's case); the bell (MIDI 71.3) is its alternative
		style: { seed: 3, stopBefore: true, palette: [glassId], ...style },
	});
	expect(res.statusCode, res.body).toBe(202);
	const job = await waitJob((res.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	const result = SoundDesignPlanResultSchema.parse(job.result);
	const pr = await inject('GET', `/api/projects/${PID}/proposals/${result.proposalId}`);
	return { result, proposal: (pr.json() as { proposal: Proposal }).proposal };
}

async function exportOf(doc: ProjectDocument, revision: number, name: string): Promise<Float32Array> {
	const seqId = Object.keys(doc.sequences)[0]!;
	const start = await inject('POST', '/api/exports', {
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
	const done = await waitJob(start.json().id);
	expect(done.error).toBeUndefined();
	const file = (await coreServices(app).exports.outputFile(start.json().id))!;
	try {
		execFileSync(TEST_FFMPEG, [
			...['-v', 'error', '-y', '-ss', '4', '-t', '4', '-i', file],
			...['-filter_complex', '[0:a]showwavespic=s=1600x300:split_channels=0', '-frames:v', '1'],
			join(OUT, `${name}.png`),
		]);
	} catch {
		// the picture is for looking at
	}
	return decode(file);
}

describe('tune to the key and stop on the bar (measured in the export)', { timeout: 900_000 }, () => {
	it('with the style off the chime keeps its pitch and the stop its 0.25 s', async () => {
		const { result, proposal } = await plan({ tuneToMusic: false, stopOnBar: false });
		const ev = result.report.events[0]!;
		expect(ev.tuning).toBeUndefined();
		expect(ev.stopOn).toBeUndefined();
		const stop = proposal.items.find((i) => i.id.startsWith('stop:'))!;
		expect((stop.meta as { stopBefore: { seconds: number } }).stopBefore.seconds).toBe(0.25);
		expect(result.report.grammar).toMatchObject({
			tuneToMusic: false,
			stopOnBar: false,
			tuned: 0,
			stopsOnBar: 0,
		});
	});

	it('the chime (MIDI 70) over C major plays an in-key note within ±1 st; the stop ramp ends on the downbeat', async () => {
		const { result, proposal } = await plan({});
		const ev = result.report.events[0]!;
		console.info(
			`[music plan] event ${JSON.stringify({ tuning: ev.tuning, rate: ev.rate, notes: ev.notes, stopOn: ev.stopOn })}`,
		);
		// the chosen chime: B♭4 (MIDI 70) → A4 (−1 st, the more stable of A and B); its alternative, the bell (MIDI
		// 71.3) → B4 (−0.3 st)
		expect(ev.sound.title).toBe('Glass chime');
		const sourceMidi = 70;
		expect(ev.tuning).toMatchObject({ key: 'C major', note: 'A4', st: -1 });
		expect(Math.abs(ev.tuning!.st)).toBeLessThanOrEqual(1);
		expect(ev.notes.some((n) => /^tuned -\d+(\.\d+)? st to C major$/.test(n))).toBe(true);
		// the alternative (the other chime) is tuned to the key on its own pitch
		const place = proposal.items.find((i) => i.id === ev.itemId)!;
		const alt = (place.alternatives ?? [])[0] as
			| { commands: { layers?: { pitchSt?: number }[] }[] }
			| undefined;
		expect(alt).toBeDefined();
		const altSt = alt!.commands[0]!.layers![0]!.pitchSt ?? 0;
		const altMidi = CHIME2_MIDI;
		console.info(`[music plan] chosen ${ev.sound.title} ${ev.tuning!.st} st; the alternative ${altSt} st`);
		expect(inKey(Math.round(altMidi + altSt), { tonic: 0, mode: 'major' })).toBe(true);
		expect(Math.abs(altMidi + altSt - Math.round(altMidi + altSt))).toBeLessThan(0.02);
		expect(ev.stopOn).toBe('downbeat');
		const stop = proposal.items.find((i) => i.id.startsWith('stop:'))!;
		const secs = (stop.meta as { stopBefore: { seconds: number } }).stopBefore.seconds;
		expect(Math.abs(6.3 - secs - 6.0)).toBeLessThan(0.005);
		expect(stop.label).toContain('on the bar line');
		expect(result.report.grammar).toMatchObject({
			tuneToMusic: true,
			stopOnBar: true,
			tuned: 1,
			stopsOnBar: 1,
		});
		const accept = await inject('POST', `/api/projects/${PID}/proposals/${proposal.id}/accept`, {
			itemIds: proposal.items.filter((i) => !isSetupItem(i)).map((i) => i.id),
		});
		expect(accept.statusCode, accept.body).toBe(200);
		const { doc, revision } = await liveDoc();
		const seq = Object.values(doc.sequences)[0]!;
		const cue = soundCuesOf(seq)[0]!;
		const clip = seq.clips[cue.placedClipIds![0]!] as AudioClip;
		expect(clipPitchOf(clip).st).toBeCloseTo(ev.tuning!.st, 3);
		// the downbeat the ramp ends on: the music's measured attack at 6.0 s (media = sequence time here)
		const beats = (await inject('POST', '/api/audio/beats', {
			mediaKey: musicMediaKey,
			startSeconds: 0,
			durationSeconds: 32,
		}).then((r) => r.json())) as { downbeats: number[] };
		const down = beats.downbeats.find((d) => Math.abs(d - 6) < 0.05)!;
		expect(Math.abs(6.3 - secs - down)).toBeLessThan(1e-6);
		// 1. with the music: the dip (export against the source music, same windows)
		const full = await exportOf(doc, revision, 'stop-on-bar');
		const s = (t: number) => Math.round(t * SR);
		const before = [s(down - 0.06), s(down - 0.035)] as const;
		const inside = [s(down + 0.001), s(down + 0.02)] as const;
		const dipExport = rmsDb(full, ...inside) - rmsDb(full, ...before);
		const dipSource = rmsDb(musicSrc, ...inside) - rmsDb(musicSrc, ...before);
		console.info(
			`[music plan] downbeat ${down} s: music ${(dipExport - dipSource).toFixed(2)} dB in the 19 ms after it (relative to 35–60 ms before)`,
		);
		expect(dipExport - dipSource).toBeLessThan(-20);
		expect(dipExport - dipSource).toBeGreaterThan(-28);
		// and 35–60 ms before the downbeat the music is untouched (the 30 ms ramp starts after): the export's level
		// against the source there is the same as a second earlier (the mix's own pan law is in both)
		const ref = [s(down - 1.06), s(down - 1.035)] as const;
		const offBefore = rmsDb(full, ...before) - rmsDb(musicSrc, ...before);
		const offRef = rmsDb(full, ...ref) - rmsDb(musicSrc, ...ref);
		expect(Math.abs(offBefore - offRef)).toBeLessThan(0.5);
		// 2. the music muted: the chime's pitch
		const muted = structuredClone(doc);
		const ms = Object.values(muted.sequences)[0]!;
		const musicTrack = ms.audioTracks.find((t) => t.id === seq.clips[musicClipId]!.trackId)!;
		expect(musicTrack.id).not.toBe(clip.trackId);
		musicTrack.mute = true;
		const chimeOut = await exportOf(muted, revision, 'chime-tuned');
		const hz = frequencyOf(chimeOut, s(HERO / 30) + s(0.01), s(0.1));
		const midi = 69 + 12 * Math.log2(hz / 440);
		console.info(
			`[music plan] the chime plays ${hz.toFixed(2)} Hz = MIDI ${midi.toFixed(3)} (source MIDI ${sourceMidi})`,
		);
		expect(Math.abs(midi - Math.round(midi))).toBeLessThan(0.05);
		expect(inKey(Math.round(midi), { tonic: 0, mode: 'major' })).toBe(true);
		expect(Math.abs(midi - sourceMidi)).toBeLessThanOrEqual(1.05);
	});
});
