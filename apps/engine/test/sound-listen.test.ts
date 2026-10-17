// Listening transcript (spec 12 §4 P6-E6, P6-E7; wp-note "Phase 6 → WP-E3") on a real engine with generated media: the
// Sound Check fixture (music, dialogue, three placed sounds) plus a production-audio hit inside the dialogue and two
// cuts on V1. Every placed sound's event is found within 1 ms of its aligned point and attributed to its clip; the
// dialogue hit to the dialogue clip; ≥ 90 % of placed sounds 6 dB under the music are heard; the chance levels equal a
// brute-force count; the transcript lines name clips, cues and the cut with no sound; typed refusals; the visual
// route's spectrogram. JASPER_LISTEN_BENCH=1 also times a 10-minute sequence.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type SoundListenResult,
	SoundListenResultSchema,
	SoundVisualResponseSchema,
} from '@jasper/api';
import { encodeWav, LoudnessMeter } from '@jasper/audio-dsp';
import { syncChance } from '@jasper/audio-fx';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, type DocBuilder, makeApp, register, type TestApp } from './helpers.ts';
import { hitSamples, musicSamples, SR, speechSamples } from './sound-bed-fixture.ts';
import { buildCheckDoc, type FixtureMedia, fpsOf, registerCheckMedia } from './sound-check-fixture.ts';

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_listen_0123456789abcdef01';
const KEY = 'key_listen_0123456789abcdef01';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'listen-agent' };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });
/** The production-audio hit inside the dialogue file (s). */
const DIALOGUE_HIT_SEC = 6.5;

let app: TestApp;
let media: FixtureMedia;
let dialogueWithHit: Awaited<ReturnType<typeof register>>;
let dir: string;
let projects = 0;
const timings: { name: string; ms: number }[] = [];

function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(++projects).toString().padStart(16, '0')}`;
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
async function post(url: string, body: unknown) {
	return app.inject({ method: 'POST', url, headers: json(AGENT_H), payload: JSON.stringify(body) });
}
async function listen(body: Record<string, unknown>, name: string): Promise<SoundListenResult> {
	const t0 = Date.now();
	const r = await post('/api/sound-design/listen', body);
	expect(r.statusCode, r.body).toBe(202);
	const job: EngineJob = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	timings.push({ name, ms: Date.now() - t0 });
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return SoundListenResultSchema.parse(job.result);
}

/** Three colour mattes on V1: cuts at 3 s (on cue B) and 9.3 s (nothing there: the music fades out). */
function addPicture(b: DocBuilder): { cuts: number[] } {
	const fps = fpsOf(b);
	const at = [0, 3, 9.3].map((s) => Math.round(s * fps));
	const len = [at[1]! - at[0]!, at[2]! - at[1]!, Math.round(10 * fps) - at[2]!];
	at.forEach((f, i) => {
		const r = b.tx([
			{ type: 'synthetic.create', kind: 'color-matte', params: { color: [i / 3, 0.2, 1 - i / 3, 1] }, ref: '$m' },
		]);
		const item = Object.values(b.doc.items).find(
			(it) => it.kind === 'synthetic' && (it as { syntheticId?: string }).syntheticId === r.refs.$m,
		);
		const pid = item?.id ?? Object.values(b.doc.items).filter((it) => it.kind === 'synthetic').at(-1)!.id;
		b.tx([{ type: 'clip.place', source: { projectItemId: pid }, at: f, tracks: { video: 'V1' }, ref: '$v' }]);
		const clip = Object.values(b.doc.sequences[b.seqId]!.clips).find(
			(c) => c.kind !== 'audio' && c.start === f,
		)!;
		if (len[i]! !== clip.duration)
			b.tx([{ type: 'clip.trim', clipId: clip.id, edge: 'out', deltaFrames: len[i]! - clip.duration }]);
	});
	return { cuts: at.slice(1) };
}

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	dir = mkdtempSync(join(tmpdir(), 'jasper-listen-'));
	media = await registerCheckMedia(app, dir, TOKEN);
	// the dialogue with a production hit inside it (a door knock in the interview)
	const speech = speechSamples();
	const hit = hitSamples();
	const at = Math.round(DIALOGUE_HIT_SEC * SR) - Math.round(0.05 * SR);
	for (let c = 0; c < 2; c++) for (let i = 0; i < hit[c]!.length; i++) speech[c]![at + i]! += hit[c]![i]!;
	const p = join(dir, 'interview.wav');
	writeFileSync(p, encodeWav(speech, SR, 's16'));
	dialogueWithHit = await register(app, p, { authorization: `Bearer ${TOKEN}` });
}, 180_000);
afterAll(async () => {
	console.log(`listen timings (ms): ${timings.map((t) => `${t.name} ${t.ms}`).join(', ')}`);
	await closeApps();
});

describe('listen_to_sequence (real engine)', { timeout: 600_000 }, () => {
	it('attributes every sound to its clip and cue, matches the cuts and reports chance levels', async () => {
		const fx = buildCheckDoc({ ...media, speech: dialogueWithHit });
		const { cuts } = addPicture(fx.b);
		const projectId = seed(fx.doc());
		const r = await listen({ projectId }, 'fixture');
		console.log(`listen transcript of the fixture:\n${r.text}`);
		const fps = fpsOf(fx.b);
		expect(r.wholeSequence).toBe(true);
		expect(r.counts.lanes).toBeGreaterThanOrEqual(3);
		// every placed sound: its own event within 1 ms of its aligned point, heard in the mix, attributed to it
		expect(r.placed.map((p) => p.clipId).sort()).toEqual([fx.ids.clipA, fx.ids.clipB, fx.ids.clipC].sort());
		for (const p of r.placed) {
			expect(p.ownOffsetMs, `${p.title} ${JSON.stringify(p)}`).not.toBeNull();
			expect(Math.abs(p.ownOffsetMs!), p.title).toBeLessThanOrEqual(1);
			expect(p.heard, p.title).toBe(true);
			const e = r.events[p.mixEvent!]!;
			expect(e.clipId).toBe(p.clipId);
			expect(e.stem).toBe('sfx');
			expect(e.explainedBy).toBe('event');
			expect(e.cueId).toBe(p.cueId);
			expect(Math.abs(e.ms - p.alignedMs!), p.title).toBeLessThanOrEqual(1);
		}
		const hitA = r.events[r.placed.find((p) => p.clipId === fx.ids.clipA)!.mixEvent!]!;
		expect(hitA).toMatchObject({ role: 'hero', cueKind: 'cut' });
		// the production hit inside the dialogue is the dialogue clip's
		const knock = r.events.filter((e) => e.shape === 'hit' && Math.abs(e.ms - DIALOGUE_HIT_SEC * 1000) <= 5);
		expect(knock, JSON.stringify(r.events.filter((e) => Math.abs(e.ms - DIALOGUE_HIT_SEC * 1000) < 150))).toHaveLength(1);
		expect(knock[0]).toMatchObject({ stem: 'dialogue', clipId: fx.ids.speech, explainedBy: 'event' });
		// the cut at 3 s is answered by the click on cue B (frame 90); the cut at 9.3 s has no sound
		const cutAt = (f: number) => r.pictureEvents.find((p) => p.kind === 'cut' && p.frame === f)!;
		expect(cuts).toEqual([90, 279]);
		expect(cutAt(90)).toMatchObject({ status: 'ok' });
		expect(r.events[cutAt(90).event!]!.clipId).toBe(fx.ids.clipB);
		expect(cutAt(279).status).toBe('none');
		expect(r.unanswered.map((u) => u.key)).toContain(cutAt(279).key);
		expect(r.events[cutAt(90).event!]!.answers.map((a) => a.key)).toContain(cutAt(90).key);
		// cues: all three answered within a frame
		const cues = r.pictureEvents.filter((p) => p.kind === 'cue');
		expect(cues.map((c) => c.cueId).sort()).toEqual([fx.ids.cueA, fx.ids.cueB, fx.ids.cueC].sort());
		for (const c of cues) expect(c.status, c.label).toBe('ok');
		// chance levels equal a brute-force count of random times over the same span
		const times = r.events.filter((e) => e.prominenceDb >= 3).map((e) => e.ms);
		for (const s of [r.sync.cuts!, r.sync.cues!, r.sync.all!]) {
			const [lo, hi] = s.spanMs;
			let ok = 0;
			let within = 0;
			let total = 0;
			for (let t = lo; t < hi; t += 0.1) {
				total++;
				const d = Math.min(...times.map((x) => Math.abs(x - t)));
				if (d <= s.frameMs) ok++;
				if (d <= 100) within++;
			}
			expect(Math.abs(s.okChance - ok / total)).toBeLessThanOrEqual(0.002);
			expect(Math.abs(s.within100Chance - within / total)).toBeLessThanOrEqual(0.002);
			expect(s.okChance).toBeCloseTo(syncChance(times, lo, hi, s.frameMs), 3);
		}
		expect(r.sync.cuts).toMatchObject({ n: 2, ok: 1, none: 1, okShare: 0.5 });
		expect(r.sync.cues).toMatchObject({ n: 3, ok: 3, okShare: 1 });
		expect(r.sync.beatsKnown).toBe(false);
		expect(r.sync.cuts!.frameMs).toBeCloseTo(1000 / fps, 1);
		// sections: dialogue + music in the middle, measured under the voice
		const talk = r.sections.find((s) => s.classes.includes('dialogue'));
		expect(talk, JSON.stringify(r.sections)).toBeDefined();
		expect(talk!.classes).toContain('music');
		expect(talk!.start / fps).toBeGreaterThan(3);
		expect(talk!.end / fps).toBeLessThan(9);
		expect(talk!.music?.underVoiceLu).not.toBeNull();
		expect(r.sections[0]!.classes).toContain('music');
		// the transcript
		expect(r.text.split('\n')).toEqual(r.lines.map((l) => `${l.timecode}  ${l.text}`));
		expect(r.lines[0]!.kind).toBe('summary');
		const line = (i: number) => r.lines.find((l) => l.kind === 'event' && l.event === i)?.text ?? '';
		expect(line(r.placed.find((p) => p.clipId === fx.ids.clipA)!.mixEvent!)).toMatch(
			/^hit, \w+ band, \+\d+ dB (over the bed|out of silence).* · SFX A\d "Test hit 0" \(hero, cue cut\)/,
		);
		expect(line(r.placed.find((p) => p.clipId === fx.ids.clipB)!.mixEvent!)).toMatch(/answers Cut on V1/);
		expect(line(r.events.indexOf(knock[0]!))).toMatch(/dialogue, A2 "interview\.wav"/);
		expect(r.lines.some((l) => l.kind === 'unanswered' && /^NO SOUND for Cut on V1/.test(l.text))).toBe(true);
		expect(r.lines.some((l) => l.kind === 'sync' && /Sync, cuts: 1\/2 have a sound within 1 frame \(50 %; chance \d+ %\)/.test(l.text))).toBe(true);
		expect(r.lines.some((l) => l.kind === 'section')).toBe(true);
		for (let i = 1; i < r.lines.length; i++) expect(r.lines[i]!.frame).toBeGreaterThanOrEqual(r.lines[i - 1]!.frame - 0);
		// loudness as delivered (the fixture normalises; no current analysis → as mixed, said so)
		expect(r.loudness.integratedLufs).not.toBeNull();
		expect(r.loudness.normalization.applied).toBe(false);
		expect(r.loudness.normalization.reason).toMatch(/analysis/);
		// deterministic
		const again = await listen({ projectId }, 'fixture again');
		expect({ ...again, timings: {} }).toEqual({ ...r, timings: {} });
		// detail
		const low = await listen({ projectId, detail: 'low' }, 'fixture low');
		const high = await listen({ projectId, detail: 'high' }, 'fixture high');
		expect(low.lines.length).toBeLessThanOrEqual(r.lines.length);
		expect(low.lines.filter((l) => l.kind === 'event').every((l) => low.events[l.event!]!.accent)).toBe(true);
		expect(r.lines.filter((l) => l.kind === 'event').length).toBeLessThan(high.lines.filter((l) => l.kind === 'event').length);
		expect(high.lines.filter((l) => l.kind === 'event').length).toBe(high.events.length);
		// a range
		const part = await listen({ projectId, range: { start: 60, end: 120 } }, 'range');
		expect(part.wholeSequence).toBe(false);
		expect(part.events.every((e) => e.frame >= 60 && e.frame < 120)).toBe(true);
		expect(part.placed.map((p) => p.clipId)).toEqual([fx.ids.clipB]);
	});

	it('hears ≥ 90 % of placed sounds that sit 6 dB under the music', async () => {
		const fx = buildCheckDoc(media, { noSpeech: true });
		const fps = fpsOf(fx.b);
		// the hit's loudest momentary and the music's, as the mix plays them (music +1.5 dB)
		const lm = (planar: Float32Array[]) => {
			const m = new LoudnessMeter(SR, 2);
			m.process(planar);
			return m.maxMomentary();
		};
		const music = lm(musicSamples()) + 1.5;
		const hit = lm(hitSamples());
		const gain = music - 6 - hit;
		// ten hits away from the fixture's own three (frames 30, 90, 255)
		const frames = [1.6, 2.2, 3.7, 4.3, 4.9, 5.5, 6.1, 6.7, 7.3, 7.9].map((s) => Math.round(s * fps));
		const ids: string[] = [];
		for (const f of frames) {
			const r = fx.b.tx([
				{ type: 'soundCue.add', cues: [{ frame: f, kind: 'appear', weight: 'support', source: 'user', ref: '$c' }] },
				{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: fx.ids.hitMedia, role: 'support', align: 'peak', ref: '$x' }] },
			]);
			ids.push(r.refs.$x!);
		}
		fx.b.tx([{ type: 'audio.setGain', clipIds: ids, mode: 'set', db: Math.round(gain * 10) / 10 }]);
		const projectId = seed(fx.doc());
		const r = await listen({ projectId }, 'under music');
		const quiet = r.placed.filter((p) => ids.includes(p.clipId));
		const heard = quiet.filter((p) => p.heard).length;
		const guided = quiet.filter((p) => p.heard && r.events[p.mixEvent!]!.guided).length;
		console.log(
			`listen: ${heard}/${quiet.length} placed sounds 6 dB under the music heard (${guided} of them found at their own onset, not by the blind onset curve; gain ${gain.toFixed(1)} dB; music max momentary ${music.toFixed(1)} LUFS, hit ${hit.toFixed(1)})`,
		);
		for (const p of quiet.filter((x) => !x.heard))
			console.log(
				`not heard: ${JSON.stringify(p)} near: ${JSON.stringify(r.events.filter((e) => Math.abs(e.ms - (p.ownEventMs ?? p.alignedMs ?? 0)) < 80).map((e) => [e.ms, e.mixMs, e.clipName, e.prominenceDb, e.explainedBy]))}`,
			);
		expect(quiet.length).toBe(10);
		expect(heard / quiet.length).toBeGreaterThanOrEqual(0.9);
		for (const p of quiet.filter((x) => x.heard)) expect(r.events[p.mixEvent!]!.clipId).toBe(p.clipId);
	});

	it('refuses bad requests with typed errors', async () => {
		const fx = buildCheckDoc(media);
		const projectId = seed(fx.doc());
		const bad = async (body: unknown, status: number, code: string) => {
			const r = await post('/api/sound-design/listen', body);
			expect(r.statusCode, r.body).toBe(status);
			expect((r.json() as { code: string }).code).toBe(code);
		};
		await bad({ projectId, range: { start: 400, end: 500 } }, 400, 'RANGE_EMPTY');
		await bad({ projectId, nope: 1 }, 400, 'VALIDATION_FAILED');
		await bad({ projectId, detail: 'loud' }, 400, 'VALIDATION_FAILED');
		await bad({ projectId, sequenceId: 'seq_nope' }, 404, 'SEQUENCE_NOT_FOUND');
		await bad({ projectId: 'prj_0000000000009999' }, 404, 'PROJECT_NOT_FOUND');
		// over 10 minutes
		const long = buildCheckDoc(media);
		const seq = long.doc().sequences[long.b.seqId]!;
		const music = Object.values(seq.clips).find((c) => c.kind === 'audio')!;
		long.b.tx([{ type: 'clip.move', clipIds: [music.id], deltaFrames: Math.round(11 * 60 * fpsOf(long.b)) }]);
		await bad({ projectId: seed(long.doc()) }, 400, 'RANGE_TOO_LONG');
	});

	it('the visual route draws the mix spectrogram when asked', async () => {
		const fx = buildCheckDoc(media);
		const projectId = seed(fx.doc());
		const r = await post('/api/sound-design/visual', { projectId, range: { start: 0, end: 150 }, spectrogram: true });
		expect(r.statusCode, r.body).toBe(200);
		const v = SoundVisualResponseSchema.parse(r.json());
		const s = v.spectrogram!;
		expect(s.frames).toBe(v.points);
		expect(s.bands).toBe(96);
		const data = Buffer.from(s.data, 'base64');
		expect(data.length).toBe(s.frames * s.bands);
		// the hero hit at 1 s is loud in the low bands; the music fills the rest
		const col = (sec: number) => data.subarray(Math.round(sec * 100) * s.bands, (Math.round(sec * 100) + 1) * s.bands);
		const low = (c: Uint8Array) => c.subarray(0, 24).reduce((a, b) => a + b, 0);
		expect(low(col(1.01))).toBeGreaterThan(low(col(0.5)));
		const plain = SoundVisualResponseSchema.parse(
			(await post('/api/sound-design/visual', { projectId, range: { start: 0, end: 150 } })).json(),
		);
		expect(plain.spectrogram).toBeUndefined();
	});

	it.runIf(process.env.JASPER_LISTEN_BENCH === '1')('times a 10-minute sequence', async () => {
		const fx = buildCheckDoc(media, { noSpeech: true });
		const fps = fpsOf(fx.b);
		const seq = fx.doc().sequences[fx.b.seqId]!;
		const musicClip = Object.values(seq.clips).find((c) => c.kind === 'audio' && c.start === 0 && c.duration > 200)!;
		// 60 copies of the 10 s music and a hit every 3 s
		const cmds: unknown[] = [];
		for (let k = 1; k < 60; k++)
			cmds.push({
				type: 'clip.place',
				source: { mediaId: (musicClip as { mediaId: string }).mediaId },
				at: Math.round(k * 10 * fps),
				tracks: { audio: 'A1' },
			});
		fx.b.tx(cmds);
		for (let k = 4; k < 200; k++)
			fx.b.tx([
				{ type: 'soundCue.add', cues: [{ frame: Math.round(k * 3 * fps), kind: 'cut', weight: 'support', source: 'user', ref: '$c' }] },
				{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: fx.ids.clickMedia, role: 'support', align: 'peak' }] },
			]);
		const projectId = seed(fx.doc());
		const t0 = Date.now();
		const r = await listen({ projectId }, '10 min');
		const ms = Date.now() - t0;
		console.log(
			`listen 10 min: ${ms} ms (timings ${JSON.stringify(r.timings)}; ${r.counts.events} events, ${r.counts.lanes} lanes, ${r.placed.filter((p) => p.heard).length}/${r.placed.length} placed heard)`,
		);
		expect(r.range.end / fps).toBeGreaterThan(590);
	});
});
