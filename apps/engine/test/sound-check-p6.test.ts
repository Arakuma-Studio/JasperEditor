// Sound Check, Phase 6 findings (spec 12 §4 P6-E1, P6-E2, P6-E3, P6-E13; wp-note "Phase 6 → WP-E1") on a real engine
// with generated media. Each seeded defect is reported with its code, clip and frame (CLICK to ±1 ms), and applying
// the reported fix clears it on the re-check:
//   CLICK            a sound starting on a full-level sample (a step) at an edit
//   EDGE             a clip whose head starts mid-sound; a music clip cut mid-note; a remix piece joined on a held chord
//   HARSH            a hot 4 kHz click over quiet music (and a bright sound: info)
//   LAYER_INAUDIBLE  a layer 50 dB under its partner
//   COVERAGE         3 of 4 staggered cards filled
//   ENDING / HEAD    a mix cut at a loud frame (the clean fixture fades out over 2 s and passes); a mix starting loud
//   ARC              the loudest moment holds no hero
//   OUT_OF_SYNC      an end-aligned riser ending 120 ms early passes, 400 ms early fails (25 fps)
//   LICENSE          a CC BY-SA sound: the ShareAlike warning
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type SoundCheckFix,
	type SoundCheckIssue,
	type SoundCheckReport,
	SoundCheckResultSchema,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import { type LibraryProvenance, makeEnvelope, type ProjectDocument } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';
import { provenance, SR } from './sound-bed-fixture.ts';
import {
	buildCheckDoc,
	type CheckFixture,
	type FixtureMedia,
	fpsOf,
	registerCheckMedia,
} from './sound-check-fixture.ts';

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_check_0123456789abcdef012';
const KEY = 'key_check_0123456789abcdef012';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'check-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

let app: TestApp;
let media: FixtureMedia;
let extra: Record<'chord' | 'step' | 'hot' | 'riser', Awaited<ReturnType<typeof register>>>;
let projects = 0;
const timings: { name: string; ms: number }[] = [];

// ── generated media ─────────────────────────────────────────────────────────────────────────────────────────────────
/** 6 s held chord (220, 277, 330 Hz), loud for 2.5 s, then 30 dB quieter (a 10 ms ramp between). */
function chordSamples(): Float32Array[] {
	const n = Math.round(6 * SR);
	const l = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		const g = t < 2.5 ? 1 : t < 2.51 ? 1 - (1 - 0.0316) * ((t - 2.5) / 0.01) : 0.0316;
		l[i] = g * 0.12 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.18 * t) + Math.sin(2 * Math.PI * 329.63 * t));
	}
	return [l, l.slice()];
}
/** 0.8 s: a 1 kHz tone that starts on a full-level sample (cos: a step from silence), then fades out cleanly. */
function stepSamples(): Float32Array[] {
	const n = Math.round(0.85 * SR);
	const l = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		const env = t < 0.5 ? 1 : t < 0.8 ? Math.exp(-(t - 0.5) / 0.04) : 0;
		l[i] = 0.1 * env * Math.cos(2 * Math.PI * 1000 * t);
	}
	return [l, l.slice()];
}
/** 0.4 s: 50 ms silence, a hot 4 kHz click ringing out over 250 ms (fading to silence at 0.35 s), silence. */
function hotSamples(): Float32Array[] {
	const n = Math.round(0.4 * SR);
	const l = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / SR - 0.05;
		if (t < 0 || t > 0.3) continue;
		l[i] = 0.25 * Math.sin(2 * Math.PI * 4000 * t) * Math.exp(-t / 0.25) * Math.min(1, (0.3 - t) / 0.05);
	}
	return [l, l.slice()];
}
/** 1.15 s: 50 ms silence, a 1 s noise riser (exponential rise) stopping at 1.05 s, 100 ms silence. */
function riserSamples(): Float32Array[] {
	const n = Math.round(1.15 * SR);
	const l = new Float32Array(n);
	let s = 7;
	for (let i = 0; i < n; i++) {
		const t = i / SR - 0.05;
		if (t < 0 || t >= 1) continue;
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		const w = (s / 2 ** 32) * 2 - 1;
		l[i] = 0.3 * w * (1000 ** t - 1) / 999;
	}
	return [l, l.slice()];
}

const prov = (soundId: string, title: string, types: string[], d: Record<string, unknown>): LibraryProvenance =>
	({
		...provenance('hit'),
		soundId,
		title,
		types,
		descriptors: { ...provenance('hit').descriptors, ...d },
	}) as LibraryProvenance;
const HOT_PROV = prov('snd_00000000000e1001', 'Hot zap', ['zap'], {
	peakSec: 0.05,
	onsetSec: 0.05,
	headQuietSec: 0.05,
	durationSec: 0.4,
	octaveBandsDb: [-80, -80, -80, -60, -30, -6, -40],
	centroidHz: 4000,
	maxMomentaryLufs: -40,
	truePeakDb: -30,
});
const RISER_PROV = prov('snd_00000000000e1002', 'Test riser', ['riser'], {
	peakSec: 1.04,
	onsetSec: 0.05,
	headQuietSec: 0.05,
	durationSec: 1.05,
	centroidHz: 2000,
	maxMomentaryLufs: -20,
	truePeakDb: -6,
});

// ── harness ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(++projects + 600).toString().padStart(16, '0')}`;
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope({ ...doc, projectId }, { revision: 3, savedAt: '2026-10-17T00:00:00.000Z', platform: 'test' }),
		),
	);
	return projectId;
}
async function post(url: string, body: unknown, headers: Record<string, string> = AGENT_H) {
	return app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(body) });
}
async function waitJob(r: { statusCode: number; body: string; json(): unknown }): Promise<EngineJob> {
	expect(r.statusCode, r.body).toBe(202);
	return coreServices(app).queue.wait((r.json() as EngineJob).id);
}
async function check(projectId: string, name: string): Promise<SoundCheckReport> {
	const t0 = Date.now();
	const job = await waitJob(await post('/api/sound-design/check', { projectId }));
	timings.push({ name, ms: Date.now() - t0 });
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return SoundCheckResultSchema.parse(job.result).report;
}
const issuesOf = (r: SoundCheckReport, code: string) => r.issues.filter((i) => i.code === code);
const describeIssues = (r: SoundCheckReport) =>
	r.issues.map((i) => `${i.severity} ${i.code} ${i.timecode ?? ''} ${i.message.text}`).join('\n');

async function applyFix(projectId: string, fix: SoundCheckFix): Promise<void> {
	expect(fix.kind).toBe('commands');
	const r = await post(
		'/api/agent/tx',
		{
			projectId,
			transaction: { label: fix.label.text.slice(0, 200), origin: { agent: 'check-test' }, commands: fix.commands },
		},
		EDITOR_H,
	);
	expect(r.statusCode, r.body).toBe(200);
	const res = (r.json() as { result: { ok: boolean; errors?: unknown } }).result;
	expect(res.ok, JSON.stringify(res.errors)).toBe(true);
}

/** Checks, expects `code` (picked), applies its fix and expects it gone (same subject) on a re-check. */
async function seeded(
	name: string,
	doc: ProjectDocument,
	code: SoundCheckIssue['code'],
	pick: (i: SoundCheckIssue) => boolean,
	opts: { safe?: boolean } = {},
): Promise<{ first: SoundCheckReport; again: SoundCheckReport; issue: SoundCheckIssue }> {
	const projectId = seed(doc);
	const first = await check(projectId, name);
	const issue = issuesOf(first, code).find(pick);
	expect(issue, `${name}: no ${code} in\n${describeIssues(first)}`).toBeDefined();
	expect(issue!.fix, `${name}: ${code} has no fix`).toBeDefined();
	if (opts.safe !== undefined)
		expect(issue!.fix!.safe, `${issue!.fix!.why} ${JSON.stringify(issue!.measured)}`).toBe(opts.safe);
	await applyFix(projectId, issue!.fix!);
	const again = await check(projectId, `${name} re-check`);
	expect(
		issuesOf(again, code).filter((i) => i.id === issue!.id),
		`${name}: ${code} still there after its fix:\n${describeIssues(again)}`,
	).toEqual([]);
	return { first, again, issue: issue! };
}

/** A new audio track's label. */
function addTrack(fx: CheckFixture): string {
	fx.b.tx([{ type: 'track.add', kind: 'audio', count: 1 }]);
	return `A${fx.doc().sequences[fx.b.seqId]!.audioTracks.length}`;
}
const clipOn = (fx: CheckFixture, mediaId: string, at: number) =>
	Object.values(fx.doc().sequences[fx.b.seqId]!.clips).find(
		(c) => (c as { mediaId?: string }).mediaId === mediaId && c.start === at,
	)!;

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	const dir = mkdtempSync(join(tmpdir(), 'jasper-check-p6-'));
	media = await registerCheckMedia(app, dir, TOKEN);
	const w = (name: string, ch: Float32Array[]) => {
		const p = join(dir, name);
		writeFileSync(p, encodeWav(ch, SR, 's16'));
		return register(app, p, { authorization: `Bearer ${TOKEN}` });
	};
	extra = {
		chord: await w('chord.wav', chordSamples()),
		step: await w('step.wav', stepSamples()),
		hot: await w('hot.wav', hotSamples()),
		riser: await w('riser.wav', riserSamples()),
	};
}, 180_000);
afterAll(async () => {
	console.log(`sound check p6 timings (ms): ${timings.map((t) => `${t.name} ${t.ms}`).join(', ')}`);
	await closeApps();
});

describe('Sound Check Phase 6 findings (real engine)', { timeout: 600_000 }, () => {
	it('the clean fixture passes; its fade-out end is no ENDING or SILENCE; HEAD and ARC are info', async () => {
		const fx = buildCheckDoc(media);
		const report = await check(seed(fx.doc()), 'clean p6');
		expect(report.verdict, describeIssues(report)).toBe('pass');
		for (const c of ['CLICK', 'EDGE', 'HARSH', 'COVERAGE', 'ENDING', 'SILENCE', 'LICENSE'])
			expect(
				issuesOf(report, c).filter((i) => i.severity !== 'info'),
				describeIssues(report),
			).toEqual([]);
		// the music starts at full level on the first sample: HEAD (info), with a fade-in fix on the Mix lane
		const head = issuesOf(report, 'HEAD')[0];
		expect(head, describeIssues(report)).toBeDefined();
		expect(head!.severity).toBe('info');
		expect(head!.category).toBe('edges');
		expect(head!.fix!.commands![0]).toMatchObject({ type: 'mixer.writeAutomation', stripId: 'Mix', lane: 'volume' });
		for (const i of [...issuesOf(report, 'ARC'), ...issuesOf(report, 'LAYER_INAUDIBLE')]) expect(i.severity).toBe('info');
	});

	/** The clean fixture with a loud held chord on its own track from 4.5 to 6.5 s: the loudest moment of the mix. */
	const loudMiddle = (o: Parameters<typeof buildCheckDoc>[1] = {}) => {
		const fx = buildCheckDoc(media, o);
		const track = addTrack(fx);
		const chord = fx.b.addMedia(extra.chord);
		fx.b.tx([
			{
				type: 'clip.place',
				source: { mediaId: chord },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
				at: 135,
				tracks: { audio: track },
				ref: '$k',
			},
		]);
		return fx;
	};

	it('ARC: the loudest 3 s hold no hero → info naming the moment and the biggest hero', async () => {
		const report = await check(seed(loudMiddle().doc()), 'arc');
		const arc = issuesOf(report, 'ARC');
		expect(arc, describeIssues(report)).toHaveLength(1);
		expect(arc[0]!.severity).toBe('info');
		expect(arc[0]!.category).toBe('loudness');
		expect(arc[0]!.measured!.variant).toBe('no-hero');
		expect(arc[0]!.message.text).toMatch(/the biggest hero is Test hit \d \(00:00:0\d:\d\d\)$/);
		expect(arc[0]!.frame!).toBeGreaterThanOrEqual(135);
		expect(arc[0]!.frame!).toBeLessThanOrEqual(195);
	});

	it('HEAD: its fade-in on the Mix lane clears it', async () => {
		const fx = buildCheckDoc(media);
		await seeded('head', fx.doc(), 'HEAD', () => true, { safe: false });
	});

	it('ARC: a hero at the loudest moment leaves no ARC', async () => {
		const fx = loudMiddle({ cueB: { weight: 'hero', media: 'hit', frame: 165 } });
		const report = await check(seed(fx.doc()), 'arc hero');
		expect(issuesOf(report, 'ARC'), describeIssues(report)).toEqual([]);
	});

	it('a mix cut at a loud frame → ENDING; the Mix fade-out clears it', async () => {
		const fx = buildCheckDoc(media, { ending: 'cut' });
		const { issue, again } = await seeded('ending', fx.doc(), 'ENDING', () => true, { safe: false });
		expect(issue.severity).toBe('warning');
		expect(issue.timecode).toBe('00:00:10:00');
		expect(issue.measured!.tailRmsDbfs as number).toBeGreaterThan(-45);
		expect(issue.fix!.commands!.at(-1)).toMatchObject({ type: 'mixer.writeAutomation', stripId: 'Mix' });
		expect(issuesOf(again, 'SILENCE'), describeIssues(again)).toEqual([]);
	});

	it('a sound starting on a full-level sample at an edit → CLICK error at that edge (±1 ms); its 1-frame fade clears it', async () => {
		const fx = buildCheckDoc(media);
		const track = addTrack(fx);
		const step = fx.b.addMedia(extra.step);
		fx.b.tx([{ type: 'clip.place', source: { mediaId: step }, at: 120, tracks: { audio: track }, ref: '$c' }]);
		const clip = clipOn(fx, step, 120);
		fx.b.tx([{ type: 'essentialSound.setType', clipIds: [clip.id], audioType: 'sfx' }]);
		const { issue } = await seeded('click', fx.doc(), 'CLICK', (i) => i.severity === 'error' && i.clipIds?.[0] === clip.id, {
			safe: true,
		});
		expect(issue.category).toBe('edges');
		expect(issue.frame).toBe(120);
		expect(issue.timecode).toBe('00:00:04:00');
		expect(Math.abs((issue.measured!.atSec as number) - 4)).toBeLessThanOrEqual(0.001);
		expect(issue.measured!.edge).toBe('start');
		expect(issue.message.key).toMatch(/^Click at an edit: the start of/);
		expect(issue.fix!.commands![0]).toMatchObject({ type: 'transition.add', clipId: clip.id, edge: 'in' });
	});

	it('a clip whose head starts mid-sound → EDGE entry; its fade-in clears it', async () => {
		const fx = buildCheckDoc(media);
		const track = addTrack(fx);
		const chord = fx.b.addMedia(extra.chord);
		fx.b.tx([
			{
				type: 'clip.place',
				source: { mediaId: chord },
				sourceRange: { in: { seconds: 1 }, out: { seconds: 6 } },
				at: 150,
				tracks: { audio: track },
			},
		]);
		const clip = clipOn(fx, chord, 150);
		const { issue, again } = await seeded(
			'entry',
			fx.doc(),
			'EDGE',
			(i) => i.clipIds?.[0] === clip.id && i.measured?.variant === 'entry',
			{ safe: true },
		);
		expect(issue.frame).toBe(150);
		expect(issue.measured!.preDb as number).toBeGreaterThan(-20);
		expect(issue.message.text).toMatch(/starts mid-sound at 00:00:05:00/);
		// the fade also removes the step at the edit
		expect(issuesOf(again, 'CLICK').filter((i) => i.severity === 'error' && i.clipIds?.includes(clip.id))).toEqual([]);
	});

	it('a music clip cut mid-note → EDGE chopped decay; its fade-out clears it', async () => {
		const fx = buildCheckDoc(media);
		const track = addTrack(fx);
		const chord = fx.b.addMedia(extra.chord);
		fx.b.tx([
			{
				type: 'clip.place',
				source: { mediaId: chord },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
				at: 30,
				tracks: { audio: track },
			},
		]);
		const clip = clipOn(fx, chord, 30);
		fx.b.tx([{ type: 'essentialSound.setType', clipIds: [clip.id], audioType: 'music' }]);
		const { issue } = await seeded(
			'decay',
			fx.doc(),
			'EDGE',
			(i) => i.clipIds?.[0] === clip.id && i.measured?.variant === 'decay',
			{ safe: true },
		);
		expect(issue.frame).toBe(90);
		expect(issue.measured!.tailDb as number).toBeGreaterThan(-35);
		expect(issue.measured!.postDb as number).toBeGreaterThan(-35);
		expect(issue.fix!.commands![0]).toMatchObject({ type: 'transition.add', clipId: clip.id, edge: 'out' });
	});

	it('a remix piece joined on a held chord → EDGE chopped music; a 100 ms crossfade clears it', async () => {
		const fx = buildCheckDoc(media);
		const track = addTrack(fx);
		const chord = fx.b.addMedia(extra.chord);
		fx.b.tx([{ type: 'clip.place', source: { mediaId: chord }, at: 0, tracks: { audio: track } }]);
		const clip = clipOn(fx, chord, 0);
		fx.b.tx([
			{ type: 'essentialSound.setType', clipIds: [clip.id], audioType: 'music' },
			{
				type: 'clip.remix',
				clipId: clip.id,
				targetFrames: 120,
				pieces: [
					{ srcSeconds: 0, lenSeconds: 2 },
					{ srcSeconds: 3, lenSeconds: 2 },
				],
				bpm: 120,
			},
		]);
		const seq = fx.doc().sequences[fx.b.seqId]!;
		const first = Object.values(seq.clips).find(
			(c) => (c as { mediaId?: string }).mediaId === chord && c.start === 0,
		)!;
		expect((first as { remix?: unknown }).remix).toBeDefined();
		const { issue } = await seeded(
			'music',
			fx.doc(),
			'EDGE',
			(i) => i.clipIds?.[0] === first.id && i.measured?.variant === 'music',
			{ safe: true },
		);
		expect(issue.frame).toBe(first.start + first.duration);
		expect(issue.measured!.crossfadeMs as number).toBeLessThan(100);
		expect(issue.fix!.commands![0]).toMatchObject({ type: 'transition.update', duration: 3 });
	});

	it('a hot 4 kHz click over quiet music → HARSH; its safe gain fix clears it; a bright sound is info', async () => {
		const fx = buildCheckDoc(media);
		const hot = fx.b.addMedia(extra.hot);
		const r = fx.b.tx([
			{ type: 'media.setLibraryInfo', mediaId: hot, library: HOT_PROV },
			{ type: 'soundCue.add', cues: [{ frame: 210, kind: 'cut', weight: 'support', source: 'user', ref: '$c' }] },
			{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: hot, align: 'peak', ref: '$x' }] },
			// the click's library sound declares a bright centroid: info only
			{
				type: 'media.setLibraryInfo',
				mediaId: fx.ids.clickMedia,
				library: { ...provenance('click'), descriptors: { ...provenance('click').descriptors, centroidHz: 8000 } },
			},
		]);
		const { issue, first } = await seeded(
			'harsh',
			fx.doc(),
			'HARSH',
			(i) => i.severity === 'warning' && i.cueId === r.refs.$c,
			{ safe: true },
		);
		// the clean fixture's own sounds are not harsh
		expect(
			issuesOf(first, 'HARSH').filter((i) => i.severity === 'warning' && i.cueId !== r.refs.$c),
			describeIssues(first),
		).toEqual([]);
		expect(issue.category).toBe('tonal');
		expect(issue.measured!.overDb as number).toBeGreaterThan(6);
		expect(issue.fix!.commands![0]).toMatchObject({ type: 'soundDesign.applyGains' });
		const bright = issuesOf(first, 'HARSH').find((i) => i.severity === 'info');
		expect(bright, describeIssues(first)).toBeDefined();
		expect(bright!.clipIds).toEqual([fx.ids.clipB]);
		expect(bright!.measured!.centroidHz).toBe(8000);
	});

	it('a layer 50 dB under its partner → LAYER_INAUDIBLE (info); the partner is heard', async () => {
		const fx = buildCheckDoc(media);
		const r = fx.b.tx([
			{ type: 'soundCue.add', cues: [{ frame: 210, kind: 'cut', weight: 'hero', source: 'user', ref: '$c' }] },
			{
				type: 'soundDesign.place',
				cueId: '$c',
				layers: [
					{ mediaId: fx.ids.hitMedia, align: 'peak', ref: '$a' },
					{ mediaId: fx.ids.hit2Media, align: 'peak', gainDb: -50, ref: '$b' },
				],
			},
		]);
		const report = await check(seed(fx.doc()), 'layer');
		const dead = issuesOf(report, 'LAYER_INAUDIBLE');
		expect(dead.map((i) => i.clipIds?.[0]), describeIssues(report)).toEqual([r.refs.$b]);
		expect(dead[0]!.severity).toBe('info');
		expect(dead[0]!.cueId).toBe(r.refs.$c);
		expect(dead[0]!.measured!.maxAddDb as number).toBeLessThan(1);
		expect(dead[0]!.fix).toMatchObject({ safe: false });
	});

	it('3 of 4 staggered cards filled → COVERAGE lists the 4th; filling it with the class sound clears it', async () => {
		const fx = buildCheckDoc(media);
		// between the cues A and B, outside the dialogue (4–8 s), whose cues are silenced by it
		const frames = [45, 51, 57, 63];
		const marks = fx.b.tx(frames.map((f, i) => ({ type: 'marker.add', frame: f, name: `card ${i + 1}`, ref: `$m${i}` })));
		const cues = fx.b.tx([
			{
				type: 'soundCue.add',
				cues: frames.map((f, i) => ({
					frame: f,
					kind: 'appear',
					weight: 'support',
					source: 'user',
					anchor: { type: 'marker', markerId: marks.refs[`$m${i}`]! },
					ref: `$c${i}`,
				})),
			},
		]);
		for (let i = 0; i < 3; i++)
			fx.b.tx([
				{
					type: 'soundDesign.place',
					cueId: cues.refs[`$c${i}`]!,
					layers: [{ mediaId: fx.ids.clickMedia, align: 'peak' }],
				},
			]);
		const { issue } = await seeded('coverage', fx.doc(), 'COVERAGE', () => true, { safe: false });
		expect(issue.cueId).toBe(cues.refs.$c3);
		expect(issue.frame).toBe(63);
		expect(issue.measured).toMatchObject({ filled: 3, unfilled: 1 });
		expect(issue.message.text).toMatch(/^3 of 4 appear cues like these have a sound; 1 do not: 00:00:02:03/);
		expect(issue.fix!.commands![0]).toMatchObject({ type: 'soundDesign.place', cueId: cues.refs.$c3 });
	});

	it('end-aligned riser: ending 120 ms early passes, 400 ms early is OUT_OF_SYNC (25 fps)', async () => {
		const build = (move: number) => {
			const b = new DocBuilder('hd-1080p-25', 901);
			const music = b.addMedia(media.music);
			const riser = b.addMedia(extra.riser);
			b.tx([
				{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
				{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
				{ type: 'mixer.setLoudness', enabled: true, targetLufs: -14, truePeakDb: -1 },
				{ type: 'media.setLibraryInfo', mediaId: riser, library: RISER_PROV },
			]);
			const r = b.tx([
				{ type: 'soundCue.add', cues: [{ frame: 100, kind: 'cut', weight: 'support', source: 'user', ref: '$c' }] },
				{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId: riser, align: 'end', ref: '$x' }] },
			]);
			if (move) b.tx([{ type: 'clip.move', clipIds: [r.refs.$x!], deltaFrames: move }]);
			return { doc: b.doc, cueId: r.refs.$c!, fps: fpsOf(b) };
		};
		const on = build(0);
		expect(on.fps).toBe(25);
		const r0 = await check(seed(on.doc), 'riser on');
		expect(issuesOf(r0, 'OUT_OF_SYNC'), describeIssues(r0)).toEqual([]);
		const early = await check(seed(build(-3).doc), 'riser 120 ms early');
		expect(issuesOf(early, 'OUT_OF_SYNC'), describeIssues(early)).toEqual([]);
		const ev = early.events.find((e) => e.align === 'end')!;
		expect(ev.located).toBe('found');
		expect(Math.abs(ev.offsetMs! + 120)).toBeLessThan(2);
		const late = await check(seed(build(-10).doc), 'riser 400 ms early');
		const sync = issuesOf(late, 'OUT_OF_SYNC');
		expect(sync, describeIssues(late)).toHaveLength(1);
		expect(sync[0]!.severity).toBe('error');
		expect(sync[0]!.measured!.offsetMs as number).toBeCloseTo(-400, 0);
		expect(sync[0]!.fix).toMatchObject({ safe: true, tool: 'align_peak' });
	});

	it('a CC BY-SA sound → LICENSE warning (ShareAlike), CREDITS still asked', async () => {
		const fx = buildCheckDoc(media, { hit2License: 'CC-BY-SA-4.0' });
		const report = await check(seed(fx.doc()), 'share-alike');
		const sa = issuesOf(report, 'LICENSE');
		expect(sa, describeIssues(report)).toHaveLength(1);
		expect(sa[0]).toMatchObject({ severity: 'warning', clipIds: [fx.ids.clipC], category: 'licence' });
		expect(sa[0]!.measured!.variant).toBe('shareAlike');
		expect(sa[0]!.message.text).toMatch(/ShareAlike\): a video synced with it must be shared under CC BY-SA/);
		expect(issuesOf(report, 'CREDITS')).toHaveLength(1);
		expect(report.verdict).toBe('warn');
	});
});
