// Spec 19 TL-101, TL-098: a title as a proposal: the feature, the draft, colourways as item alternatives, one undo step on
// accept, and the lenient reader the Review panel uses.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	agentProposalsAllowed,
	createProposal,
	defaultRegistries,
	MAX_TITLE_ART_CHECK_BYTES,
	PROPOSAL_LIMITS,
	type ProposalContext,
	ProposalSchema,
	previewProposal,
	projectSettingFeatures,
	proposalFeatureInfo,
	TITLE_ART_FEATURE,
	TITLE_ART_GROUP,
	TITLE_ART_ITEM_ID,
	type TitleCheckRow,
	titleArtCheck,
	titleArtCheckOf,
	titleArtDraft,
	titleArtMetaOf,
	utf8Length,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const CTX: ProposalContext = { registries: defaultRegistries(), now: () => '2026-11-02T10:00:00.000Z' };
const recipe = { palette: { face: [1, 0, 0, 1] }, layers: [{ type: 'face' }] };
const meta = (colorwayName?: string) => ({
	text: 'Hello',
	lookName: 'Plain',
	seed: 4,
	clipRef: '$title',
	...(colorwayName ? { colorwayId: colorwayName.toLowerCase(), colorwayName } : {}),
});
const commands = (palette: number[]) => [
	{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Hello' }, ref: '$title' },
	{
		type: 'look.apply',
		clipIds: ['$title'],
		look: { name: 'Plain', recipe: { ...recipe, palette: { face: palette } } },
		seed: 4,
	},
];

function draft(sequenceId: string) {
	return titleArtDraft({
		sequenceId,
		title: 'Title: Hello',
		summary: 'Plain',
		option: { label: 'Plain', commands: commands([1, 0, 0, 1]), meta: meta() },
		alternatives: [{ label: 'Plain, Blue', commands: commands([0, 0, 1, 1]), meta: meta('Blue') }],
	});
}

describe('title-art feature', () => {
	it('is a project-setting feature, on by default, produced by title_propose', () => {
		const f = proposalFeatureInfo(TITLE_ART_FEATURE)!;
		expect(f).toMatchObject({
			producers: ['title_propose'],
			agentAccept: { setting: 'project', default: true },
		});
		expect(f.groups.map((g) => g.id)).toEqual([TITLE_ART_GROUP]);
		expect(projectSettingFeatures().map((x) => x.id)).toContain(TITLE_ART_FEATURE);
		expect(agentProposalsAllowed(new Harness().doc, TITLE_ART_FEATURE)).toBe(true);
	});
});

describe('title-art draft', () => {
	it('is one item with its colourways as alternatives', () => {
		const d = draft('seq_1');
		expect(d).toMatchObject({ feature: TITLE_ART_FEATURE, sequenceId: 'seq_1', title: 'Title: Hello' });
		expect(d.items).toHaveLength(1);
		const item = d.items[0]!;
		expect(item.id).toBe(TITLE_ART_ITEM_ID);
		expect(item.group).toBe(TITLE_ART_GROUP);
		expect(item.alternatives?.map((a) => a.label)).toEqual(['Plain, Blue']);
		expect(titleArtMetaOf(item)).toMatchObject({ lookName: 'Plain', group: 'titles', seed: 4 });
		expect(titleArtMetaOf(item.alternatives![0]!)).toMatchObject({ colorwayName: 'Blue' });
	});

	it('cuts long titles and labels to the proposal limits, and leaves alternatives out when there are none', () => {
		const long = 'x'.repeat(PROPOSAL_LIMITS.maxTitle + 50);
		const d = titleArtDraft({
			sequenceId: 'seq_1',
			title: long,
			option: {
				label: 'y'.repeat(PROPOSAL_LIMITS.maxLabel + 50),
				commands: commands([1, 0, 0, 1]),
				meta: meta(),
			},
			alternatives: [],
		});
		expect(d.title.length).toBe(PROPOSAL_LIMITS.maxTitle);
		expect(d.items[0]!.label.length).toBe(PROPOSAL_LIMITS.maxLabel);
		expect('alternatives' in d.items[0]!).toBe(false);
	});

	it('reads meta leniently', () => {
		expect(titleArtMetaOf({})).toBeNull();
		expect(titleArtMetaOf({ meta: { text: 3 } })).toBeNull();
		expect(titleArtMetaOf({ meta: { ...meta(), future: true } })).toMatchObject({ future: true });
	});

	it('validates as a proposal, and each alternative previews its own colour', () => {
		const h = new Harness();
		const r = createProposal(
			h.doc,
			draft(h.seqId),
			{
				id: 'prp_0000000000000001',
				projectId: h.doc.projectId,
				author: { agent: 'test' },
				now: '2026-11-02T10:00:00.000Z',
				revision: h.revision,
			},
			CTX,
		);
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const { proposal } = r;
		expect(proposal.items[0]!.state).toBe('pending');
		const faceOf = (selectedAlternative: number) => {
			const p = {
				...proposal,
				items: proposal.items.map((i) => ({ ...i, selectedAlternative })),
			};
			const v = previewProposal(h.doc, p, [TITLE_ART_ITEM_ID], { ...CTX, checkInvariants: false });
			expect(v.failed).toEqual({});
			const clips = Object.values(v.document.sequences[h.seqId]!.clips) as unknown as {
				effects: { appearance: { palette: { face: { value: number[] } } } }[];
			}[];
			return clips[0]!.effects[0]!.appearance.palette.face.value;
		};
		expect(faceOf(0)).toEqual([1, 0, 0, 1]);
		expect(faceOf(1)).toEqual([0, 0, 1, 1]);
	});
});

describe('title-art check on the item (rendered rows for Review)', () => {
	const row = (id: string, status: TitleCheckRow['status'], message = `${id} measured`): TitleCheckRow => ({
		id,
		kind: 'format',
		status,
		measured: { ratio: 4.2 },
		expected: '≥ 3:1',
		at: { frame: 30, sec: 1, timecode: '00:00:01:00' },
		message,
		...(status === 'fail' ? { fix: { label: 'Add a dark rim' } } : {}),
	});
	const body = (rows: TitleCheckRow[]) => ({
		revision: 3,
		verified: !rows.some((r) => r.status === 'fail'),
		counts: { pass: 0, warn: 0, fail: 0, unverified: 0 },
		rows,
		notChecked: ['Taste.'],
	});

	it('travels in the option meta through the proposal schema, and an older reader keeps the rest', () => {
		const h = new Harness();
		const d = draft(h.seqId);
		const check = titleArtCheck(body([row('safe-area', 'pass'), row('contrast', 'fail')]));
		const item = d.items[0]!;
		const withCheck = { ...d, items: [{ ...item, meta: { ...(item.meta as object), check } }] };
		const r = createProposal(
			h.doc,
			withCheck,
			{
				id: 'prp_0000000000000002',
				projectId: h.doc.projectId,
				author: { agent: 'test' },
				now: '2026-11-02T10:00:00.000Z',
				revision: h.revision,
			},
			CTX,
		);
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		// what the engine's store writes and reads back
		const stored = ProposalSchema.parse(JSON.parse(JSON.stringify(r.proposal)));
		expect(titleArtCheckOf(stored.items[0]!)).toEqual(check);
		expect(titleArtMetaOf(stored.items[0]!)).toMatchObject({ lookName: 'Plain', seed: 4 });
		expect(titleArtCheckOf(stored.items[0]!.alternatives![0]!)).toBeNull();
	});

	it('reads leniently: no check, or a bad one, is null and leaves the meta readable', () => {
		expect(titleArtCheckOf({})).toBeNull();
		expect(titleArtCheckOf({ meta: 'x' })).toBeNull();
		const bad = { meta: { ...meta(), check: { rows: 'nope' } } };
		expect(titleArtCheckOf(bad)).toBeNull();
		expect(titleArtMetaOf(bad)).toMatchObject({ text: 'Hello' });
		expect(titleArtCheckOf({ meta: { check: { ...titleArtCheck(body([])), future: 1 } } })).toMatchObject({
			future: 1,
		});
	});

	it('stays within its budget, dropping passes before anything that needs attention, and says how many', () => {
		const long = 'x'.repeat(1500);
		const rows = [
			row('contrast', 'fail', long),
			...Array.from({ length: 40 }, (_, i) => row(`lint-${i}`, 'pass', long)),
			row('read-time', 'warn', long),
		];
		const c = titleArtCheck(body(rows));
		expect(utf8Length(JSON.stringify(c))).toBeLessThanOrEqual(MAX_TITLE_ART_CHECK_BYTES);
		expect(c.omitted).toBeGreaterThan(0);
		expect(c.rows.length + c.omitted!).toBe(rows.length);
		expect(c.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['contrast', 'read-time']));
		expect(titleArtCheck(body(rows.slice(0, 2))).omitted).toBeUndefined();
	});

	it('any rows give a readable check within the budget (fuzz)', () => {
		const status = fc.constantFrom('pass', 'warn', 'fail', 'unverified') as fc.Arbitrary<
			TitleCheckRow['status']
		>;
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.string({ maxLength: 100 }), status, fc.string({ maxLength: 3000 })), {
					maxLength: 300,
				}),
				(spec) => {
					const c = titleArtCheck(body(spec.map(([id, st, m]) => row(id, st, m))));
					expect(utf8Length(JSON.stringify(c))).toBeLessThanOrEqual(MAX_TITLE_ART_CHECK_BYTES);
					expect(c.rows.length + (c.omitted ?? 0)).toBe(spec.length);
					expect(titleArtCheckOf({ meta: { check: c } })).toEqual(c);
				},
			),
			{ numRuns: 200 },
		);
	});
});
