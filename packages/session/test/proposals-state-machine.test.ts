// The review's accept / reject / Apply / Undo / Redo / reopen state machine (Phase 3 verification, spec 12 §2.7
// "After Undo, the proposal reopens with its decisions intact"): random sequences of local decisions, Apply, Undo,
// Redo, unrelated edits, an allowed agent's accept relayed into the session, stray reopen requests and alternative
// choices. After every step (once the follow-ups settled) the engine's stored states and the session's document agree:
// an item is `accepted` exactly when what it adds is in the document, and nothing is ever in it twice. The fake engine
// enforces the engine's guards (reopen refused while an accept is in the document, a redo record checked).
import { setImmediate } from 'node:timers/promises';
import { createCounterIdSource, createEmptyProject, defaultRegistries, type Sequence } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EditorSession, proposalsFor } from '../src/index.ts';
import { FakeEngine } from './fake-proposals-engine.ts';

const REG = defaultRegistries();
const MARKERS = [1, 2, 3, 4] as const;

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
	const base = session.apply({
		label: 'Setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [0, 0, 1, 1] }] as never[],
	});
	if (!base.ok) throw new Error(JSON.stringify(base.errors));
	const queue: (() => void)[] = [];
	const c = proposalsFor(session, {
		engine,
		setTimer: (fn) => {
			queue.push(fn);
			return queue.length;
		},
		clearTimer: () => {},
	});
	c.connect(engine.subscribe);
	const p = engine.create({
		feature: 'sound-design',
		title: 'Pass',
		sequenceId: seqId,
		items: [
			{
				id: 'trk',
				label: 'SFX track',
				commands: [{ type: 'track.add', kind: 'audio', name: 'SFX P', ref: '$sfx' }],
			},
			{
				id: 'mute',
				label: 'Mute it',
				requires: ['trk'],
				commands: [{ type: 'track.update', trackId: '$sfx', patch: { mute: true } }],
			},
			...MARKERS.map((i) => ({
				id: `m${i}`,
				label: `Marker ${i}`,
				commands: [{ type: 'marker.add', frame: 20 * i, name: `P${i}` }],
				alternatives: [
					{ label: `Alt ${i}`, commands: [{ type: 'marker.add', frame: 20 * i + 1, name: `P${i}alt` }] },
				],
			})),
		],
	});
	const drain = () => {
		for (let n = 0; queue.length && n < 10_000; n++) queue.shift()!();
	};
	return { session, engine, c, seqId, proposalId: p.id, drain };
}

type Op =
	| { k: 'accept' | 'reject' | 'clear'; item: number }
	| { k: 'apply' | 'undo' | 'redo' | 'edit' | 'strayReopen' | 'agentAccept' }
	| { k: 'select'; item: number; alt: number };

const ITEM_IDS = ['trk', 'mute', 'm1', 'm2', 'm3', 'm4'];
const op: fc.Arbitrary<Op> = fc.oneof(
	{ weight: 4, arbitrary: fc.record({ k: fc.constant('accept' as const), item: fc.nat(5) }) },
	{ weight: 2, arbitrary: fc.record({ k: fc.constant('reject' as const), item: fc.nat(5) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('clear' as const), item: fc.nat(5) }) },
	{ weight: 3, arbitrary: fc.record({ k: fc.constant('apply' as const) }) },
	{ weight: 3, arbitrary: fc.record({ k: fc.constant('undo' as const) }) },
	{ weight: 2, arbitrary: fc.record({ k: fc.constant('redo' as const) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('edit' as const) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('strayReopen' as const) }) },
	{ weight: 1, arbitrary: fc.record({ k: fc.constant('agentAccept' as const) }) },
	{
		weight: 1,
		arbitrary: fc.record({
			k: fc.constant('select' as const),
			item: fc.integer({ min: 2, max: 5 }),
			alt: fc.nat(1),
		}),
	},
);

const settle = async (f: ReturnType<typeof setup>) => {
	await f.c.settled();
	// FakeEngine resolves requests without I/O: one event-loop turn drains its event/follow-up microtasks.
	await setImmediate();
	f.drain();
	await f.c.settled();
};

function check(f: ReturnType<typeof setup>, trace: string[]) {
	const seq = f.session.getCommitted().sequences[f.seqId] as Sequence;
	const stored = f.engine.proposals.get(f.proposalId)!;
	const state = (id: string) => stored.items.find((it) => it.id === id)!.state;
	const why = () => `after ${trace.join(' → ')}`;
	const tracks = seq.audioTracks.filter((t) => t.name === 'SFX P');
	expect(tracks.length, why()).toBeLessThanOrEqual(1);
	expect(state('trk') === 'accepted', why()).toBe(tracks.length === 1);
	expect(state('mute') === 'accepted', why()).toBe(tracks.length === 1 && tracks[0]!.mute === true);
	for (const i of MARKERS) {
		const n = seq.markers.filter((m) => m.name === `P${i}` || m.name === `P${i}alt`).length;
		expect(n, `marker ${i} twice ${why()}`).toBeLessThanOrEqual(1);
		expect(state(`m${i}`) === 'accepted', `m${i} ${why()}`).toBe(n === 1);
	}
	// the review shows the stored decision: an applied item is "applied", nothing else is
	for (const it of f.c.getState().items)
		expect(it.state === 'applied', `${it.id} shown ${it.state} ${why()}`).toBe(state(it.id) === 'accepted');
}

describe('proposals: accept / reject / apply / undo / redo / reopen state machine', () => {
	it('engine states and the document stay consistent; nothing is applied twice', async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 24 }), async (ops) => {
				const f = setup();
				await f.c.setActive(f.proposalId);
				await settle(f);
				const trace: string[] = [];
				let edits = 0;
				for (const o of ops) {
					trace.push('item' in o ? `${o.k}(${ITEM_IDS[o.item]})` : o.k);
					if (o.k === 'accept' || o.k === 'reject' || o.k === 'clear')
						await f.c.setItemDecision([ITEM_IDS[o.item]!], o.k);
					else if (o.k === 'select') await f.c.selectAlternative(ITEM_IDS[o.item]!, o.alt);
					else if (o.k === 'apply') await f.c.apply({ trusted: true });
					else if (o.k === 'undo') f.session.undo();
					else if (o.k === 'redo') f.session.redo();
					else if (o.k === 'edit')
						f.session.apply({
							label: 'Unrelated edit',
							origin: 'user',
							sequenceId: f.seqId,
							commands: [{ type: 'marker.add', frame: 250 + edits++, name: 'x' }] as never[],
						});
					else if (o.k === 'strayReopen')
						// a reopen nobody undid first (another window, a stale tab): refused while applied
						await f.engine.reopenProposal('', f.proposalId, { itemIds: 'all' }).catch(() => undefined);
					else if (o.k === 'agentAccept') {
						const undecided = f.engine.proposals
							.get(f.proposalId)!
							.items.filter((it) => it.state === 'pending' || it.state === 'stale')
							.map((it) => it.id);
						if (undecided.length)
							await f.engine
								.acceptProposal(
									'',
									f.proposalId,
									{ itemIds: [undecided[0]!], partial: true },
									{
										agent: 'sound-agent',
									},
								)
								.catch(() => undefined);
					}
					await settle(f);
					check(f, trace);
				}
				f.c.dispose();
			}),
			{ numRuns: Number(process.env.PROPOSALS_SM_RUNS ?? 60) },
		);
	}, 300_000);

	it('undo then redo before the engine answered: the follow-ups reach it in order (no duplicate on re-apply)', async () => {
		const f = setup();
		await f.c.setActive(f.proposalId);
		await settle(f);
		await f.c.setItemDecision(['m1', 'm2'], 'accept');
		await f.c.apply({ trusted: true });
		await settle(f);
		// both before anything settles
		f.session.undo();
		f.session.redo();
		await settle(f);
		check(f, ['apply', 'undo', 'redo']);
		expect(f.engine.proposals.get(f.proposalId)!.items.find((it) => it.id === 'm1')!.state).toBe('accepted');
		// and the other way round
		f.session.undo();
		await settle(f);
		f.session.redo();
		f.session.undo();
		await settle(f);
		check(f, ['undo', 'redo', 'undo']);
		expect(f.engine.proposals.get(f.proposalId)!.items.find((it) => it.id === 'm1')!.state).toBe('pending');
		// applying again puts them in once
		await f.c.apply({ trusted: true });
		await settle(f);
		check(f, ['apply']);
		f.c.dispose();
	});

	it('an allowed agent’s accept relayed into the session is followed too: Undo puts it back into review', async () => {
		const f = setup();
		await f.c.setActive(f.proposalId);
		await settle(f);
		await f.engine.acceptProposal('', f.proposalId, { itemIds: ['m3'] }, { agent: 'sound-agent' });
		await settle(f);
		check(f, ['agentAccept(m3)']);
		f.session.undo();
		await settle(f);
		check(f, ['undo']);
		expect(f.engine.proposals.get(f.proposalId)!.items.find((it) => it.id === 'm3')!.state).toBe('pending');
		f.session.redo();
		await settle(f);
		check(f, ['redo']);
		expect(f.engine.proposals.get(f.proposalId)!.items.find((it) => it.id === 'm3')!.state).toBe('accepted');
		f.c.dispose();
	});
});
