// One dialogue definition everywhere (spec 12 P6-R3; wp-note "Phase 6 → WP6.3"): on one edit — real speech (LJ Speech)
// on an Essential Sound dialogue clip without a transcript, speaking 2–6 s and 9–11 s of a 12 s clip, music under it,
// cuts at 4 s (in speech) and 7.5 s (in the pause), sound effects at 4.2 s and 7.6 s — the engine's voice activity, the
// cue route, the plan job's cue collection, the masking solver's speech overlap and Sound Check's speech segments all
// agree: the cut and the effect in speech are "under dialogue", the ones in the pause are not, and the ranges are the
// same frames. Without voice activity (the pure fallback) the whole clip is dialogue.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type SoundCheckResult,
	SoundCheckResultSchema,
	SoundCuesResponseSchema,
	type SoundDesignPlanRequest,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import { mgRegistry } from '@jasper/mg-templates';
import { dialogueSpans, makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testMusic } from '../../../packages/audio-fx/test/music.ts';
import { MeasureCache, measureSfxEvents } from '../src/sound-design/bed.ts';
import { collectPlanCues, resolveStyle } from '../src/sound-design/plan.ts';
import { voiceServiceFor } from '../src/sound-design/voice.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, ROOT, register, TEST_FFMPEG, type TestApp } from './helpers.ts';

const HAVE_FFMPEG = spawnSync(TEST_FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;
const JSON_H = { host: '127.0.0.1:47900', 'content-type': 'application/json' };
const SR = 48_000;
const LJ = join(ROOT, 'fixtures', 'speech', 'lj-composite.flac');

let app: TestApp;
let doc: ProjectDocument;
let seqId = '';
let projectId = '';
const ids: Record<string, string> = {};

function decode(path: string, ss: number, t: number): Float32Array {
	const r = spawnSync(TEST_FFMPEG, ['-v', 'error', '-ss', String(ss), '-t', String(t), '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], {
		maxBuffer: 1 << 28,
	});
	const b = r.stdout as Buffer;
	const out = new Float32Array(b.byteLength / 4);
	Buffer.from(out.buffer).set(b.subarray(0, out.length * 4));
	return out;
}

async function post(url: string, body: unknown) {
	const r = await app.inject({ method: 'POST', url, headers: JSON_H, payload: JSON.stringify(body) });
	return { status: r.statusCode, json: () => JSON.parse(r.body) as Record<string, unknown>, body: r.body };
}

describe.skipIf(!HAVE_FFMPEG)('dialogue ranges agree across cue derivation, the plan, the solver and Sound Check', () => {
	beforeAll(async () => {
		app = await makeApp();
		const dir = mkdtempSync(join(tmpdir(), 'jasper-dialogue-'));
		// voice: LJ speech at 2–6 s and 9–11 s of 12 s (digital silence between)
		const voice = new Float32Array(12 * SR);
		voice.set(decode(LJ, 0.62, 4).subarray(0, 4 * SR), 2 * SR);
		voice.set(decode(LJ, 6.78, 2).subarray(0, 2 * SR), 9 * SR);
		writeFileSync(join(dir, 'voice.wav'), encodeWav([voice, voice], SR, 's16'));
		const music = testMusic(SR, 120, 6, 4).audio.map((c) => c.map((v) => v * 0.2));
		writeFileSync(join(dir, 'music.wav'), encodeWav(music, SR, 's16'));
		const hit = new Float32Array(SR / 2);
		for (let i = 0; i < hit.length; i++) hit[i] = 0.6 * Math.exp(-i / (0.05 * SR)) * Math.sin((2 * Math.PI * 1200 * i) / SR);
		writeFileSync(join(dir, 'hit.wav'), encodeWav([hit, hit], SR, 's16'));
		for (const [name, src] of [
			['a.mp4', 'testsrc2=s=320x180:r=30:d=12'],
			['b.mp4', 'smptebars=s=320x180:r=30:d=12'],
		] as const) {
			const r = spawnSync(TEST_FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-an', join(dir, name)], {
				encoding: 'utf8',
			});
			expect(r.status, r.stderr).toBe(0);
		}
		const b = new DocBuilder('hd-1080p-30', 777);
		const m = {
			voice: b.addMedia(await register(app, join(dir, 'voice.wav'))),
			music: b.addMedia(await register(app, join(dir, 'music.wav'))),
			hit: b.addMedia(await register(app, join(dir, 'hit.wav'))),
			a: b.addMedia(await register(app, join(dir, 'a.mp4'))),
			b: b.addMedia(await register(app, join(dir, 'b.mp4'))),
		};
		const shot = (mediaId: string, inS: number, outS: number, at: number) => ({
			type: 'clip.place',
			source: { mediaId },
			sourceRange: { in: { seconds: inS }, out: { seconds: outS } },
			at,
			tracks: { video: 'V1' },
		});
		const r = b.tx([
			shot(m.a, 0, 4, 0),
			shot(m.b, 0, 3.5, 120),
			shot(m.a, 6, 10.5, 225),
			{ type: 'clip.place', source: { mediaId: m.voice }, at: 0, tracks: { audio: 'A1' }, ref: '$voice' },
			{ type: 'clip.place', source: { mediaId: m.music }, at: 0, tracks: { audio: 'A2' }, ref: '$music' },
			{ type: 'clip.place', source: { mediaId: m.hit }, at: 126, tracks: { audio: 'A3' }, ref: '$inSpeech' },
			{ type: 'clip.place', source: { mediaId: m.hit }, at: 228, tracks: { audio: 'A3' }, ref: '$inPause' },
		]);
		Object.assign(ids, r.refs);
		// record keys are not ref contexts: tag by id
		b.tx([
			{ type: 'essentialSound.autoTag', results: { [r.refs.$voice!]: { category: 'dialogue', confidence: 0.9 } } },
			{ type: 'essentialSound.setType', clipIds: [r.refs.$music!], audioType: 'music' },
			{ type: 'essentialSound.setType', clipIds: [r.refs.$inSpeech!, r.refs.$inPause!], audioType: 'sfx' },
		]);
		doc = b.doc;
		seqId = b.seqId;
		projectId = 'prj_0000000000007777';
		const file = appdirPaths(app.appdir).projectFile(projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(makeEnvelope({ ...doc, projectId }, { revision: 1, savedAt: '2026-10-17T00:00:00.000Z', platform: 'test' })),
		);
	}, 300_000);
	afterAll(closeApps);

	it('every consumer reads the same ranges', { timeout: 900_000 }, async () => {
		const core = coreServices(app);
		const seq = doc.sequences[seqId]!;
		// 1. voice activity of the dialogue clip (media seconds) ≈ where LJ speaks
		const v = await voiceServiceFor(core.ffmpeg, core.registry).forSequence(doc, seq);
		expect(v.state).toBe('ready');
		const regions = v.voice[ids.$voice!]!;
		expect(regions[0]![0]).toBeGreaterThan(1.9);
		expect(regions[0]![0]).toBeLessThan(2.3);
		expect(regions.at(-1)![1]).toBeGreaterThan(10.6);
		expect(regions.at(-1)![1]).toBeLessThan(11.1);
		expect(regions.some(([a, b]) => a < 7.5 && b > 6.6)).toBe(false);
		const spans = dialogueSpans(doc, seq, { voice: v.voice });
		expect(spans.length).toBe(2);
		expect(spans.every((s) => s.sources.join() === 'vad')).toBe(true);
		const inSpans = (f: number) => spans.some((s) => f >= s.start && f < s.end);
		expect(inSpans(120)).toBe(true);
		expect(inSpans(225)).toBe(false);
		// without the measurement the whole clip is dialogue
		expect(dialogueSpans(doc, seq).map((s) => [s.start, s.end])).toEqual([[0, 360]]);

		// 2. the cue route: the same spans, the cut in speech suppressed, the one in the pause kept
		const c = await post('/api/sound-design/cues', { projectId, opts: { sources: ['edits'], density: 'rich' } });
		expect(c.status, c.body).toBe(200);
		const cues = SoundCuesResponseSchema.parse(c.json());
		expect(cues.dialogue.map((d) => [d.start, d.end])).toEqual(spans.map((s) => [s.start, s.end]));
		expect(cues.voice?.state).toBe('ready');
		expect(cues.voiceActivity?.[ids.$voice!]).toEqual(regions);
		expect(cues.cues.filter((x) => x.kind === 'cut').map((x) => x.frame)).toEqual([225]);
		expect(cues.stats.bySource.edits!.suppressedByDialogue).toBe(1);

		// 3. the plan's cue collection with the same voice activity (the job measures it the same way)
		const req = { projectId, sequenceId: seqId, style: { cueSources: ['edits'] } } as SoundDesignPlanRequest;
		const style = resolveStyle(req, seq);
		const planned = collectPlanCues(doc, seq, req, style, { mgTemplates: mgRegistry, voice: v.voice });
		expect(planned.cues.filter((x) => x.kind === 'cut').map((x) => x.frame)).toEqual([225]);
		expect(collectPlanCues(doc, seq, req, style, { mgTemplates: mgRegistry }).cues.filter((x) => x.kind === 'cut')).toEqual([]);

		// 4. the solver: speech overlap of each effect is "its window meets a dialogue span"
		const m = await measureSfxEvents(
			{
				bedDoc: doc,
				sequenceId: seqId,
				targets: [ids.$inSpeech!, ids.$inPause!].map((clipId) => ({ doc, clipId, weight: 'support' as const })),
			},
			{ ff: core.ffmpeg, registry: core.registry, cache: new MeasureCache() },
		);
		const speech = m.sounds.get(ids.$inSpeech!)!;
		const pause = m.sounds.get(ids.$inPause!)!;
		expect(speech.speechOverlap).toBe(true);
		expect(speech.speechTracks).toEqual(['A1']);
		expect(pause.speechOverlap).toBe(false);
		for (const s of [speech, pause]) {
			const meets = spans.some((d) => d.start / 30 < s.window.end && d.end / 30 > s.window.start);
			expect(s.speechOverlap).toBe(meets);
		}

		// 5. Sound Check: its speech segments are the same spans (seconds, to one 10 ms hop)
		const r = await post('/api/sound-design/check', { projectId });
		expect(r.status, r.body).toBe(202);
		const job = await core.queue.wait((r.json() as unknown as EngineJob).id);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const result: SoundCheckResult = SoundCheckResultSchema.parse(job.result);
		const segs = result.report.speech.segments;
		expect(segs.length).toBe(spans.length);
		segs.forEach(([a, b], i) => {
			expect(Math.abs(a - Math.max(0, spans[i]!.start) / 30)).toBeLessThanOrEqual(0.011);
			expect(Math.abs(b - Math.min(360, spans[i]!.end) / 30)).toBeLessThanOrEqual(0.011);
		});
	});
});
