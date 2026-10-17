// Fix all safe and a single Fix judge the safe fixes together on the document as it is now (`planSoundCheckFixes`;
// wp-note "WP6.5b → Sound Check"): a hero demoted with its own Fix, then Fix all safe with the hero-solved gain of the
// same report — that gain would put the support over its bed cap, so it is left for the next check; with normalisation
// off two gains that each keep the mix under the true-peak ceiling but not together — the second is left; a single
// Fix of a fix that is no longer safe asks first, with why.
import type { SoundCheckIssue, SoundCheckReport, SoundCheckResult } from '@jasper/api';
import {
	type LibraryProvenance,
	type Sequence,
	SOUND_CHECK_MESSAGES,
	type SoundCheckLevelModel,
	soundCheckMessage,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { resultFixture } from '../../mcp/test/sound-check-report-fixture.ts';
import { applyCheckFix, type CheckEngine, fixAllSafe, soundCheckStore } from '../src/sound/check-run.ts';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const LIB = (soundId: string, title: string): LibraryProvenance => ({
	soundId,
	title,
	types: ['hit'],
	source: { type: 'starter' },
	license: 'CC0-1.0',
	licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
	author: 'Kenney',
	sourceUrl: 'https://kenney.nl/assets/impact-sounds',
	attribution: null,
	descriptors: {
		peakSec: 0.0123,
		onsetSec: 0.011,
		headQuietSec: 0.0105,
		durationSec: 0.9,
		octaveBandsDb: [-30, -25, -20, -18, -19, -24, -33],
		centroidHz: 1820,
		maxMomentaryLufs: -14.2,
	},
	snapshotHash: 'sha256:abc',
});

/** Two heroes at 40 and 85 (B is 1.5 s after A), library sounds; the Mix normalises or not. */
function fixture(normalise: boolean) {
	const { session, seqId } = makeSession();
	const ok = (commands: unknown[]) => {
		const r = session.apply({ label: 'setup', origin: 'user', sequenceId: seqId, commands: commands as never[] });
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const reg = ok([
		{ type: 'media.register', asset: { ...audioAsset(1), library: LIB('snd_00000000000000a1', 'Hit A') }, ref: '$a' },
		{ type: 'media.register', asset: { ...audioAsset(1), library: LIB('snd_00000000000000b2', 'Hit B') }, ref: '$b' },
		{
			type: 'soundCue.add',
			cues: [
				{ frame: 40, kind: 'cut', weight: 'hero', source: 'user', ref: '$ca' },
				{ frame: 85, kind: 'cut', weight: 'hero', source: 'user', ref: '$cb' },
			],
		},
		{ type: 'soundDesign.place', cueId: '$ca', layers: [{ mediaId: '$a', role: 'hero', track: 'A1', ref: '$xa' }] },
		{ type: 'soundDesign.place', cueId: '$cb', layers: [{ mediaId: '$b', role: 'hero', track: 'A2', ref: '$xb' }] },
		{ type: 'mixer.setLoudness', enabled: normalise, targetLufs: -14, truePeakDb: -1 },
	]);
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const ids = { clipA: reg.refs.$xa!, clipB: reg.refs.$xb!, cueB: reg.refs.$cb! };
	const gain = (id: string) => (seq().clips[id] as unknown as { gainDb: number }).gainDb;
	const engine = {
		async soundCheck() {
			throw new Error('no re-run in this test');
		},
		async registerSound() {
			throw new Error('no swaps in this test');
		},
	} as unknown as CheckEngine;
	return { session, seqId, seq, ids, gain, engine };
}

const model = (clipId: string, gainDb: number, o: Partial<SoundCheckLevelModel>): SoundCheckLevelModel => ({
	clipId,
	title: clipId === 'x' ? 'x' : `Hit ${clipId.slice(-1)}`,
	gainDb,
	liftAt0Db: 10 - gainDb,
	peakOverBedAt0Lu: 0 - gainDb,
	truePeakAt0Db: -20 - gainDb,
	mixTruePeakDb: null,
	start: 0,
	end: 300,
	speech: false,
	...o,
});

function report(
	f: ReturnType<typeof fixture>,
	issues: SoundCheckIssue[],
	levels: SoundCheckLevelModel[],
): SoundCheckResult {
	const base = resultFixture({ projectId: f.session.projectId, sequenceId: f.seqId });
	const r: SoundCheckReport = {
		...base.report,
		issues,
		levelGuard: {
			ceilingDb: -1,
			eventCeilingDb: -1,
			bedCapLu: { hero: 10, support: 6, ambient: 6 },
			capToleranceLu: 0.5,
			levels,
		},
	};
	return { ...base, report: r };
}
const gainIssue = (
	f: ReturnType<typeof fixture>,
	code: 'MASKED' | 'OVERLOAD',
	clipId: string,
	db: number,
): SoundCheckIssue => ({
	id: `${code}:${clipId}`,
	code,
	severity: 'warning',
	category: 'mix',
	frame: 85,
	clipIds: [clipId],
	message: soundCheckMessage('overloadBed', 'Hit', '00:00:02:25', 12, 10),
	fix: {
		kind: 'commands',
		label: soundCheckMessage('fixGain', db),
		safe: true,
		tool: 'apply_commands',
		args: {},
		commands: [{ type: 'soundDesign.applyGains', sequenceId: f.seqId, gains: { [clipId]: db } }],
	},
});
const demoteIssue = (f: ReturnType<typeof fixture>): SoundCheckIssue => ({
	id: `DENSITY:${f.ids.cueB}`,
	code: 'DENSITY',
	severity: 'warning',
	category: 'cues',
	frame: 85,
	cueId: f.ids.cueB,
	message: soundCheckMessage('densityHeroes', 1.5, '00:00:01:10', '00:00:02:25', 2, 'balanced'),
	fix: {
		kind: 'commands',
		label: soundCheckMessage('fixDemote'),
		safe: true,
		tool: 'apply_commands',
		args: {},
		commands: [
			{ type: 'soundCue.update', cueId: f.ids.cueB, weight: 'support' },
			{ type: 'soundDesign.setRole', clipIds: [f.ids.clipB], role: 'support' },
		],
	},
});

describe('Fix all safe judges the safe fixes together', () => {
	it('after the hero was demoted with its own Fix, its hero-solved gain is left for the next check', async () => {
		const f = fixture(true);
		const gB = f.gain(f.ids.clipB);
		// B peaks 12 LU over the bed as a hero (OVERLOAD, solved to 10); demoted it drops to its support default (−6 dB)
		const result = report(
			f,
			[gainIssue(f, 'OVERLOAD', f.ids.clipB, gB - 2), demoteIssue(f)],
			[model(f.ids.clipB, gB, { peakOverBedAt0Lu: 12 - gB })],
		);
		soundCheckStore(f.session).setState({ result, jobId: 'job_1', fixed: [] });
		// the demotion alone is safe: one Fix, no question
		const asked: string[] = [];
		const one = await applyCheckFix(f.session, f.engine, result.report.issues[1]!, {
			confirm: async (o) => {
				asked.push(o.body);
				return false;
			},
		});
		expect(asked).toEqual([]);
		expect(one.ok).toBe(true);
		expect(f.gain(f.ids.clipB)).toBeCloseTo(gB - 6, 6);
		// Fix all safe: the remaining safe fix (the hero-solved gain) would leave the support 4 LU over its cap
		const labels = f.session.getState().history.entries.length;
		const all = await fixAllSafe(f.session, f.engine, { rerun: false });
		expect(all.applied).toEqual([]);
		expect(all.skipped).toEqual([`OVERLOAD:${f.ids.clipB}`]);
		expect(all.message).toContain('left for the next check');
		expect(all.message).toContain('4.0 LU over the bed');
		expect(f.session.getState().history.entries.length).toBe(labels);
		expect(f.gain(f.ids.clipB)).toBeCloseTo(gB - 6, 6);
		// its single Fix asks first, saying why
		const again = await applyCheckFix(f.session, f.engine, result.report.issues[0]!, {
			confirm: async (o) => {
				asked.push(o.body);
				return false;
			},
		});
		expect(again.declined).toBe(true);
		expect(asked[0]).toContain('4.0 LU over the bed');
		expect(f.gain(f.ids.clipB)).toBeCloseTo(gB - 6, 6);
	});

	it('normalisation off: two gains each under the true-peak ceiling but not together: the second is left', async () => {
		const f = fixture(false);
		const gA = f.gain(f.ids.clipA);
		const gB = f.gain(f.ids.clipB);
		const span = { start: 40, end: 100, mixTruePeakDb: -4 };
		const result = report(
			f,
			[gainIssue(f, 'MASKED', f.ids.clipA, gA + 4), gainIssue(f, 'MASKED', f.ids.clipB, gB + 4)],
			[
				model(f.ids.clipA, gA, { ...span, liftAt0Db: 1 - gA, truePeakAt0Db: -9 - gA }),
				model(f.ids.clipB, gB, { ...span, liftAt0Db: 1 - gB, truePeakAt0Db: -9 - gB }),
			],
		);
		soundCheckStore(f.session).setState({ result, jobId: 'job_1', fixed: [] });
		const n = f.session.getState().history.entries.length;
		const all = await fixAllSafe(f.session, f.engine, { rerun: false });
		expect(all.applied).toEqual([`MASKED:${f.ids.clipA}`]);
		expect(all.skipped).toEqual([`MASKED:${f.ids.clipB}`]);
		expect(f.session.getState().history.entries.slice(n).map((e) => e.label)).toEqual(['Fix 1 Sound Check Finding']);
		expect(f.gain(f.ids.clipA)).toBeCloseTo(gA + 4, 6);
		expect(f.gain(f.ids.clipB)).toBeCloseTo(gB, 6);
		expect(soundCheckStore(f.session).getState().fixed).toEqual([`MASKED:${f.ids.clipA}`]);
		// the reason is the translated template
		expect(all.message).toContain('the mix where');
		expect(SOUND_CHECK_MESSAGES.whyFixMixPeak).toContain('{1} dBTP');
	});
});
