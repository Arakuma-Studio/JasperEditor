// WP5.2 Sound Check panel model (pure): translated finding texts (template keys + params; cue kinds translated), the
// grouping and order of the findings, the fix plan (duplicates once, swaps once per clip, safe only), the delivery
// target choice and what "Use as sequence target" writes, the custom target fields, the verdict marker commands, the
// sync strip geometry and waveform, and hostile input (never throws).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SoundCheckIssue } from '@jasper/api';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type Sequence,
	SOUND_CHECK_CUSTOM_LABEL,
	SOUND_CHECK_MESSAGES,
	SOUND_CHECK_UNMEASURED,
	SOUND_CHECK_VERDICT_MARKER,
	soundCheckHumanVerdicts,
	soundCheckMessage,
} from '@jasper/project';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { videoAsset } from '../../../packages/project/test/helpers.ts';
import { reportFixture } from '../../mcp/test/sound-check-report-fixture.ts';
import { __setCatalogForTests } from '../src/i18n/runtime.ts';
import {
	defaultChoice,
	fixWhyText,
	groupIssues,
	isSequenceTarget,
	listenRows,
	messageText,
	orderedIssues,
	parseCustomTarget,
	planFixes,
	safeFixable,
	sequenceTargetCommands,
	staleText,
	summaryChips,
	verdictCommands,
	verdictSentence,
	verdictStaleText,
} from '../src/sound/check-model.ts';
import { stripGeometry, wavePath } from '../src/sound/SyncStrip.tsx';

const root = join(__dirname, '../../..');
const ES = JSON.parse(readFileSync(join(root, 'apps/web/src/i18n/es.json'), 'utf8')) as Record<
	string,
	string
>;
const NAMES = JSON.parse(
	readFileSync(join(root, 'apps/web/src/i18n/model-strings.json'), 'utf8'),
) as string[];
afterEach(() => __setCatalogForTests('en', null));

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
	it('the worst moment says its finding translated, not the English text it quotes', () => {
		__setCatalogForTests('es', ES, NAMES);
		const rows = listenRows(report(), undefined);
		const worst = rows.find((r) => r.slot === 'worst')!;
		expect(worst.text).toContain('corte');
		expect(worst.text).not.toContain('late on its');
		expect(worst.text).not.toContain('Worst finding');
	});
});

describe('why a fix needs judgement, and unmeasured reasons, in the UI language', () => {
	it('fixWhyText translates the engine message (else its English text); unmeasured reasons are translated', () => {
		__setCatalogForTests('es', ES, NAMES);
		const fix = {
			kind: 'commands' as const,
			label: soundCheckMessage('fixSilenceCue'),
			safe: false,
			why: 'Only if the silence is intended',
			whyMessage: soundCheckMessage('whySilence'),
			tool: 'apply_commands',
			args: {},
		};
		expect(fixWhyText(fix)).toBe('Solo si el silencio es intencionado');
		const { whyMessage: _w, ...old } = fix;
		expect(fixWhyText(old)).toBe('Only if the silence is intended');
		expect(fixWhyText(undefined)).toBeNull();
		const duck = soundCheckMessage('whyDuckDepth', 6, 5.2);
		expect(fixWhyText({ ...fix, why: duck.text, whyMessage: duck })).toBe(
			'Atenuar 6 dB deja la música 5.2 LU por debajo de la voz',
		);
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
		expect(fixWhyText(gainFix)).toBe('La ganancia del solucionador no lo resuelve: limitado por diálogo A1');
		// without a report: the message as before
		expect(fixWhyText({ ...gainFix, commands: [] as never })).toBe(
			'La ganancia del solucionador no lo resuelve: limited by dialogue A1 (the speech band)',
		);
		const m = soundCheckMessage('syncUnmeasurable', 'Air whoosh', SOUND_CHECK_UNMEASURED.covered);
		expect(messageText(m)).toContain('otros sonidos lo tapan');
		expect(messageText(m)).toContain('Air whoosh');
	});
});

describe('every Sound Check message key is translated', () => {
	it('each finding / fix / listen template and the custom label is a model string with a Spanish text (same placeholders)', () => {
		const ph = (x: string) =>
			[...x.matchAll(/\{(\d+)\}/g)]
				.map((m) => m[1])
				.sort()
				.join();
		const keys = [
			...Object.values(SOUND_CHECK_MESSAGES),
			...Object.values(SOUND_CHECK_UNMEASURED),
			SOUND_CHECK_CUSTOM_LABEL,
		];
		expect(keys.length).toBeGreaterThan(50);
		expect(keys.filter((k) => !NAMES.includes(k))).toEqual([]);
		expect(keys.filter((k) => typeof ES[k] !== 'string' || !ES[k]!.trim())).toEqual([]);
		expect(keys.filter((k) => ph(k) !== ph(ES[k]!))).toEqual([]);
	});
});

describe('finding texts', () => {
	it('fills the template; cue kinds and densities become labels; Spanish translates the template', () => {
		const m = soundCheckMessage('syncLate', 'Impact', 66.7, 'cut', '00:00:03:00', 1);
		expect(messageText(m)).toBe(
			'Impact plays 66.7 ms late on its cut cue at 00:00:03:00 (tolerance ±1 frames)',
		);
		__setCatalogForTests('es', ES, NAMES);
		const es = messageText(m);
		expect(es).toContain('Impact');
		expect(es).toContain('66.7');
		expect(es).toContain('corte');
		expect(es).not.toBe(m.text);
		expect(messageText(soundCheckMessage('fixAlign'))).toBe(ES['Align its peak to the cue']);
	});

	it('falls back to the English text on malformed messages; never throws', () => {
		expect(messageText({ key: 3 as never, params: [], text: 'x' })).toBe('x');
		expect(messageText(null)).toBe('');
		fc.assert(
			fc.property(fc.anything(), (m) => typeof messageText(m as never) === 'string'),
			{ numRuns: 300 },
		);
	});

	it('summary chips, verdict sentence and the stale line', () => {
		const r = report();
		const chips = Object.fromEntries(summaryChips(r).map((c) => [c.id, c.value]));
		expect(chips).toMatchObject({
			integrated: '−17.2 LUFS',
			truePeak: '−2.1 dBTP',
			lra: '6.3 LU',
			errors: '1',
			warnings: '4',
		});
		expect(verdictSentence('fail', { error: 1, warning: 2 })).toBe('Sound Check Fail: 1 error, 2 warnings');
		expect(staleText({ state: 'current', reasons: [] })).toBeNull();
		expect(staleText({ state: 'stale', reasons: ['mix', 'preset'] })).toBe(
			'Stale: the mix changed, the delivery target changed since this check',
		);
	});
});

describe('grouping', () => {
	it('categories in the panel order, errors first, then time; the list order follows', () => {
		const r = report();
		expect(groupIssues(r.issues).map((g) => [g.category, g.issues.map((i) => i.code)])).toEqual([
			['sync', ['OUT_OF_SYNC', 'TRUNCATED']],
			['loudness', ['LOUDNESS']],
			['mix', ['MUSIC_OVER_VOICE', 'SILENCE']],
		]);
		expect(orderedIssues(r.issues).map((i) => i.code)).toEqual([
			'OUT_OF_SYNC',
			'TRUNCATED',
			'LOUDNESS',
			'MUSIC_OVER_VOICE',
			'SILENCE',
		]);
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

describe('sync strip', () => {
	it('5 frames around the cue; the picture line at the cue, the measured line after it for a late sound', () => {
		const f = doc();
		const g = stripGeometry(f.seq(), 90, 66.7, 300);
		expect(g.frames).toEqual([88, 89, 90, 91, 92]);
		expect(g.range).toEqual({ start: 81, end: 100 });
		expect(g.eventX).toBeCloseTo(9 / 19, 5);
		expect(g.measuredX!).toBeCloseTo((9 + 2.001) / 19, 3);
		expect(stripGeometry(f.seq(), 1, null, 300)).toMatchObject({ frames: [0, 1, 2, 3], measuredX: null });
		expect(stripGeometry(f.seq(), 299, -10, 300).frames).toEqual([297, 298, 299]);
	});

	it('the waveform path is closed and inside the box; empty input draws nothing; hostile numbers never throw', () => {
		expect(wavePath([], 100, 50)).toBe('');
		const p = wavePath([-60, -6, Number.NaN, 0, 12], 100, 50);
		expect(p.startsWith('M')).toBe(true);
		expect(p.endsWith('Z')).toBe(true);
		const nums = [...p.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => [
			Number(m[1]),
			Number(m[2]),
		]);
		expect(nums.every(([x, y]) => x! >= 0 && x! <= 100 && y! >= 0 && y! <= 50)).toBe(true);
		fc.assert(
			fc.property(
				fc.array(fc.double()),
				fc.integer({ min: -5, max: 2000 }),
				(a, w) => typeof wavePath(a, w, 40) === 'string',
			),
			{ numRuns: 300 },
		);
	});
});
