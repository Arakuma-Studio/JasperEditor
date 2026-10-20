// Proposals (spec 12 §2.5, P3-R1): creation and validation, accept composition (closure, order, alternatives, refs
// of earlier accepts), re-validation on a changed document (stale items, moved anchors), the accept plan, review
// decisions, ghosts, and the properties the spec asks for.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyTransaction,
	approvalReasons,
	composeAcceptTx,
	createCounterIdSource,
	createProposal,
	defaultRegistries,
	dependencyClosure,
	markAccepted,
	PROPOSAL_LIMITS,
	type ProjectDocument,
	type Proposal,
	type ProposalContext,
	ProposalSchema,
	planAccept,
	previewProposal,
	proposalCounts,
	proposalGhost,
	rejectItems,
	reopenItems,
	revalidate,
	selectAlternative,
	setItemNote,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const NOW = '2026-10-16T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW };
const AGENT = { agent: 'test-agent' };

function setup() {
	const h = new Harness();
	const mediaId = h.registerVideo({ seconds: 10 });
	h.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1', audio: 'A1' } }]);
	const clipId = h.clips('V1')[0]!.id;
	return { h, mediaId, clipId };
}

let idn = 0;
const nextId = () => `prp_${String(++idn).padStart(16, '0')}`;

function create(h: Harness, draft: Record<string, unknown>): Proposal {
	const r = createProposal(
		h.doc,
		{ feature: 'sound-design', title: 'Sound pass', sequenceId: h.seqId, ...draft },
		{ id: nextId(), projectId: h.doc.projectId, author: AGENT, now: NOW, revision: h.revision },
		CTX,
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
	return r.proposal;
}

function refuse(h: Harness, draft: Record<string, unknown>) {
	const r = createProposal(
		h.doc,
		{ feature: 'sound-design', title: 'Sound pass', sequenceId: h.seqId, ...draft },
		{ id: nextId(), projectId: h.doc.projectId, author: AGENT, now: NOW, revision: h.revision },
		CTX,
	);
	if (r.ok) throw new Error('expected a refusal');
	return r.errors;
}

const marker = (frame: number, name = `m${frame}`) => ({ type: 'marker.add', frame, name });
const cue = (frame: number, extra: Record<string, unknown> = {}) => ({
	type: 'soundCue.add',
	cues: [{ frame, kind: 'cut', weight: 'support', source: 'agent', ...extra }],
});
const item = (id: string, commands: unknown[], extra: Record<string, unknown> = {}) => ({
	id,
	label: `Item ${id}`,
	commands,
	...extra,
});

/** Applies a composed accept like the engine does: one transaction. */
function apply(h: Harness, p: Proposal, ids: string[] | 'all') {
	const c = composeAcceptTx(p, ids, AGENT);
	if (!c.ok) throw new Error(JSON.stringify(c.errors));
	const before = h.revision;
	const r = h.ok(c.tx.commands, { label: c.tx.label, origin: AGENT });
	expect(h.revision).toBe(before + 1);
	return { c, r, p: markAccepted(p, c.itemIds, { revision: h.revision, refs: r.refs, at: NOW }) };
}

describe('createProposal', () => {
	it('validates every item by dry run, records anchors, the base revision and the document hash', () => {
		const { h, clipId } = setup();
		const before = h.doc;
		const p = create(h, {
			summary: 'two cues',
			items: [
				item('a', [cue(30, { anchor: { type: 'clip', clipId, edge: 'start' } })], { group: 'hero' }),
				item('b', [marker(60)], { meta: { why: 'beat' } }),
			],
			report: { events: 2 },
		});
		expect(h.doc).toBe(before); // nothing was applied
		expect(ProposalSchema.safeParse(p).success).toBe(true);
		expect(p.items.map((i) => i.state)).toEqual(['pending', 'pending']);
		expect(p.items[0]!.anchors).toEqual({ [clipId]: expect.stringMatching(/^clip:/) });
		expect(p.items[0]!.group).toBe('hero');
		expect(p.items[1]!.requires).toEqual([]);
		expect(p.baseRevision).toBe(h.revision);
		expect(p.docHash).toMatch(/^[0-9a-f]{16}$/);
		expect(p.author).toEqual(AGENT);
		expect(p.report).toEqual({ events: 2 });
		expect(proposalCounts(p)).toEqual({ pending: 2, accepted: 0, rejected: 0, stale: 0, invalid: 0 });
	});

	it('marks an item whose commands fail invalid with the reason, and the items requiring it too', () => {
		const { h } = setup();
		const p = create(h, {
			items: [
				item('ok', [marker(10)]),
				item('bad', [{ type: 'track.update', trackId: 'A9', patch: { name: 'x' } }]),
				item('dep', [marker(20)], { requires: ['bad'] }),
			],
		});
		expect(p.items.map((i) => i.state)).toEqual(['pending', 'invalid', 'invalid']);
		expect(p.items[1]!.reason).toMatch(/^E_NOT_FOUND: .*A9/);
		expect(p.items[2]!.reason).toBe('requires item bad, which is invalid');
	});

	it('marks the later of two items that only conflict together invalid (one transaction must apply)', () => {
		const { h } = setup();
		const id = 'cue_0000000000000ZZZ';
		const p = create(h, {
			items: [item('a', [cue(30, { id })]), item('b', [cue(40, { id })]), item('c', [marker(5)])],
		});
		expect(p.items.map((i) => i.state)).toEqual(['pending', 'invalid', 'pending']);
		expect(p.items[1]!.reason).toMatch(/^conflicts with the items before it: E_INVALID_PARAM/);
	});

	it('resolves addressing forms against the document and stores ids', () => {
		const { h, clipId } = setup();
		const p = create(h, {
			items: [
				item('a', [
					{ type: 'clip.update', clipId: { clipAt: { track: 'V1', at: 5 } }, patch: { name: 'Shot' } },
				]),
			],
		});
		expect(p.items[0]!.state).toBe('pending');
		expect((p.items[0]!.commands[0] as { clipId: string }).clipId).toBe(clipId);
		const q = create(h, {
			items: [
				item('a', [
					{ type: 'clip.update', clipId: { clipAt: { track: 'V1', at: 900 } }, patch: { name: 'x' } },
				]),
			],
		});
		expect(q.items[0]!.state).toBe('invalid');
	});

	it('refuses malformed drafts with typed issues and never throws', () => {
		const { h } = setup();
		const codes = (d: Record<string, unknown>) => refuse(h, d).map((e) => e.code);
		expect(codes({ items: [] })).toEqual(['E_SCHEMA']);
		expect(codes({ items: [item('-bad', [marker(1)])] })).toEqual(['E_SCHEMA']);
		expect(codes({ feature: 'Sound Design', items: [item('a', [marker(1)])] })).toEqual(['E_SCHEMA']);
		expect(codes({ items: [item('a', [marker(1)]), item('a', [marker(2)])] })).toEqual(['E_INVALID_PARAM']);
		expect(codes({ items: [item('a', [marker(1)], { requires: ['b'] }), item('b', [marker(2)])] })).toEqual([
			'E_INVALID_PARAM',
		]);
		expect(codes({ items: [item('a', [marker(1)], { requires: ['zz'] })] })).toEqual(['E_NOT_FOUND']);
		expect(codes({ items: [item('a', [marker(1)], { requires: ['a'] })] })).toEqual(['E_INVALID_PARAM']);
		// temp refs are unique in a proposal: accepting items together is one transaction
		const t = (ref: string) => ({ type: 'track.add', kind: 'audio', ref });
		expect(codes({ items: [item('a', [t('$t')]), item('b', [t('$t')])] })).toEqual(['E_INVALID_PARAM']);
		// an alternative declares the same refs as its item (later items may use them)
		expect(
			codes({ items: [item('a', [t('$t')], { alternatives: [{ label: 'other', commands: [marker(3)] }] })] }),
		).toEqual(['E_INVALID_PARAM']);
		expect(
			codes({
				items: [
					item('a', [marker(1)], {
						alternatives: [{ label: 'x', commands: [marker(2)] }],
						selectedAlternative: 2,
					}),
				],
			}),
		).toEqual(['E_INVALID_PARAM']);
		// strict commands: unknown keys and types are the creator's error
		expect(codes({ items: [item('a', [{ ...marker(1), frme: 2 }])] })).toEqual(['E_SCHEMA']);
		expect(codes({ items: [item('a', [{ type: 'marker.explode' }])] })).toEqual(['E_SCHEMA']);
		expect(codes({ items: [item('a', [{ type: 'marker.add', frame: 'soon' }])] })).toEqual(['E_SCHEMA']);
		expect(codes({ sequenceId: 'seq_000000000000NOPE', items: [item('a', [marker(1)])] })).toEqual([
			'E_NOT_FOUND',
		]);
		expect(
			codes({ items: [item('a', [marker(1)], { meta: 'x'.repeat(PROPOSAL_LIMITS.maxMetaBytes) })] }),
		).toEqual(['E_SCHEMA']);
		// limits: items and commands
		const many = Array.from({ length: PROPOSAL_LIMITS.maxItems + 1 }, (_, i) => item(`i${i}`, [marker(i)]));
		expect(codes({ items: many })).toEqual(['E_SCHEMA']);
		const heavy = Array.from({ length: 3 }, (_, i) =>
			item(
				`i${i}`,
				Array.from({ length: 2000 }, (_, k) => marker(k)),
			),
		);
		expect(codes({ items: heavy })).toEqual(['E_LIMIT']);
		for (const junk of [null, 1, 'x', [], { items: 'x' }, { feature: 'a', title: 'b', items: [{}] }])
			expect(
				createProposal(
					h.doc,
					junk,
					{ id: nextId(), projectId: 'p', author: 'user', now: NOW, revision: 0 },
					CTX,
				).ok,
			).toBe(false);
	});
});

describe('composeAcceptTx', () => {
	it('takes the dependency closure in proposal order as ONE transaction "Accept <title> (n of m)"', () => {
		const { h } = setup();
		const p = create(h, {
			items: [
				item('track', [{ type: 'track.add', kind: 'audio', name: 'SFX 1', ref: '$sfx' }]),
				item('x', [marker(5)]),
				item('name', [{ type: 'track.update', trackId: '$sfx', patch: { mute: true } }], {
					requires: ['track'],
				}),
			],
		});
		expect(p.items.map((i) => i.state)).toEqual(['pending', 'pending', 'pending']);
		const c = composeAcceptTx(p, ['name'], AGENT, { expectedRevision: 4 });
		if (!c.ok) throw new Error('compose');
		expect(c.itemIds).toEqual(['track', 'name']);
		expect(c.added).toEqual(['track']);
		expect(c.tx.label).toBe('Accept Sound pass (2 of 3)');
		expect(c.tx.origin).toEqual(AGENT);
		expect(c.tx.sequenceId).toBe(h.seqId);
		expect(c.tx.expectedRevision).toBe(4);
		expect(c.tx.commands.map((x) => x.type)).toEqual(['track.add', 'track.update']);
		expect(c.ranges).toEqual([
			{ itemId: 'track', start: 0, end: 1 },
			{ itemId: 'name', start: 1, end: 2 },
		]);
		const tracks = h.seq.audioTracks.length;
		h.ok(c.tx.commands, { label: c.tx.label });
		expect(h.seq.audioTracks.length).toBe(tracks + 1);
		expect(h.seq.audioTracks.at(-1)!.mute).toBe(true);
	});

	it('uses the refs an earlier accept defined, skips accepted items and applies the selected alternative', () => {
		const { h } = setup();
		let p = create(h, {
			items: [
				item('track', [{ type: 'track.add', kind: 'audio', name: 'SFX 1', ref: '$sfx' }]),
				item('mute', [{ type: 'track.update', trackId: '$sfx', patch: { mute: true } }], {
					requires: ['track'],
					alternatives: [
						{
							label: 'solo instead',
							commands: [{ type: 'track.update', trackId: '$sfx', patch: { solo: true } }],
						},
					],
				}),
			],
		});
		const first = apply(h, p, ['track']);
		p = first.p;
		const trackId = first.r.refs.$sfx!;
		expect(p.items[0]!.applied).toEqual({ revision: h.revision, refs: { $sfx: trackId }, at: NOW });
		const sel = selectAlternative(p, 'mute', 1, NOW);
		if (!sel.ok) throw new Error('select');
		p = sel.proposal;
		const c = composeAcceptTx(p, ['track', 'mute'], AGENT);
		if (!c.ok) throw new Error('compose');
		expect(c.skipped).toEqual(['track']);
		expect(c.itemIds).toEqual(['mute']);
		expect(c.tx.commands).toEqual([{ type: 'track.update', trackId, patch: { solo: true } }]);
		h.ok(c.tx.commands);
		const t = h.seq.audioTracks.find((x) => x.id === trackId)!;
		expect([t.solo, t.mute]).toEqual([true, false]);
	});

	it('refuses unknown and invalid items (also through requires) and more commands than one transaction', () => {
		const { h } = setup();
		const p = create(h, {
			items: [
				item('bad', [{ type: 'track.update', trackId: 'A9', patch: { name: 'x' } }]),
				item('ok', [marker(3)]),
			],
		});
		const bad = composeAcceptTx(p, ['nope'], AGENT);
		expect(bad.ok ? [] : bad.errors.map((e) => e.code)).toEqual(['E_NOT_FOUND']);
		const inv = composeAcceptTx(p, ['bad'], AGENT);
		expect(inv.ok ? [] : inv.errors.map((e) => e.code)).toEqual(['E_INVALID_PARAM']);
		const forged: Proposal = { ...p, items: [p.items[0]!, { ...p.items[1]!, requires: ['bad'] }] };
		const via = composeAcceptTx(forged, ['ok'], AGENT);
		expect(via.ok ? '' : via.errors[0]!.message).toMatch(/Item bad \(required by ok\) is invalid/);
		const big = composeAcceptTx(p, ['ok'], AGENT, { maxCommands: 0 });
		expect(big.ok ? [] : big.errors.map((e) => e.code)).toEqual(['E_LIMIT']);
		// 'all' = the undecided items; nothing undecided → an empty composition
		const all = composeAcceptTx(p, 'all', AGENT);
		expect(all.ok && all.itemIds).toEqual(['ok']);
	});
});

describe('revalidate and planAccept on a changed document', () => {
	it('an anchored item goes stale when its clip moves or is deleted, and pending again when it is back', () => {
		const { h, clipId } = setup();
		const p = create(h, {
			items: [
				item('a', [cue(30, { anchor: { type: 'clip', clipId, edge: 'start' } })]),
				item('b', [marker(80)]),
			],
		});
		const base = h.doc;
		h.ok([{ type: 'clip.move', clipIds: [clipId], deltaFrames: 12 }]);
		const moved = revalidate(h.doc, p, CTX);
		expect(moved.changed).toBe(true);
		// a reason a person can read (timecodes, what it is), and the structured problem the editor translates
		expect(moved.stale).toEqual([
			{
				itemId: 'a',
				reason: expect.stringMatching(/^The clip( “[^”]*”)? at 00:00:00:00 moved to 00:00:00:12$/),
				problem: expect.objectContaining({
					type: 'anchor',
					id: clipId,
					entity: 'clip',
					change: 'start',
					at: 0,
					to: 12,
				}),
			},
		]);
		expect(moved.proposal.items[1]!.state).toBe('pending');
		const back = revalidate(base, moved.proposal, CTX);
		expect(back.proposal.items.map((i) => i.state)).toEqual(['pending', 'pending']);
		expect(back.proposal.items[0]!.reason).toBeUndefined();
		h.ok([{ type: 'clip.lift', clipIds: [clipId] }]);
		const gone = revalidate(h.doc, p, CTX);
		expect(gone.stale[0]!.reason).toBe('The clip at 00:00:00:00 was deleted');
		expect(gone.stale[0]!.problem).toMatchObject({
			type: 'anchor',
			entity: 'clip',
			change: 'deleted',
			at: 0,
		});
	});

	it('an item whose commands stop applying goes stale, and so do the items requiring it', () => {
		const { h } = setup();
		const p = create(h, {
			items: [
				item('a', [{ type: 'track.update', trackId: 'A3', patch: { name: 'Music' } }]),
				item('b', [marker(4)], { requires: ['a'] }),
			],
		});
		const a3 = h.seq.audioTracks[2]!.id;
		h.ok([{ type: 'track.remove', trackIds: [a3] }]);
		const r = revalidate(h.doc, p, CTX);
		expect(r.proposal.items.map((i) => i.state)).toEqual(['stale', 'stale']);
		expect(r.proposal.items[0]!.reason).toMatch(/no longer exists|E_NOT_FOUND/);
		expect(r.proposal.items[1]!.reason).toMatch(/^Requires item a \(“[^”]+”\), which is stale$/);
		expect(r.stale.find((x) => x.itemId === 'b')!.problem).toMatchObject({
			type: 'requires',
			itemId: 'a',
			state: 'stale',
		});
		expect(r.stale.find((x) => x.itemId === 'a')!.problem).toMatchObject({ type: 'conflict' });
	});

	it('planAccept is all-or-nothing, or with partial applies the rest and reports the stale items', () => {
		const { h, clipId } = setup();
		const p = create(h, {
			items: [
				item('a', [cue(30, { anchor: { type: 'clip', clipId, edge: 'start' } })]),
				item('b', [marker(80)]),
				item('c', [marker(90)], { requires: ['a'] }),
			],
		});
		h.ok([{ type: 'clip.move', clipIds: [clipId], deltaFrames: 3 }]);
		const strict = planAccept(h.doc, p, 'all', AGENT, CTX);
		expect(strict.ok).toBe(false);
		if (strict.ok) return;
		expect(strict.errors.map((e) => [e.itemId, e.code])).toEqual([
			['a', 'E_STALE'],
			['c', 'E_STALE'],
		]);
		expect(strict.stale.map((s) => s.itemId)).toEqual(['a', 'c']);
		const partial = planAccept(h.doc, p, 'all', AGENT, CTX, { partial: true, expectedRevision: h.revision });
		if (!partial.ok || !partial.composed) throw new Error('partial');
		expect(partial.composed.itemIds).toEqual(['b']);
		expect(partial.composed.tx.expectedRevision).toBe(h.revision);
		expect(partial.stale.map((s) => s.itemId)).toEqual(['a', 'c']);
		const none = planAccept(h.doc, p, ['a'], AGENT, CTX, { partial: true });
		expect(none.ok && none.composed).toBe(null);
		const unknown = planAccept(h.doc, p, ['zz'], AGENT, CTX);
		expect(unknown.ok ? [] : unknown.errors.map((e) => e.code)).toEqual(['E_NOT_FOUND']);
	});

	it('an item that newly conflicts with the others is found by the dry run of the composed set', () => {
		const { h } = setup();
		const id = 'cue_0000000000000ZZY';
		const p = create(h, { items: [item('a', [cue(30, { id })]), item('b', [marker(3)])] });
		// The user adds a cue with that id meanwhile: a is stale by the together dry run (no anchor names it).
		h.ok([cue(50, { id, source: 'user' })]);
		const strict = planAccept(h.doc, p, 'all', AGENT, CTX);
		expect(strict.ok).toBe(false);
		const partial = planAccept(h.doc, p, 'all', AGENT, CTX, { partial: true });
		if (!partial.ok || !partial.composed) throw new Error('partial');
		expect(partial.composed.itemIds).toEqual(['b']);
		expect(partial.proposal.items[0]!.state).toBe('stale');
	});

	it("entities an accepted item changed are not anchors of the proposal's later items", () => {
		const { h, clipId } = setup();
		let p = create(h, {
			items: [
				item('move', [{ type: 'clip.move', clipIds: [clipId], deltaFrames: 5 }]),
				item('name', [{ type: 'clip.update', clipId, patch: { name: 'After move' } }]),
			],
		});
		p = apply(h, p, ['move']).p;
		const r = revalidate(h.doc, p, CTX);
		expect(r.proposal.items.map((i) => i.state)).toEqual(['accepted', 'pending']);
	});
});

describe('review decisions', () => {
	it('reject, note, select and reopen change the proposal only; an accepted item cannot be rejected', () => {
		const { h } = setup();
		const doc = h.doc;
		let p = create(h, {
			items: [
				item('a', [marker(1)], { alternatives: [{ label: 'later', commands: [marker(2)] }] }),
				item('b', [marker(3)]),
				item('c', [marker(4)]),
			],
		});
		const rj = rejectItems(p, ['b'], NOW);
		if (!rj.ok) throw new Error('reject');
		expect(rj.changed).toEqual(['b']);
		expect(h.doc).toBe(doc);
		p = rj.proposal;
		const note = setItemNote(p, 'b', 'too loud', NOW);
		if (!note.ok) throw new Error('note');
		p = note.proposal;
		expect(p.items[1]!.note).toBe('too loud');
		const cleared = setItemNote(p, 'b', null, NOW);
		expect(cleared.ok && cleared.proposal.items[1]!.note).toBeUndefined();
		const longNote = setItemNote(p, 'b', 'x'.repeat(PROPOSAL_LIMITS.maxNote + 1), NOW);
		expect(longNote.ok).toBe(false);
		const sel = selectAlternative(p, 'a', 1, NOW);
		if (!sel.ok) throw new Error('select');
		expect(sel.proposal.items[0]!.selectedAlternative).toBe(1);
		const back = selectAlternative(sel.proposal, 'a', 0, NOW);
		expect(back.ok && back.proposal.items[0]!.selectedAlternative).toBeUndefined();
		expect(selectAlternative(p, 'a', 2, NOW).ok).toBe(false);
		expect(selectAlternative(p, 'zz', 0, NOW).ok).toBe(false);
		p = apply(h, p, ['a']).p;
		const noReject = rejectItems(p, ['a'], NOW);
		expect(noReject.ok ? [] : noReject.errors.map((e) => e.code)).toEqual(['E_INVALID_PARAM']);
		expect(selectAlternative(p, 'a', 1, NOW).ok).toBe(false);
		const all = rejectItems(p, 'all', NOW);
		expect(all.ok && all.proposal.items.map((i) => i.state)).toEqual(['accepted', 'rejected', 'rejected']);
		// After Undo in History the proposal reopens with its notes and alternatives intact.
		const re = reopenItems(p, 'all', NOW);
		if (!re.ok) throw new Error('reopen');
		expect(re.proposal.items.map((i) => i.state)).toEqual(['pending', 'pending', 'pending']);
		expect(re.proposal.items[0]!.applied).toBeUndefined();
		expect(re.proposal.items[1]!.note).toBe('too loud');
		expect(reopenItems(p, ['zz'], NOW).ok).toBe(false);
	});
});

describe('ghosts', () => {
	it('proposalGhost lists created, changed and deleted entities, down to the effects inside a clip', () => {
		const { h, clipId } = setup();
		const before = h.doc;
		const r = applyTransaction(
			before,
			{
				label: 'x',
				origin: 'user',
				commands: [{ type: 'effect.add', target: { clipId }, effectId: 'jasper.gaussian-blur' }, marker(12)],
			},
			h.ctx(),
		);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		const g = proposalGhost(before, r);
		const seq = Object.values(r.document.sequences)[0]!;
		const fx = (seq.clips[clipId] as { effects: { id: string }[] }).effects.at(-1)!.id;
		expect(g.changed).toContain(clipId);
		expect(g.created).toContain(fx);
		expect(g.created).toContain(seq.markers.at(-1)!.id);
		expect(proposalGhost(r.document, before).deleted).toContain(fx);
		expect(proposalGhost(before, before)).toEqual({ created: [], changed: [], deleted: [] });
	});

	it('previewProposal applies items one by one on a copy, with per-item ghosts and failures', () => {
		const { h } = setup();
		const p0 = create(h, {
			items: [
				item('t', [{ type: 'track.add', kind: 'audio', name: 'SFX 1', ref: '$s' }]),
				item('m', [{ type: 'track.update', trackId: '$s', patch: { mute: true } }], { requires: ['t'] }),
				item('k', [marker(7)]),
			],
		});
		const doc = h.doc;
		const pv = previewProposal(doc, p0, 'undecided', CTX);
		expect(h.doc).toBe(doc);
		expect(pv.applied).toEqual(['t', 'm', 'k']);
		const trackId = pv.items.t!.created.find((id) => id.startsWith('trk_'))!;
		expect(pv.items.m!.changed).toEqual([trackId]);
		expect(pv.items.k!.created).toHaveLength(1);
		expect(pv.ghost.created).toEqual(expect.arrayContaining([trackId, ...pv.items.k!.created]));
		// a failing requirement fails its dependents (the user removed A3 the item names)
		const p1 = create(h, {
			items: [
				item('a', [{ type: 'track.update', trackId: 'A3', patch: { name: 'x' } }]),
				item('b', [marker(9)], { requires: ['a'] }),
			],
		});
		h.ok([{ type: 'track.remove', trackIds: [h.seq.audioTracks[2]!.id] }]);
		const pv1 = previewProposal(h.doc, p1, ['b'], CTX);
		expect(Object.keys(pv1.failed)).toEqual(['a', 'b']);
		expect(pv1.document).toBe(h.doc);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Properties

/** Document JSON with ids numbered in order of appearance (fresh ids for the same edit compare equal). */
function normalizeIds(doc: ProjectDocument): string {
	const map = new Map<string, string>();
	return JSON.stringify(doc).replace(/\b([a-z]{2,3})_[0-9A-Z]{16}\b/g, (id, prefix) => {
		if (!map.has(id)) map.set(id, `${prefix}#${map.size}`);
		return map.get(id)!;
	});
}

/** n items: markers, a track with a ref, and items that use that ref (they require the track item). */
function generatedDraft(spec: { kind: 'marker' | 'track' | 'useTrack'; frame: number }[]) {
	const items: ReturnType<typeof item>[] = [];
	let lastTrack: string | null = null;
	spec.forEach((s, i) => {
		const id = `i${i}`;
		if (s.kind === 'track') {
			items.push(item(id, [{ type: 'track.add', kind: 'audio', name: `T${i}`, ref: `$t${i}` }]));
			lastTrack = id;
		} else if (s.kind === 'useTrack' && lastTrack) {
			items.push(
				item(id, [{ type: 'track.update', trackId: `$t${lastTrack.slice(1)}`, patch: { name: `N${i}` } }], {
					requires: [lastTrack],
				}),
			);
		} else items.push(item(id, [marker(s.frame, `m${i}`)]));
	});
	return items;
}

const specArb = fc.array(
	fc.record({
		kind: fc.constantFrom('marker' as const, 'track' as const, 'useTrack' as const),
		frame: fc.integer({ min: 0, max: 500 }),
	}),
	{ minLength: 1, maxLength: 8 },
);

describe('properties', () => {
	it('accepting A then B equals accepting A ∪ B (A before B in proposal order)', () => {
		fc.assert(
			fc.property(
				specArb,
				fc.integer({ min: 0, max: 8 }),
				fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
				(spec, cut, pick) => {
					const { h } = setup();
					const p = create(h, { items: generatedDraft(spec) });
					const ids = p.items.map((i) => i.id);
					const A = ids.slice(0, cut).filter((_, i) => pick[i]);
					const B = ids.slice(cut).filter((_, i) => pick[(i + cut) % 8]);
					if (A.length === 0 || B.length === 0) return;
					const base = h.doc;
					const run = (steps: string[][]) => {
						let doc = base;
						let rev = 0;
						let pp = p;
						const ids2 = createCounterIdSource(900);
						for (const s of steps) {
							const c = composeAcceptTx(pp, s, AGENT);
							if (!c.ok) throw new Error(JSON.stringify(c.errors));
							if (c.itemIds.length === 0) continue;
							const r = applyTransaction(doc, c.tx, { ...h.ctx(), ids: ids2, revision: rev });
							if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
							doc = r.document;
							rev = r.result.revision;
							pp = markAccepted(pp, c.itemIds, { revision: rev, refs: r.result.refs, at: NOW });
						}
						return { doc, pp };
					};
					const twoSteps = run([A, B]);
					const oneStep = run([[...A, ...B]]);
					expect(normalizeIds(twoSteps.doc)).toBe(normalizeIds(oneStep.doc));
					expect(twoSteps.pp.items.map((i) => i.state)).toEqual(oneStep.pp.items.map((i) => i.state));
				},
			),
			{ numRuns: 40 },
		);
	});

	it('rejecting leaves the document identical; accepting the rest equals never having had the rejected items', () => {
		fc.assert(
			fc.property(specArb, fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }), (spec, rej) => {
				const { h } = setup();
				const p = create(h, { items: generatedDraft(spec) });
				const doc = h.doc;
				const snapshot = JSON.stringify(doc);
				const rejected = p.items.filter((_, i) => rej[i]).map((i) => i.id);
				const r = rejectItems(p, rejected, NOW);
				if (!r.ok) throw new Error('reject');
				expect(h.doc).toBe(doc);
				expect(JSON.stringify(doc)).toBe(snapshot);
				for (const it of r.proposal.items)
					expect(it.state).toBe(rejected.includes(it.id) ? 'rejected' : 'pending');
				// 'all' after rejecting composes only the undecided items (plus what they require)
				const c = composeAcceptTx(r.proposal, 'all', AGENT);
				if (!c.ok) throw new Error('compose');
				const pending = r.proposal.items.filter((i) => i.state === 'pending').map((i) => i.id);
				expect(c.itemIds).toEqual(dependencyClosure(r.proposal, pending).map((i) => i.id));
			}),
			{ numRuns: 40 },
		);
	});

	it('compose is deterministic and the closure is minimal and closed', () => {
		const dagArb = fc
			.array(fc.array(fc.nat(), { maxLength: 3 }), { minLength: 1, maxLength: 12 })
			.map((reqs) =>
				reqs.map((r, i) => ({
					id: `n${i}`,
					requires: i === 0 ? [] : [...new Set(r.map((x) => `n${x % i}`))],
				})),
			);
		fc.assert(
			fc.property(dagArb, fc.array(fc.nat(), { minLength: 1, maxLength: 4 }), (dag, picks) => {
				const p: Proposal = {
					version: 1,
					id: 'prp_0000000000000001',
					projectId: 'prj_0000000000000001',
					sequenceId: null,
					feature: 'test',
					title: 'T',
					summary: '',
					author: 'user',
					createdAt: NOW,
					updatedAt: NOW,
					baseRevision: 0,
					docHash: '0',
					items: dag.map((d, i) => ({
						...d,
						label: d.id,
						group: '',
						commands: [marker(i)],
						state: 'pending' as const,
					})),
				};
				const S = [...new Set(picks.map((x) => `n${x % dag.length}`))];
				const closure = dependencyClosure(p, S).map((i) => i.id);
				// contains S, closed under requires, and every member is required (transitively) by S
				for (const s of S) expect(closure).toContain(s);
				for (const id of closure)
					for (const r of p.items.find((i) => i.id === id)!.requires) expect(closure).toContain(r);
				const reach = new Set<string>();
				const visit = (id: string) => {
					if (reach.has(id)) return;
					reach.add(id);
					for (const r of p.items.find((i) => i.id === id)!.requires) visit(r);
				};
				for (const s of S) visit(s);
				expect(new Set(closure)).toEqual(reach);
				// proposal order
				expect(closure).toEqual(p.items.map((i) => i.id).filter((id) => reach.has(id)));
				const a = composeAcceptTx(p, S, AGENT);
				const b = composeAcceptTx(structuredClone(p), [...S].reverse(), AGENT);
				expect(a).toEqual(b);
			}),
			{ numRuns: 200 },
		);
	});

	it('never throws on fuzzed drafts and proposals; problems are typed', () => {
		const { h } = setup();
		const doc = h.doc;
		const draftArb = fc.record(
			{
				feature: fc.oneof(fc.constant('sound-design'), fc.string()),
				title: fc.oneof(fc.constant('T'), fc.string()),
				sequenceId: fc.oneof(fc.constant(h.seqId), fc.string(), fc.constant(null)),
				items: fc.array(
					fc.record(
						{
							id: fc.oneof(fc.constantFrom('a', 'b', 'c', '__proto__', 'constructor'), fc.string()),
							label: fc.string(),
							commands: fc.array(
								fc.oneof(
									fc.constant(marker(3)),
									fc.constant({ type: 'track.add', kind: 'audio', ref: '$x' }),
									fc.constant({ type: 'track.update', trackId: '$x', patch: { mute: true } }),
									fc.dictionary(fc.string(), fc.jsonValue()),
								),
								{ maxLength: 3 },
							),
							requires: fc.array(fc.constantFrom('a', 'b', 'c', 'zz'), { maxLength: 2 }),
							alternatives: fc.array(
								fc.record({
									label: fc.string(),
									commands: fc.array(fc.constant(marker(9)), { maxLength: 2 }),
								}),
								{
									maxLength: 2,
								},
							),
							selectedAlternative: fc.integer({ min: -1, max: 3 }),
							meta: fc.jsonValue(),
						},
						{ requiredKeys: ['id', 'label', 'commands'] },
					),
					{ maxLength: 5 },
				),
			},
			{ requiredKeys: [] },
		);
		fc.assert(
			fc.property(fc.oneof(draftArb, fc.anything()), (draft) => {
				const r = createProposal(
					doc,
					draft,
					{ id: nextId(), projectId: doc.projectId, author: 'user', now: NOW, revision: 0 },
					CTX,
				);
				if (!r.ok) {
					expect(r.errors.length).toBeGreaterThan(0);
					for (const e of r.errors) expect(e.code).toMatch(/^E_[A-Z_]+$/);
					return;
				}
				expect(ProposalSchema.safeParse(r.proposal).success).toBe(true);
				const all = composeAcceptTx(r.proposal, 'all', AGENT);
				expect(typeof all.ok).toBe('boolean');
				const plan = planAccept(doc, r.proposal, 'all', AGENT, CTX, { partial: true });
				expect(typeof plan.ok).toBe('boolean');
				expect(typeof revalidate(doc, r.proposal, CTX).changed).toBe('boolean');
				previewProposal(doc, r.proposal, 'undecided', CTX);
			}),
			{ numRuns: 150 },
		);
	});
});

describe('agent guard', () => {
	it('an agent granting itself "Allow agents to apply sound proposals" needs the user\'s approval', () => {
		expect(
			approvalReasons({ commands: [{ type: 'soundDesign.setSettings', agentsMayApply: true }] }),
		).toEqual([
			'agentsMayApply: true in soundDesign.setSettings (command 1) lets agents apply sound proposals',
		]);
		expect(
			approvalReasons({ commands: [{ type: 'soundDesign.setSettings', agentsMayApply: false }] }),
		).toEqual([]);
		expect(approvalReasons({ commands: [{ type: 'soundDesign.setSettings', density: 'rich' }] })).toEqual([]);
		expect(
			approvalReasons({
				dryRun: true,
				commands: [{ type: 'soundDesign.setSettings', agentsMayApply: true }],
			}),
		).toEqual([]);
	});
});
