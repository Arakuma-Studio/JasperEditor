// The session's proposals slice (spec 12 §2.5 "Session", P3-R4): sync with the engine (list, events, the proposal
// under review), local decisions vs stored ones, the preview document (never the session's document), the ghosts'
// attribution, stale items after a document change, Apply as ONE undo entry through the accept route, Undo → the
// items back in review with their decisions, Redo → recorded applied again. The engine is a fake built on the pure
// model (`planAccept`, decisions) that relays accepts into the session as the user's edit, like the real one.
import { setImmediate } from 'node:timers/promises';
import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, heardDocument, type ProposalsController, proposalsFor } from '../src/index.ts';
import { FakeEngine } from './fake-proposals-engine.ts';

const REG = defaultRegistries();

/** Manual timers: the debounced work runs when the test says so. */
function timers() {
	const queue = new Map<number, () => void>();
	let n = 0;
	return {
		setTimer: (fn: () => void) => {
			queue.set(++n, fn);
			return n;
		},
		clearTimer: (h: unknown) => queue.delete(h as number),
		run() {
			for (let i = 0; i < 10 && queue.size; i++) {
				const fns = [...queue.values()];
				queue.clear();
				for (const f of fns) f();
			}
		},
	};
}

const settle = () => setImmediate();

async function setup() {
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
	const base = session.apply({
		label: 'Setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [0, 0, 1, 1] },
			{ type: 'marker.add', frame: 100, name: 'Hit', ref: '$m' },
		] as never[],
	});
	if (!base.ok) throw new Error(JSON.stringify(base.errors));
	const markerId = base.refs.$m!;
	const t = timers();
	const c: ProposalsController = proposalsFor(session, {
		engine,
		setTimer: t.setTimer,
		clearTimer: t.clearTimer,
	});
	c.connect(engine.subscribe);
	const draft = {
		feature: 'sound-design',
		title: 'Sound pass',
		sequenceId: seqId,
		items: [
			{
				id: 'trk',
				label: 'SFX track',
				commands: [{ type: 'track.add', kind: 'audio', name: 'SFX 1', ref: '$sfx' }],
			},
			{
				id: 'cut',
				label: 'Marker at 30',
				group: 'hero',
				commands: [{ type: 'marker.add', frame: 30, name: 'Whoosh' }],
				meta: { why: 'Cut on V1' },
				alternatives: [
					{ label: 'Marker at 31', commands: [{ type: 'marker.add', frame: 31, name: 'Swoosh' }] },
				],
			},
			{
				id: 'mk',
				label: 'Rename the hit',
				commands: [{ type: 'marker.update', markerId, name: 'Boom' }],
			},
			{
				id: 'mute',
				label: 'Mute SFX',
				requires: ['trk'],
				commands: [{ type: 'track.update', trackId: '$sfx', patch: { mute: true } }],
			},
		],
	};
	return { session, engine, c, t, seqId, markerId, draft };
}

const states = (c: ProposalsController) =>
	Object.fromEntries(c.getState().items.map((it) => [it.id, it.state]));
const engineStates = (e: FakeEngine, id: string) =>
	Object.fromEntries(e.proposals.get(id)!.items.map((it) => [it.id, it.state]));

describe('proposals slice: sync with the engine', () => {
	it('lists the project proposals and follows proposal.changed (list, the active one, deletion)', async () => {
		const { c, engine, t, draft } = await setup();
		expect((await c.load()).ok).toBe(true);
		expect(c.getState().list).toEqual([]);
		const p = engine.create(draft);
		t.run();
		await settle();
		expect(c.getState().list.map((x) => x.id)).toEqual([p.id]);
		expect(c.getState().list[0]!.counts.pending).toBe(4);
		await c.setActive(p.id);
		expect(c.getState().proposal?.id).toBe(p.id);
		// another client (an agent) rejects an item: the event re-reads the active proposal
		await engine.rejectProposal('x', p.id, { itemIds: ['mk'] });
		await settle();
		expect(states(c).mk).toBe('rejected');
		// deletion ends the review
		await engine.deleteProposal('x', p.id);
		await settle();
		expect(c.getState().activeId).toBeNull();
		expect(c.getState().lastError?.code).toBe('E_PROPOSAL_GONE');
	});

	it('events of other projects are ignored; engine failures resolve to typed results (never throw)', async () => {
		const { c, engine, draft } = await setup();
		const p = engine.create(draft);
		c.handleEvent({ projectId: 'prj_other', proposalId: p.id, change: 'created' });
		engine.failNext = 'E_BOOM';
		const r = await c.setActive(p.id);
		expect(r).toMatchObject({ ok: false, code: 'E_BOOM' });
		expect(c.getState().activeId).toBeNull();
		const none = await c.apply({ trusted: true });
		expect(none).toMatchObject({ ok: false, code: 'E_NOT_FOUND' });
	});
});

describe('proposals slice: preview document and ghosts', () => {
	it('builds a preview document (never the session document) with ghosts per item; hear plays it', async () => {
		const { c, engine, t, session, seqId, draft } = await setup();
		const p = engine.create(draft);
		await c.setActive(p.id);
		const committed = session.getCommitted();
		const history = session.getState().history.entries.length;
		t.run();
		const pv = c.getState().preview!;
		expect(pv.proposalId).toBe(p.id);
		expect(pv.heard).toEqual(['trk', 'cut', 'mk', 'mute']);
		const seq = pv.document.sequences[seqId]!;
		expect(seq.audioTracks.map((x) => x.name)).toContain('SFX 1');
		expect(seq.audioTracks.find((x) => x.name === 'SFX 1')?.mute).toBe(true);
		expect(seq.markers.map((m) => m.name).sort()).toEqual(['Boom', 'Whoosh']);
		// ghosts are attributed to their items
		const created = pv.result.items.cut!.created;
		expect(created).toHaveLength(1);
		expect(pv.owner[created[0]!]).toBe('cut');
		expect(pv.result.items.mk!.changed.length).toBeGreaterThan(0);
		// the session document and History are untouched
		expect(session.getCommitted()).toBe(committed);
		expect(session.getState().history.entries).toHaveLength(history);
		expect(committed.sequences[seqId]!.markers.map((m) => m.name)).toEqual(['Hit']);
		// Hear proposal: the Program plays the preview; off, or during a gesture, the session's document
		expect(heardDocument(c.getState(), session)).toBeNull();
		c.setHear(true);
		expect(heardDocument(c.getState(), session)).toBe(pv.document);
		const g = session.beginGesture('drag');
		expect(heardDocument(c.getState(), session)).toBeNull();
		g.cancel();
		expect(c.toggleHear()).toBe(false);
		expect(heardDocument(c.getState(), session)).toBeNull();
	});

	it('previewProposal(id, itemIds): one item alone, same ids as the slice preview; another proposal → null', async () => {
		const { c, engine, t, seqId, draft } = await setup();
		const p = engine.create(draft);
		await c.setActive(p.id);
		t.run();
		const one = c.previewProposal(p.id, ['cut'])!;
		expect(one.applied).toEqual(['cut']);
		expect(one.items.cut!.created).toEqual(c.getState().preview!.result.items.cut!.created);
		expect(one.document.sequences[seqId]!.markers.map((m) => m.name).sort()).toEqual(['Hit', 'Whoosh']);
		expect(c.previewProposal('prp_0000000000000099', ['cut'])).toBeNull();
	});

	it('recomputes debounced on doc.changed, keeping the preview entities on the same ids', async () => {
		const { c, engine, t, session, seqId, draft } = await setup();
		const p = engine.create(draft);
		await c.setActive(p.id);
		t.run();
		const first = c.getState().preview!;
		session.apply({
			label: 'Unrelated',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'marker.add', frame: 200, name: 'Later' }] as never[],
		});
		expect(c.getState().preview).toBe(first);
		t.run();
		const second = c.getState().preview!;
		expect(second).not.toBe(first);
		expect(second.revision).toBe(session.revision);
		expect(second.result.items.cut!.created).toEqual(first.result.items.cut!.created);
		expect(second.document.sequences[seqId]!.markers.map((m) => m.name)).toContain('Later');
	});

	it('flags stale items when their anchors move, and revives them when moved back', async () => {
		const { c, engine, t, session, seqId, markerId, draft } = await setup();
		const p = engine.create(draft);
		await c.setActive(p.id);
		t.run();
		expect(states(c).mk).toBe('pending');
		const move = (frame: number) =>
			session.apply({
				label: 'Move marker',
				origin: 'user',
				sequenceId: seqId,
				commands: [{ type: 'marker.update', markerId, frame }] as never[],
			});
		move(120);
		t.run();
		const mk = c.getState().items.find((it) => it.id === 'mk')!;
		expect(mk.state).toBe('stale');
		expect(mk.problem).toMatchObject({
			type: 'anchor',
			entity: 'marker',
			change: 'frame',
			at: 100,
			to: 120,
			name: 'Hit',
		});
		expect(c.getState().stale.mk).toBeDefined();
		// the stored state is the engine's (not re-validated): only this window's view says stale
		expect(engineStates(engine, p.id).mk).toBe('pending');
		move(100);
		t.run();
		expect(states(c).mk).toBe('pending');
	});
});

describe('proposals slice: decisions', () => {
	it('accept is local until Apply (with what it requires); reject and clear go to the engine', async () => {
		const { c, engine, t, seqId, draft } = await setup();
		const p = engine.create(draft);
		await c.setActive(p.id);
		t.run();
		expect((await c.setItemDecision(['mute'], 'accept')).ok).toBe(true);
		expect(states(c)).toMatchObject({ trk: 'accepted', mute: 'accepted', cut: 'pending' });
		expect(engineStates(engine, p.id)).toMatchObject({ trk: 'pending', mute: 'pending' });
		// reject: stored; the heard document leaves it out, the ghost geometry keeps it (drawn hatched)
		const r = await c.setItemDecision(['cut'], 'reject');
		expect(r.ok).toBe(true);
		expect(engineStates(engine, p.id).cut).toBe('rejected');
		t.run();
		const pv = c.getState().preview!;
		expect(pv.heard).not.toContain('cut');
		expect(pv.result.items.cut).toBeDefined();
		expect(pv.document.sequences[seqId]!.markers.map((m) => m.name)).not.toContain('Whoosh');
		// clear: back to pending (reopen)
		await c.setItemDecision(['cut'], 'clear');
		expect(engineStates(engine, p.id).cut).toBe('pending');
		expect(states(c).cut).toBe('pending');
		// accepting a rejected item reopens it and accepts it here
		await c.setItemDecision(['mk'], 'reject');
		await c.setItemDecision(['mk'], 'accept');
		expect(engineStates(engine, p.id).mk).toBe('pending');
		expect(states(c).mk).toBe('accepted');
		expect(c.acceptedIds()).toEqual(['trk', 'mk', 'mute']);
		// clear of a local accept stays local
		await c.setItemDecision(['mk'], 'clear');
		expect(states(c).mk).toBe('pending');
		// refusals
		expect(await c.setItemDecision(['nope'], 'accept')).toMatchObject({ ok: false, code: 'E_NOT_FOUND' });
	});

	it('alternatives (route select, cycling) and notes', async () => {
		const { c, engine, t, seqId, draft } = await setup();
		const p = engine.create(draft);
		await c.setActive(p.id);
		t.run();
		const cut = () => c.getState().items.find((it) => it.id === 'cut')!;
		expect(cut()).toMatchObject({ alternatives: 2, selectedAlternative: 0 });
		expect(cut().alternativeLabels).toEqual(['Marker at 30', 'Marker at 31']);
		expect((await c.cycleAlternative('cut', 1)).ok).toBe(true);
		expect(cut().selectedAlternative).toBe(1);
		t.run();
		const names = c.getState().preview!.document.sequences[seqId]!.markers.map((m) => m.name);
		expect(names).toContain('Swoosh');
		expect(names).not.toContain('Whoosh');
		await c.cycleAlternative('cut', 1);
		expect(cut().selectedAlternative).toBe(0);
		expect(await c.selectAlternative('cut', 5)).toMatchObject({ ok: false, code: 'E_INVALID_PARAM' });
		await c.note('cut', 'quieter please');
		expect(cut().note).toBe('quieter please');
		expect(engine.proposals.get(p.id)!.items.find((it) => it.id === 'cut')!.note).toBe('quieter please');
	});
});

describe('proposals slice: apply, undo, redo', () => {
	it('applies only from a trusted gesture, as ONE undo entry; Undo reopens with decisions intact; Redo records it', async () => {
		const { c, engine, t, session, seqId, draft } = await setup();
		const p = engine.create(draft);
		await c.setActive(p.id);
		t.run();
		await c.setItemDecision(['cut', 'mute'], 'accept');
		await c.setItemDecision(['mk'], 'reject');
		expect(await c.apply({ trusted: false })).toMatchObject({ ok: false, code: 'E_UNTRUSTED' });
		const before = session.getState().history.entries.length;
		const markersBefore = session.getCommitted().sequences[seqId]!.markers.length;
		const r = await c.apply({ trusted: true });
		expect(r.ok, JSON.stringify(r)).toBe(true);
		if (!r.ok) return;
		expect(r.applied).toEqual(['trk', 'cut', 'mute']);
		expect(r.label).toBe('Accept Sound pass (3 of 4)');
		const h = session.getState().history;
		expect(h.entries).toHaveLength(before + 1);
		expect(h.entries.at(-1)).toMatchObject({ label: 'Accept Sound pass (3 of 4)', origin: 'user' });
		const seq = session.getCommitted().sequences[seqId]!;
		expect(seq.markers).toHaveLength(markersBefore + 1);
		expect(seq.audioTracks.find((x) => x.name === 'SFX 1')?.mute).toBe(true);
		expect(engineStates(engine, p.id)).toEqual({
			trk: 'accepted',
			cut: 'accepted',
			mk: 'rejected',
			mute: 'accepted',
		});
		expect(states(c)).toEqual({ trk: 'applied', cut: 'applied', mk: 'rejected', mute: 'applied' });
		expect(c.acceptedIds()).toEqual([]);
		t.run();
		expect(c.getState().preview!.heard).toEqual([]);

		// Undo (one step) → the items come back to review, accepted here, the rejected one still rejected
		expect(session.undo().ok).toBe(true);
		await settle();
		expect(session.getCommitted().sequences[seqId]!.markers).toHaveLength(markersBefore);
		expect(engineStates(engine, p.id)).toEqual({
			trk: 'pending',
			cut: 'pending',
			mk: 'rejected',
			mute: 'pending',
		});
		expect(states(c)).toEqual({ trk: 'accepted', cut: 'accepted', mk: 'rejected', mute: 'accepted' });

		// Redo → applied again, recorded (nothing applied twice)
		expect(session.redo().ok).toBe(true);
		await settle();
		expect(engineStates(engine, p.id)).toEqual({
			trk: 'accepted',
			cut: 'accepted',
			mk: 'rejected',
			mute: 'accepted',
		});
		expect(session.getCommitted().sequences[seqId]!.markers).toHaveLength(markersBefore + 1);
		expect(c.acceptedIds()).toEqual([]);

		// Undo again, then Apply again: one more entry, the same result
		session.undo();
		await settle();
		const again = await c.apply({ trusted: true });
		expect(again.ok).toBe(true);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Accept Sound pass (3 of 4)');
		expect(session.getCommitted().sequences[seqId]!.markers).toHaveLength(markersBefore + 1);
	});

	it('reports stale items left out of Apply; nothing to apply is refused', async () => {
		const { c, engine, t, session, seqId, markerId, draft } = await setup();
		const p = engine.create(draft);
		await c.setActive(p.id);
		t.run();
		expect(await c.apply({ trusted: true })).toMatchObject({ ok: false, code: 'E_NOTHING' });
		await c.setItemDecision(['mk', 'cut'], 'accept');
		session.apply({
			label: 'Move',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'marker.update', markerId, frame: 140 }] as never[],
		});
		const r = await c.apply({ trusted: true });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.applied).toEqual(['cut']);
		expect(r.stale.map((x) => x.itemId)).toEqual(['mk']);
	});
});
