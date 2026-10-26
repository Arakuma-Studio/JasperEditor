// Derived preview (spec 14 TC-042): a temporary timeline the Program monitor plays — never committed, never saved,
// never in History — that ends when the committed document changes, a gesture starts or the session closes; plus the
// frame maps between the committed and the derived sequence.
import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	derivedPreviewDocument,
	derivedPreviewFor,
	EditorSession,
	normalizeFrameRanges,
	toDerivedFrame,
	toOriginalFrame,
} from '../src/index.ts';

function setup() {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'P', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-26T10:00:00.000Z', registries: defaultRegistries() },
	});
	const seqId = Object.keys(doc.sequences)[0]!;
	const r = session.apply({
		label: 'Setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [0, 0, 1, 1] }] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, seqId };
}

const seqEnd = (
	doc: { sequences: Record<string, { clips: Record<string, { start: number; duration: number }> }> },
	id: string,
) => Math.max(...Object.values(doc.sequences[id]!.clips).map((c) => c.start + c.duration));

describe('derived preview', () => {
	it('plays a derived document without touching the session, its History or dirty state', () => {
		const { session, seqId } = setup();
		const before = session.getState();
		const c = derivedPreviewFor(session);
		expect(derivedPreviewFor(session)).toBe(c);
		const r = c.start({
			label: 'Clean Up result',
			kind: 'cleanup.result',
			sequenceId: seqId,
			commands: [{ type: 'range.extract', from: 30, to: 60 }] as never[],
			omitted: [[30, 60]],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const after = session.getState();
		expect(after.document).toBe(before.document);
		expect(after.revision).toBe(before.revision);
		expect(after.history).toBe(before.history);
		expect(seqEnd(r.preview.document, seqId)).toBe(90);
		expect(seqEnd(session.getCommitted(), seqId)).toBe(120);
		expect(derivedPreviewDocument(c.getState(), session)).toBe(r.preview.document);
		c.stop();
		expect(c.getState()).toEqual({ active: null, ended: 'stopped' });
		expect(derivedPreviewDocument(c.getState(), session)).toBeNull();
		expect(session.getState().history.canUndo).toBe(true); // only the setup entry
		expect(session.getState().history.entries).toHaveLength(1);
	});

	it('ends when the committed document changes (stale), when a gesture starts and when the session closes', async () => {
		const { session, seqId } = setup();
		const c = derivedPreviewFor(session);
		const start = () =>
			c.start({
				label: 'R',
				kind: 'k',
				sequenceId: seqId,
				commands: [{ type: 'range.extract', from: 0, to: 10 }] as never[],
				omitted: [[0, 10]],
			});
		expect(start().ok).toBe(true);
		session.apply({
			label: 'Marker',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'marker.add', frame: 5 }] as never[],
		});
		expect(c.getState()).toEqual({ active: null, ended: 'stale' });
		expect(start().ok).toBe(true);
		const g = session.beginGesture('Drag');
		expect(c.getState().ended).toBe('gesture');
		// no preview starts while a gesture draws its own transient
		const busy = start();
		expect(busy.ok).toBe(false);
		if (!busy.ok) expect(busy.code).toBe('E_BUSY');
		g.cancel();
		expect(start().ok).toBe(true);
		await session.close();
		expect(c.getState().ended).toBe('closed');
	});

	it('refuses commands that fail with their code, and an unknown sequence', () => {
		const { session, seqId } = setup();
		const c = derivedPreviewFor(session);
		const bad = c.start({
			label: 'R',
			kind: 'k',
			sequenceId: seqId,
			commands: [{ type: 'item.delete', itemIds: ['itm_missing'] }] as never[],
			omitted: [],
		});
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.code).toMatch(/^E_/);
		const none = c.start({ label: 'R', kind: 'k', sequenceId: 'seq_nope', commands: [], omitted: [] });
		expect(none).toMatchObject({ ok: false, code: 'E_NOT_FOUND' });
		expect(c.getState().active).toBeNull();
	});

	it('maps frames between the committed and the derived sequence', () => {
		const om = normalizeFrameRanges([
			[50, 60],
			[10, 20],
			[20, 25],
			[70, 70],
		]);
		expect(om).toEqual([
			[10, 25],
			[50, 60],
		]);
		expect(toDerivedFrame(om, 5)).toBe(5);
		expect(toDerivedFrame(om, 10)).toBe(10);
		expect(toDerivedFrame(om, 17)).toBe(10); // inside an omitted range: where it was
		expect(toDerivedFrame(om, 25)).toBe(10);
		expect(toDerivedFrame(om, 55)).toBe(35);
		expect(toDerivedFrame(om, 80)).toBe(55);
		expect(toOriginalFrame(om, 10)).toBe(25);
		expect(toOriginalFrame(om, 35)).toBe(60);
		expect(toOriginalFrame(om, 9)).toBe(9);
	});

	it('the maps are inverse on every kept frame (fast-check)', () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 1, max: 40 })), {
					maxLength: 12,
				}),
				fc.integer({ min: 0, max: 600 }),
				(raw, f) => {
					const om = normalizeFrameRanges(raw.map(([a, n]) => [a, a + n] as [number, number]));
					const inside = om.some(([a, b]) => f >= a && f < b);
					const d = toDerivedFrame(om, f);
					if (!inside) expect(toOriginalFrame(om, d)).toBe(f);
					expect(toDerivedFrame(om, toOriginalFrame(om, d))).toBe(d);
				},
			),
			{ numRuns: 300 },
		);
	});
});
