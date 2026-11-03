// Spec 19 TL-098: an agent's title in Review: a poster of the option under review and of its alternatives, colourways among
// them, each on the proposal's own words. Choosing one selects that alternative; A/B (Compare) shows it in Program.
// `meta` is the agent's and is read leniently: what cannot be read shows no picture, never a failure.
import type { LookPosterRequest } from '@jasper/api';
import { LookRecipeSchema, type ProjectDocument, type ProposalItem } from '@jasper/project';
import { cx } from '@jasper/ui';
import { useMemo } from 'react';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { lookEntries } from '../title-looks/library.ts';
import { type PosterStore, posterRequest, posterStoreFor, usePoster } from '../title-looks/posters.ts';

export const TITLE_ART_FEATURE = 'title-art';

/** Whether a proposal changes what is seen: its A/B compares pictures rather than hears a mix. */
export const isVisualProposal = (feature: string | undefined) => feature === TITLE_ART_FEATURE;

const MetaSchema = z.looseObject({
	text: z.string().max(2000),
	lookId: z.string().max(128).optional(),
	lookName: z.string().max(120).optional(),
	colorwayId: z.string().max(128).optional(),
	colorwayName: z.string().max(120).optional(),
});

const ApplySchema = z.looseObject({
	type: z.literal('look.apply'),
	look: z.looseObject({ recipe: z.unknown() }).optional(),
	lookId: z.string().optional(),
});
const WaySchema = z.looseObject({ type: z.literal('look.setColorway'), palette: z.unknown() });

export type TitleArtOption = { label: string; request: LookPosterRequest | null };

type OptionSource = { label: string; commands: readonly unknown[]; meta?: unknown };

/** What one option draws: the look in its commands, or the look it names, in the option's colours and words. */
function optionRequest(doc: ProjectDocument, o: OptionSource, width: number): LookPosterRequest | null {
	const meta = MetaSchema.safeParse(o.meta);
	if (!meta.success) return null;
	const entries = lookEntries(doc);
	const named = (id: string | undefined) => (id ? entries.find((e) => e.lookId === id) : undefined);
	let recipe: unknown = null;
	let palette: unknown = null;
	let entry = named(meta.data.lookId);
	for (const c of o.commands) {
		const a = ApplySchema.safeParse(c);
		if (a.success) {
			recipe = a.data.look?.recipe ?? null;
			entry ??= named(a.data.lookId);
		}
		const w = WaySchema.safeParse(c);
		if (w.success) palette = w.data.palette;
	}
	const parsed = LookRecipeSchema.safeParse(recipe ?? entry?.recipe);
	if (!parsed.success) return null;
	const way = meta.data.colorwayId ? entry?.colorways.find((c) => c.id === meta.data.colorwayId) : undefined;
	const colours = palette && typeof palette === 'object' ? { palette } : (way ?? null);
	return posterRequest(
		parsed.data,
		colours as Parameters<typeof posterRequest>[1],
		{ text: meta.data.text.split('\n')[0] ?? '' },
		width,
	);
}

/** The options of a title item, its own first. */
export function titleArtOptions(doc: ProjectDocument, item: ProposalItem, width = 240): TitleArtOption[] {
	const own: OptionSource = { label: item.label, commands: item.commands, meta: item.meta };
	return [own, ...(item.alternatives ?? [])].map((o) => ({
		label: o.label,
		request: optionRequest(doc, o as OptionSource, width),
	}));
}

function Poster(props: { store: PosterStore | null; request: LookPosterRequest; label: string }) {
	const poster = usePoster(props.store, props.request);
	if (poster.state === 'ready')
		return <img src={poster.url} alt={props.label} className="block w-full rounded-pr-control" />;
	return (
		<span
			className="flex aspect-video w-full items-center justify-center rounded-pr-control bg-pr-field-deep p-1 text-center text-pr-small text-pr-muted"
			title={poster.state === 'error' ? poster.message : undefined}
		>
			{poster.state === 'error' ? t('No preview') : t('Rendering…')}
		</span>
	);
}

export function TitleArtDetails(props: {
	doc: ProjectDocument;
	item: ProposalItem | null;
	selected: number;
	disabled: boolean;
	onSelect(alternative: number): void;
}) {
	const { doc, item } = props;
	const client = useEngineOrNull()?.client ?? null;
	const store = useMemo(() => (client ? posterStoreFor(client) : null), [client]);
	const options = useMemo(() => (item ? titleArtOptions(doc, item) : []), [doc, item]);
	const shown = options[props.selected];
	if (!shown?.request) return null;
	return (
		<div className="flex flex-col gap-1" data-testid="title-art-details">
			<Poster store={store} request={shown.request} label={shown.label} />
			{options.length > 1 ? (
				<div className="grid grid-cols-4 gap-1" role="group" aria-label={t('Alternates')}>
					{options.map((o, i) =>
						o.request ? (
							<button
								// biome-ignore lint/suspicious/noArrayIndexKey: options are positional, like the alternates they select
								key={i}
								type="button"
								aria-pressed={i === props.selected}
								aria-label={o.label}
								title={o.label}
								disabled={props.disabled}
								className={cx(
									'overflow-hidden rounded-pr-control border',
									i === props.selected ? 'border-pr-focus' : 'border-pr-border-subtle',
								)}
								onClick={() => props.onSelect(i)}
								data-testid={`title-art-option-${i}`}
							>
								<Poster store={store} request={o.request} label={o.label} />
							</button>
						) : null,
					)}
				</div>
			) : null}
		</div>
	);
}
