// The Review panel's row of a transcript fix (spec 17 SC-082): the text diff "context · ~~before~~ → after · context"
// on the row's first line, its category and confidence label (from Δ_tok, with the rule that decided it) on the
// second. Drawn inside the panel's own row (same heights, decision buttons, timecode, ▶, stale problem and "Not
// selected" marker), so a fix proposal uses the Review panel's structure and keys unchanged. Design tokens only.
import { t } from '../i18n/runtime.ts';
import {
	confidenceOf,
	FIX_CATEGORY_LABELS,
	type FixMeta,
	mediaTimeText,
	rowDiff,
	ruleLine,
} from './model.ts';

/** First line: the words as they read now and after the fix. */
export function FixDiff(p: { meta: FixMeta; label: string }) {
	const d = rowDiff(p.meta);
	const before = d.before.join(' ');
	const after = d.after.join(' ');
	const title = t('{0} → {1}', before || t('(nothing)'), after || t('(nothing)'));
	return (
		<span
			className="min-w-0 flex-1 truncate"
			title={`${d.contextBefore} ${title} ${d.contextAfter}`.trim()}
			data-fix-diff
		>
			{d.contextBefore ? <span className="text-pr-muted">{d.contextBefore} </span> : null}
			{before ? (
				<del className="text-pr-danger decoration-pr-danger" data-fix-before>
					{before}
				</del>
			) : (
				<span className="text-pr-muted" data-fix-before>
					+
				</span>
			)}
			<span className="text-pr-muted" aria-hidden="true">
				{' → '}
			</span>
			{after ? (
				<ins className="font-semibold text-pr-success no-underline" data-fix-after>
					{after}
				</ins>
			) : (
				<span className="text-pr-muted" data-fix-after>
					∅
				</span>
			)}
			{d.contextAfter ? <span className="text-pr-muted"> {d.contextAfter}</span> : null}
		</span>
	);
}

const LEVEL_TONE = {
	high: 'text-pr-success',
	medium: 'text-pr-text',
	low: 'text-pr-warning',
	none: 'text-pr-muted',
} as const;

/** Second line: category · confidence (the rule and Δ on hover) · where it is when the sequence does not play it. */
export function FixFacts(p: { meta: FixMeta; inSequence: boolean }) {
	const m = p.meta;
	const c = confidenceOf(m.deltaTok);
	const r = ruleLine(m);
	return (
		<>
			<span className="shrink-0" data-fix-category={m.category}>
				{FIX_CATEGORY_LABELS[m.category] ?? FIX_CATEGORY_LABELS.other}
			</span>
			<span
				className={`shrink-0 ${LEVEL_TONE[c.level]}`}
				title={`${r.rule}. ${r.tooltip}`}
				data-fix-confidence={c.level}
			>
				{r.confidence}
			</span>
			<span className="min-w-0 truncate" title={r.rule} data-fix-rule={m.rule}>
				{r.rule}
			</span>
			{!p.inSequence ? (
				<span
					className="shrink-0 pr-tabular"
					title={t('Not in the sequence: at {0} of the recording', mediaTimeText(m.start))}
					data-fix-source-time
				>
					{t('recording {0}', mediaTimeText(m.start))}
				</span>
			) : null}
		</>
	);
}

/** The accessible part of a fix row's name: "Glimer box to Glimmerbox, Name, High confidence, Audio check". */
export function fixAriaText(m: FixMeta): string {
	const before = m.asr.join(' ') || t('nothing');
	const after = m.script.join(' ') || t('nothing');
	return [
		t('{0} to {1}', before, after),
		FIX_CATEGORY_LABELS[m.category] ?? FIX_CATEGORY_LABELS.other!,
		ruleLine(m).confidence,
		ruleLine(m).rule,
	].join(', ');
}
