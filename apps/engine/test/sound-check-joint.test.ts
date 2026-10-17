// Sound Check fixes judged together and true-peak headroom, and a mono Mix checked in mono (wp-note "WP6.5b → Sound
// Check"), on a real engine with generated media (sound-check-fixture.ts), each case measured by applying the fixes
// and checking again:
//   (a) a masked hero that is also too close to the previous hero: its gain fix and its demotion are each "safe"; applied
//       together the demotion resets the solved gain to the support default and the hero is masked again (measured on
//       the re-check). The report marks the demotion not safe (it conflicts with the gain); the safe set resolves it.
//   (b) normalisation off: the gain that unmasks a support under loud music pushes the mix's true peak over the
//       ceiling. Not safe; applied anyway, the re-check measures the true peak over the ceiling (and under the bound).
//   (c) a mono Mix is rendered and measured in mono: the integrated loudness and true peak equal the export mixer's mono
//       render, 3 LU under its stereo upmix; with normalisation off a warning says a 2-channel export measures louder.
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SoundCheckFix, SoundCheckIssue, SoundCheckReport } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import { defaultRegistries, type ProjectDocument, SOUND_CHECK_MESSAGES, type Sequence } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMixdown } from '../src/audio/mixdown.ts';
import { audioWorld } from '../src/sound-design/bed.ts';
import { checkSequence } from '../src/sound-design/check.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, makeApp, type TestApp } from './helpers.ts';
import { buildCheckDoc, type CheckFixture, type FixtureMedia, registerCheckMedia } from './sound-check-fixture.ts';

const TOKEN = 'tok_joint_0123456789abcdef012';
let app: TestApp;
let media: FixtureMedia;
let dir: string;

beforeAll(async () => {
	app = await makeApp({ dev: false, token: TOKEN });
	dir = mkdtempSync(join(tmpdir(), 'jasper-check-joint-'));
	media = await registerCheckMedia(app, dir, TOKEN);
}, 180_000);
afterAll(async () => {
	await closeApps();
	rmSync(dir, { recursive: true, force: true });
});

async function check(doc: ProjectDocument): Promise<SoundCheckReport> {
	const core = coreServices(app);
	const seq = doc.sequences[Object.keys(doc.sequences)[0]!] as Sequence;
	const scratch = mkdtempSync(join(tmpdir(), 'jasper-check-joint-scratch-'));
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
const issuesOf = (r: SoundCheckReport, code: string) => r.issues.filter((i) => i.code === code);
const describeIssues = (r: SoundCheckReport) =>
	r.issues
		.map((i) => `${i.severity} ${i.code} ${i.message.text}${i.fix ? ` [${i.fix.safe ? 'safe' : 'unsafe'}: ${i.fix.why ?? ''}]` : ''}`)
		.join('\n');
const applyAll = (fx: CheckFixture, fixes: SoundCheckFix[]) =>
	fx.b.tx(fixes.flatMap((f) => (f.commands ?? []) as unknown[]));
const clone = (fx: CheckFixture) => {
	const copy = Object.create(Object.getPrototypeOf(fx.b)) as CheckFixture['b'];
	Object.assign(copy, fx.b, { doc: structuredClone(fx.b.doc) });
	return { ...fx, b: copy, doc: () => copy.doc } as CheckFixture;
};

describe('Sound Check fixes together (real engine)', { timeout: 600_000 }, () => {
	it('(a) a masked hero too close to the previous one: its demotion conflicts with its gain fix', async () => {
		const fx = buildCheckDoc(media, { cueB: { weight: 'hero', frame: 75, media: 'hit' } });
		fx.b.tx([{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'set', db: 14 }]);
		const report = await check(fx.doc());
		const masked = issuesOf(report, 'MASKED').find((i) => i.clipIds?.[0] === fx.ids.clipB);
		const density = issuesOf(report, 'DENSITY').find((i) => i.cueId === fx.ids.cueB);
		expect(masked, describeIssues(report)).toBeDefined();
		expect(density, describeIssues(report)).toBeDefined();
		expect(masked!.fix?.safe, describeIssues(report)).toBe(true);
		// the demotion is not safe with (after) the gain fix: it resets the gain to the support default
		expect(density!.fix?.safe, describeIssues(report)).toBe(false);
		expect(density!.fix!.whyMessage?.key).toBe(SOUND_CHECK_MESSAGES.whyFixMasked);
		expect(density!.fix!.conflictsWith).toEqual([masked!.id]);
		expect(report.levelGuard?.levels.map((l) => l.clipId)).toContain(fx.ids.clipB);

		// measured: both applied in one transaction (what "Fix all safe" did before) → B masked again on the re-check
		const both = clone(fx);
		applyAll(both, [masked!.fix!, density!.fix!]);
		const again = await check(both.doc());
		expect(
			issuesOf(again, 'MASKED').some((i) => i.clipIds?.[0] === fx.ids.clipB),
			describeIssues(again),
		).toBe(true);
		// the safe set (the gain only) resolves it
		applyAll(fx, report.issues.filter((i) => i.fix?.safe && i.fix.kind === 'commands').map((i) => i.fix!));
		const fixed = await check(fx.doc());
		expect(
			issuesOf(fixed, 'MASKED').some((i) => i.clipIds?.[0] === fx.ids.clipB),
			describeIssues(fixed),
		).toBe(false);
	});

	it('(b) normalisation off: a gain fix that would raise the true peak over the ceiling is not safe (measured)', async () => {
		const build = (normalise: boolean) => {
			const fx = buildCheckDoc(media);
			fx.b.tx([
				{ type: 'mixer.setLoudness', enabled: normalise, targetLufs: -14, truePeakDb: -1 },
				// the heroes out of the way (hand-set gains), the music loud, the support click buried under it
				{ type: 'audio.setGain', clipIds: [fx.ids.clipA, fx.ids.clipC], mode: 'set', db: -40 },
				{ type: 'audio.setGain', clipIds: [fx.ids.music], mode: 'set', db: 9 },
				{ type: 'soundDesign.applyGains', gains: { [fx.ids.clipB]: -24 } },
			]);
			return fx;
		};
		const fx = build(false);
		const report = await check(fx.doc());
		const tp = report.loudness.truePeakDb!;
		// the mix peaks under the −1 dBTP ceiling: no TRUE_PEAK before the fix
		expect(issuesOf(report, 'TRUE_PEAK'), describeIssues(report)).toEqual([]);
		expect(tp).toBeLessThanOrEqual(-1.1);
		const masked = issuesOf(report, 'MASKED').find((i) => i.clipIds?.[0] === fx.ids.clipB);
		expect(masked, describeIssues(report)).toBeDefined();
		expect(masked!.fix?.kind).toBe('commands');
		expect(masked!.fix!.safe, describeIssues(report)).toBe(false);
		expect(masked!.fix!.whyMessage?.key).toBe(SOUND_CHECK_MESSAGES.whyFixMixPeak);
		expect(masked!.fix!.conflictsWith ?? []).toEqual([]);
		const model = report.levelGuard!.levels.find((l) => l.clipId === fx.ids.clipB)!;
		expect(model.mixTruePeakDb).not.toBeNull();
		const solved = masked!.measured!.solvedGainDb as number;
		const d = solved - model.gainDb;
		const bound =
			20 * Math.log10(10 ** (model.mixTruePeakDb! / 20) + (10 ** (d / 20) - 1) * 10 ** ((model.truePeakAt0Db! + model.gainDb) / 20));
		expect(bound).toBeGreaterThan(-1);
		// measured: applied anyway, the mix's true peak goes over the ceiling — and stays under the bound
		applyAll(fx, [masked!.fix!]);
		const again = await check(fx.doc());
		console.log(
			`(b) TP before ${tp} dBTP (window ${model.mixTruePeakDb}), gain ${model.gainDb} → ${solved} dB: bound ${bound.toFixed(2)}, measured ${again.loudness.truePeakDb} dBTP`,
		);
		expect(again.loudness.truePeakDb!).toBeGreaterThan(-1);
		expect(issuesOf(again, 'TRUE_PEAK').length, describeIssues(again)).toBe(1);
		expect(again.loudness.truePeakDb!).toBeLessThanOrEqual(bound + 0.05);
		// with normalisation the limiter holds the ceiling: the same fix is safe
		const norm = await check(build(true).doc());
		const m2 = issuesOf(norm, 'MASKED').find((i) => i.clipIds?.[0] === fx.ids.clipB);
		expect(m2?.fix?.safe, describeIssues(norm)).toBe(true);
	});

	it('(c) a mono Mix is checked in mono: loudness equals the mono export, 3 LU under its stereo upmix', async () => {
		for (const normalise of [false, true]) {
			const fx = buildCheckDoc(media);
			fx.b.tx([
				{ type: 'sequence.updateSettings', sequenceId: fx.b.seqId, settings: { masterLayout: 'mono' } },
				{ type: 'mixer.setLoudness', enabled: normalise, targetLufs: -14, truePeakDb: -1 },
			]);
			const doc = fx.doc();
			const report = await check(doc);
			expect(report.loudness.layout).toBe('mono');
			const core = coreServices(app);
			const world = await audioWorld(doc, fx.b.seqId, core.registry);
			const scratch = mkdtempSync(join(tmpdir(), 'jasper-check-mono-'));
			const render = (outputLayout: 'mono' | 'stereo') =>
				renderMixdown({
					ff: core.ffmpeg,
					snapshot: world.snapshot,
					media: world.media,
					range: { start: 0, end: 300 },
					outputLayout,
					scratchDir: scratch,
					...(normalise ? { normalize: { targetLufs: -14, truePeakDb: -1 } } : { withoutLoudness: true }),
				});
			const mono = await render('mono');
			const stereo = await render('stereo');
			expect(report.loudness.integratedLufs!).toBeCloseTo(mono.loudness.integrated, 1);
			expect(report.loudness.truePeakDb!).toBeCloseTo(mono.loudness.truePeakDb, 1);
			if (!normalise) {
				// the stereo upmix (both channels) measures 3.01 LU louder
				expect(stereo.loudness.integrated - mono.loudness.integrated).toBeCloseTo(3.01, 1);
				expect(report.warnings.map((w) => w.code)).toContain('W_MONO_MIX');
			} else expect(report.warnings.map((w) => w.code)).not.toContain('W_MONO_MIX');
			for (const r of [mono, stereo]) await rm(r.path!, { force: true });
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

export type { SoundCheckIssue };
