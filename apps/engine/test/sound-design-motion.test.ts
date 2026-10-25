// Engine cue sources on a real engine with generated media (spec 12 §2.2, §2.8, P6-R2; wp-note "Phase 6 → WP6.2"):
// the `motion-analysis` job on footage of a box that rests, moves and stops (its start and stop found within ±2 frames);
// the cue route's scene, beat and pixel sources (pending with job ids first, never silently missing; then cues whose
// anchors resolve back); `POST /api/audio/beats` on a click track; beat snapping; the plan job measuring inline;
// Sound Check's NO_PICTURE_EVENT using the measured picture; cancellation; hostile bodies; determinism.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BeatsResultSchema,
	type EngineJob,
	type EnvelopeJson,
	MotionAnalysisResultSchema,
	type SoundCheckResult,
	SoundCuesResponseSchema,
	type SoundDesignPlanResult,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import {
	MOVE_OFF,
	MOVE_ON,
	makeEnvelope,
	type PixelMotionCurve,
	type ProjectDocument,
	pixelMotionCues,
	pixelMotionEvents,
	resolveCueAnchor,
	sceneAnchorAt,
} from '@jasper/project';
import { ENGINE_VIDEO_ARGS } from '@jasper/testkit/fixture-video';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobContext } from '../src/jobs/types.ts';
import { editFrames, MotionService, planMotion } from '../src/sound-design/motion.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, TEST_FFMPEG, type TestApp } from './helpers.ts';

const HAVE_FFMPEG = spawnSync(TEST_FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0;
const HOST = { host: '127.0.0.1:47900' };
const JSON_H = { ...HOST, 'content-type': 'application/json' };

let app: TestApp;
let dir = '';
let media: Record<'box' | 'cut' | 'click', Awaited<ReturnType<typeof register>>>;
let projects = 0;
const timings: Record<string, number> = {};

function ff(args: string[]): void {
	const r = spawnSync(TEST_FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/**
 * A textured 240 px box on gray, sequence-sized (1920×1080, 30 fps): still for frames 0–30, 20 px per frame from 30 to
 * 60 (the first moved frame is 31, it arrives at 60), then still. At the analysis size (128 px wide) that is 1.33 px
 * per frame, 0.27 screen diagonals per second.
 */
function boxVideo(file: string, seconds = 4): void {
	ff([
		...['-f', 'lavfi', '-i', `color=c=0x404040:s=1920x1080:r=30:d=${seconds}`],
		...['-f', 'lavfi', '-i', 'testsrc2=s=240x240:r=30:d=1'],
		'-filter_complex',
		"[1:v]trim=end_frame=1,loop=loop=-1:size=1:start=0,setpts=N/30/TB[b];[0:v][b]overlay=x='if(lt(t,1),200,if(lt(t,2),200+(t-1)*600,800))':y=400:shortest=1:eval=frame,format=yuv420p",
		...[...ENGINE_VIDEO_ARGS, '-g', '15', '-an', file],
	]);
}

/** Two shots: 2 s of one test pattern, then 2 s of another (a hard cut at media 2 s). */
function cutVideo(file: string): void {
	ff([
		...['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2'],
		...['-f', 'lavfi', '-i', 'smptebars=s=320x180:r=30:d=2'],
		'-filter_complex',
		'[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p',
		...[...ENGINE_VIDEO_ARGS, '-an', file],
	]);
}

const SR = 48000;
/** A 120 BPM click track (2 kHz clicks, every 4th accented) from `offset` s, 12 s long. */
function clickWav(file: string, offset = 0.25): number[] {
	const n = SR * 12;
	const x = new Float32Array(n);
	const at: number[] = [];
	for (let k = 0; ; k++) {
		const t = offset + k * 0.5;
		const s = Math.round(t * SR);
		if (s >= n) break;
		at.push(t);
		const amp = k % 4 === 0 ? 0.8 : 0.3;
		for (let i = 0; i < 0.03 * SR && s + i < n; i++)
			x[s + i] = amp * Math.exp(-i / (0.004 * SR)) * Math.sin((2 * Math.PI * 2000 * i) / SR);
	}
	writeFileSync(file, encodeWav([x, x], SR, 's16'));
	return at;
}

function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(++projects).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...doc, projectId },
				{ revision: 3, savedAt: '2026-10-17T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}

async function post(url: string, body: unknown) {
	const r = await app.inject({ method: 'POST', url, headers: JSON_H, payload: JSON.stringify(body) });
	return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
}
const wait = (id: string): Promise<EngineJob> => coreServices(app).queue.wait(id);

/** The cue route for engine sources: the first answer may be pending; wait for its jobs and ask again. */
async function cues(body: Record<string, unknown>) {
	const first = await post('/api/sound-design/cues', body);
	expect(first.status, JSON.stringify(first.body)).toBe(200);
	const a = SoundCuesResponseSchema.parse(first.body);
	const pending = a.warnings.filter((w) => w.code === 'W_ANALYSIS_PENDING').flatMap((w) => w.jobIds ?? []);
	if (!pending.length) return { first: a, final: a, pending };
	for (const id of pending) expect((await wait(id)).state).toBe('succeeded');
	const again = await post('/api/sound-design/cues', body);
	return { first: a, final: SoundCuesResponseSchema.parse(again.body), pending };
}

function boxDoc(at = 0, opts: { speed?: number } = {}) {
	const b = new DocBuilder('hd-1080p-30', 300 + projects);
	const id = b.addMedia(media.box);
	const r = b.tx([{ type: 'clip.place', source: { mediaId: id }, at, tracks: { video: 'V1' }, ref: '$v' }]);
	if (opts.speed) b.tx([{ type: 'clip.setSpeed', clipIds: [r.refs.$v!], rate: opts.speed, ripple: false }]);
	return { b, mediaId: id, clipId: r.refs.$v! };
}

describe.skipIf(!HAVE_FFMPEG)('engine cue sources (generated media)', () => {
	beforeAll(async () => {
		app = await makeApp();
		dir = mkdtempSync(join(tmpdir(), 'jasper-p6-'));
		boxVideo(join(dir, 'box.mp4'));
		cutVideo(join(dir, 'cut.mp4'));
		clickWav(join(dir, 'click.wav'));
		media = {
			box: await register(app, join(dir, 'box.mp4')),
			cut: await register(app, join(dir, 'cut.mp4')),
			click: await register(app, join(dir, 'click.wav')),
		};
	}, 180_000);
	afterAll(async () => {
		console.log(`motion timings ${JSON.stringify(timings)}`);
		await closeApps();
	});

	it('measures the moving box, caches it, and exposes the curve through the visual API', async () => {
		const { b } = boxDoc();
		const projectId = seed(b.doc);
		const t0 = Date.now();
		const r = await post('/api/sound-design/motion', { projectId });
		expect(r.status, JSON.stringify(r.body)).toBe(202);
		const job = await wait((r.body as { id: string }).id);
		timings.box4s = Date.now() - t0;
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const analysed = MotionAnalysisResultSchema.parse(job.result);
		expect(analysed).toMatchObject({ projectId, cached: false, frames: 120, range: { start: 0, end: 120 } });
		expect(analysed.renderPath).toBeTruthy();
		expect(analysed.curve.speed).toHaveLength(120);
		expect(analysed.curve.width).toBe(128);
		const move = analysed.events.find((e) => e.kind === 'move')!;
		expect(Math.abs(move.start! - 31), JSON.stringify(analysed.events)).toBeLessThanOrEqual(2);
		expect(Math.abs(move.end! - 61), JSON.stringify(analysed.events)).toBeLessThanOrEqual(2);
		expect(move.direction).toBe('right');
		expect(move.global).toBe(false);
		const land = analysed.events.find((e) => e.kind === 'land')!;
		expect(Math.abs(land.frame - 60)).toBeLessThanOrEqual(2);
		expect(land.how).toBe('abrupt stop');
		// still before and after
		expect(Math.max(...analysed.curve.speed.slice(2, 28))).toBeLessThan(0.03);
		expect(Math.max(...analysed.curve.speed.slice(66, 118))).toBeLessThan(0.03);
		// 20 px / frame of 1920 → 1.33 px of 128 → 1.33 / 146.9 × 30 ≈ 0.27 screens per second (the median of the moving
		// frames within 15 %; the peak is the noisiest frame)
		const moving = analysed.curve.speed.slice(31, 61).sort((a, b) => a - b);
		expect(Math.abs(moving[15]! / 0.2723 - 1)).toBeLessThan(0.15);
		expect(move.peakSpeed!).toBeLessThan(0.45);
		expect(Math.min(...analysed.curve.vx.slice(31, 61))).toBeGreaterThan(0.15);
		const again = await wait(
			((await post('/api/sound-design/motion', { projectId })).body as { id: string }).id,
		);
		expect(MotionAnalysisResultSchema.parse(again.result)).toMatchObject({
			cached: true,
			fingerprint: analysed.fingerprint,
		});
		const whole = await post('/api/sound-design/visual', { projectId, range: { start: 0, end: 120 } });
		expect(whole.status, JSON.stringify(whole.body).slice(0, 400)).toBe(200);
		const pm = whole.body.pixelMotion as { startFrame: number; speed: (number | null)[] } | null;
		expect(pm?.startFrame).toBe(0);
		expect(pm!.speed).toHaveLength(120);
		for (const [i, v] of pm!.speed.entries())
			expect(Math.abs(v! - analysed.curve.speed[i]!), String(i)).toBeLessThan(0.001);
		const part = await post('/api/sound-design/visual', { projectId, range: { start: 30, end: 90 } });
		const pp = part.body.pixelMotion as { startFrame: number; speed: (number | null)[] };
		expect(pp.startFrame).toBe(30);
		expect(pp.speed).toHaveLength(60);
		expect(Math.abs(pp.speed[10]! - analysed.curve.speed[40]!)).toBeLessThan(0.001);
		// a picture never analysed (the clip 7 frames later): null, the keyframed motion still there
		const other = seed(boxDoc(7).b.doc);
		const none = await post('/api/sound-design/visual', { projectId: other, range: { start: 0, end: 120 } });
		expect(none.status).toBe(200);
		expect(none.body.pixelMotion).toBeNull();
		expect((none.body.motion as { speed: number[] }).speed).toHaveLength(120);
	}, 180_000);

	it('untouched footage is decoded at the analysis size: the same curve, events and cues as the full render', async () => {
		// WP6.5b item 12: stretches whose picture is one untouched source (copyableRuns) skip the 1080p composite.
		// Reference: the same picture rendered through the export at full size then scaled (the old path).
		const fake = (): JobContext => {
			const ac = new AbortController();
			return {
				job: { id: `job_motion_${projects}` } as never,
				input: null,
				signal: ac.signal,
				slots: 2,
				progress: () => {},
				trackChild: () => {},
				addPartial: () => {},
				scratchDir: async () => mkdtempSync(join(tmpdir(), 'jasper-motion-scratch-')),
				log: () => {},
			};
		};
		const core = coreServices(app);
		const viaSource = new MotionService(core, mkdtempSync(join(tmpdir(), 'jasper-motion-a-')));
		const viaRender = new MotionService(core, mkdtempSync(join(tmpdir(), 'jasper-motion-b-')), {
			sourceDecode: false,
		});
		const compare = async (doc: ProjectDocument, want: string) => {
			const seq = Object.values(doc.sequences)[0]!;
			const plan = planMotion(doc, seq);
			const envelope = makeEnvelope(doc, {
				revision: 1,
				savedAt: '2026-10-17T00:00:00.000Z',
				platform: 'test',
			}) as unknown as EnvelopeJson;
			const input = { projectId: null, envelope, plan };
			const t0 = Date.now();
			const a = await viaSource.measurePicture(fake(), input);
			const t1 = Date.now();
			const r = await viaRender.measurePicture(fake(), input);
			const t2 = Date.now();
			expect(a.renderPath).toBe(want);
			expect(r.renderPath).toBe('native');
			expect(a.curve.decoded).toBe(plan.range.end - plan.range.start);
			const curveOf = (c: typeof a.curve): PixelMotionCurve => ({
				startFrame: plan.range.start,
				fps: 30,
				width: plan.width,
				height: plan.height,
				speed: c.speed,
				vx: c.vx,
				vy: c.vy,
				area: c.area,
				cx: c.cx,
				residual: c.residual,
			});
			if (process.env.MOTION_DEBUG)
				process.stderr.write(
					`${want}\nA ${[...a.curve.speed].map((x) => x.toFixed(3)).join(' ')}\nR ${[...r.curve.speed].map((x) => x.toFixed(3)).join(' ')}\n`,
				);
			const edits = editFrames(seq, plan.range);
			const ea = pixelMotionEvents(curveOf(a.curve), { edits });
			const er = pixelMotionEvents(curveOf(r.curve), { edits });
			expect(ea.map((e) => [e.kind, e.frame])).toEqual(er.map((e) => [e.kind, e.frame]));
			const anchorAt = sceneAnchorAt(doc, seq);
			const ca = pixelMotionCues(curveOf(a.curve), ea, anchorAt).cues.map((c) => [c.kind, c.frame]);
			const cr = pixelMotionCues(curveOf(r.curve), er, anchorAt).cues.map((c) => [c.kind, c.frame]);
			expect(ca).toEqual(cr);
			let maxDiff = 0;
			let maxRel = 0;
			for (let i = 0; i < a.curve.speed.length; i++) {
				const x = a.curve.speed[i]!;
				const y = r.curve.speed[i]!;
				maxDiff = Math.max(maxDiff, Math.abs(x - y));
				if (Math.max(x, y) > MOVE_OFF) maxRel = Math.max(maxRel, Math.abs(x - y) / Math.max(x, y));
				// every frame on the same side of the move thresholds: what the events and cues read
				expect(x >= MOVE_ON, `frame ${i}: ${x} vs ${y}`).toBe(y >= MOVE_ON);
				expect(x >= MOVE_OFF, `frame ${i}: ${x} vs ${y}`).toBe(y >= MOVE_OFF);
			}
			// the moving frames' median speed agrees within 5 %; per frame within 15 % (the reference is an H.264 encode of
			// the 1080p composite: its own noise is ±12 % per frame on this box, measured on the build server)
			const med = (c: Float32Array) => [...c.slice(32, 60)].sort((x, y) => x - y)[14]!;
			expect(Math.abs(med(a.curve.speed) / med(r.curve.speed) - 1)).toBeLessThan(0.05);
			expect(maxRel).toBeLessThan(0.15);
			timings[`maxRelDiff-${want}`] = Math.round(maxRel * 1000) / 1000;
			timings[`source-${want}`] = t1 - t0;
			timings[`render-${want}`] = t2 - t1;
			timings[`maxSpeedDiff-${want}`] = Math.round(maxDiff * 10_000) / 10_000;
			return { ea, cues: ca };
		};
		// all untouched: one source piece
		const whole = await compare(boxDoc().b.doc, 'source');
		expect(whole.cues.length).toBeGreaterThanOrEqual(2);
		// mixed: the first half untouched (source), the second half at 99 % opacity (rendered); the move spans the seam
		const b = new DocBuilder('hd-1080p-30', 900);
		const id = b.addMedia(media.box);
		const r = b.tx([
			{
				type: 'clip.place',
				source: { mediaId: id },
				at: 0,
				tracks: { video: 'V1' },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1.5 } },
				ref: '$a',
			},
			{
				type: 'clip.place',
				source: { mediaId: id },
				at: 45,
				tracks: { video: 'V1' },
				sourceRange: { in: { seconds: 1.5 }, out: { seconds: 4 } },
				ref: '$b',
			},
		]);
		b.tx([{ type: 'param.set', target: ['clip', r.refs.$b!, 'opacity'], value: 99 }]);
		await compare(b.doc, 'source+native');
	}, 600_000);

	it('pixel cues: pending with the job ids first, then moves and lands that resolve back to their frames', async () => {
		const { b, clipId, mediaId } = boxDoc(10);
		const projectId = seed(b.doc);
		const { first, final, pending } = await cues({
			projectId,
			opts: { sources: ['pixel'], density: 'rich' },
		});
		expect(pending.length).toBe(1);
		expect(first.analysis?.pixel).toMatchObject({ state: 'pending', jobIds: pending });
		expect(first.cues.filter((c) => c.from === 'pixel')).toEqual([]);
		expect(final.analysis?.pixel?.state).toBe('ready');
		expect(final.warnings.filter((w) => w.code === 'W_ANALYSIS_PENDING')).toEqual([]);
		const px = final.cues.filter((c) => c.from === 'pixel');
		const move = px.find((c) => c.kind === 'move')!;
		const land = px.find((c) => c.kind === 'land')!;
		expect(move.window!.start).toBeGreaterThanOrEqual(39);
		expect(move.window!.start).toBeLessThanOrEqual(43);
		expect(Math.abs(land.frame - 70)).toBeLessThanOrEqual(2);
		for (const c of px) {
			expect(c.confidence).toBeLessThanOrEqual(0.5);
			expect(c.anchor).toMatchObject({ type: 'scene', mediaId, clipId });
			expect(resolveCueAnchor(b.doc, b.doc.sequences[b.seqId]!, c.anchor)).toBe(c.frame);
		}
		expect(move.reason).toContain('moves right');
		expect(move.types[0]).toBe('whoosh');
		expect(final.engineCues?.length).toBe(px.length);
		// deterministic
		const again = SoundCuesResponseSchema.parse(
			(await post('/api/sound-design/cues', { projectId, opts: { sources: ['pixel'], density: 'rich' } }))
				.body,
		);
		expect(again.engineCues).toEqual(final.engineCues);
		expect(again.cues).toEqual(final.cues);
	}, 180_000);

	it('scene cuts: the shot change at media 2 s is a cut at frame 60, at 30 when the clip plays at 200 %', async () => {
		for (const [speed, frame] of [
			[1, 60],
			[2, 30],
		] as const) {
			const b = new DocBuilder('hd-1080p-30', 400 + speed);
			const id = b.addMedia(media.cut);
			const r = b.tx([
				{ type: 'clip.place', source: { mediaId: id }, at: 0, tracks: { video: 'V1' }, ref: '$v' },
			]);
			if (speed !== 1) b.tx([{ type: 'clip.setSpeed', clipIds: [r.refs.$v!], rate: speed, ripple: false }]);
			const projectId = seed(b.doc);
			const { final, pending } = await cues({ projectId, opts: { sources: ['scene'] } });
			if (speed === 1) expect(pending.length).toBe(1);
			const sc = final.cues.filter((c) => c.from === 'scene');
			expect(
				sc.map((c) => [c.frame, c.kind]),
				JSON.stringify(final),
			).toEqual([[frame, 'cut']]);
			expect(resolveCueAnchor(b.doc, b.doc.sequences[b.seqId]!, sc[0]!.anchor)).toBe(frame);
			expect(final.analysis?.scene).toMatchObject({ state: 'ready', found: 1 });
		}
	}, 180_000);

	it('POST /api/audio/beats on a click track: 120 BPM, beats within 5 ms, downbeats; cached; typed refusals', async () => {
		const r = await post('/api/audio/beats', {
			mediaKey: media.click.mediaKey,
			startSeconds: 0,
			durationSeconds: 12,
		});
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const res = BeatsResultSchema.parse(r.body);
		expect(Math.abs(res.bpm! - 120)).toBeLessThan(1);
		const truth = Array.from({ length: 24 }, (_, k) => 0.25 + 0.5 * k);
		for (const b of res.beats) expect(Math.min(...truth.map((t) => Math.abs(t - b)))).toBeLessThan(0.005);
		expect(res.downbeats?.length).toBeGreaterThan(2);
		for (const d of res.downbeats!)
			expect(Math.min(...truth.filter((_, k) => k % 4 === 0).map((t) => Math.abs(t - d)))).toBeLessThan(
				0.005,
			);
		expect(res.cached).toBe(false);
		const again = BeatsResultSchema.parse(
			(
				await post('/api/audio/beats', {
					mediaKey: media.click.mediaKey,
					startSeconds: 0,
					durationSeconds: 12,
				})
			).body,
		);
		expect(again).toEqual({ ...res, cached: true });
		expect(
			(await post('/api/audio/beats', { mediaKey: 'mk_nope', startSeconds: 0, durationSeconds: 1 })).status,
		).toBe(404);
		expect(
			(await post('/api/audio/beats', { mediaKey: media.box.mediaKey, startSeconds: 0, durationSeconds: 1 }))
				.status,
		).toBe(400);
		for (const bad of [
			{},
			{ mediaKey: media.click.mediaKey },
			{ mediaKey: media.click.mediaKey, startSeconds: -1, durationSeconds: 1 },
			{ mediaKey: media.click.mediaKey, startSeconds: 0, durationSeconds: 99_999 },
			{ mediaKey: media.click.mediaKey, startSeconds: 0, durationSeconds: 1, extra: 1 },
		])
			expect((await post('/api/audio/beats', bad)).status, JSON.stringify(bad)).toBe(400);
	}, 120_000);

	it('beat cues of an Essential music clip within ±1 frame of the clicks; snapToBeats moves a move ≤ 2 frames', async () => {
		const b = new DocBuilder('hd-1080p-30', 500);
		const music = b.addMedia(media.click);
		const r = b.tx([
			{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		]);
		b.tx([{ type: 'essentialSound.setType', clipIds: [r.refs.$m!], audioType: 'music' }]);
		const projectId = seed(b.doc);
		const { final, pending } = await cues({ projectId, opts: { sources: ['beat'], density: 'rich' } });
		expect(pending).toEqual([]);
		const beats = final.engineCues!.filter((c) => c.from === 'beat');
		expect(beats.length).toBeGreaterThanOrEqual(20);
		for (const c of beats) {
			const t = (c.anchor as { mediaSec: number }).mediaSec;
			expect(
				Math.abs(c.frame - Math.round((Math.round((t - 0.25) / 0.5) * 0.5 + 0.25) * 30)),
			).toBeLessThanOrEqual(1);
			expect(resolveCueAnchor(b.doc, b.doc.sequences[b.seqId]!, c.anchor)).toBe(c.frame);
			expect(c.weight).not.toBe('hero');
		}
		expect(beats.filter((c) => c.weight === 'support').length).toBeGreaterThan(2);
		// a keyframed move 2 frames off a beat snaps onto it (and records the offset)
		const still = b.addMedia(media.box);
		const v = b.tx([
			{ type: 'clip.place', source: { mediaId: still }, at: 0, tracks: { video: 'V2' }, ref: '$s' },
		]);
		const path = ['clip', v.refs.$s!, 'transform', 'position'];
		b.tx([
			{ type: 'param.setAnimated', target: path, animated: true, at: { frames: 0 } },
			{ type: 'keyframe.add', target: path, at: { frames: 40 }, value: [960, 540], interpolation: 'linear' },
			{ type: 'keyframe.add', target: path, at: { frames: 47 }, value: [1500, 540], interpolation: 'linear' },
		]);
		const pid2 = seed(b.doc);
		const plain = SoundCuesResponseSchema.parse(
			(await post('/api/sound-design/cues', { projectId: pid2, opts: { sources: ['keyframes'] } })).body,
		);
		const move = plain.cues.find((c) => c.kind === 'move')!;
		const snapped = SoundCuesResponseSchema.parse(
			(
				await post('/api/sound-design/cues', {
					projectId: pid2,
					opts: { sources: ['keyframes'], snapToBeats: true },
				})
			).body,
		);
		const m2 = snapped.cues.find((c) => c.kind === 'move')!;
		const beatFrames = beats.map((c) => c.frame);
		const nearest = beatFrames.reduce((a, f) =>
			Math.abs(f - move.frame) < Math.abs(a - move.frame) ? f : a,
		);
		if (Math.abs(nearest - move.frame) <= 2 && nearest !== move.frame) {
			expect(m2.frame).toBe(nearest);
			expect(m2.anchorOffset).toBe(nearest - move.frame);
			expect(snapped.stats.snappedToBeat).toBe(1);
		} else {
			expect(m2.frame).toBe(move.frame);
			expect(snapped.stats.snappedToBeat).toBe(0);
		}
		expect(snapped.engineCues).toEqual([]);
	}, 120_000);

	it('the plan job measures picture motion inline and plans its cues', async () => {
		const { b } = boxDoc(20);
		const projectId = seed(b.doc);
		const r = await post('/api/sound-design/plan', {
			projectId,
			style: { cueSources: ['pixel'], density: 'rich' },
		});
		expect(r.status, JSON.stringify(r.body)).toBe(202);
		const job = await wait((r.body as { id: string }).id);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		const res = job.result as SoundDesignPlanResult;
		const keys = [...res.report.events.map((e) => e.cueKey), ...res.report.skipped.map((s) => s.cueKey)];
		expect(
			keys.some((k) => typeof k === 'string' && k.startsWith('pixel:')),
			JSON.stringify(res.report),
		).toBe(true);
		// the analysis it made is cached for the cue route
		const { pending } = await cues({ projectId, opts: { sources: ['pixel'] } });
		expect(pending).toEqual([]);
	}, 180_000);

	it('Sound Check: a derived cue on the measured landing passes NO_PICTURE_EVENT, one on a still picture does not', async () => {
		const { b } = boxDoc();
		b.tx([
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 60, // The generated box stops at this known frame; no dependency on another test's result.
						kind: 'land',
						weight: 'support',
						source: 'derived',
					},
					{ frame: 100, kind: 'land', weight: 'support', source: 'derived' },
				],
			},
		]);
		const projectId = seed(b.doc);
		// measure this picture first (the cue route or analyze_picture_motion would): the check only uses what is measured
		const m = await wait(((await post('/api/sound-design/motion', { projectId })).body as { id: string }).id);
		expect(m.state).toBe('succeeded');
		const check = async () => {
			const r = await post('/api/sound-design/check', { projectId });
			expect(r.status, JSON.stringify(r.body)).toBe(202);
			const job = await wait((r.body as { id: string }).id);
			expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
			return (job.result as SoundCheckResult).report.issues
				.filter((i) => i.code === 'NO_PICTURE_EVENT')
				.map((i) => i.frame);
		};
		expect(await check()).toEqual([100]);
		// another picture that was never analysed: footage motion is unknown, both are flagged
		const other = boxDoc(5);
		other.b.tx([
			{ type: 'soundCue.add', cues: [{ frame: 65, kind: 'land', weight: 'support', source: 'derived' }] },
		]);
		const pid = seed(other.b.doc);
		const r = await post('/api/sound-design/check', { projectId: pid });
		const job = await wait((r.body as { id: string }).id);
		expect(
			(job.result as SoundCheckResult).report.issues
				.filter((i) => i.code === 'NO_PICTURE_EVENT')
				.map((i) => i.frame),
		).toEqual([65]);
	}, 240_000);

	it('cancellation, refusals and the range cap', async () => {
		const { b } = boxDoc(40);
		const projectId = seed(b.doc);
		const r = await post('/api/sound-design/motion', { projectId });
		expect(r.status).toBe(202);
		const id = (r.body as { id: string }).id;
		coreServices(app).queue.cancel(id);
		expect((await wait(id)).state).toBe('cancelled');
		for (const bad of [
			{},
			{ projectId: '../x' },
			{ projectId, range: { start: 5, end: 2 } },
			{ projectId, extra: true },
		])
			expect((await post('/api/sound-design/motion', bad)).status, JSON.stringify(bad)).toBe(400);
		expect((await post('/api/sound-design/motion', { projectId: 'prj_9999999999999999' })).status).toBe(404);
		expect((await post('/api/sound-design/motion', { projectId, sequenceId: 'seq_nope' })).status).toBe(404);
		expect(
			(await post('/api/sound-design/motion', { projectId, range: { start: 500, end: 600 } })).body,
		).toMatchObject({ code: 'RANGE_EMPTY' });
		const long = boxDoc(20_000);
		const pl = seed(long.b.doc);
		expect(
			(await post('/api/sound-design/motion', { projectId: pl, range: { start: 0, end: 19_000 } })).body,
		).toMatchObject({
			code: 'RANGE_TOO_LONG',
		});
	}, 120_000);
});
