// A stylized title as a reviewable proposal (spec 19 TL-101, TL-098): one item per title, its colourways as the item's
// alternatives. `propose_title` builds the draft; `titleArtMetaOf` is the lenient reader the Review panel uses for the
// thumbnail and the swatches. Pure.
import { z } from 'zod';
import { TITLE_ART_FEATURE } from './features.ts';
import { PROPOSAL_LIMITS, type ProposalDraft } from './schema.ts';

export const TITLE_ART_GROUP = 'titles';
/** The item's id: a `propose_title` holds one title. */
export const TITLE_ART_ITEM_ID = 'title';

/** What Review shows for an option (`meta` of the item and of each alternative). */
export const TitleArtMetaSchema = z.looseObject({
	group: z.literal(TITLE_ART_GROUP).optional(),
	text: z.string().max(2000),
	/** A project look, a library id, or absent for a recipe. */
	lookId: z.string().max(128).optional(),
	lookName: z.string().max(120),
	colorwayId: z.string().max(128).optional(),
	colorwayName: z.string().max(120).optional(),
	seed: z.number().int().min(0),
	/** The clip the item creates, as a temp ref of its commands. */
	clipRef: z.string().max(64),
	costClass: z.string().max(32).optional(),
	renderPath: z.string().max(32).optional(),
});
export type TitleArtMeta = z.infer<typeof TitleArtMetaSchema>;

export type TitleArtOption = { label: string; commands: Record<string, unknown>[]; meta: TitleArtMeta };

export type TitleArtInput = {
	sequenceId: string;
	title: string;
	summary?: string;
	/** Alternative 0. */
	option: TitleArtOption;
	alternatives: readonly TitleArtOption[];
};

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The proposal draft of a title (feature `title-art`, group `titles`). */
export function titleArtDraft(input: TitleArtInput): ProposalDraft {
	const { option } = input;
	return {
		feature: TITLE_ART_FEATURE,
		sequenceId: input.sequenceId,
		title: clip(input.title, PROPOSAL_LIMITS.maxTitle),
		...(input.summary ? { summary: clip(input.summary, PROPOSAL_LIMITS.maxSummary) } : {}),
		items: [
			{
				id: TITLE_ART_ITEM_ID,
				label: clip(option.label, PROPOSAL_LIMITS.maxLabel),
				group: TITLE_ART_GROUP,
				commands: option.commands,
				meta: { ...option.meta, group: TITLE_ART_GROUP },
				...(input.alternatives.length
					? {
							alternatives: input.alternatives
								.slice(0, PROPOSAL_LIMITS.maxAlternatives)
								.map((a) => ({
									label: clip(a.label, PROPOSAL_LIMITS.maxLabel),
									commands: a.commands,
									meta: a.meta,
								})),
						}
					: {}),
			},
		],
	};
}

/** The meta of a title item or alternative, or null when it is not one. Never throws. */
export function titleArtMetaOf(item: { meta?: unknown }): TitleArtMeta | null {
	const r = TitleArtMetaSchema.safeParse(item.meta);
	return r.success ? r.data : null;
}
