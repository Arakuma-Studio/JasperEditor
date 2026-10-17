// Sound Check panel model additions (spec 12 §2.7 "Sound Check panel", P5-R3; wp-note "Phase 5 → WP5.2"): a custom
// delivery target (stored with the summary, part of the inputs hash, staleness), the listen-here verdict markers
// (`soundCheckHumanVerdicts` — what the panel writes and MCP `sound_check` reads back) and their hostile input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	createCounterIdSource,
	loadProject,
	makeEnvelope,
	mixFingerprint,
	readSoundCheckTarget,
	repairDocument,
	SOUND_CHECK_CUSTOM_LABEL,
	SOUND_CHECK_MODEL_STRINGS,
	SOUND_CHECK_VERDICT_MARKER,
	soundCheckHumanVerdicts,
	soundCheckInputsHash,
	soundCheckStatus,
	soundCheckVerdictMarkerName,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const target = { integratedLufs: -20, truePeakDb: -2 };

function summary(h: Harness, over: Record<string, unknown> = {}) {
	return {
		mixHash: mixFingerprint(h.doc, h.seqId),
		verdict: 'pass',
		counts: {},
		at: '2026-10-17T12:00:00.000Z',
		preset: 'web',
		target,
		inputsHash: soundCheckInputsHash(h.doc, h.seqId, 'web', target),
		jobId: 'job_custom',
		...over,
	};
}

describe('custom delivery target', () => {
	it('is part of the inputs hash only when given (preset hashes stored before stay valid)', () => {
		const h = new Harness();
		const preset = soundCheckInputsHash(h.doc, h.seqId, 'web');
		expect(soundCheckInputsHash(h.doc, h.seqId, 'web', null)).toBe(preset);
		expect(soundCheckInputsHash(h.doc, h.seqId, 'web', undefined)).toBe(preset);
		const custom = soundCheckInputsHash(h.doc, h.seqId, 'web', target);
		expect(custom).not.toBe(preset);
		expect(soundCheckInputsHash(h.doc, h.seqId, 'web', { ...target, truePeakDb: -1 })).not.toBe(custom);
	});

	it('setCheck stores it; the status is current with it and stale after a preset check of the same mix', () => {
		const h = new Harness();
		h.ok([{ type: 'soundDesign.setCheck', summary: summary(h) }], { label: 'Sound Check Result' });
		const st = soundCheckStatus(h.doc, h.seqId);
		expect(st).toMatchObject({ state: 'current', summary: { target } });
		// the summary of a custom check, judged as if the preset had been checked: inputs differ
		h.ok([
			{
				type: 'soundDesign.setCheck',
				summary: summary(h, { inputsHash: soundCheckInputsHash(h.doc, h.seqId, 'web') }),
			},
		]);
		expect(soundCheckStatus(h.doc, h.seqId)).toMatchObject({ state: 'stale', reasons: ['inputs'] });
	});

	it('refuses an out-of-range or malformed target', () => {
		const h = new Harness();
		const code = (t: unknown) => {
			const r = h.tx([{ type: 'soundDesign.setCheck', summary: summary(h, { target: t }) }]);
			return r.ok ? 'ok' : r.errors[0]!.code;
		};
		expect(code({ integratedLufs: -60, truePeakDb: -1 })).toBe('E_SCHEMA');
		expect(code({ integratedLufs: -14, truePeakDb: 1 })).toBe('E_SCHEMA');
		expect(code({ integratedLufs: -14 })).toBe('E_SCHEMA');
		expect(code({ integratedLufs: -14, truePeakDb: -1, x: 1 })).toBe('E_SCHEMA');
		expect(code({ integratedLufs: -18, truePeakDb: -1.5 })).toBe('ok');
	});

	it('load keeps it; repair drops a summary whose target is damaged (idempotent)', () => {
		const h = new Harness();
		h.ok([{ type: 'soundDesign.setCheck', summary: summary(h) }]);
		const env = makeEnvelope(h.doc, { revision: 1, savedAt: '2026-10-17T00:00:00.000Z', platform: 'web' });
		const loaded = loadProject(JSON.parse(JSON.stringify(env)));
		const seq = loaded.document.sequences[h.seqId] as { soundDesign?: { lastCheck?: unknown } };
		expect(seq.soundDesign?.lastCheck).toMatchObject({ target });
		const bad = clone(h.doc);
		(
			bad.sequences[h.seqId] as { soundDesign: { lastCheck: { target: unknown } } }
		).soundDesign.lastCheck.target = { integratedLufs: 'loud' };
		const once = repairDocument(bad, createCounterIdSource(77)).document;
		expect(
			(once.sequences[h.seqId] as { soundDesign?: { lastCheck?: unknown } }).soundDesign?.lastCheck,
		).toBe(undefined);
		expect(repairDocument(once, createCounterIdSource(78)).document).toEqual(once);
	});

	it('readSoundCheckTarget: in range, rounded to 0.1, else null — never throws', () => {
		expect(readSoundCheckTarget({ integratedLufs: -18.04, truePeakDb: -1.46 })).toEqual({
			integratedLufs: -18,
			truePeakDb: -1.5,
		});
		for (const v of [
			null,
			1,
			'x',
			[],
			{},
			{ integratedLufs: Number.NaN, truePeakDb: -1 },
			{ integratedLufs: -14, truePeakDb: Number.POSITIVE_INFINITY },
			{ integratedLufs: -41, truePeakDb: -1 },
		])
			expect(readSoundCheckTarget(v)).toBeNull();
		fc.assert(
			fc.property(fc.anything(), (v) => {
				const r = readSoundCheckTarget(v);
				return r === null || (r.integratedLufs >= -40 && r.integratedLufs <= -5 && r.truePeakDb <= 0);
			}),
			{ numRuns: 300 },
		);
	});

	it('its label is a model string (translated by the editor)', () => {
		expect(SOUND_CHECK_MODEL_STRINGS).toContain(SOUND_CHECK_CUSTOM_LABEL);
	});
});

describe('listen-here verdict markers', () => {
	it('reads the user’s comment markers with the verdict names, in frame order, with the note', () => {
		const h = new Harness();
		h.ok([
			{
				type: 'marker.add',
				frame: 90,
				name: soundCheckVerdictMarkerName('flag'),
				markerType: 'comment',
				comment: '  the hit is late  ',
			},
			{ type: 'marker.add', frame: 30, name: SOUND_CHECK_VERDICT_MARKER.ok, markerType: 'comment' },
			// not verdicts: another name, another type
			{ type: 'marker.add', frame: 40, name: 'Sound Check: maybe', markerType: 'comment' },
			{ type: 'marker.add', frame: 50, name: SOUND_CHECK_VERDICT_MARKER.ok, markerType: 'chapter' },
		]);
		const v = soundCheckHumanVerdicts(h.seq);
		expect(v.map(({ frame, verdict, note }) => ({ frame, verdict, note }))).toEqual([
			{ frame: 30, verdict: 'ok', note: null },
			{ frame: 90, verdict: 'flag', note: 'the hit is late' },
		]);
		expect(v.every((x) => h.seq.markers.some((m) => m.id === x.markerId && m.frame === x.frame))).toBe(true);
	});

	it('an agent-authored marker with a verdict name is not a human verdict', () => {
		const h = new Harness();
		h.ok([{ type: 'marker.add', frame: 10, name: SOUND_CHECK_VERDICT_MARKER.ok, markerType: 'comment' }], {
			origin: { agent: 'sound-agent' },
		});
		expect(soundCheckHumanVerdicts(h.seq)).toEqual([]);
	});

	it('never throws on hostile sequences', () => {
		fc.assert(
			fc.property(fc.anything(), (v) => Array.isArray(soundCheckHumanVerdicts(v))),
			{ numRuns: 300 },
		);
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.oneof(fc.string(), fc.integer()),
						frame: fc.oneof(fc.integer(), fc.double()),
						name: fc.constantFrom(SOUND_CHECK_VERDICT_MARKER.ok, SOUND_CHECK_VERDICT_MARKER.flag, 'x'),
						type: fc.constantFrom('comment', 'chapter'),
						author: fc.oneof(fc.constant('user'), fc.anything()),
						comment: fc.anything(),
					}),
					{ maxLength: 20 },
				),
				(markers) => {
					const out = soundCheckHumanVerdicts({ markers });
					return out.every((x) => Number.isInteger(x.frame) && x.frame >= 0);
				},
			),
			{ numRuns: 300 },
		);
	});
});
