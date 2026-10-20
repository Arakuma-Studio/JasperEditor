// Why a review item is stale, said with timecodes and the cue kind — never an entity id — in English and Spanish
// (Phase 3 verification; WP3.3b limit "the stale reason names a cue by id"). The model's structured problem comes from
// `revalidate` on a real document: a stored cut cue moved from 90 to 100 (30 fps).
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	createProposal,
	defaultRegistries,
	revalidate,
	type Sequence,
	type StaleProblem,
} from '@jasper/project';
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../src/i18n/runtime.ts';
import { describeProblem, problemText } from '../src/proposals/stale-text.ts';

afterEach(() => setLanguage('en'));

const REG = defaultRegistries();
const ctx = { registries: REG, now: () => '2026-10-16T10:00:00.000Z' };

function fixture() {
	const ids = createCounterIdSource(3);
	let doc = createEmptyProject({ ids, name: 'P', preset: 'hd-1080p-30' });
	const seqId = Object.keys(doc.sequences)[0]!;
	const tx = (commands: unknown[]) => {
		const r = applyTransaction(
			doc,
			{ label: 'x', origin: 'user', sequenceId: seqId, commands },
			{ ids, now: ctx.now, revision: 0, registries: REG },
		);
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
		doc = r.document;
		return r.result;
	};
	tx([
		{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [0, 0, 1, 1], ref: '$c' },
		{ type: 'soundCue.add', cues: [{ frame: 90, kind: 'cut', weight: 'support', source: 'user' }] },
		{ type: 'marker.add', frame: 120, name: 'Logo' },
	]);
	const seq = () => doc.sequences[seqId] as Sequence;
	const cueId = Object.keys(seq().soundDesign?.cues ?? {})[0]!;
	const markerId = seq().markers[0]!.id;
	const clipId = Object.keys(seq().clips)[0]!;
	const r = createProposal(
		doc,
		{
			feature: 'sound-design',
			title: 'Pass',
			sequenceId: seqId,
			items: [
				{
					id: 'cut',
					label: 'Hit on the cut',
					commands: [{ type: 'soundCue.update', cueId, reason: 'x' }],
					meta: { cueId, kind: 'cut' },
				},
				{ id: 'logo', label: 'Logo', commands: [{ type: 'marker.update', markerId, name: 'Logo!' }] },
				{
					id: 'clip',
					label: 'On the clip',
					commands: [{ type: 'clip.update', clipIds: [clipId], patch: { name: 'Shot' } }],
				},
				{
					id: 'after',
					label: 'After',
					requires: ['cut'],
					commands: [{ type: 'marker.add', frame: 5, name: 'y' }],
				},
			],
		},
		{
			id: 'prp_0000000000000001',
			projectId: doc.projectId,
			author: { agent: 'a' },
			now: ctx.now(),
			revision: 0,
		},
		ctx,
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { tx, seq, cueId, markerId, clipId, proposal: r.proposal, doc: () => doc };
}

const problems = (f: ReturnType<typeof fixture>) => {
	const rv = revalidate(f.doc(), f.proposal, ctx);
	return Object.fromEntries(rv.stale.map((s) => [s.itemId, s]));
};

describe('stale reasons', () => {
	it('a moved cue: kind and timecodes, in English for agents and in the editor, in Spanish too', async () => {
		const f = fixture();
		f.tx([{ type: 'soundCue.update', cueId: f.cueId, frame: 100 }]);
		const s = problems(f);
		expect(s.cut!.reason).toBe('The cut cue at 00:00:03:00 moved to 00:00:03:10');
		expect(s.cut!.reason).not.toContain(f.cueId);
		const problem = s.cut!.problem as StaleProblem;
		expect(problem).toMatchObject({
			type: 'anchor',
			entity: 'cue',
			change: 'frame',
			at: 90,
			to: 100,
			cueKind: 'cut',
		});
		const item = { state: 'stale' as const, reason: s.cut!.reason, problem };
		expect(problemText(item, f.seq())).toBe('Cut cue at 00:00:03:00 moved to 00:00:03:10');
		// the item requiring it
		expect(s.after!.problem).toMatchObject({ type: 'requires', itemId: 'cut', label: 'Hit on the cut' });
		expect(describeProblem(s.after!.problem!, f.seq())).toBe(
			'Needs “Hit on the cut”, which changed since it was proposed',
		);
		await setLanguage('es');
		expect(problemText(item, f.seq())).toBe('La señal Corte en 00:00:03:00 se movió a 00:00:03:10');
		expect(describeProblem(s.after!.problem!, f.seq())).toBe(
			'Necesita «Hit on the cut», que ha cambiado desde que se propuso',
		);
	});

	it('a deleted cue keeps its kind (from the item) and where it was; markers and clips by name', async () => {
		const f = fixture();
		f.tx([
			{ type: 'soundCue.remove', cueIds: [f.cueId] },
			{ type: 'marker.update', markerId: f.markerId, frame: 150 },
			{ type: 'clip.move', clipIds: [f.clipId], deltaFrames: 30 },
		]);
		const s = problems(f);
		expect(s.cut!.reason).toBe('The cut cue at 00:00:03:00 was deleted');
		expect(describeProblem(s.cut!.problem!, f.seq())).toBe('Cut cue at 00:00:03:00 was deleted');
		expect(s.logo!.reason).toBe('The marker “Logo” at 00:00:04:00 moved to 00:00:05:00');
		expect(describeProblem(s.logo!.problem!, f.seq())).toBe(
			'Marker “Logo” at 00:00:04:00 moved to 00:00:05:00',
		);
		expect(s.clip!.problem).toMatchObject({ entity: 'clip', change: 'start', at: 0, to: 30 });
		expect(describeProblem(s.clip!.problem!, f.seq())).toMatch(/^“.+” at 00:00:00:00 moved to 00:00:01:00$/);
		for (const x of Object.values(s)) {
			expect(x.reason).not.toMatch(/(clp|cue|mrk)_[0-9A-Z]{16}/);
			expect(describeProblem(x.problem!, f.seq())).not.toMatch(/(clp|cue|mrk)_[0-9A-Z]{16}/);
		}
		await setLanguage('es');
		expect(describeProblem(s.logo!.problem!, f.seq())).toBe(
			'El marcador «Logo» en 00:00:04:00 se movió a 00:00:05:00',
		);
	});

	it('without a structured problem the stored reason is shown (translated when it is a model template)', () => {
		expect(problemText({ state: 'stale', reason: 'Something odd' }, undefined)).toBe('Something odd');
		expect(problemText({ state: 'stale' }, undefined)).toBe('Changed since it was proposed');
		expect(problemText({ state: 'pending', reason: 'x' }, undefined)).toBeNull();
		expect(describeProblem({ type: 'conflict', issue: '' }, undefined)).toBe('Does not apply any more');
	});
});
