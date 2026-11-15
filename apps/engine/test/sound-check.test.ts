// Sound Check (spec 12 §2.6, P5-R1, P5-R4; wp-note "Phase 5 → WP5.1") on a real engine with generated media: the
// clean fixture passes; each seeded defect is found with its code; each fix applied through its command or job resolves
// it on a re-check; short media never pass; `store` writes the summary and `soundCheckStatus` follows the mix.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type EngineJob,
	type SoundCheckFix,
	type SoundCheckIssue,
	type SoundCheckReport,
	type SoundCheckResult,
	SoundCheckResultSchema,
	SoundVisualResponseSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope, mixFingerprint, type ProjectDocument, soundCheckStatus } from '@jasper/project';
import { measureLoudness } from '@jasper/testkit/oracle';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMixdown } from '../src/audio/mixdown.ts';
import { audioWorld } from '../src/sound-design/bed.ts';
import { visualRange } from '../src/sound-design/visual.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, editorCookie, makeApp, TEST_HOST, type TestApp } from './helpers.ts';
import {
	buildCheckDoc,
	type CheckFixture,
	type FixtureMedia,
	registerCheckMedia,
} from './sound-check-fixture.ts';

const HOST = { host: TEST_HOST };
const TOKEN = 'tok_check_0123456789abcdef012';
const KEY = 'key_check_0123456789abcdef012';
const AGENT_H = { ...HOST, authorization: `Bearer ${TOKEN}`, 'x-jasper-agent': 'check-agent' };
const EDITOR_H = { ...HOST, cookie: editorCookie(TOKEN, KEY) };
const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

let app: TestApp;
let media: FixtureMedia;
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
				{ revision: 3, savedAt: '2026-10-16T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	return projectId;
}
async function saved(projectId: string): Promise<{ doc: ProjectDocument; revision: number }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/agent/query',
		headers: json(EDITOR_H),
		payload: JSON.stringify({ projectId, query: 'doc.get', args: {} }),
	});
	const b = r.json() as { result: ProjectDocument; revision: number };
	return { doc: b.result, revision: b.revision };
}
async function post(url: string, body: unknown, headers: Record<string, string> = AGENT_H) {
	return app.inject({ method: 'POST', url, headers: json(headers), payload: JSON.stringify(body) });
}
async function waitJob(r: { statusCode: number; body: string; json(): unknown }): Promise<EngineJob> {
	expect(r.statusCode, r.body).toBe(202);
	return coreServices(app).queue.wait((r.json() as EngineJob).id);
}
async function check(
	body: Record<string, unknown>,
	name: string,
	headers: Record<string, string> = AGENT_H,
): Promise<{ job: EngineJob; result: SoundCheckResult; report: SoundCheckReport }> {
	const t0 = Date.now();
	const job = await waitJob(await post('/api/sound-design/check', body, headers));
	timings.push({ name, ms: Date.now() - t0 });
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	const result = SoundCheckResultSchema.parse(job.result);
	return { job, result, report: result.report };
}
const codes = (r: SoundCheckReport) => [...new Set(r.issues.map((i) => i.code))].sort();
const issuesOf = (r: SoundCheckReport, code: string) => r.issues.filter((i) => i.code === code);
const describeIssues = (r: SoundCheckReport) =>
	r.issues.map((i) => `${i.severity} ${i.code} ${i.message.text}`).join('\n');

/** Applies a fix as the editor would: one transaction, or the engine job. */
async function applyFix(projectId: string, fix: SoundCheckFix): Promise<void> {
	if (fix.kind === 'commands') {
		const r = await post(
			'/api/agent/tx',
			{
				projectId,
				transaction: {
					label: fix.label.text.slice(0, 200),
					origin: { agent: 'check-test' },
					commands: fix.commands,
				},
			},
			EDITOR_H,
		);
		expect(r.statusCode, r.body).toBe(200);
		const res = (r.json() as { result: { ok: boolean; errors?: unknown } }).result;
		expect(res.ok, JSON.stringify(res.errors)).toBe(true);
		return;
	}
	if (fix.kind === 'job') {
		const job = await waitJob(await post(`/api/sound-design/${fix.job!.route}`, fix.job!.body, EDITOR_H));
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		return;
	}
	throw new Error(`fix kind ${fix.kind} is not applied by this test`);
}

/** Runs the check on a variant, expects `code`, applies its fix and expects it gone on a re-check. */
async function seededDefect(
	name: string,
	fx: CheckFixture,
	code: SoundCheckIssue['code'],
	pick: (i: SoundCheckIssue) => boolean = () => true,
	opts: { expectSafe?: boolean } = {},
): Promise<{ first: SoundCheckReport; again: SoundCheckReport; issue: SoundCheckIssue }> {
	const projectId = seed(fx.doc());
	const { report: first } = await check({ projectId }, name);
	const issue = issuesOf(first, code).find(pick);
	expect(issue, `${name}: no ${code} in\n${describeIssues(first)}`).toBeDefined();
	expect(first.verdict).not.toBe('pass');
	expect(issue!.fix, `${name}: ${code} has no fix`).toBeDefined();
	if (opts.expectSafe !== undefined) expect(issue!.fix!.safe).toBe(opts.expectSafe);
	await applyFix(projectId, issue!.fix!);
	const { report: again } = await check({ projectId }, `${name} re-check`);
	const still = issuesOf(again, code).filter((i) => i.id === issue!.id);
	expect(still, `${name}: ${code} still there after its fix:\n${describeIssues(again)}`).toEqual([]);
	return { first, again, issue: issue! };
}

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
	media = await registerCheckMedia(app, mkdtempSync(join(tmpdir(), 'jasper-check-')), TOKEN);
}, 180_000);
afterAll(async () => {
	console.log(`sound check timings (ms): ${timings.map((t) => `${t.name} ${t.ms}`).join(', ')}`);
	await closeApps();
});

describe('Sound Check (real engine)', { timeout: 600_000 }, () => {
	it('the clean fixture passes; the report is complete; store writes the summary; staleness follows the mix', async () => {
		const fx = buildCheckDoc(media);
		const projectId = seed(fx.doc());
		const before = await saved(projectId);
		const { job, result, report } = await check({ projectId, store: true }, 'clean', EDITOR_H);
		expect(report.verdict, describeIssues(report)).toBe('pass');
		expect(
			report.issues.filter((i) => i.severity !== 'info'),
			describeIssues(report),
		).toEqual([]);
		// A loud start is informational and can be faded on the Mix lane (P6-E3).
		const head = issuesOf(report, 'HEAD')[0];
		expect(head, describeIssues(report)).toMatchObject({ severity: 'info', category: 'edges' });
		expect(head!.fix!.commands![0]).toMatchObject({
			type: 'mixer.writeAutomation',
			stripId: 'Mix',
			lane: 'volume',
		});
		for (const issue of [...issuesOf(report, 'ARC'), ...issuesOf(report, 'LAYER_INAUDIBLE')])
			expect(issue.severity).toBe('info');
		// loudness as delivered: normalised to −14 ±1 under −1 dBTP
		expect(report.loudness.measurable).toBe(true);
		expect(report.loudness.normalization.enabled).toBe(true);
		expect(Math.abs(report.loudness.integratedLufs! + 14)).toBeLessThan(1);
		expect(report.loudness.truePeakDb!).toBeLessThanOrEqual(-0.95);
		// every sound effect located on its cue, inside its tolerance
		expect(report.events.map((e) => e.clipId).sort()).toEqual(
			[fx.ids.clipA, fx.ids.clipB, fx.ids.clipC].sort(),
		);
		for (const e of report.events) {
			expect(e.located, e.title).toBe('found');
			expect(Math.abs(e.offsetMs!), e.title).toBeLessThan(2);
			expect(e.liftDb!).toBeGreaterThan(e.minLiftDb!);
			expect(e.status).toBe('pass');
		}
		// stems, speech, curves
		expect(report.stems).toMatchObject({ sfx: 3, dialogue: 1, music: 1, ambience: 0, bed: 2, mix: 5 });
		expect(report.speech.seconds).toBeGreaterThan(2.5);
		expect(report.speech.seconds).toBeLessThan(4.5);
		expect(report.curves.points).toBeGreaterThan(100);
		expect(report.curves.mix.length).toBe(report.curves.points);
		expect(report.curves.sfx.length).toBe(report.curves.points);
		expect(Math.max(...report.curves.mix)).toBeGreaterThan(-30);
		// listen-here: worst is absent when nothing fails; the rest point at real moments
		const slots = report.listen.map((l) => l.slot);
		expect(slots).toEqual(['hero', 'loudest', 'densest', 'passing']);
		for (const l of report.listen) {
			expect(l.timecode).toMatch(/^\d\d:\d\d:\d\d[:;]\d\d$/);
		}
		// stored summary
		expect(result.stored).toBe(true);
		const after = await saved(projectId);
		expect(after.revision).toBe(before.revision + 1);
		const seqId = report.sequenceId;
		const status = soundCheckStatus(after.doc, seqId);
		expect(status.state).toBe('current');
		expect(status.summary).toMatchObject({
			verdict: 'pass',
			preset: 'web',
			jobId: job.id,
			mixHash: report.mixHash,
		});
		// a gain change makes it stale
		const tx = await post(
			'/api/agent/tx',
			{
				projectId,
				transaction: {
					label: 'Gain',
					origin: { agent: 'x' },
					commands: [{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'adjust', db: 1 }],
				},
			},
			EDITOR_H,
		);
		expect(tx.statusCode).toBe(200);
		const stale = soundCheckStatus((await saved(projectId)).doc, seqId);
		expect(stale).toMatchObject({ state: 'stale', reasons: ['mix'] });
		// the visual route over the first 4 s, with this job's findings
		const v = await post('/api/sound-design/visual', {
			projectId,
			range: { start: 0, end: 120 },
			checkJobId: job.id,
		});
		expect(v.statusCode, v.body).toBe(200);
		const vis = SoundVisualResponseSchema.parse(v.json());
		expect(vis.points).toBe(400);
		expect(vis.curves.mix.momentary.length).toBe(400);
		expect(vis.curves.sfx.shortTerm.length).toBe(400);
		expect(vis.waveformPeakDb.length).toBe(400);
		expect(vis.motion.speed.length).toBe(120);
		expect(vis.cues.map((c) => c.frame)).toEqual([30, 90]);
		expect(vis.clips.map((c) => Math.round(c.alignedFrame!))).toEqual([30, 90]);
		// the hit at 1 s stands out of the bed in the sound-effects curve
		expect(vis.curves.sfx.momentary[100]!).toBeGreaterThan(vis.curves.sfx.momentary[50]! + 20);
		const { sfx, bed } = vis.stemPeakDb!;
		expect(sfx).toHaveLength(vis.points);
		expect(bed).toHaveLength(vis.points);
		const hitPeak = Math.max(...sfx.slice(97, 104));
		expect(hitPeak).toBeGreaterThan(-30);
		expect(hitPeak).toBeGreaterThan(Math.max(...sfx.slice(40, 60)) + 20);
	});

	it('a custom target (WP5.2 "Custom…"): checked at its numbers, its fix normalises there, the summary keeps it', async () => {
		const fx = buildCheckDoc(media);
		const projectId = seed(fx.doc());
		const target = { integratedLufs: -20, truePeakDb: -2 };
		const { report } = await check({ projectId, target, store: true }, 'custom target', EDITOR_H);
		expect(report.preset).toMatchObject({
			id: 'web',
			integratedLufs: -20,
			custom: true,
		});
		const loud = issuesOf(report, 'LOUDNESS')[0];
		expect(loud, describeIssues(report)).toBeDefined();
		// a custom target is never judged as a broadcast delivery
		expect(loud!.severity).toBe('warning');
		expect(loud!.fix).toMatchObject({
			safe: true,
			commands: [{ type: 'mixer.setLoudness', enabled: true, targetLufs: -20, truePeakDb: -2 }],
		});
		const seqId = report.sequenceId;
		let doc = (await saved(projectId)).doc;
		expect(soundCheckStatus(doc, seqId)).toMatchObject({
			state: 'current',
			summary: { preset: 'web', target },
		});
		await applyFix(projectId, loud!.fix!);
		const { report: again } = await check({ projectId, target, store: true }, 'custom re-check', EDITOR_H);
		expect(issuesOf(again, 'LOUDNESS'), describeIssues(again)).toEqual([]);
		expect(Math.abs(again.loudness.integratedLufs! + 20)).toBeLessThan(1);
		expect(again.loudness.truePeakDb!).toBeLessThanOrEqual(-1.95);
		doc = (await saved(projectId)).doc;
		expect(soundCheckStatus(doc, seqId).state).toBe('current');
		// out of range → refused before a job starts
		const bad = await post('/api/sound-design/check', {
			projectId,
			target: { integratedLufs: -70, truePeakDb: -1 },
		});
		expect(bad.statusCode).toBe(400);
	});

	it('2-frame offset → OUT_OF_SYNC with the offset in ms; the safe align fix puts it back', async () => {
		const fx = buildCheckDoc(media);
		fx.b.tx([{ type: 'clip.move', clipIds: [fx.ids.clipA], deltaFrames: 2 }]);
		const { issue, again } = await seededDefect('offset', fx, 'OUT_OF_SYNC', (i) => i.cueId === fx.ids.cueA, {
			expectSafe: true,
		});
		expect(issue.severity).toBe('error');
		expect(issue.measured!.measuredIn).toBe('mix');
		expect(Math.abs((issue.measured!.offsetMs as number) - 66.7)).toBeLessThan(2);
		expect(issue.fix!.tool).toBe('align_peak');
		expect(again.verdict, describeIssues(again)).toBe('pass');
	});

	it('a clip that ends at its peak → OUT_OF_SYNC (the sound is cut); lengthening it resolves it', async () => {
		const fx = buildCheckDoc(media);
		const clip = fx.doc().sequences[fx.b.seqId]!.clips[fx.ids.clipB]!;
		// the click aligned at frame 90 starts at 89: one frame long, it ends on its peak
		fx.b.tx([{ type: 'clip.trim', clipId: fx.ids.clipB, edge: 'out', deltaFrames: 1 - clip.duration }]);
		const { issue } = await seededDefect('cut', fx, 'OUT_OF_SYNC', (i) => i.cueId === fx.ids.cueB, {
			expectSafe: true,
		});
		expect(issue.fix!.commands![0]).toMatchObject({ type: 'clip.trim', edge: 'out' });
	});

	it('masked hit under loud music → MASKED; the solver gain fix lifts it', async () => {
		const fx = buildCheckDoc(media);
		fx.b.tx([
			{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'set', db: 14 },
			{ type: 'soundDesign.applyGains', gains: { [fx.ids.clipB]: -12 } },
		]);
		const { issue } = await seededDefect('masked', fx, 'MASKED', (i) => i.clipIds?.[0] === fx.ids.clipB, {
			expectSafe: true,
		});
		expect(issue.measured!.liftDb as number).toBeLessThan(1.5);
		expect(issue.fix!.commands![0]).toMatchObject({ type: 'soundDesign.applyGains' });
	});

	it('0.8 s digital silence → SILENCE; marking it intended resolves it', async () => {
		const fx = buildCheckDoc(media, { musicHole: [1.8, 2.6] });
		const { issue } = await seededDefect('silence', fx, 'SILENCE', () => true, { expectSafe: false });
		expect(issue.measured!.seconds as number).toBeGreaterThan(0.7);
		expect(issue.measured!.seconds as number).toBeLessThan(0.9);
		expect(issue.range!.start).toBeGreaterThanOrEqual(53);
		expect(issue.range!.start).toBeLessThanOrEqual(57);
	});

	it('music 3 LU under the voice → MUSIC_OVER_VOICE; the ducking fix resolves it', async () => {
		const fx = buildCheckDoc(media);
		fx.b.tx([{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'set', db: 7.5 }]);
		const { issue } = await seededDefect('music over voice', fx, 'MUSIC_OVER_VOICE', () => true, {
			expectSafe: true,
		});
		expect(issue.measured!.underLu as number).toBeGreaterThan(1.5);
		expect(issue.measured!.underLu as number).toBeLessThan(4.5);
		expect(issue.measured!.ducked).toBe(false);
		expect(issue.fix!.job).toMatchObject({ route: 'delivery', body: { autoMatch: false, loudness: false } });
	});

	it('true peak −0.2 dBTP → TRUE_PEAK; normalising at the preset resolves it', async () => {
		const fx = buildCheckDoc(media);
		fx.b.tx([{ type: 'mixer.setLoudness', enabled: false }]);
		const projectId = seed(fx.doc());
		// Calibrate from FFmpeg's independent true-peak meter, not the checker being tested.
		// With no master effects/normalisation, one fader correction scales every sample equally.
		const scratch = mkdtempSync(join(tmpdir(), 'jasper-check-peak-'));
		let inputPeak: number | null = null;
		try {
			const core = coreServices(app);
			const world = await audioWorld(fx.doc(), fx.b.seqId, core.registry);
			const input = await renderMixdown({
				ff: core.ffmpeg,
				snapshot: world.snapshot,
				media: world.media,
				range: { start: 0, end: 300 },
				outputLayout: 'stereo',
				withoutLoudness: true,
				scratchDir: scratch,
			});
			inputPeak = measureLoudness(input.path!).truePeak;
			expect(Number.isFinite(inputPeak)).toBe(true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
		const gain = Math.round((-0.2 - inputPeak!) * 100) / 100;
		const adjusted = await post(
			'/api/agent/tx',
			{
				projectId,
				transaction: {
					label: 'Gain',
					origin: { agent: 'x' },
					commands: [{ type: 'mixer.updateStrip', stripId: 'Mix', patch: { volumeDb: gain } }],
				},
			},
			EDITOR_H,
		);
		expect(adjusted.statusCode, adjusted.body).toBe(200);
		const { report } = await check({ projectId }, 'tp −0.2');
		expect(Math.abs(report.loudness.truePeakDb! + 0.2)).toBeLessThan(0.1);
		const issue = issuesOf(report, 'TRUE_PEAK')[0];
		expect(issue, describeIssues(report)).toBeDefined();
		expect(issue!.severity).toBe('error');
		expect(issue!.fix).toMatchObject({
			safe: true,
			commands: [{ type: 'mixer.setLoudness', enabled: true }],
		});
		// the fix stores the measured mix as the Mix's loudness analysis, so the preview is normalised at once (final
		// verification B: without it the preview played the un-normalised mix until someone ran Analyze)
		const analysis = (issue!.fix!.commands![0] as { analysis?: { integratedLufs: number; mixHash: string } })
			.analysis;
		expect(analysis, JSON.stringify(issue!.fix)).toBeDefined();
		expect(Math.abs(analysis!.integratedLufs - report.loudness.integratedLufs!)).toBeLessThan(0.05);
		await applyFix(projectId, issue!.fix!);
		const fixedDoc = (await saved(projectId)).doc;
		const stored = (
			fixedDoc.sequences[report.sequenceId]!.master as { loudness?: { analysis?: { mixHash: string } } }
		).loudness?.analysis;
		expect(stored?.mixHash).toBe(mixFingerprint(fixedDoc, report.sequenceId));
		const { report: again } = await check({ projectId }, 'tp re-check');
		expect(issuesOf(again, 'TRUE_PEAK'), describeIssues(again)).toEqual([]);
		expect(issuesOf(again, 'LOUDNESS')).toEqual([]);
		expect(again.loudness.truePeakDb!).toBeLessThanOrEqual(-0.95);
		expect(again.loudness.limiterMaxGrDb!).toBeGreaterThan(0);
	});

	it('short media is never a trivial pass: the loudness is "not measurable"', async () => {
		const fx = buildCheckDoc(media);
		const projectId = seed(fx.doc());
		// 6 frames (0.2 s) of the sequence
		const { report } = await check({ projectId, range: { start: 33, end: 39 } }, 'short');
		expect(report.verdict).toBe('warn');
		expect(report.loudness.measurable).toBe(false);
		expect(report.loudness.integratedLufs).toBeNull();
		expect(report.warnings.map((w) => w.code)).toContain('W_RANGE');
		// a silent stretch: not measurable either (and silence)
		const silent = buildCheckDoc(media, { musicHole: [1.5, 3.5], noSpeech: true });
		const sp = seed(silent.doc());
		const { report: s } = await check({ projectId: sp, range: { start: 60, end: 90 } }, 'short silent');
		expect(s.verdict).not.toBe('pass');
		expect(codes(s)).toEqual(expect.arrayContaining(['LOUDNESS', 'SILENCE']));
	});

	it('an empty sequence is never a pass: silent, nothing to measure', async () => {
		const b = buildCheckDoc(media);
		const empty = { ...b.doc(), sequences: { ...b.doc().sequences } };
		const seqId = Object.keys(empty.sequences)[0]!;
		empty.sequences[seqId] = { ...empty.sequences[seqId]!, clips: {}, soundDesign: undefined } as never;
		const { report } = await check({ projectId: seed(empty) }, 'empty');
		expect(report.verdict).toBe('warn');
		expect(report.loudness.integratedLufs).toBeNull();
		expect(report.events).toEqual([]);
	});

	it('a cue whose marker moved → STALE_CUE; resync resolves it', async () => {
		const fx = buildCheckDoc(media);
		const m = fx.b.tx([{ type: 'marker.add', frame: 285, name: 'boom', ref: '$mk' }]).refs.$mk!;
		const r = fx.b.tx([
			{
				type: 'soundCue.add',
				cues: [
					{
						frame: 285,
						kind: 'manual',
						weight: 'support',
						source: 'user',
						anchor: { type: 'marker', markerId: m },
						ref: '$c',
					},
				],
			},
			{
				type: 'soundDesign.place',
				cueId: '$c',
				layers: [{ mediaId: fx.ids.clickMedia, role: 'support', align: 'peak' }],
			},
		]);
		fx.b.tx([{ type: 'marker.update', markerId: m, frame: 279 }]);
		const { issue } = await seededDefect('stale cue', fx, 'STALE_CUE', (i) => i.cueId === r.refs.$c, {
			expectSafe: true,
		});
		expect(issue.measured).toMatchObject({ anchorFrame: 279, movedFrames: -6 });
	});

	it('the same sound back to back → REPEAT; swapping to its alternative resolves it', async () => {
		const fx0 = buildCheckDoc(media);
		const clickSound = (fx0.doc().media[fx0.ids.clickMedia] as { library: { soundId: string } }).library
			.soundId;
		const hitSound = (fx0.doc().media[fx0.ids.hitMedia] as { library: { soundId: string } }).library.soundId;
		const fx = buildCheckDoc(media, { cueB: { media: 'hit', alternatives: [hitSound, clickSound] } });
		const { issue } = await seededDefect('repeat', fx, 'REPEAT', () => true, { expectSafe: true });
		expect(issue.clipIds).toEqual([fx.ids.clipA, fx.ids.clipB]);
		expect(issue.fix!.commands![0]).toMatchObject({
			type: 'soundDesign.swap',
			clipId: fx.ids.clipB,
			mediaId: fx.ids.clickMedia,
		});
	});

	it('two heroes 1.5 s apart → DENSITY; demoting the later one resolves it', async () => {
		const fx = buildCheckDoc(media, { cueB: { weight: 'hero', frame: 75 } });
		const { issue } = await seededDefect('density', fx, 'DENSITY', (i) => i.cueId === fx.ids.cueB, {
			expectSafe: true,
		});
		expect(issue.measured).toMatchObject({ gapSec: 1.5, minSec: 2 });
	});

	it('NC and user-provided licences → LICENSE; swapping to a commercial-safe alternative resolves it', async () => {
		const fx0 = buildCheckDoc(media);
		const hit2Sound = (fx0.doc().media[fx0.ids.hit2Media] as { library: { soundId: string } }).library
			.soundId;
		const fx = buildCheckDoc(media, { clickLicense: 'CC-BY-NC-4.0', cueB: { alternatives: [hit2Sound] } });
		const { issue } = await seededDefect(
			'licence nc',
			fx,
			'LICENSE',
			(i) => i.clipIds?.[0] === fx.ids.clipB,
			{
				expectSafe: true,
			},
		);
		expect(issue.severity).toBe('error');
		const user = buildCheckDoc(media, { clickLicense: 'LicenseRef-UserProvided' });
		const { report } = await check({ projectId: seed(user.doc()) }, 'licence user');
		const u = issuesOf(report, 'LICENSE')[0]!;
		expect(u.severity).toBe('warning');
		expect(u.measured).toMatchObject({ class: 'user-provided' });
	});

	it('CC-BY sounds without a credits file → CREDITS; configuring credits resolves it', async () => {
		const fx = buildCheckDoc(media, {
			hit2License: 'CC-BY-4.0',
			hit2Attribution: '"Hit" by Fixture author, CC BY 4.0',
		});
		const { issue } = await seededDefect('credits', fx, 'CREDITS', () => true, { expectSafe: true });
		expect(issue.fix!.commands![0]).toMatchObject({ type: 'soundDesign.setSettings', credits: 'md' });
	});

	it('a derived cue with nothing on screen → NO_PICTURE_EVENT', async () => {
		const fx = buildCheckDoc(media);
		fx.b.tx([
			{ type: 'soundCue.add', cues: [{ frame: 200, kind: 'move', weight: 'support', source: 'derived' }] },
		]);
		const { issue } = await seededDefect('no picture', fx, 'NO_PICTURE_EVENT', () => true, {
			expectSafe: false,
		});
		expect(issue.frame).toBe(200);
	});

	it('typed refusals before a job starts', async () => {
		const projectId = seed(buildCheckDoc(media).doc());
		const code = async (url: string, body: unknown) => {
			const r = await post(url, body);
			return [r.statusCode, (r.json() as { code: string }).code];
		};
		expect(await code('/api/sound-design/check', { projectId: 'prj_9999999999999999' })).toEqual([
			404,
			'PROJECT_NOT_FOUND',
		]);
		expect(await code('/api/sound-design/check', { projectId, sequenceId: 'seq_000000000000none' })).toEqual([
			404,
			'SEQUENCE_NOT_FOUND',
		]);
		expect(await code('/api/sound-design/check', { projectId, preset: 'loud' })).toEqual([
			400,
			'VALIDATION_FAILED',
		]);
		expect(await code('/api/sound-design/check', { projectId, range: { start: 10, end: 5 } })).toEqual([
			400,
			'VALIDATION_FAILED',
		]);
		expect(await code('/api/sound-design/check', { projectId, range: { start: 5000, end: 6000 } })).toEqual([
			400,
			'RANGE_EMPTY',
		]);
		expect(await code('/api/sound-design/check', { projectId, extra: true })).toEqual([
			400,
			'VALIDATION_FAILED',
		]);
		expect(await code('/api/sound-design/visual', { projectId, range: { start: 900, end: 960 } })).toEqual([
			400,
			'RANGE_EMPTY',
		]);
		// over 120 s of a long sequence
		const doc = buildCheckDoc(media).doc();
		const seq = doc.sequences[Object.keys(doc.sequences)[0]!]!;
		const long = {
			...seq,
			clips: { ...seq.clips, x: { ...Object.values(seq.clips)[0]!, id: 'x', start: 0, duration: 30 * 600 } },
		} as typeof seq;
		expect(() => visualRange(long, { range: { start: 0, end: 30 * 121 } })).toThrow(/At most 120 s/);
		expect(visualRange(long, { range: { start: 30, end: 30 * 120 } })).toEqual({ start: 30, end: 3600 });
		expect(
			await code('/api/sound-design/visual', {
				projectId,
				range: { start: 0, end: 30 },
				checkJobId: 'job_nope',
			}),
		).toEqual([404, 'JOB_NOT_FOUND']);
		expect(await code('/api/sound-design/visual', { projectId })).toEqual([400, 'VALIDATION_FAILED']);
	});
});
