// Stop-before, build and room glue on rendered audio (spec 12 §2.4, P4-R3; wp-note "Phase 4 → WP4.2a"), on a real
// engine with generated media and the export mixer:
//   - stop-before: a 440 Hz music tone under a hero at 5 s, exported natively (24-bit PCM in MOV) and decoded: the dip
//     is −24 dB deep, starts 0.25 s before the hero (30 ms ramp) and is back 20 ms after it;
//   - build: pink-noise music's spectral centroid rises over the build window and comes back after the hero; a 220 Hz
//     tone through the sweep has no discontinuity (third difference far under a step's);
//   - room glue: the hit's energy appears in the "SFX Room" return, the interface click (no send) renders identically
//     with or without the room, and the bed / solo measurements count the return as the sound's own contribution.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '@jasper/audio-dsp';
import { bandLevels, welchPower } from '@jasper/audio-fx';
import type { LibraryProvenance } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	MeasureCache,
	type MeasureDeps,
	measureSfxEvents,
	renderSequencePcm,
	soloTailSec,
} from '../src/sound-design/bed.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';
import { provenance, SR, writeBedFixture } from './sound-bed-fixture.ts';

let app: TestApp;
let deps: MeasureDeps;
let dir: string;
let files: ReturnType<typeof writeBedFixture> & { tone440: string; tone220: string };

const FPS = 30;
const db = (x: number) => 20 * Math.log10(Math.max(1e-12, x));

function toneWav(path: string, hz: number, seconds: number, amp: number): string {
	const n = Math.round(seconds * SR);
	const l = new Float32Array(n);
	for (let i = 0; i < n; i++) l[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
	writeFileSync(path, encodeWav([l, l.slice()], SR, 'f32'));
	return path;
}

function rms(x: Float32Array, a: number, b: number): number {
	let e = 0;
	const s = Math.max(0, Math.floor(a));
	const t = Math.min(x.length, Math.floor(b));
	for (let i = s; i < t; i++) e += x[i]! * x[i]!;
	return Math.sqrt(e / Math.max(1, t - s));
}

function decode(file: string): Float32Array {
	const r = spawnSync(
		TEST_FFMPEG,
		['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
		{
			maxBuffer: 256 * 1024 * 1024,
		},
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	const b = r.stdout;
	return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

async function exportPcm(d: DocBuilder): Promise<string> {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: {
				sequenceId: d.seqId,
				destination: { type: 'download' },
				range: { type: 'entire' },
				container: 'mov',
				video: {
					codec: 'h264',
					width: 320,
					height: 180,
					frameRate: { num: FPS, den: 1 },
					scaling: 'fit',
					quality: { mode: 'crf', value: 35 },
					encoderSpeed: 'fast',
				},
				audio: { codec: 'pcm', sampleRate: SR, channels: 2 },
				engine: 'native',
			},
		},
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	return (await coreServices(app).exports.outputFile(start.json().id))!;
}

/** A doc with a music clip (`music`, typed music) on A1 and a hero cue at `frame` with the given fields. */
async function musicDoc(music: string, frame: number, cue: Record<string, unknown>) {
	const d = new DocBuilder('hd-1080p-30', 700);
	const m = d.addMedia(await register(app, music));
	const r = d.tx([
		{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{
			type: 'soundCue.add',
			cues: [{ frame, kind: 'land', weight: 'hero', source: 'user', ref: '$c', ...cue }],
		},
	]);
	return { d, music: r.refs.$m!, cue: r.refs.$c! };
}

beforeAll(async () => {
	app = await makeApp();
	const core = coreServices(app);
	deps = { ff: core.ffmpeg, registry: core.registry, cache: new MeasureCache() };
	dir = mkdtempSync(join(tmpdir(), 'jasper-mix-'));
	files = {
		...writeBedFixture(dir),
		tone440: toneWav(join(dir, 'tone440.wav'), 440, 10, 0.1),
		tone220: toneWav(join(dir, 'tone220.wav'), 220, 10, 0.1),
	};
}, 120_000);
afterAll(closeApps);

describe('stop-before on exported audio', { timeout: 300_000 }, () => {
	it('the music dips −24 dB from 0.25 s before the hero (30 ms ramps) and is back 20 ms after it', async () => {
		const { d, cue } = await musicDoc(files.tone440, 150, { stopBefore: { seconds: 0.25, depthDb: -24 } });
		const r = d.tx([{ type: 'soundDesign.applyStopBefore', cueId: cue }]);
		expect((r.results[0] as { writes: { target: string }[] }).writes[0]!.target).toBe('trackVolume');
		const x = decode(await exportPcm(d));
		const T = 5 * SR;
		const ref = rms(x, 3.5 * SR, 4.5 * SR);
		expect(db(ref)).toBeGreaterThan(-30);
		// the floor (between the ramps)
		const floor = db(rms(x, T - 0.2 * SR, T - 0.03 * SR)) - db(ref);
		expect(Math.abs(floor + 24), `floor ${floor.toFixed(2)} dB`).toBeLessThan(0.3);
		// timing: −12 dB (the ramps' middle) crossed at T − 0.265 s going down and at T + 0.005 s coming back
		const win = Math.round(SR / 440) * 2; // two periods
		const env = (i: number) => db(rms(x, i - win / 2, i + win / 2)) - db(ref);
		let down = -1;
		for (let i = T - 0.4 * SR; i < T; i += 8)
			if (env(i) < -12) {
				down = i;
				break;
			}
		let up = -1;
		for (let i = T + 0.1 * SR; i > T - 0.2 * SR; i -= 8)
			if (env(i) < -12) {
				up = i;
				break;
			}
		const downMs = ((down - T) / SR) * 1000;
		const upMs = ((up - T) / SR) * 1000;
		expect(Math.abs(downMs - -265), `down at ${downMs.toFixed(1)} ms`).toBeLessThan(3);
		expect(Math.abs(upMs - 5), `up at ${upMs.toFixed(1)} ms`).toBeLessThan(3);
		// outside the dip the music is untouched
		expect(Math.abs(db(rms(x, T + 0.1 * SR, T + 1 * SR)) - db(ref))).toBeLessThan(0.05);
		writeFileSync(join(tmpdir(), 'jasper-stop-before-export.json'), JSON.stringify({ floor, downMs, upMs }));
	});
});

describe('build on rendered audio', { timeout: 300_000 }, () => {
	it('the spectral centroid of the music rises over the build and returns after the hero', async () => {
		const { d, cue } = await musicDoc(files.music, 180, { build: { seconds: 2, fromHz: 150, toHz: 2000 } });
		d.tx([{ type: 'soundDesign.applyBuild', cueId: cue }]);
		const out = await renderSequencePcm(d.doc, d.seqId, { start: 90, end: 210 }, null, deps);
		const sr = out.sampleRate;
		const at = (sec: number) => Math.round((sec - 3) * sr);
		const centroid = (a: number, b: number) => {
			const w = welchPower(out.channels, out.channels[0]!.length, sr, at(a), at(b))!;
			let num = 0;
			let den = 0;
			for (let k = 1; k < w.power.length; k++) {
				num += k * w.binHz * w.power[k]!;
				den += w.power[k]!;
			}
			return num / den;
		};
		const before = centroid(3.2, 3.8);
		const c = [4.1, 4.6, 5.1, 5.6, 5.85].map((t) => centroid(t, t + 0.12));
		const after = centroid(6.2, 6.8);
		for (let i = 1; i < c.length; i++)
			expect(c[i]!, `centroid rises: ${c.map(Math.round)}`).toBeGreaterThan(c[i - 1]!);
		expect(c[c.length - 1]!).toBeGreaterThan(1.5 * before);
		expect(Math.abs(after - before) / before).toBeLessThan(0.1);
		writeFileSync(join(tmpdir(), 'jasper-build-centroid.json'), JSON.stringify({ before, c, after }));
	});

	it('a 220 Hz tone through the sweep has no click (third difference ≪ a step)', async () => {
		const { d, cue } = await musicDoc(files.tone220, 180, { build: { seconds: 2, fromHz: 150, toHz: 2000 } });
		d.tx([{ type: 'soundDesign.applyBuild', cueId: cue }]);
		const out = await renderSequencePcm(d.doc, d.seqId, { start: 90, end: 210 }, null, deps);
		const x = out.channels[0]!;
		const amp = 0.1;
		// a clean 220 Hz sine's third difference is at most A·ω³ ≈ 2.4e-6 at 48 kHz; a step of 1 % of A gives ≈ 1e-3
		const w = (2 * Math.PI * 220) / out.sampleRate;
		let max = 0;
		let at = 0;
		for (let i = 3; i < x.length; i++) {
			const d3 = Math.abs(x[i]! - 3 * x[i - 1]! + 3 * x[i - 2]! - x[i - 3]!);
			if (d3 > max) {
				max = d3;
				at = i;
			}
		}
		expect(max, `max third difference ${max} at ${(3 + at / out.sampleRate).toFixed(3)} s`).toBeLessThan(
			amp * w ** 3 * 20,
		);
		// the detector sees a 1 % step
		const y = Float32Array.from(x);
		for (let i = 48_000; i < y.length; i++) y[i]! *= 1.01;
		let ymax = 0;
		for (let i = 3; i < y.length; i++)
			ymax = Math.max(ymax, Math.abs(y[i]! - 3 * y[i - 1]! + 3 * y[i - 2]! - y[i - 3]!));
		expect(ymax).toBeGreaterThan(amp * w ** 3 * 20);
		writeFileSync(
			join(tmpdir(), 'jasper-build-clicks.json'),
			JSON.stringify({ max, limit: amp * w ** 3 * 20, ymax }),
		);
	});
});

describe('room glue on rendered audio', { timeout: 300_000 }, () => {
	async function roomDoc() {
		const d = new DocBuilder('hd-1080p-30', 900);
		const music = d.addMedia(await register(app, files.music));
		const hit = d.addMedia(await register(app, files.hit));
		const click = d.addMedia(await register(app, files.click));
		const clickLib: LibraryProvenance = { ...provenance('click'), types: ['click', 'ui'] };
		const r = d.tx([
			{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
			{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
			{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
			{ type: 'media.setLibraryInfo', mediaId: click, library: clickLib },
			{ type: 'track.add', kind: 'audio', count: 2 },
			{
				type: 'soundDesign.place',
				frame: 60,
				layers: [{ mediaId: hit, track: 'A2', role: 'hero', ref: '$h' }],
			},
			{ type: 'soundDesign.place', frame: 150, layers: [{ mediaId: click, track: 'A3', ref: '$k' }] },
		]);
		const plain = d.doc;
		d.tx([{ type: 'soundDesign.ensureBus', roomGlue: { sendDb: -16, decay: 0.6 } }]);
		return { d, plain, ids: { music: r.refs.$m!, hit: r.refs.$h!, click: r.refs.$k! } };
	}

	it('the hit sends into the SFX Room (its tail is in the mix); the interface click is dry', async () => {
		const { d, plain, ids } = await roomDoc();
		const seq = d.doc.sequences[d.seqId]!;
		const a2 = seq.audioTracks[1]!;
		const a3 = seq.audioTracks[2]!;
		expect(a2.mixer?.sends?.[0]?.target).toBe(seq.submixTracks![0]!.id);
		expect(a3.mixer?.sends ?? []).toEqual([]);
		const range = { start: 45, end: 135 };
		const wet = await renderSequencePcm(d.doc, d.seqId, range, new Set([ids.hit]), deps);
		const dry = await renderSequencePcm(plain, d.seqId, range, new Set([ids.hit]), deps);
		const sr = wet.sampleRate;
		// after the hit (0.6 s from 1.95 s) the room tail is there, the dry render is silent
		const a = Math.round((2.65 - 1.5) * sr);
		const b = Math.round((3.2 - 1.5) * sr);
		const tailWet = db(rms(wet.channels[0]!, a, b));
		const tailDry = db(rms(dry.channels[0]!, a, b));
		expect(tailWet - tailDry, `tail ${tailWet.toFixed(1)} vs ${tailDry.toFixed(1)} dBFS`).toBeGreaterThan(30);
		expect(tailWet).toBeGreaterThan(-120);
		// the click: no send, so identical with or without the room
		const cr = { start: 140, end: 180 };
		const cw = await renderSequencePcm(d.doc, d.seqId, cr, new Set([ids.click]), deps);
		const cd = await renderSequencePcm(plain, d.seqId, cr, new Set([ids.click]), deps);
		let diff = 0;
		for (let i = 0; i < cw.channels[0]!.length; i++)
			diff = Math.max(diff, Math.abs(cw.channels[0]![i]! - cd.channels[0]![i]!));
		expect(diff).toBeLessThan(1e-6);
		writeFileSync(
			join(tmpdir(), 'jasper-room-glue.json'),
			JSON.stringify({ tailWet, tailDry, clickDiff: diff }),
		);
	});

	it('the bed has no room return of the effects; each sound alone (with its tail) is its contribution to the mix', async () => {
		const { d, plain, ids } = await roomDoc();
		const doc = d.doc;
		const seq = doc.sequences[d.seqId]!;
		expect(soloTailSec(seq, seq.clips[ids.hit]!)).toBeCloseTo(0.608, 3);
		expect(soloTailSec(seq, seq.clips[ids.click]!)).toBe(0.5);
		const m = await measureSfxEvents(
			{ bedDoc: doc, sequenceId: d.seqId, targets: [{ doc, clipId: ids.hit, weight: 'hero' }] },
			deps,
		);
		const hit = m.sounds.get(ids.hit)!;
		// the bed equals the plain document's bed (music alone): the room carries nothing of the effects there
		const range = { start: 0, end: 150 };
		const bedRoom = await renderSequencePcm(doc, d.seqId, range, new Set([ids.music]), deps);
		const bedPlain = await renderSequencePcm(plain, d.seqId, range, new Set([ids.music]), deps);
		let diff = 0;
		for (let i = 0; i < bedRoom.channels[0]!.length; i++)
			diff = Math.max(diff, Math.abs(bedRoom.channels[0]![i]! - bedPlain.channels[0]![i]!));
		expect(diff).toBeLessThan(1e-6);
		// full mix − bed = the hit with its room return, measured over the hit's window (tail included)
		const full = await renderSequencePcm(doc, d.seqId, range, new Set([ids.music, ids.hit]), deps);
		const sr = full.sampleRate;
		const contrib = full.channels.map((c, k) => c.map((v, i) => v - bedRoom.channels[k]![i]!));
		const w = hit.window;
		const gain = (seq.clips[ids.hit] as { gainDb: number }).gainDb;
		const mine = bandLevels(contrib, sr, w);
		for (let b = 0; b < 7; b++)
			if (hit.soundBandsDb[b]! > -80)
				expect(Math.abs(mine[b]! - (hit.soundBandsDb[b]! + gain)), `band ${b}`).toBeLessThan(0.1);
		void plain;
	});
});
