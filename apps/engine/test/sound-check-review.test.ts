// Sound Check review (wp-note "Phase 5 → Sound Check engine review"): regressions found by reviewing the check engine
// on a real engine with generated media — sync at the edges of the sequence, the same sound twice near a cue, reversed
// clips, SILENCE of a signal in one channel, DIP against deliberate level moves, REPEAT fixes that must not create a
// LICENSE finding, and MASKED numbers equal to the solver's (rebalance job) on the same document.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	SfxRebalanceResultSchema,
	type SoundCheckReport,
	SoundCheckResultSchema,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import {
	FLICKS_PER_SECOND,
	makeEnvelope,
	type ProjectDocument,
	readSoundCheckTarget,
	SOUND_CHECK_MESSAGES,
	soundCheckStatus,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';
import { SR } from './sound-bed-fixture.ts';
import { buildCheckDoc, type FixtureMedia, registerCheckMedia } from './sound-check-fixture.ts';

const HOST = { host: '127.0.0.1:47900' };
const TOKEN = 'tok_check_0123456789abcdef012';
const KEY = 'key_check_0123456789abcdef012';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'check-agent' };
const EDITOR_H = { ...HOST, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

let app: TestApp;
let media: FixtureMedia;
let dir: string;
let projects = 0;

function seed(doc: ProjectDocument): string {
	const projectId = `prj_${(7000 + ++projects).toString().padStart(16, '0')}`;
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
async function post(url: string, body: unknown, headers: Record<string, string> = AGENT_H) {
	return app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(body) });
}
async function job(
	url: string,
	body: unknown,
	headers: Record<string, string> = AGENT_H,
): Promise<EngineJob> {
	const r = await post(url, body, headers);
	expect(r.statusCode, r.body).toBe(202);
	const j = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(j.state, JSON.stringify(j.error)).toBe('succeeded');
	return j;
}
async function check(doc: ProjectDocument): Promise<SoundCheckReport> {
	const j = await job('/api/sound-design/check', { projectId: seed(doc) });
	return SoundCheckResultSchema.parse(j.result).report;
}
const issuesOf = (r: SoundCheckReport, code: string) => r.issues.filter((i) => i.code === code);
const describeIssues = (r: SoundCheckReport) =>
	r.issues.map((i) => `${i.severity} ${i.code} ${i.message.text}`).join('\n');
const soundIdOf = (doc: ProjectDocument, mediaId: string) =>
	(doc.media[mediaId] as unknown as { library: { soundId: string } }).library.soundId;

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	dir = mkdtempSync(join(tmpdir(), 'jasper-check-review-'));
	media = await registerCheckMedia(app, dir, TOKEN);
}, 180_000);
afterAll(async () => {
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

describe('Sound Check engine review (real engine)', { timeout: 600_000 }, () => {
	it('sounds on the first and the last frames of the sequence are located in the mix', async () => {
		const fx = buildCheckDoc(media);
		const add = (frame: number, mediaId: string) =>
			fx.b.tx([
				{
					type: 'soundCue.add',
					cues: [{ frame, kind: 'cut', weight: 'support', source: 'user', ref: '$c' }],
				},
				{
					type: 'soundDesign.place',
					cueId: '$c',
					layers: [{ mediaId, role: 'support', align: 'peak', ref: '$x' }],
				},
			]).refs.$x!;
		const first = add(1, fx.ids.hitMedia);
		// the click's clip ends ≈ 0.2 s after its peak: the sequence ends with it
		const last = add(296, fx.ids.clickMedia);
		const report = await check(fx.doc());
		for (const id of [first, last]) {
			const e = report.events.find((x) => x.clipId === id)!;
			expect(e.located, `${e.title} at ${e.timecode}\n${describeIssues(report)}`).toBe('found');
			expect(Math.abs(e.offsetMs!)).toBeLessThan(2);
			expect(issuesOf(report, 'OUT_OF_SYNC').filter((i) => i.clipIds?.includes(id))).toEqual([]);
		}
	});

	it('the same sound twice within the search window: each clip is measured at its own copy', async () => {
		const fx = buildCheckDoc(media);
		// a second hit on cue A's frame (another cue, another track), then cue A's own hit nudged 2 frames late
		const twin = fx.b.tx([
			{
				type: 'soundCue.add',
				cues: [{ frame: 30, kind: 'cut', weight: 'support', source: 'user', ref: '$c' }],
			},
			{
				type: 'soundDesign.place',
				cueId: '$c',
				layers: [{ mediaId: fx.ids.hitMedia, role: 'support', align: 'peak', ref: '$x' }],
			},
		]).refs.$x!;
		fx.b.tx([{ type: 'clip.move', clipIds: [fx.ids.clipA], deltaFrames: 2 }]);
		const report = await check(fx.doc());
		const sync = issuesOf(report, 'OUT_OF_SYNC');
		// the nudged hit is found 2 frames late (its own copy), not on its twin at the cue
		const a = report.events.find((e) => e.clipId === fx.ids.clipA)!;
		expect(a.located, describeIssues(report)).toBe('found');
		expect(Math.abs(a.offsetMs! - 66.7), describeIssues(report)).toBeLessThan(2);
		const ia = sync.find((i) => i.clipIds?.includes(fx.ids.clipA));
		expect(ia, describeIssues(report)).toBeDefined();
		expect(ia!.measured).toMatchObject({ measuredIn: 'mix' });
		// the twin on its cue is in sync (not measured at the nudged copy: no "renders it off" finding)
		const t = report.events.find((e) => e.clipId === twin)!;
		expect(t.located).toBe('found');
		expect(Math.abs(t.offsetMs!), describeIssues(report)).toBeLessThan(2);
		expect(sync.filter((i) => i.clipIds?.includes(twin))).toEqual([]);
	});

	it('a reversed clip is judged where its aligned point plays reversed (no false offset)', async () => {
		const fx = buildCheckDoc(media);
		const x = fx.b.tx([
			{
				type: 'soundCue.add',
				cues: [{ frame: 200, kind: 'cut', weight: 'support', source: 'user', ref: '$c' }],
			},
			{
				type: 'soundDesign.place',
				cueId: '$c',
				layers: [{ mediaId: fx.ids.hitMedia, role: 'support', align: 'peak', ref: '$x' }],
			},
		]).refs.$x!;
		fx.b.tx([{ type: 'clip.setSpeed', clipIds: [x], reverse: true, ripple: false }]);
		const seq = fx.doc().sequences[fx.b.seqId]!;
		const clip = seq.clips[x] as unknown as {
			start: number;
			duration: number;
			sourceIn: number;
			speed: { rate: number; reverse: boolean };
			sfx: { placement: { peakFlicks: number } };
		};
		expect(clip.speed.reverse).toBe(true);
		const F = (FLICKS_PER_SECOND * seq.settings.frameRate.den) / seq.settings.frameRate.num;
		// reversed, content c plays at start + duration − (c − sourceIn) / rate: move the clip so its peak is on the cue
		const into = (clip.sfx.placement.peakFlicks - clip.sourceIn) / clip.speed.rate / F;
		const delta = Math.round(200 - (clip.start + clip.duration - into));
		fx.b.tx([{ type: 'clip.move', clipIds: [x], deltaFrames: delta }]);
		const report = await check(fx.doc());
		const mine = issuesOf(report, 'OUT_OF_SYNC').filter((i) => i.clipIds?.includes(x));
		expect(
			mine.map((i) => i.severity),
			describeIssues(report),
		).toEqual(['info']);
		expect(mine[0]!.message.text).toMatch(/reversed/);
	});

	it('SILENCE is the loudest channel: a left-only room tone at −58.5 dBFS is not silence; at −62 it is', async () => {
		const tone = (db: number, name: string) => {
			const n = 3 * SR;
			const amp = 10 ** (db / 20);
			const l = new Float32Array(n);
			let s = 12345;
			for (let i = 0; i < n; i++) {
				s = (s * 1103515245 + 12345) >>> 0;
				l[i] = ((s / 2 ** 32) * 2 - 1) * amp * Math.sqrt(3); // uniform noise of RMS `amp`
			}
			const p = join(dir, name);
			writeFileSync(p, encodeWav([l, new Float32Array(n)], SR, 's16'));
			return p;
		};
		const run = async (db: number) => {
			const m = await register(app, tone(db, `left-${-db}.wav`), { authorization: `Bearer ${TOKEN}` });
			const b = new DocBuilder('hd-1080p-30', 900);
			const id = b.addMedia(m);
			b.tx([{ type: 'clip.place', source: { mediaId: id }, at: 0, tracks: { audio: 'A1' } }]);
			return check(b.doc);
		};
		const quiet = await run(-58.5);
		expect(issuesOf(quiet, 'SILENCE'), describeIssues(quiet)).toEqual([]);
		const silent = await run(-62);
		expect(issuesOf(silent, 'SILENCE').length, describeIssues(silent)).toBeGreaterThan(0);
	});

	it('DIP: a music dip written as Volume keyframes is deliberate; the same drop by a clip gain is reported', async () => {
		const dip = { start: 3.5 * FLICKS_PER_SECOND, end: 7.5 * FLICKS_PER_SECOND, depthDb: -30, fadeMs: 30 };
		const keyed = buildCheckDoc(media, { noSpeech: true });
		keyed.b.tx([{ type: 'audio.volumeDip', clipIds: [keyed.ids.music], dips: [dip] }]);
		const r1 = await check(keyed.doc());
		expect(issuesOf(r1, 'DIP'), describeIssues(r1)).toEqual([]);
		// control: the same drop as a lower clip gain (no level move written) is still a DIP
		const cut = buildCheckDoc(media, { noSpeech: true });
		cut.b.tx([{ type: 'clip.split', at: { seconds: 3.5 }, clipIds: [cut.ids.music] }]);
		const mid = () =>
			Object.values(cut.doc().sequences[cut.b.seqId]!.clips).find(
				(c) => c.kind === 'audio' && c.start === 105 && c.trackId === cut.b.track('A1'),
			)!;
		cut.b.tx([{ type: 'clip.split', at: { seconds: 7.5 }, clipIds: [mid().id] }]);
		cut.b.tx([{ type: 'audio.setGain', clipIds: [mid().id], mode: 'adjust', db: -30 }]);
		const r2 = await check(cut.doc());
		expect(issuesOf(r2, 'DIP').length, describeIssues(r2)).toBeGreaterThan(0);
	});

	it('DIP: a pause in the dialogue over quiet music is not a dip; the music itself dropping in the pause is (verification)', async () => {
		// speech 4–8 s, a 4 s pause, speech again 12–16 s; the music (20 s) 20 dB down, far under the voice
		const build = () => {
			const fx = buildCheckDoc(media);
			const mediaOf = (clipId: string) =>
				(fx.doc().sequences[fx.b.seqId]!.clips[clipId] as unknown as { mediaId: string }).mediaId;
			const music2 = fx.b.tx([
				{
					type: 'clip.place',
					source: { mediaId: mediaOf(fx.ids.music) },
					at: { seconds: 10 },
					tracks: { audio: 'A1' },
					ref: '$m2',
				},
				{
					type: 'clip.place',
					source: { mediaId: mediaOf(fx.ids.speech) },
					sourceRange: { in: { seconds: 4 }, out: { seconds: 8 } },
					at: { seconds: 12 },
					tracks: { audio: 'A2' },
					ref: '$s2',
				},
			]).refs;
			fx.b.tx([
				{ type: 'essentialSound.setType', clipIds: [music2.$m2!], audioType: 'music' },
				{ type: 'essentialSound.setType', clipIds: [music2.$s2!], audioType: 'dialogue' },
				{ type: 'audio.setGain', clipIds: [fx.ids.music, music2.$m2!], mode: 'adjust', db: -20 },
			]);
			return { fx, music2: music2.$m2! };
		};
		const pause = build();
		const r1 = await check(pause.fx.doc());
		expect(issuesOf(r1, 'DIP'), describeIssues(r1)).toEqual([]);
		// control: the music itself drops 14 dB from 8.5 to 11.5 s inside the pause (clip gains, no level move written)
		const drop = build();
		const A1 = drop.fx.b.track('A1');
		const clipAt = (start: number) =>
			Object.values(drop.fx.doc().sequences[drop.fx.b.seqId]!.clips).find(
				(c) => c.kind === 'audio' && c.start === start && c.trackId === A1,
			)!.id;
		drop.fx.b.tx([{ type: 'clip.split', at: { seconds: 8.5 }, clipIds: [drop.fx.ids.music] }]);
		drop.fx.b.tx([{ type: 'clip.split', at: { seconds: 11.5 }, clipIds: [drop.music2] }]);
		drop.fx.b.tx([{ type: 'audio.setGain', clipIds: [clipAt(255), clipAt(300)], mode: 'adjust', db: -14 }]);
		const r2 = await check(drop.fx.doc());
		expect(issuesOf(r2, 'DIP').length, describeIssues(r2)).toBeGreaterThan(0);
		// its fix needs the user's judgement, and says why in a translatable message
		const fix = issuesOf(r2, 'DIP')[0]!.fix!;
		expect(fix.safe).toBe(false);
		expect(fix.whyMessage).toEqual({ key: SOUND_CHECK_MESSAGES.whySilence, params: [], text: fix.why });
	});

	it('DIP: hits ringing out over a steady, quiet music bed are not a dip (the programme holds) (verification)', async () => {
		const fx = buildCheckDoc(media, { noSpeech: true });
		fx.b.tx([{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'adjust', db: -24 }]);
		const r = await check(fx.doc());
		expect(issuesOf(r, 'DIP'), describeIssues(r)).toEqual([]);
	});

	it('REPEAT never offers a safe swap to an alternative whose licence is not commercial-safe', async () => {
		const fx0 = buildCheckDoc(media);
		const click = soundIdOf(fx0.doc(), fx0.ids.clickMedia);
		const fx = buildCheckDoc(media, {
			clickLicense: 'CC-BY-NC-4.0',
			cueB: { media: 'hit', alternatives: [click] },
		});
		const report = await check(fx.doc());
		const rep = issuesOf(report, 'REPEAT')[0];
		expect(rep, describeIssues(report)).toBeDefined();
		const fix = rep!.fix;
		if (fix) {
			expect(fix.args).not.toMatchObject({ to: click });
			expect(JSON.stringify(fix.commands ?? [])).not.toContain(fx.ids.clickMedia);
		}
	});

	it('a custom target between 0.1 steps: the stored summary is current at once (one rounding everywhere)', async () => {
		const projectId = seed(buildCheckDoc(media).doc());
		const target = { integratedLufs: -18.55, truePeakDb: -1.25 };
		const j = await job('/api/sound-design/check', { projectId, target, store: true }, EDITOR_H);
		const result = SoundCheckResultSchema.parse(j.result);
		expect(result.stored).toBe(true);
		const r = await post('/api/agent/query', { projectId, query: 'doc.get', args: {} }, EDITOR_H);
		const doc = (r.json() as { result: ProjectDocument }).result;
		const st = soundCheckStatus(doc, result.sequenceId);
		expect(st, JSON.stringify(st.summary)).toMatchObject({ state: 'current', reasons: [] });
		// the report states the target it checked
		expect(result.report.preset).toMatchObject({ custom: true });
		expect(result.report.preset.integratedLufs).toBe(readSoundCheckTarget(target)!.integratedLufs);
	});

	it("MUSIC_OVER_VOICE: the ducking fix is safe only when the delivery's own depth (6 dB) clears 8 LU", async () => {
		const fx = buildCheckDoc(media);
		// music about level with the voice: ducking by the delivery's 6 dB leaves it ≈ 6 LU under, not 8
		fx.b.tx([{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'set', db: 10.5 }]);
		const projectId = seed(fx.doc());
		const first = SoundCheckResultSchema.parse(
			(await job('/api/sound-design/check', { projectId }, EDITOR_H)).result,
		).report;
		const issue = issuesOf(first, 'MUSIC_OVER_VOICE')[0];
		expect(issue, describeIssues(first)).toBeDefined();
		const under = issue!.measured!.underLu as number;
		expect(under).toBeLessThan(2);
		expect(issue!.fix!.safe, JSON.stringify(issue!.fix)).toBe(false);
		expect(issue!.fix!.why).toMatch(/6\.0 dB/);
		// applied anyway, it does not resolve the finding (what "not safe" said)
		await job(`/api/sound-design/${issue!.fix!.job!.route}`, issue!.fix!.job!.body, EDITOR_H);
		const again = SoundCheckResultSchema.parse(
			(await job('/api/sound-design/check', { projectId }, EDITOR_H)).result,
		).report;
		expect(issuesOf(again, 'MUSIC_OVER_VOICE').length, describeIssues(again)).toBeGreaterThan(0);
	});

	it("MASKED numbers are the solver's: the rebalance job solves the same gain and lift on the same document", async () => {
		const fx = buildCheckDoc(media);
		fx.b.tx([
			{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'set', db: 14 },
			{ type: 'soundDesign.applyGains', gains: { [fx.ids.clipB]: -12 } },
		]);
		const projectId = seed(fx.doc());
		const j = await job('/api/sound-design/check', { projectId });
		const report = SoundCheckResultSchema.parse(j.result).report;
		const masked = issuesOf(report, 'MASKED').find((i) => i.clipIds?.[0] === fx.ids.clipB);
		expect(masked, describeIssues(report)).toBeDefined();
		const reb = SfxRebalanceResultSchema.parse(
			(await job('/api/sound-design/rebalance', { projectId, mode: 'propose' })).result,
		);
		const ev = reb.report.events.find((e) => e.clipId === fx.ids.clipB)!;
		expect(ev).toBeDefined();
		expect(masked!.measured).toMatchObject({ solvedGainDb: ev.gainDb, solvedLiftDb: ev.achievedLiftDb });
		const row = report.events.find((e) => e.clipId === fx.ids.clipB)!;
		expect(row.liftDb).toBe(masked!.measured!.liftDb);
		// the lift at the current gain is the solved lift minus the gain still to add (dB for dB)
		expect(row.liftDb! + (ev.gainDb - row.gainDb)).toBeCloseTo(ev.achievedLiftDb!, 1);
	});
});
