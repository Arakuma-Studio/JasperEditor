// Clean Up review model (spec 14 TC-040…TC-043): decisions per item / kind / retake, the word marks (what the plan
// cuts, coloured by why; review; lexical fillers), the grouped and virtualised findings list, navigation, the timeline
// bands, the derived previews' commands, the scope, staleness, and the settings drawer covering every setting with its
// bounds and units.
import {
	analyzeSequenceCleanup,
	type CleanupAnalysis,
	CleanupSettingsSchema,
	FAST_SETTINGS,
	sequenceWords,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	analysisInputsChanged,
	chooseTake,
	decideItem,
	decideKind,
	EMPTY_DECISIONS,
	findingAccepted,
	groupFindings,
	inlineFindings,
	KIND_LABELS,
	KIND_ORDER,
	listLayout,
	overlayBands,
	reasonText,
	removedPreview,
	resultPreview,
	scopeOf,
	stepFinding,
	toCleanupDecisions,
	visibleEntries,
	wordMarks,
} from '../src/panels/text/cleanup/model.ts';
import { parseFieldValue, SETTING_FIELDS, showFieldValue } from '../src/panels/text/cleanup/settings-fields.ts';
import { cleanupSession, fakeCleanupEngine, REC, seqOf } from './cleanup-helpers.ts';

function analysed(decisions = EMPTY_DECISIONS) {
	const engine = fakeCleanupEngine();
	const { session, seqId } = cleanupSession(engine.client);
	const seq = seqOf(session, seqId);
	const doc = session.getCommitted();
	const a = analyzeSequenceCleanup({
		doc,
		seq,
		voice: () => REC.voice,
		decisions: toCleanupDecisions(decisions),
	}) as CleanupAnalysis;
	if (!a.ok) throw new Error('analysis refused');
	return { session, seq, doc, a };
}

describe('Clean Up review model', () => {
	it('decisions: item over kind, kind clears its items, retake choices, persisted rejections', () => {
		const { a } = analysed();
		const f = a.findings.find((x) => x.suggested === 'remove')!;
		const none = new Set<string>();
		expect(findingAccepted(f, EMPTY_DECISIONS, none)).toBe(true);
		let d = decideItem(EMPTY_DECISIONS, f.id, 'reject');
		expect(findingAccepted(f, d, none)).toBe(false);
		d = decideKind(d, f.kind, 'accept', a.findings);
		expect(d.reject).not.toContain(f.id);
		expect(findingAccepted(f, d, none)).toBe(true);
		d = decideItem(d, f.id, 'reject');
		expect(findingAccepted(f, d, none)).toBe(false); // the item wins over its kind
		d = decideItem(d, f.id, 'clear');
		expect(findingAccepted(f, d, none)).toBe(true);
		expect(findingAccepted(f, EMPTY_DECISIONS, new Set([f.fingerprint]))).toBe(false);
		expect(chooseTake(EMPTY_DECISIONS, 'g0', 1).retakes).toEqual({ g0: 1 });
		expect(toCleanupDecisions(EMPTY_DECISIONS)).toEqual({});
	});

	it('marks exactly the words the plan removes, coloured by the accepted finding; review and lexical words', () => {
		const { a, seq, doc } = analysed();
		const words = sequenceWords(doc, seq);
		const marks = wordMarks(words, seq, a, EMPTY_DECISIONS, new Set());
		expect(marks).toHaveLength(words.length);
		const F = 705_600_000 / 30;
		words.forEach((w, i) => {
			const mid = Math.floor((w.start + (w.end - w.start) / 2) / F);
			const inRange = a.plan.ranges.some((r) => r.start <= mid && mid < r.end);
			expect(marks[i]!.removed, w.text).toBe(inRange);
		});
		const removed = marks.filter((m) => m.removed);
		expect(removed.length).toBeGreaterThan(5);
		expect(removed.every((m) => m.kind !== null)).toBe(true);
		const kinds = new Set(removed.map((m) => m.kind));
		for (const k of ['retake', 'false-start', 'filler-vocalic', 'off-script']) expect(kinds).toContain(k);
		// the truth of the synthetic recording: words to keep are not struck
		const kept = words.map((w, i) => ({ w, m: marks[i]! })).filter(({ w }) => REC.words[w.index]!.keep);
		expect(kept.filter(({ m }) => m.removed).length).toBeLessThanOrEqual(1);
		// a pause finding lies between words: it is shown inline, before the next word
		const inline = inlineFindings(words, seq, a);
		const n = [...inline.before.values()].flat().length + inline.after.length;
		expect(n).toBe(a.findings.filter((f) => !f.words).length);
	});

	it('groups findings by kind in the list order with counts, a virtualised layout and wrapping navigation', () => {
		const { a } = analysed();
		const groups = groupFindings(a, EMPTY_DECISIONS, new Set());
		expect(groups.map((g) => g.kind)).toEqual(KIND_ORDER.filter((k) => a.findings.some((f) => f.kind === k)));
		expect(groups.reduce((s, g) => s + g.findings.length, 0)).toBe(a.findings.length);
		for (const g of groups) expect(g.accepted).toBe(g.findings.filter((f) => f.suggested === 'remove').length);
		const layout = listLayout(groups, new Set([groups[0]!.kind]), { header: 24, row: 33 });
		expect(layout.order).toHaveLength(a.findings.length - groups[0]!.findings.length);
		expect(layout.total).toBe(groups.length * 24 + layout.order.length * 33);
		const v = visibleEntries(layout, 0, 100, 0);
		expect(v.start).toBe(0);
		expect(v.end).toBeLessThanOrEqual(5);
		expect(stepFinding(layout.order, null, 1)).toBe(layout.order[0]);
		expect(stepFinding(layout.order, layout.order[0]!, -1)).toBe(layout.order.at(-1));
		expect(stepFinding([], null, 1)).toBeNull();
		for (const f of a.findings) expect(reasonText(f).length).toBeGreaterThan(3);
		for (const k of KIND_ORDER) expect(KIND_LABELS[k]).toBeTruthy();
	});

	it('visible entries cover the viewport for any scroll position (fast-check)', () => {
		const { a } = analysed();
		const layout = listLayout(groupFindings(a, EMPTY_DECISIONS, new Set()), new Set(), { header: 20, row: 30 });
		fc.assert(
			fc.property(fc.integer({ min: 0, max: layout.total }), fc.integer({ min: 1, max: 400 }), (top, h) => {
				const { start, end } = visibleEntries(layout, top, h, 0);
				for (let i = 0; i < layout.entries.length; i++) {
					const e = layout.entries[i]!;
					const height = e.type === 'header' ? 20 : 30;
					const overlaps = e.top < top + h && e.top + height > top;
					if (overlaps) expect(i >= start && i < end).toBe(true);
				}
			}),
			{ numRuns: 200 },
		);
	});

	it('timeline bands: every cut, and padding / kept pauses only inside kept pieces on the speech track', () => {
		const { a, seq } = analysed();
		const bands = overlayBands(seq, a, () => REC.voice);
		expect(bands.cuts).toHaveLength(a.plan.ranges.length);
		const audioTrack = seq.audioTracks[0]!.id;
		for (const b of [...bands.padding, ...bands.pauses]) {
			expect(b.trackId).toBe(audioTrack);
			expect(a.plan.kept.some((k) => k.start <= b.start + 1e-6 && b.end <= k.end + 1e-6)).toBe(true);
			expect(b.end).toBeGreaterThan(b.start);
		}
		expect(overlayBands(seq, a, () => null).padding).toEqual([]);
	});

	it('derived previews: the result is the plan; "removed" keeps only the removed ranges', () => {
		const { a, seq } = analysed();
		const r = resultPreview(seq, a)!;
		expect(r.omitted).toEqual(a.plan.ranges.map((x) => [x.start, x.end]));
		expect(r.commands[0]).toMatchObject({ type: 'cleanup.apply', mode: 'extract', fadeMs: 4 });
		const m = removedPreview(seq, a)!;
		// keep ranges are the complement of the removed ones
		const removedFrames = a.plan.ranges.reduce((s, x) => s + x.end - x.start, 0);
		const omittedFrames = m.omitted.reduce((s, [x, y]) => s + y - x, 0);
		const len = Math.max(...Object.values(seq.clips).map((c) => c.start + c.duration));
		expect(omittedFrames + removedFrames).toBe(len);
		expect(m.start).toBe(a.plan.ranges[0]!.start);
	});

	it('scope and staleness', () => {
		const { session, seq, doc } = analysed();
		expect(scopeOf(seq, 'sequence', [])).toEqual({ ok: true, scope: {} });
		expect(scopeOf(seq, 'inout', []).ok).toBe(false);
		expect(scopeOf({ inPoint: 10, outPoint: 50 }, 'inout', [])).toEqual({ ok: true, scope: { range: { from: 10, to: 50 } } });
		expect(scopeOf(seq, 'clips', []).ok).toBe(false);
		expect(scopeOf(seq, 'clips', ['clp_x'])).toEqual({ ok: true, scope: { clipIds: ['clp_x'] } });
		// settings changes are not staleness; clip edits are
		session.apply({
			label: 'settings',
			origin: 'user',
			sequenceId: seq.id,
			commands: [{ type: 'cleanup.configure', settings: { presetId: 'builtin.natural' } }] as never[],
		});
		expect(analysisInputsChanged(doc, session.getCommitted(), seq.id)).toBe(false);
		session.apply({
			label: 'cut',
			origin: 'user',
			sequenceId: seq.id,
			commands: [{ type: 'range.extract', from: 0, to: 5 }] as never[],
		});
		expect(analysisInputsChanged(doc, session.getCommitted(), seq.id)).toBe(true);
	});

	it('the settings drawer shows every setting of the schema within its bounds, with units', () => {
		const g0 = CleanupSettingsSchema.shape;
		const shapes = {
			rules: g0.rules.shape,
			thresholds: g0.thresholds.shape,
			edges: g0.edges.shape,
			gaps: g0.gaps.shape,
			guards: g0.guards.shape,
			joins: g0.joins.shape,
		};
		for (const [g, shape] of Object.entries(shapes)) {
			const keys = SETTING_FIELDS.filter((f) => f.group === g).map((f) => f.key);
			expect(keys.sort(), g).toEqual(Object.keys(shape).sort());
		}
		for (const f of SETTING_FIELDS) {
			const value = (FAST_SETTINGS[f.group] as Record<string, unknown>)[f.key];
			const schema = (shapes[f.group] as Record<string, { safeParse(v: unknown): { success: boolean } }>)[f.key]!;
			if (f.type === 'choice') {
				for (const o of f.options) expect(schema.safeParse(o).success, `${f.key}=${o}`).toBe(true);
				expect(f.options).toContain(value);
			} else if (f.type === 'number') {
				// shown bounds map to stored values the schema accepts, and the Fast value round-trips
				expect(schema.safeParse(parseFieldValue(f, String(f.min))).success, `${f.key} min`).toBe(true);
				expect(schema.safeParse(parseFieldValue(f, String(f.max))).success, `${f.key} max`).toBe(true);
				expect(parseFieldValue(f, String(f.max + 1))).toBeNull();
				expect(parseFieldValue(f, showFieldValue(f, value as number))).toBeCloseTo(value as number, 6);
				expect(f.unit === '' ? /\((words|letters|frames)\)$/.test(f.label) : f.unit.length > 0, f.key).toBe(true);
			} else expect(typeof value).toBe('boolean');
		}
		const fade = SETTING_FIELDS.find((f) => f.key === 'fadeMs')! as Extract<(typeof SETTING_FIELDS)[number], { type: 'number' }>;
		expect(parseFieldValue(fade, 'abc')).toBeNull();
		expect(parseFieldValue(fade, '4,5')).toBe(4.5);
	});
});
