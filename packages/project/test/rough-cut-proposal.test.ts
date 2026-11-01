// Spec 18 AF-PROP-001 / AF-PROP-002 (pure model): the `rough-cut` proposal feature (groups, noun, agent accept off by
// default), the agent's rough-cut input (strategy, items with group / reason / beat / quote / commands /
// alternatives; limits), the draft it becomes, the per-item failures of a validated proposal (every failing item with
// its command error, alternatives included) and the fast-forward rule of `expectedRevision` in proposal dry runs.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	agentProposalsAllowed,
	createProposal,
	defaultRegistries,
	PROPOSAL_FEATURE_MODEL_STRINGS,
	type Proposal,
	type ProposalContext,
	projectFeaturePolicy,
	projectSettingFeatures,
	proposalFeatureInfo,
	proposalItemFailures,
	ROUGH_CUT_FEATURE,
	ROUGH_CUT_GROUPS,
	RoughCutInputSchema,
	roughCutDraft,
	roughCutMetaOf,
	strategySentences,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const NOW = '2026-10-31T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW };
const AGENT = { agent: 'cut-agent' };
let n = 0;
const nextId = () => `prp_${String(++n).padStart(16, '0')}`;

/** V1: three solids A [0,60) B [60,120) C [120,180). */
function seeded() {
	const h = new Harness();
	h.ok([
		{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] },
		{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0, 1, 0, 1] },
		{ type: 'clip.addSolid', at: 120, duration: 60, track: 'V1', color: [0, 0, 1, 1] },
	]);
	const [a, b, c] = h.clips('V1');
	return { h, a: a!, b: b!, c: c! };
}

const input = (sequenceId: string, items: unknown[], extra: Record<string, unknown> = {}) => ({
	sequenceId,
	title: 'Tight cut',
	strategy: 'Open on the hook. Drop the false start. Keep the strongest take of the demo.',
	items,
	...extra,
});

function create(h: Harness, draft: unknown, ctx: ProposalContext = CTX) {
	const r = createProposal(
		h.doc,
		draft,
		{ id: nextId(), projectId: h.doc.projectId, author: AGENT, now: NOW, revision: h.revision },
		{ ...ctx, revision: h.revision },
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.proposal;
}

describe('rough-cut feature (AF-PROP-001)', () => {
	it('is declared with its groups, noun and agent accept off by default (a project setting)', () => {
		const f = proposalFeatureInfo(ROUGH_CUT_FEATURE)!;
		expect(f).toMatchObject({
			id: 'rough-cut',
			name: 'Rough cut',
			itemNoun: { one: '1 edit', other: '{0} edits' },
			agentAccept: { setting: 'project', default: false },
		});
		expect(f.groups.map((g) => [g.id, g.label])).toEqual([
			['selects', 'Selects'],
			['removed', 'Removed'],
			['retakes', 'Retakes'],
			['reorder', 'Reorder'],
			['b-roll', 'B-roll'],
			['other', 'Other'],
		]);
		expect(f.groups.map((g) => g.id)).toEqual([...ROUGH_CUT_GROUPS]);
		expect(f.producers).toContain('propose_edits');
		expect(projectSettingFeatures().map((x) => x.id)).toContain('rough-cut');
		for (const s of ['Rough cut', 'Selects', 'Removed', 'Reorder', 'B-roll'])
			expect(PROPOSAL_FEATURE_MODEL_STRINGS).toContain(s);
	});

	it('agents may not apply rough cuts unless the user turned it on', () => {
		const h = new Harness();
		expect(agentProposalsAllowed(h.doc, ROUGH_CUT_FEATURE)).toBe(false);
		const p = { feature: ROUGH_CUT_FEATURE, items: [] } as unknown as Proposal;
		const refused = projectFeaturePolicy(ROUGH_CUT_FEATURE)(h.doc, p);
		expect(refused).toMatchObject({ allowed: false });
		expect(refused.allowed ? '' : refused.reason).toContain('rough cut');
		h.ok([{ type: 'project.updateSettings', settings: { agentProposals: { 'rough-cut': true } } }]);
		expect(agentProposalsAllowed(h.doc, ROUGH_CUT_FEATURE)).toBe(true);
		expect(projectFeaturePolicy(ROUGH_CUT_FEATURE)(h.doc, p)).toEqual({ allowed: true });
	});
});

describe('rough-cut input (AF-PROP-002)', () => {
	it('builds a draft: ids by index, the strategy as the summary, beat / quote / reason in meta', () => {
		const { h, a, b } = seeded();
		const parsed = RoughCutInputSchema.parse(
			input(h.seqId, [
				{
					group: 'removed',
					beat: 'False start',
					quote: 'So, um, today we',
					reason: 'Restart: the take two lines later is clean',
					commands: [{ type: 'clip.extract', clipIds: [a.id] }],
				},
				{
					group: 'selects',
					reason: 'Best delivery of the demo line',
					commands: [
						{ type: 'clip.move', clipIds: [b.id], deltaFrames: 0, deltaTracks: 1, createTracks: true },
					],
					alternatives: [
						{
							label: 'Keep on V1',
							reason: 'If the overlay hides too much',
							commands: [{ type: 'clip.trim', clipId: b.id, edge: 'out', deltaFrames: -10 }],
						},
					],
				},
			]),
		);
		const draft = roughCutDraft(parsed);
		expect(draft).toMatchObject({
			feature: 'rough-cut',
			sequenceId: h.seqId,
			title: 'Tight cut',
			summary: parsed.strategy,
		});
		expect(draft.items.map((i) => [i.id, i.label, i.group])).toEqual([
			['e0', 'False start: Restart: the take two lines later is clean', 'removed'],
			['e1', 'Best delivery of the demo line', 'selects'],
		]);
		expect(draft.items[0]!.meta).toEqual({
			group: 'removed',
			reason: 'Restart: the take two lines later is clean',
			beat: 'False start',
			quote: 'So, um, today we',
		});
		expect(draft.items[1]!.alternatives).toEqual([
			{
				label: 'Keep on V1',
				meta: { reason: 'If the overlay hides too much' },
				commands: [{ type: 'clip.trim', clipId: b.id, edge: 'out', deltaFrames: -10 }],
			},
		]);
		const p = create(h, draft);
		expect(p.items.map((i) => i.state)).toEqual(['pending', 'pending']);
		expect(p.summary).toBe(parsed.strategy);
		expect(roughCutMetaOf(p.items[0]!.meta)).toEqual({
			group: 'removed',
			reason: 'Restart: the take two lines later is clean',
			beat: 'False start',
			quote: 'So, um, today we',
		});
	});

	it('refuses a bad group, out-of-range text and too many items or commands', () => {
		const cmd = { type: 'marker.add', frame: 1 };
		const item = { group: 'selects', reason: 'Keep it', commands: [cmd] };
		const bad = (v: unknown) => RoughCutInputSchema.safeParse(v);
		expect(bad(input('seq', [item])).success).toBe(true);
		const issue = (v: unknown) => {
			const r = bad(v);
			expect(r.success).toBe(false);
			return r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
		};
		expect(issue(input('seq', [{ ...item, group: 'keepers' }]))).toMatch(/^items\.0\.group/);
		expect(issue(input('seq', [{ ...item, reason: '' }]))).toMatch(/^items\.0\.reason/);
		expect(issue(input('seq', [{ ...item, reason: 'x'.repeat(281) }]))).toMatch(/^items\.0\.reason/);
		expect(issue(input('seq', [{ ...item, beat: 'x'.repeat(41) }]))).toMatch(/^items\.0\.beat/);
		expect(issue(input('seq', [{ ...item, quote: 'x'.repeat(281) }]))).toMatch(/^items\.0\.quote/);
		expect(issue(input('seq', [{ ...item, commands: [] }]))).toMatch(/^items\.0\.commands/);
		expect(issue(input('seq', [{ ...item, commands: Array(101).fill(cmd) }]))).toMatch(/^items\.0\.commands/);
		expect(issue(input('seq', [{ ...item, extra: 1 }]))).toMatch(/^items\.0/);
		expect(issue(input('seq', []))).toMatch(/^items/);
		expect(issue(input('seq', Array(201).fill(item)))).toMatch(/^items/);
		// 2 000 commands in all (alternatives included)
		const full = { ...item, commands: Array(100).fill(cmd) };
		expect(bad(input('seq', Array(20).fill(full))).success).toBe(true);
		expect(issue(input('seq', [...Array(20).fill(full), item]))).toMatch(/at most 2000 commands/);
		const withAlt = { ...full, alternatives: [{ label: 'other', commands: [cmd] }] };
		expect(issue(input('seq', [...Array(19).fill(full), withAlt]))).toMatch(/at most 2000 commands/);
		// the strategy: 1–8 sentences, at most 2 000 characters
		expect(issue(input('seq', [item], { strategy: '' }))).toMatch(/^strategy/);
		expect(issue(input('seq', [item], { strategy: `${'x'.repeat(1999)}.!` }))).toMatch(/^strategy/);
		expect(
			issue(input('seq', [item], { strategy: 'One. Two. Three. Four. Five. Six. Seven. Eight. Nine.' })),
		).toMatch(/8 sentences/);
		expect(
			bad(input('seq', [item], { strategy: 'One. Two. Three. Four. Five. Six. Seven. Eight.' })).success,
		).toBe(true);
	});

	it('counts sentences by their ends, not by abbreviations or decimals', () => {
		expect(strategySentences('Cut the intro.')).toBe(1);
		expect(strategySentences('Cut the intro')).toBe(1);
		expect(strategySentences('Keep take 2.5 of the demo, e.g. the calm one. Then the outro!')).toBe(2);
		expect(strategySentences('Why? Because. It works…')).toBe(3);
		expect(strategySentences('   ')).toBe(0);
		fc.assert(
			fc.property(fc.string({ maxLength: 400 }), (s) => {
				const k = strategySentences(s);
				expect(Number.isInteger(k) && k >= 0 && k <= s.length).toBe(true);
			}),
		);
	});

	it('reads meta leniently (never throws)', () => {
		expect(roughCutMetaOf(undefined)).toBeNull();
		expect(roughCutMetaOf({ reason: 7 })).toBeNull();
		expect(roughCutMetaOf({ group: 'selects', reason: 'Keep', beat: 3, quote: 'q' })).toEqual({
			group: 'selects',
			reason: 'Keep',
			quote: 'q',
		});
		fc.assert(
			fc.property(fc.anything(), (v) => {
				roughCutMetaOf(v);
			}),
		);
	});
});

describe('proposalItemFailures', () => {
	it('lists every failing item by index with its command error (alternatives included)', () => {
		const { h, a, b, c } = seeded();
		const draft = roughCutDraft(
			RoughCutInputSchema.parse(
				input(h.seqId, [
					{
						group: 'selects',
						reason: 'fine',
						commands: [{ type: 'clip.trim', clipId: a.id, edge: 'out', deltaFrames: -5 }],
					},
					{
						group: 'removed',
						reason: 'gone clip',
						commands: [
							{ type: 'marker.add', frame: 3 },
							{ type: 'clip.extract', clipIds: ['clp_ZZZZZZZZZZZZZZZZ'] },
						],
					},
					{
						group: 'reorder',
						reason: 'alt fails',
						commands: [
							{ type: 'clip.move', clipIds: [c.id], deltaFrames: 0, deltaTracks: 1, createTracks: true },
						],
						alternatives: [
							{ label: 'bad', commands: [{ type: 'clip.lift', clipIds: ['clp_YYYYYYYYYYYYYYYY'] }] },
						],
					},
					{
						group: 'other',
						reason: 'b ok',
						commands: [{ type: 'clip.trim', clipId: b.id, edge: 'in', deltaFrames: 5 }],
					},
				]),
			),
		);
		const p = create(h, draft);
		expect(p.items.map((i) => i.state)).toEqual(['pending', 'invalid', 'pending', 'pending']);
		const failures = proposalItemFailures(h.doc, p, { ...CTX, revision: h.revision });
		expect(failures).toEqual([
			{
				index: 1,
				itemId: 'e1',
				code: 'E_NOT_FOUND',
				message: expect.any(String),
				commandIndex: 1,
			},
			{
				index: 2,
				itemId: 'e2',
				alternative: 1,
				code: 'E_NOT_FOUND',
				message: expect.any(String),
				commandIndex: 0,
			},
		]);
		// a valid proposal has none
		const ok = create(
			h,
			roughCutDraft(
				RoughCutInputSchema.parse(
					input(h.seqId, [
						{ group: 'selects', reason: 'fine', commands: [{ type: 'marker.add', frame: 1 }] },
					]),
				),
			),
		);
		expect(proposalItemFailures(h.doc, ok, CTX)).toEqual([]);
	});

	it('items that apply alone but not together are failures too', () => {
		const { h, a } = seeded();
		const both = (id: string) => ({
			group: 'removed',
			reason: id,
			commands: [{ type: 'clip.extract', clipIds: [a.id] }],
		});
		const p = create(h, roughCutDraft(RoughCutInputSchema.parse(input(h.seqId, [both('x'), both('y')]))));
		expect(p.items.map((i) => i.state)).toEqual(['pending', 'invalid']);
		const [f] = proposalItemFailures(h.doc, p, CTX);
		expect(f).toMatchObject({ index: 1, itemId: 'e1', code: 'E_CONFLICT', commandIndex: null });
		expect(f!.message).toMatch(/conflicts with the items before it/);
	});
});

describe('expectedRevision in proposal dry runs (fast-forward rule)', () => {
	it('an item touching an entity changed since expectedRevision is invalid; others pass', () => {
		const { h, a, b } = seeded();
		const planned = h.revision;
		// the user trims B after the agent read the document
		h.ok([{ type: 'clip.trim', clipId: b.id, edge: 'out', deltaFrames: -10 }]);
		const draft = roughCutDraft(
			RoughCutInputSchema.parse(
				input(h.seqId, [
					{ group: 'removed', reason: 'A', commands: [{ type: 'clip.lift', clipIds: [a.id] }] },
					{ group: 'removed', reason: 'B', commands: [{ type: 'clip.lift', clipIds: [b.id] }] },
				]),
			),
		);
		const ctx: ProposalContext = { ...CTX, expectedRevision: planned, entityRevisions: h.entityRevisions };
		const p = create(h, draft, ctx);
		expect(p.items.map((i) => i.state)).toEqual(['pending', 'invalid']);
		expect(p.items[1]!.reason).toMatch(/E_REVISION_MISMATCH/);
		expect(proposalItemFailures(h.doc, p, { ...ctx, revision: h.revision })).toMatchObject([
			{ index: 1, code: 'E_REVISION_MISMATCH' },
		]);
		// without a revision map every item is stale (unknown history: S01:AGT-010)
		const blind = create(h, draft, { ...CTX, expectedRevision: planned });
		expect(blind.items.map((i) => i.state)).toEqual(['invalid', 'invalid']);
		// at the current revision nothing is stale
		const now = create(h, draft, {
			...CTX,
			expectedRevision: h.revision,
			entityRevisions: h.entityRevisions,
		});
		expect(now.items.map((i) => i.state)).toEqual(['pending', 'pending']);
	});
});
