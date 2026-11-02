// Spec 19 TL-101, TL-098: a title as a proposal: the feature, the draft, colourways as item alternatives, one undo step on
// accept, and the lenient reader the Review panel uses.
import { describe, expect, it } from 'vitest';
import {
	agentProposalsAllowed,
	createProposal,
	defaultRegistries,
	PROPOSAL_LIMITS,
	type ProposalContext,
	proposalFeatureInfo,
	previewProposal,
	projectSettingFeatures,
	TITLE_ART_FEATURE,
	TITLE_ART_GROUP,
	TITLE_ART_ITEM_ID,
	titleArtDraft,
	titleArtMetaOf,
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
	it('is a project-setting feature, on by default, produced by propose_title', () => {
		const f = proposalFeatureInfo(TITLE_ART_FEATURE)!;
		expect(f).toMatchObject({ producers: ['propose_title'], agentAccept: { setting: 'project', default: true } });
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
			option: { label: 'y'.repeat(PROPOSAL_LIMITS.maxLabel + 50), commands: commands([1, 0, 0, 1]), meta: meta() },
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
