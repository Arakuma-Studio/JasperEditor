// Music to picture on a real engine (spec 12 P6-E11 "Done when"; wp-note "Phase 6 → WP-E7"), with generated music of a
// known key, bar lines and drop (`dropMusic`: C major, 120 BPM, the drop at bar 17 = 32 s):
//   - `/api/audio/beats` reports the key (C major) and the drop as the top candidate;
//   - an anchored `/api/audio/remix-plan` + `clip.remix` lands the drop on the hero frame: MEASURED in the native
//     export by cross-correlating the exported audio around the hero with the source around the drop (≤ 1 ms);
//   - the remix joints (anchored, and a plain remix of the generated test music) cause no CLICK or EDGE finding;
//   - End on Bar: the exported music ends within a frame of the bar line, faded;
//   - hostile inputs (no beat: a steady tone; a 1 s clip; an anchor outside the music; an exact target no plan
//     reaches) are refused with typed errors.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BeatsResult, RemixPlanResult, SoundCheckReport } from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { mgRegistry } from '@jasper/mg-templates';
import {
	type AudioClip,
	defaultRegistries,
	endOnBarPlan,
	type ProjectDocument,
	remixCommandOf,
	type Sequence,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dropMusic, testMusic } from '../../../packages/audio-fx/test/music.ts';
import { checkSequence } from '../src/sound-design/check.ts';
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
} from './helpers.ts';

vi.setConfig({ testTimeout: 600_000 });

const SR = 48_000;
const FPS = 30;
const OUT = join(ROOT, 'test-results', 'sd-music-picture');
let app: TestApp;
let dir: string;
const media: Record<string, Awaited<ReturnType<typeof register>>> = {};
let dropSrc: Float32Array;

beforeAll(async () => {
	app = await makeApp();
	dir = mkdtempSync(join(tmpdir(), 'jasper-music-picture-'));
	mkdirSync(OUT, { recursive: true });
	const drop = dropMusic(SR, 120, 32, 17);
	dropSrc = drop.audio[0]!;
	writeFileSync(join(dir, 'drop.wav'), encodeWav(drop.audio, SR, 'f32'));
	writeFileSync(join(dir, 'test.wav'), encodeWav(testMusic(SR, 120, 24, 7).audio, SR, 'f32'));
	const tone = Float32Array.from({ length: SR * 20 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR));
	writeFileSync(join(dir, 'tone.wav'), encodeWav([tone, tone], SR, 'f32'));
	const short = drop.audio.map((c) => c.slice(0, SR));
	writeFileSync(join(dir, 'short.wav'), encodeWav(short, SR, 'f32'));
	for (const k of ['drop', 'test', 'tone', 'short']) media[k] = await register(app, join(dir, `${k}.wav`));
}, 300_000);
afterAll(async () => {
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload: Record<string, unknown>) =>
	app.inject({ method: 'POST', url, headers: JSON_H, payload });

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

async function exportAudio(d: DocBuilder, name: string): Promise<Float32Array> {
	const start = await post('/api/exports', {
		envelope: d.envelope(),
		sequenceId: d.seqId,
		settings: {
			sequenceId: d.seqId,
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
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	const file = (await coreServices(app).exports.outputFile(start.json().id))!;
	try {
		execFileSync(TEST_FFMPEG, [
			...['-v', 'error', '-y', '-i', file],
			...['-filter_complex', '[0:a]showwavespic=s=1600x240:split_channels=0', '-frames:v', '1'],
			join(OUT, `${name}.png`),
		]);
	} catch {
		// the picture is for looking at, not an assertion
	}
	return decode(file);
}

/** Lag (samples) of `y` around `at` against `x` around `src` maximising their cross-correlation over ±`r`. */
function lagOf(x: Float32Array, src: number, y: Float32Array, at: number, r: number, w = 4096): number {
	let best = 0;
	let bestV = Number.NEGATIVE_INFINITY;
	for (let lag = -r; lag <= r; lag++) {
		let v = 0;
		for (let k = -w; k < w; k++) v += (x[src + k] ?? 0) * (y[at + lag + k] ?? 0);
		if (v > bestV) {
			bestV = v;
			best = lag;
		}
	}
	return best;
}

async function soundCheck(doc: ProjectDocument): Promise<SoundCheckReport> {
	const core = coreServices(app);
	const seq = doc.sequences[Object.keys(doc.sequences)[0]!] as Sequence;
	const scratch = mkdtempSync(join(tmpdir(), 'jasper-music-check-'));
	try {
		return await checkSequence(
			doc,
			seq,
			{ projectId: 'prj_0000000000000001', revision: null, preset: 'web' },
			{
				ff: core.ffmpeg,
				registry: core.registry,
				registries: defaultRegistries(mgRegistry),
				mgTemplates: mgRegistry,
				scratchDir: scratch,
			},
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function musicDoc(key: string): { d: DocBuilder; clipId: string } {
	const d = new DocBuilder();
	const m = d.addMedia(media[key]!);
	const r = d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, ref: '$m' }]);
	const clipId = r.refs.$m!;
	d.tx([{ type: 'essentialSound.setType', clipIds: [clipId], audioType: 'music' }]);
	return { d, clipId };
}

const seqOf = (d: DocBuilder) => d.doc.sequences[d.seqId]!;

describe('music to picture on the engine', () => {
	it('the beats route reports the key (C major) and the drop at bar 17', async () => {
		const res = await post('/api/audio/beats', {
			mediaKey: media.drop!.mediaKey,
			startSeconds: 0,
			durationSeconds: 64,
		});
		expect(res.statusCode, res.body).toBe(200);
		const b = res.json() as BeatsResult;
		console.info(
			`[music] key ${b.key?.name} (${b.key?.confidence}), drops ${JSON.stringify(b.drops.slice(0, 3))}`,
		);
		expect(b.key?.scale).toEqual([0, 2, 4, 5, 7, 9, 11]);
		expect(b.key!.confidence).toBeGreaterThanOrEqual(0.6);
		expect(b.drops[0]!.bar).toBe(17);
		expect(Math.abs(b.drops[0]!.sourceSeconds - 32)).toBeLessThan(0.005);
		const tone = (await post('/api/audio/beats', {
			mediaKey: media.tone!.mediaKey,
			startSeconds: 0,
			durationSeconds: 20,
		}).then((r) => r.json())) as BeatsResult;
		expect(tone.reason).toBe('NO_BEAT');
		expect(tone.drops).toEqual([]);
		expect(tone.key === null || tone.key.confidence < 0.6).toBe(true);
	});

	it('an anchored remix lands the drop on the hero frame within 1 ms in the export; its joints are clean', async () => {
		const { d, clipId } = musicDoc('drop');
		const hero = 615; // 00:00:20:15
		const first = (await post('/api/audio/remix-plan', {
			mediaKey: media.drop!.mediaKey,
			startSeconds: 0,
			durationSeconds: 64,
			targetSeconds: 64,
		}).then((r) => r.json())) as RemixPlanResult;
		const drop = first.drops![0]!;
		expect(drop.bar).toBe(17);
		const res = await post('/api/audio/remix-plan', {
			mediaKey: media.drop!.mediaKey,
			startSeconds: 0,
			durationSeconds: 64,
			targetSeconds: 64,
			anchors: [{ sourceSeconds: drop.sourceSeconds, outputSeconds: hero / FPS }],
			fit: 'nearest',
			maxTargetSeconds: 64,
		});
		expect(res.statusCode, res.body).toBe(200);
		const plan = res.json() as RemixPlanResult;
		console.info(
			`[music] anchored plan: ${plan.pieces.length} pieces, head ${plan.headTrimSeconds} s, length ${plan.lengthSeconds} s (target ${plan.targetSeconds}), anchor ${JSON.stringify(plan.anchors)}`,
		);
		expect(Math.abs(plan.anchors![0]!.errorMs)).toBeLessThanOrEqual(1);
		expect(Math.abs(plan.lengthSeconds - plan.targetSeconds!)).toBeLessThanOrEqual(0.26);
		const bars = new Set(plan.downbeats!.map((x) => Math.round(x * 1e4)));
		for (const [o, i] of plan.cuts) {
			expect(bars.has(Math.round(o * 1e4)), `cut out ${o}`).toBe(true);
			expect(bars.has(Math.round(i * 1e4)), `cut in ${i}`).toBe(true);
		}
		const cmd = remixCommandOf(seqOf(d).clips[clipId] as AudioClip, plan, { num: FPS, den: 1 });
		d.tx([cmd]);
		const out = await exportAudio(d, 'anchored-remix');
		const lag = lagOf(
			dropSrc,
			Math.round(drop.sourceSeconds * SR),
			out,
			Math.round((hero / FPS) * SR),
			4 * 48,
		);
		console.info(`[music] the drop in the export: ${((1000 * lag) / SR).toFixed(3)} ms from the hero frame`);
		expect(Math.abs(lag)).toBeLessThanOrEqual(SR / 1000);
		const report = await soundCheck(d.doc);
		const pieces = new Set(Object.values(seqOf(d).clips).map((c) => c.id));
		const bad = report.issues.filter(
			(i) => (i.code === 'CLICK' || i.code === 'EDGE') && (i.clipIds ?? []).some((id) => pieces.has(id)),
		);
		console.info(
			`[music] Sound Check: ${report.issues.map((i) => `${i.severity} ${i.code}`).join(', ') || 'no findings'}`,
		);
		expect(bad.map((i) => i.message.text)).toEqual([]);
	});

	it('a plain remix of the generated test music: the joints cause no CLICK or EDGE finding', async () => {
		const { d, clipId } = musicDoc('test');
		const plan = (await post('/api/audio/remix-plan', {
			mediaKey: media.test!.mediaKey,
			startSeconds: 0,
			durationSeconds: 48,
			targetSeconds: 30,
		}).then((r) => r.json())) as RemixPlanResult;
		d.tx([remixCommandOf(seqOf(d).clips[clipId] as AudioClip, plan, { num: FPS, den: 1 })]);
		expect(Object.keys(seqOf(d).clips).length).toBe(plan.pieces.length);
		const report = await soundCheck(d.doc);
		const bad = report.issues.filter((i) => i.code === 'CLICK' || i.code === 'EDGE');
		console.info(
			`[music] plain remix Sound Check: ${report.issues.map((i) => `${i.severity} ${i.code}`).join(', ') || 'no findings'}`,
		);
		expect(bad.map((i) => i.message.text)).toEqual([]);
	});

	it('End on Bar: the exported music ends within a frame of the bar line, faded', async () => {
		const { d, clipId } = musicDoc('drop');
		d.tx([{ type: 'clip.trim', clipId, edge: 'out', deltaFrames: 924 - 1920 }]); // ends at 30.8 s
		const b = (await post('/api/audio/beats', {
			mediaKey: media.drop!.mediaKey,
			startSeconds: 0,
			durationSeconds: 64,
		}).then((r) => r.json())) as BeatsResult;
		const p = endOnBarPlan(d.doc, seqOf(d), clipId, b.downbeats!, { bpm: b.bpm });
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		d.tx(p.commands);
		const out = await exportAudio(d, 'end-on-bar');
		let last = 0;
		for (let i = out.length - 1; i >= 0; i--)
			if (Math.abs(out[i]!) > 1e-4) {
				last = i;
				break;
			}
		const endSec = (last + 1) / SR;
		const barSec = p.barSeconds;
		console.info(
			`[music] End on Bar: bar line ${barSec.toFixed(4)} s, clip end frame ${p.endFrame}, music heard until ${endSec.toFixed(4)} s, fade ${p.fadeFrames} frames`,
		);
		expect(endSec).toBeLessThanOrEqual(barSec);
		expect(barSec - endSec).toBeLessThanOrEqual(1 / FPS + 0.004);
		const rms = (a: number, b2: number) => {
			let e = 0;
			for (let i = a; i < b2; i++) e += out[i]! ** 2;
			return 10 * Math.log10(e / Math.max(1, b2 - a) + 1e-20);
		};
		const endS = last + 1;
		const fadeS = Math.round((p.fadeFrames / FPS) * SR);
		// the fade: the last tenth of it far under the music just before it
		expect(
			rms(endS - fadeS - SR / 10, endS - fadeS) - rms(endS - Math.round(fadeS / 10), endS),
		).toBeGreaterThan(12);
	});

	it('hostile inputs are refused with typed errors', async () => {
		const tone = await post('/api/audio/remix-plan', {
			mediaKey: media.tone!.mediaKey,
			startSeconds: 0,
			durationSeconds: 20,
			targetSeconds: 10,
			anchors: [{ sourceSeconds: 5, outputSeconds: 3 }],
		});
		expect(tone.statusCode).toBe(422);
		expect(tone.json().code).toBe('REMIX_NO_BEAT');
		const short = await post('/api/audio/remix-plan', {
			mediaKey: media.short!.mediaKey,
			startSeconds: 0,
			durationSeconds: 1,
			targetSeconds: 2,
			anchors: [{ sourceSeconds: 0.5, outputSeconds: 1 }],
		});
		expect(short.statusCode).toBe(422);
		expect(['REMIX_NO_BEAT', 'REMIX_TOO_SHORT']).toContain(short.json().code);
		const outside = await post('/api/audio/remix-plan', {
			mediaKey: media.drop!.mediaKey,
			startSeconds: 0,
			durationSeconds: 64,
			targetSeconds: 40,
			anchors: [{ sourceSeconds: 100, outputSeconds: 3 }],
		});
		expect(outside.statusCode).toBe(422);
		expect(outside.json().code).toBe('E_INVALID_PARAM');
		let refused: { code: string; detail?: { nearestTargetSeconds?: number[] } } | null = null;
		for (const t of [50.1, 50.6, 51.1, 51.6]) {
			const r = await post('/api/audio/remix-plan', {
				mediaKey: media.drop!.mediaKey,
				startSeconds: 0,
				durationSeconds: 64,
				targetSeconds: t,
				anchors: [{ sourceSeconds: 32, outputSeconds: 20 }],
			});
			if (r.statusCode === 422) {
				refused = r.json();
				break;
			}
		}
		expect(refused?.code).toBe('E_INVALID_PARAM');
		expect(refused?.detail?.nearestTargetSeconds?.length).toBeGreaterThan(0);
		const tooMany = await post('/api/audio/remix-plan', {
			mediaKey: media.drop!.mediaKey,
			startSeconds: 0,
			durationSeconds: 64,
			targetSeconds: 40,
			anchors: Array.from({ length: 5 }, (_, i) => ({ sourceSeconds: i, outputSeconds: i })),
		});
		expect(tooMany.statusCode).toBe(400);
	});
});
