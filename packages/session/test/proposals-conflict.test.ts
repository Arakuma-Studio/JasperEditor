// A large proposal (more than the 64 items the review once checked together) whose items each apply but break an
// invariant together: the review preview flags the later item stale with the issue ("conflicts with the items before
// it: …"), Hear leaves it out, and the rest is previewed — before Apply, not only by Apply (WP6.5b item 14).
import { createCounterIdSource, createEmptyProject, defaultRegistries, type Proposal } from '@jasper/project';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSession, proposalsFor } from '../src/index.ts';
import { FakeEngine } from './fake-proposals-engine.ts';

const REG = defaultRegistries();
const N = 130;
const DUP = 'mrk_00000000000000D0';
const markerId = (i: number) => `mrk_${String(i).padStart(16, '0')}`;

afterEach(() => vi.restoreAllMocks());

function setup() {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'P', preset: 'hd-1080p-30' });
	let session!: EditorSession;
	const engine = new FakeEngine(() => session);
	session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-16T10:00:00.000Z', registries: REG },
	});
	const seqId = Object.keys(doc.sequences)[0]!;
	const created = engine.create({
		feature: 'sound-design',
		title: 'Markers',
		sequenceId: seqId,
		items: Array.from({ length: N }, (_, i) => ({
			id: `m${i}`,
			label: `Marker ${i}`,
			commands: [{ type: 'marker.add', frame: 10 + i * 5, name: `M${i}`, id: markerId(1000 + i) }],
		})),
	});
	// Items 40 and 110 add a marker with the same id: `marker.add` takes a supplied id it does not find among the
	// document's markers, so each applies alone, but together the document has one id twice (INV-001). The engine
	// refuses such a pair when the proposal is made (its whole-set dry run); a stored proposal can still hold one
	// (made by an older build, or a creator whose check was off), and the review must show it before Apply.
	const withConflict: Proposal = {
		...created,
		items: created.items.map((it, i) =>
			i === 40 || i === 110
				? { ...it, commands: [{ ...(it.commands[0] as Record<string, unknown>), id: DUP }] as never }
				: it,
		),
	};
	engine.proposals.set(created.id, withConflict);
	return { session, engine, seqId, proposalId: created.id };
}

describe(`review preview of ${N} items with an invariant-only conflict`, () => {
	it('flags the later item stale with the invariant, leaves it out of Hear and previews the rest', async () => {
		const { session, engine, seqId, proposalId } = setup();
		const queue: (() => void)[] = [];
		let elapsed = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => (elapsed += 9));
		const c = proposalsFor(session, {
			engine,
			setTimer: (fn) => {
				queue.push(fn);
				return queue.length;
			},
			clearTimer: () => {},
		});
		await c.setActive(proposalId);
		queue.shift()!();
		// The editor gets control back before the large preview is complete. Partial edits stay private.
		expect(c.getState().previewing).toBe(true);
		expect(c.getState().preview).toBeNull();
		expect(session.getCommitted().sequences[seqId]!.markers).toHaveLength(0);
		for (let i = 0; queue.length && i < 100_000; i++) queue.shift()!();
		const s = c.getState();
		expect(s.previewing).toBe(false);
		expect(s.preview).not.toBeNull();
		const bad = s.items.find((it) => it.id === 'm110')!;
		expect(bad.state).toBe('stale');
		expect(bad.reason).toMatch(/INV-001|Duplicate id/);
		expect(s.items.find((it) => it.id === 'm40')!.state).toBe('pending');
		expect(s.items.filter((it) => it.state === 'pending')).toHaveLength(N - 1);
		expect(s.preview!.heard).not.toContain('m110');
		expect(s.preview!.heard).toHaveLength(N - 1);
		const markers = s.preview!.document.sequences[seqId]!.markers;
		expect(markers.filter((m) => m.id === DUP)).toHaveLength(1);
		expect(markers).toHaveLength(N - 1);
		// the session's own document is untouched
		expect(session.getCommitted().sequences[seqId]!.markers).toHaveLength(0);
		c.dispose();
	});
});
