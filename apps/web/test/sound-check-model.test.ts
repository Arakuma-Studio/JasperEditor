// Sound Check input validation, fix planning, verdict binding, translation and codec-aware summaries (spec 12 §2.6).
import type { SoundCheckIssue } from '@jasper/api';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type Sequence,
	SOUND_CHECK_UNMEASURED,
	SOUND_CHECK_VERDICT_MARKER,
	soundCheckHumanVerdicts,
	soundCheckMessage,
} from '@jasper/project';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { videoAsset } from '../../../packages/project/test/helpers.ts';
import { reportFixture } from '../../mcp/test/sound-check-report-fixture.ts';
import { exportAudioOf } from '../src/export/SoundCheckGate.tsx';
import { setLanguage } from '../src/i18n/runtime.ts';
import {
	defaultChoice,
	fixWhyText,
	isSequenceTarget,
	listenRows,
	messageText,
	parseCustomTarget,
	planFixes,
	safeFixable,
	sequenceTargetCommands,
	summaryChips,
	verdictCommands,
	verdictStaleText,
} from '../src/sound/check-model.ts';

afterEach(() => setLanguage('en'));

function doc() {
	const ids = createCounterIdSource(3);
	let d: ProjectDocument = createEmptyProject({ ids, name: 'M', preset: 'hd-1080p-30' });
	const seqId = Object.keys(d.sequences)[0]!;
	const tx = (commands: unknown[]) => {
		const r = applyTransaction(
			d,
			{ protocol: 'jasper.tx/1', label: 'x', origin: 'user', sequenceId: seqId, commands } as never,
			{ ids, now: () => '2026-10-17T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
		);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		d = r.document;
	};
	return { seq: () => d.sequences[seqId] as Sequence, doc: () => d, seqId, tx };
}

const report = () => reportFixture({ projectId: 'prj_x', sequenceId: 'seq_x' });

describe('listen-here reasons in the UI language', () => {
	it('the worst moment says its finding translated, not the English text it quotes', async () => {
		await setLanguage('es');
		const rows = listenRows(report(), undefined);
		const worst = rows.find((r) => r.slot === 'worst')!;
		expect(worst.text).toContain('corte');
		expect(worst.text).not.toContain('late on its');
		expect(worst.text).not.toContain('Worst finding');
	});
});

describe('why a fix needs judgement, and unmeasured reasons, in the UI language', () => {
	it('fixWhyText translates the engine message (else its English text); unmeasured reasons are translated', async () => {
		await setLanguage('es');
		const fix = {
			kind: 'commands' as const,
			label: soundCheckMessage('fixSilenceCue'),
			safe: false,
			why: 'Only if the silence is intended',
			whyMessage: soundCheckMessage('whySilence'),
			tool: 'apply_commands',
			args: {},
		};
		expect(fixWhyText(fix)).toBeTruthy();
		expect(fixWhyText(fix)).not.toBe(fix.why);
		const { whyMessage: _w, ...old } = fix;
		expect(fixWhyText(old)).toBe('Only if the silence is intended');
		expect(fixWhyText(undefined)).toBeNull();
		const duck = soundCheckMessage('whyDuckDepth', 6, 5.2);
		const duckReason = fixWhyText({ ...fix, why: duck.text, whyMessage: duck });
		expect(duckReason).not.toBe(duck.text);
		for (const value of ['6', '5.2']) expect(duckReason).toContain(value);
		// WP6.5a: the solver's English reason in "The solver's gain does not resolve it: {0}" is said from the fix's
		// own gain report instead
		const solver = soundCheckMessage('whySolverGain', 'limited by dialogue A1 (the speech band)');
		const gainFix = {
			...fix,
			why: solver.text,
			whyMessage: solver,
			commands: [
				{
					type: 'soundDesign.applyGains',
					gains: { clp_1: -6 },
					report: {
						clp_1: {
							targetLiftDb: 6,
							achievedLiftDb: 2,
							limitedBy: ['dialogue'],
							reason: 'limited by dialogue A1 (the speech band)',
						},
					},
				},
			] as never,
		};
		const gainReason = fixWhyText(gainFix);
		expect(gainReason).toContain('A1');
		expect(gainReason).not.toContain('limited by dialogue');
		expect(gainReason).not.toContain('(the speech band)');
		// without a report: the message as before
		expect(fixWhyText({ ...gainFix, commands: [] as never })).toContain(
			'limited by dialogue A1 (the speech band)',
		);
		const m = soundCheckMessage('syncUnmeasurable', 'Air whoosh', SOUND_CHECK_UNMEASURED.covered);
		expect(messageText(m)).not.toBe(m.text);
		expect(messageText(m)).not.toContain(SOUND_CHECK_UNMEASURED.covered);
		expect(messageText(m)).toContain('Air whoosh');
	});
});

describe('finding texts', () => {
	it('fills the template; cue kinds and densities become labels; Spanish translates the template', async () => {
		const m = soundCheckMessage('syncLate', 'Impact', 66.7, 'cut', '00:00:03:00', 1);
		await setLanguage('es');
		const es = messageText(m);
		expect(es).toContain('Impact');
		expect(es).toContain('66.7');
		expect(es).toContain('corte');
		expect(es).not.toBe(m.text);
	});

	it('falls back to the English text on malformed messages; never throws', () => {
		expect(messageText({ key: 3 as never, params: [], text: 'x' })).toBe('x');
		expect(messageText(null)).toBe('');
		fc.assert(
			fc.property(fc.anything(), (m) => typeof messageText(m as never) === 'string'),
			{ numRuns: 300 },
		);
	});
});

describe('fix plan', () => {
	it('safe only: commands of each fix together, one swap per clip, the jobs; the same fix twice once', () => {
		const r = report();
		const tp: SoundCheckIssue = {
			...r.issues.find((i) => i.code === 'LOUDNESS')!,
			id: 'TRUE_PEAK:mix',
			code: 'TRUE_PEAK',
		};
		const twice = [...r.issues, tp];
		const plan = planFixes(twice, { safeOnly: true });
		expect(plan.commands.map((c) => c.type)).toEqual(['clip.move', 'mixer.setLoudness']);
		expect(plan.swaps).toEqual([{ clipId: 'clp_b', soundId: 'snd_00000000000000b1' }]);
		expect(plan.jobs).toEqual([expect.objectContaining({ route: 'delivery' })]);
		expect(plan.units).toHaveLength(4);
		expect(plan.issueIds).toContain('TRUE_PEAK:mix');
		expect(plan.units.find((u) => u.issueIds.includes('TRUE_PEAK:mix'))!.issueIds).toEqual([
			'LOUDNESS:mix',
			'TRUE_PEAK:mix',
		]);
		// unsafe fixes only when asked for one by one
		expect(planFixes(twice, { safeOnly: false }).units).toHaveLength(5);
		expect(safeFixable(r.issues).map((i) => i.code)).toEqual([
			'OUT_OF_SYNC',
			'TRUNCATED',
			'LOUDNESS',
			'MUSIC_OVER_VOICE',
		]);
	});

	it('never throws on hostile findings; every unit points at an input finding (property)', () => {
		const issue = fc.record({
			id: fc.string(),
			code: fc.constantFrom('OUT_OF_SYNC', 'LOUDNESS', 'SILENCE'),
			severity: fc.constantFrom('error', 'warning', 'info'),
			category: fc.constantFrom('sync', 'mix'),
			message: fc.constant(soundCheckMessage('fixAlign')),
			fix: fc.option(
				fc.record({
					kind: fc.constantFrom('commands', 'job', 'swap'),
					label: fc.constant(soundCheckMessage('fixAlign')),
					safe: fc.boolean(),
					tool: fc.string(),
					args: fc.constant({}),
					commands: fc.option(fc.array(fc.record({ type: fc.string() }), { maxLength: 3 }), {
						nil: undefined,
					}),
					job: fc.option(
						fc.record({ route: fc.constantFrom('rebalance', 'delivery', 'x'), body: fc.object() }),
						{
							nil: undefined,
						},
					),
					swap: fc.option(fc.record({ clipId: fc.string(), soundId: fc.string() }), { nil: undefined }),
				}),
				{ nil: undefined },
			),
		});
		fc.assert(
			fc.property(fc.array(issue, { maxLength: 12 }), fc.boolean(), (list, safeOnly) => {
				const p = planFixes(list as SoundCheckIssue[], { safeOnly });
				const ids = new Set(list.map((i) => i.id));
				return p.units.every((u) => u.issueIds.every((id) => ids.has(id)));
			}),
			{ numRuns: 300 },
		);
	});
});

describe('delivery target', () => {
	it('defaults to the sequence preset; a stored custom check or a non-preset normalisation is custom', () => {
		const f = doc();
		expect(defaultChoice(f.seq())).toEqual({ kind: 'preset', preset: 'web' });
		f.tx([{ type: 'mixer.setLoudness', enabled: true, targetLufs: -18, truePeakDb: -1.5 }]);
		expect(defaultChoice(f.seq())).toEqual({
			kind: 'custom',
			target: { integratedLufs: -18, truePeakDb: -1.5 },
		});
		expect(isSequenceTarget(defaultChoice(f.seq()), f.seq())).toBe(true);
		f.tx(sequenceTargetCommands({ kind: 'preset', preset: 'podcast' }, f.seqId));
		expect(defaultChoice(f.seq())).toEqual({ kind: 'preset', preset: 'podcast' });
		expect(isSequenceTarget({ kind: 'preset', preset: 'podcast' }, f.seq())).toBe(true);
		expect(isSequenceTarget({ kind: 'preset', preset: 'web' }, f.seq())).toBe(false);
		expect(defaultChoice(undefined)).toEqual({ kind: 'preset', preset: 'web' });
	});

	it('custom fields: real minus and comma accepted, ranges refused with which field', () => {
		expect(parseCustomTarget('−18,5', '-1')).toEqual({
			ok: true,
			target: { integratedLufs: -18.5, truePeakDb: -1 },
		});
		expect(parseCustomTarget('', '-1')).toMatchObject({ ok: false, field: 'lufs' });
		expect(parseCustomTarget('-4', '-1')).toMatchObject({ ok: false, field: 'lufs' });
		expect(parseCustomTarget('-16', '0.5')).toMatchObject({ ok: false, field: 'tp' });
		expect(parseCustomTarget('-16', 'abc')).toMatchObject({ ok: false, field: 'tp' });
		fc.assert(
			fc.property(fc.string(), fc.string(), (a, b) => {
				const r = parseCustomTarget(a, b);
				return !r.ok || (r.target.integratedLufs <= -5 && r.target.integratedLufs >= -40);
			}),
			{ numRuns: 300 },
		);
	});
});

describe('verdict markers', () => {
	/** A 20 s clip on V1/A1 so listen frames are inside the sequence. */
	function withClip() {
		const f = doc();
		f.tx([{ type: 'media.register', asset: videoAsset({ seconds: 20 }), ref: '$m' }]);
		const media = Object.keys(f.doc().media)[0]!;
		f.tx([{ type: 'clip.place', source: { mediaId: media }, at: 0 }]);
		return f;
	}

	it('soundDesign.setVerdict: a user comment marker bound to the moment, updated on the same moment', () => {
		const f = withClip();
		const clipId = Object.values(f.seq().clips).find((c) => c.kind === 'audio')!.id;
		const cmds = verdictCommands(f.seq(), { frame: 90, slot: 'worst', clipId }, 'flag', '  late  ', 'mix123');
		expect(cmds).toEqual([
			{
				type: 'soundDesign.setVerdict',
				sequenceId: f.seqId,
				frame: 90,
				verdict: 'flag',
				note: 'late',
				slot: 'worst',
				clipId,
				reportMixHash: 'mix123',
			},
		]);
		f.tx(cmds);
		expect(soundCheckHumanVerdicts(f.seq())).toEqual([
			expect.objectContaining({
				frame: 90,
				verdict: 'flag',
				note: 'late',
				clipId,
				slot: 'worst',
				bound: true,
			}),
		]);
		// an older unbound verdict marker at 90 written by hand: the next verdict on the moment keeps one
		f.tx([{ type: 'marker.add', frame: 90, name: SOUND_CHECK_VERDICT_MARKER.ok, markerType: 'comment' }]);
		f.tx(verdictCommands(f.seq(), { frame: 90, slot: 'worst', clipId }, 'ok', ''));
		expect(soundCheckHumanVerdicts(f.seq())).toEqual([
			expect.objectContaining({ frame: 90, verdict: 'ok', note: null }),
		]);
		expect(f.seq().markers.filter((m) => m.frame === 90)).toHaveLength(1);
		// a clip that is gone since the report: the verdict binds to the frame's window only
		expect(
			verdictCommands(f.seq(), { frame: 90, clipId: 'clp_gone', cueId: 'cue_gone' }, 'ok', '')[0],
		).not.toHaveProperty('clipId');
	});

	it('listen rows carry the verdict of their moment; a verdict whose window changed is out of date', () => {
		const f = withClip();
		const audio = Object.values(f.seq().clips).find((c) => c.kind === 'audio')!;
		f.tx(verdictCommands(f.seq(), { frame: 91 }, 'ok', ''));
		let rows = listenRows(report(), f.seq(), f.doc());
		expect(rows.map((r) => [r.frame, r.verdict?.verdict ?? null])).toEqual([
			[90, null],
			[91, 'ok'],
			[120, null],
			[150, null],
			[270, null],
		]);
		expect(verdictStaleText(rows[1]!.verdict)).toBeNull();
		// the audio under the moment changes: out of date
		f.tx([{ type: 'audio.setGain', clipIds: [audio.id], mode: 'adjust', db: -6 }]);
		rows = listenRows(report(), f.seq(), f.doc());
		expect(rows[1]!.verdict).toMatchObject({ stale: true, staleReasons: ['moment'] });
		expect(verdictStaleText(rows[1]!.verdict)).toBe('Out of date: the sound here changed since you listened');
	});
});

describe('checked as an export encodes it (loudness.delivered)', () => {
	it('the chips show the decoded codec audio, the codec and the limiter ceiling in front of the encoder', () => {
		const base = report();
		const r = {
			...base,
			loudness: {
				...base.loudness,
				integratedLufs: -14.3,
				truePeakDb: -2.5,
				normalization: {
					...base.loudness.normalization,
					enabled: true,
					targetLufs: -14,
					truePeakDb: -1,
					limiterCeilingDb: -2.5,
					codecHeadroomDb: 1.5,
				},
				delivered: {
					codec: 'aac' as const,
					bitrateKbps: 128,
					sampleRate: 48000,
					integratedLufs: -14.0,
					truePeakDb: -1.3,
					truePeakMet: true,
				},
			},
		};
		const chips = Object.fromEntries(summaryChips(r).map((c) => [c.id, c]));
		expect(chips.integrated!.value).toBe('−14.0 LUFS');
		expect(chips.truePeak!.value).toBe('−1.3 dBTP');
		expect(chips.truePeak!.title).toContain('as AAC 128 kb/s decodes');
		expect(chips.truePeak!.title).toContain('limiter −2.5 dBTP in front of the encoder');
		// a PCM check (no delivered, the ceiling is the target): the titles stay as they were
		const pcm = Object.fromEntries(summaryChips(report()).map((c) => [c.id, c]));
		expect(pcm.truePeak!.title).toBe(`Ceiling ${report().preset.truePeakDb} dBTP`);
	});

	it('the Export dialog checks with the plan’s audio codec and bit rate', () => {
		expect(exportAudioOf('aac', { bitrateKbps: 256, sampleRate: 48000 })).toEqual({
			codec: 'aac',
			bitrateKbps: 256,
			sampleRate: 48000,
		});
		expect(exportAudioOf('libopus', { bitrateKbps: 160, sampleRate: 48000 })).toEqual({
			codec: 'opus',
			bitrateKbps: 160,
			sampleRate: 48000,
		});
		expect(exportAudioOf('pcm_s24le', { bitrateKbps: 1536, sampleRate: 44100 })).toEqual({
			codec: 'pcm',
			sampleRate: 44100,
		});
		expect(exportAudioOf(undefined, undefined)).toBeUndefined();
	});
});
