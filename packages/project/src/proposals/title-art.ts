// A stylized title as a reviewable proposal (spec 19 TL-101, TL-098): one item per title, its colourways as the item's
// alternatives. `propose_title` builds the draft; `titleArtMetaOf` is the lenient reader the Review panel uses for the
// thumbnail and the swatches. The rendered check of the option `propose_title` measured travels in its meta (`check`,
// read by `titleArtCheckOf`): `meta` is opaque to the proposal schema, so this adds no field an older build would drop. Pure.
import { z } from 'zod';
import { utf8Length } from '../clipboard/payload.ts';
import type { TitleCheckRow } from '../title-looks/check.ts';
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
	/** The option's rendered check (`TitleArtCheckSchema`), read with `titleArtCheckOf` so a bad one hides nothing else. */
	check: z.unknown().optional(),
});
export type TitleArtMeta = z.infer<typeof TitleArtMetaSchema>;

/** Most bytes of JSON a stored check takes: well inside the 64 KB of an item's meta. */
export const MAX_TITLE_ART_CHECK_BYTES = 32 * 1024;
const MAX_CHECK_ROWS = 200;
const MAX_CHECK_TEXT = 2000;

const CheckRowSchema = z.looseObject({
	id: z.string().max(64),
	kind: z.enum(['format', 'judgement']),
	status: z.enum(['pass', 'warn', 'fail', 'unverified']),
	measured: z.unknown().optional(),
	expected: z.unknown().optional(),
	at: z
		.looseObject({ frame: z.number(), sec: z.number(), timecode: z.string().max(32) })
		.nullable()
		.optional(),
	message: z.string().max(MAX_CHECK_TEXT),
	/** A proposal's rows carry a label only: its clip has no id yet. */
	fix: z.looseObject({ label: z.string().max(500) }).optional(),
});

/**
 * `title_check`'s body for the option as `propose_title` rendered it: the rows, the verdict and the revision they hold
 * for. `pending`: the renders outlived the call, so only the rows that need no picture are here. `omitted`: rows left
 * out to stay within `MAX_TITLE_ART_CHECK_BYTES`, passes first.
 */
export const TitleArtCheckSchema = z.looseObject({
	revision: z.number().int().min(0).nullable(),
	verified: z.boolean(),
	counts: z.looseObject({
		pass: z.number().int().min(0),
		warn: z.number().int().min(0),
		fail: z.number().int().min(0),
		unverified: z.number().int().min(0),
	}),
	rows: z.array(CheckRowSchema).max(MAX_CHECK_ROWS),
	notChecked: z.array(z.string().max(MAX_CHECK_TEXT)).max(64),
	pending: z.boolean().optional(),
	omitted: z.number().int().min(0).optional(),
});
export type TitleArtCheck = z.infer<typeof TitleArtCheckSchema>;

const jsonBytes = (v: unknown) => utf8Length(JSON.stringify(v));

/** A check as an option's meta keeps it: within its byte budget, dropping passes before anything that needs attention. */
export function titleArtCheck(body: {
	revision: number | null;
	verified: boolean;
	counts: TitleArtCheck['counts'];
	rows: readonly TitleCheckRow[];
	notChecked: readonly string[];
	pending?: boolean;
}): TitleArtCheck {
	// Cut to what the reader accepts, so a stored check is never unreadable.
	const rows = body.rows.slice(0, MAX_CHECK_ROWS).map((r) => ({
		...r,
		id: clip(r.id, 64),
		message: clip(r.message, MAX_CHECK_TEXT),
		...(r.fix ? { fix: { ...r.fix, label: clip(r.fix.label, 500) } } : {}),
	}));
	let omitted = body.rows.length - rows.length;
	const out = (): TitleArtCheck => ({
		revision: body.revision,
		verified: body.verified,
		counts: { ...body.counts },
		rows: [...rows],
		notChecked: body.notChecked.slice(0, 64).map((n) => clip(n, MAX_CHECK_TEXT)),
		...(body.pending ? { pending: true } : {}),
		...(omitted ? { omitted } : {}),
	});
	while (rows.length && jsonBytes(out()) > MAX_TITLE_ART_CHECK_BYTES) {
		let drop = rows.length - 1;
		for (let i = rows.length - 1; i >= 0; i--)
			if (rows[i]!.status === 'pass') {
				drop = i;
				break;
			}
		rows.splice(drop, 1);
		omitted++;
	}
	return out();
}

/** The stored check of a title item or alternative, or null: none was stored (an alternative), or it is unreadable. */
export function titleArtCheckOf(item: { meta?: unknown }): TitleArtCheck | null {
	const meta = item.meta as { check?: unknown } | null | undefined;
	if (!meta || typeof meta !== 'object') return null;
	const r = TitleArtCheckSchema.safeParse(meta.check);
	return r.success ? r.data : null;
}

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
							alternatives: input.alternatives.slice(0, PROPOSAL_LIMITS.maxAlternatives).map((a) => ({
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
