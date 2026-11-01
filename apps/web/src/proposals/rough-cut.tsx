// An agent's rough cut in the Review panel (spec 18 AF-PROP-003): the proposal's strategy above its items, and per
// row the beat chip, the quote and the reason (`meta` of `propose_edits` items, read leniently by `roughCutMetaOf`).
// Decisions, ghosts, A/B, Apply n of m and stale handling are the panel's own, unchanged.
import { ROUGH_CUT_FEATURE, type RoughCutMeta, roughCutMetaOf } from '@jasper/project';
import { t } from '../i18n/runtime.ts';

/** The rough-cut meta of an item of a rough-cut proposal (null for any other feature or a meta without a reason). */
export function cutMetaFor(feature: string | undefined, meta: unknown): RoughCutMeta | null {
	return feature === ROUGH_CUT_FEATURE ? roughCutMetaOf(meta) : null;
}

/** "“…”" around a quote. */
export function quoted(quote: string): string {
	return t('“{0}”', quote);
}

/** The strategy of a rough cut, above its items (scrolls when long). */
export function RoughCutStrategy({ text }: { text: string }) {
	return (
		<section
			aria-label={t('Strategy')}
			className="max-h-24 shrink-0 overflow-auto border-b border-pr-border px-2 py-1 text-pr-small"
			data-testid="review-strategy"
		>
			<span className="font-semibold text-pr-strong">{t('Strategy')}</span>{' '}
			<span className="whitespace-pre-wrap text-pr-text">{text}</span>
		</section>
	);
}

/** The beat chip of a row ("Hook"). */
export function CutBeat({ beat }: { beat: string }) {
	return (
		<span
			className="max-w-[40%] shrink-0 truncate rounded-pr-control border border-pr-border px-1 text-pr-small text-pr-muted"
			title={t('Beat: {0}', beat)}
			data-review-beat
		>
			{beat}
		</span>
	);
}

/** The reason of a row, in the place of its label. */
export function CutReason({ reason }: { reason: string }) {
	return (
		<span className="min-w-0 flex-1 truncate" title={reason} data-review-cut-reason>
			{reason}
		</span>
	);
}

/** The words a row keeps or cuts, quoted. */
export function CutQuote({ quote }: { quote: string }) {
	const q = quoted(quote);
	return (
		<span className="min-w-0 truncate italic" title={q} data-review-quote>
			{q}
		</span>
	);
}

/** The row's beat and quote for its accessible name ("beat Hook. “…”"). */
export function cutAriaText(m: RoughCutMeta): string {
	return [m.beat ? t('beat {0}', m.beat) : null, m.quote ? quoted(m.quote) : null].filter(Boolean).join('. ');
}
