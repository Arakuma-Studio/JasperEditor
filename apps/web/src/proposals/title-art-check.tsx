// Spec 19 TL-098 / TL-102: the rendered check `title_propose` stored with a title proposal (`meta.check`, read with
// `titleArtCheckOf`), in Review: each row's status, what was measured against what was expected, the frame it was measured
// at and the fix's label. Only the first option is measured, so an alternate says it has no rows rather than showing none.
// The check is the agent's data, read leniently: values of any shape are shown as short text and never throw.
import type { TitleArtCheck } from '@jasper/project';
import { cx } from '@jasper/ui';
import { t } from '../i18n/runtime.ts';

type Row = TitleArtCheck['rows'][number];
type Status = Row['status'];

const STATUS: Record<Status, { label: string; tone: string; rank: number }> = {
	fail: { label: 'Fail', tone: 'text-pr-danger', rank: 0 },
	warn: { label: 'Warn', tone: 'text-pr-warning', rank: 1 },
	unverified: { label: 'Not checked', tone: 'text-pr-muted', rank: 2 },
	pass: { label: 'Pass', tone: 'text-pr-success', rank: 3 },
};

/** Names of `title_check`'s rows; a style lint row (`lint-<issue>`) and an unknown id show as they are. */
const ROW_LABELS: Record<string, string> = {
	'safe-area': 'Safe area',
	'target-safe-area': 'Platform safe area',
	'off-frame': 'Off the frame',
	contrast: 'Contrast',
	'min-size': 'Text size',
	'read-time': 'Reading time',
	'font-available': 'Font',
	'export-path': 'Export path',
	lint: 'Style check',
};

export const titleCheckRowLabel = (id: string): string =>
	ROW_LABELS[id] ? t(ROW_LABELS[id]) : id.startsWith('lint-') ? t('Style: {0}', id.slice(5)) : id;

/** Longest text a measured or expected value takes. */
const MAX_VALUE_TEXT = 200;
/** Items of a list shown before "…". */
const MAX_LIST = 4;
/** Levels of nesting shown before "…". */
const MAX_DEPTH = 3;

const roundNumber = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '—');

function valueText(v: unknown, depth: number): string {
	if (v === null || v === undefined) return '—';
	if (typeof v === 'number') return roundNumber(v);
	if (typeof v === 'string') return v;
	if (typeof v === 'boolean') return v ? t('yes') : t('no');
	if (depth >= MAX_DEPTH || typeof v !== 'object') return '…';
	if (Array.isArray(v)) {
		const shown = v.slice(0, MAX_LIST).map((x) => valueText(x, depth + 1));
		return `[${shown.join(', ')}${v.length > MAX_LIST ? ', …' : ''}]`;
	}
	const parts = Object.entries(v as Record<string, unknown>).map(([k, x]) => {
		const inner = valueText(x, depth + 1);
		return depth > 0 && x !== null && typeof x === 'object' ? `${k} (${inner})` : `${k} ${inner}`;
	});
	return parts.join(depth > 0 ? ', ' : '; ');
}

/** A measured or expected value as one short line: numbers rounded, objects as `key value` pairs, cut to length. */
export function checkValueText(v: unknown): string {
	const s = valueText(v, 0);
	return s.length > MAX_VALUE_TEXT ? `${s.slice(0, MAX_VALUE_TEXT - 1)}…` : s;
}

/** Rows that need attention first: fail, warn, not checked, pass; the stored order within each. */
export function sortedCheckRows(rows: readonly Row[]): Row[] {
	return rows
		.map((r, i) => ({ r, i }))
		.sort((a, b) => STATUS[a.r.status].rank - STATUS[b.r.status].rank || a.i - b.i)
		.map((x) => x.r);
}

/** "2 fail · 1 warn · 5 pass", leaving out the statuses with no row. */
export function checkCountsText(counts: TitleArtCheck['counts']): string {
	return (['fail', 'warn', 'unverified', 'pass'] as const)
		.filter((s) => counts[s] > 0)
		.map((s) => `${counts[s]} ${t(STATUS[s].label).toLowerCase()}`)
		.join(' · ');
}

function CheckRow(props: { row: Row }) {
	const r = props.row;
	const s = STATUS[r.status];
	const hasValues = r.measured !== undefined || r.expected !== undefined;
	return (
		<li
			className="flex flex-col gap-0.5 border-b border-pr-border-subtle py-1 last:border-b-0"
			data-testid="title-art-check-row"
			data-row-id={r.id}
			data-status={r.status}
		>
			<div className="flex min-w-0 items-center gap-1.5">
				<span className={cx('shrink-0 font-semibold', s.tone)}>{t(s.label)}</span>
				<span className="min-w-0 truncate text-pr-strong">{titleCheckRowLabel(r.id)}</span>
				{r.at ? (
					<span
						className="ml-auto shrink-0 font-pr-mono text-pr-small text-pr-timecode"
						title={t('Measured at this frame')}
						data-testid="title-art-check-at"
					>
						{r.at.timecode}
					</span>
				) : null}
			</div>
			<p className="text-pr-text">{r.message}</p>
			{hasValues ? (
				<p className="break-words text-pr-dim" data-testid="title-art-check-values">
					{t('Measured {0} · expected {1}', checkValueText(r.measured), checkValueText(r.expected))}
				</p>
			) : null}
			{r.fix ? (
				<p className="text-pr-muted" data-testid="title-art-check-fix">
					{t('Fix: {0}', r.fix.label)}
				</p>
			) : null}
		</li>
	);
}

/** The stored check of the option under review. */
export function TitleArtCheckView(props: { check: TitleArtCheck }) {
	const { check } = props;
	const rows = sortedCheckRows(check.rows);
	const counts = checkCountsText(check.counts);
	return (
		<section
			className="flex flex-col gap-0.5"
			aria-label={t('Title check')}
			data-testid="title-art-check"
			data-verified={check.verified}
		>
			<div className="flex flex-wrap items-baseline gap-x-1.5">
				<span className="font-semibold text-pr-strong">{t('Title check')}</span>
				{counts ? <span className="text-pr-muted">{counts}</span> : null}
			</div>
			{check.pending ? (
				<p className="text-pr-warning" data-testid="title-art-check-pending">
					{t(
						'Pending: the renders took longer than the agent waited, so only the rows that need no picture are here.',
					)}
				</p>
			) : null}
			{rows.length ? (
				<ul className="list-none">
					{rows.map((r, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: ids repeat (a contrast row per part); the stored rows never reorder
						<CheckRow key={`${r.id}-${i}`} row={r} />
					))}
				</ul>
			) : null}
			{check.omitted ? (
				<p className="text-pr-muted" data-testid="title-art-check-omitted">
					{t('{0} more rows were left out to keep the proposal small, passes first.', check.omitted)}
				</p>
			) : null}
			{check.notChecked.length ? (
				<p className="text-pr-muted" data-testid="title-art-check-not-checked">
					{t('Not measured: {0}', check.notChecked.join(' · '))}
				</p>
			) : null}
		</section>
	);
}

/** What an alternate says in place of rows: the agent measured only the first option. */
export function TitleArtAlternateUnchecked() {
	return (
		<p className="text-pr-muted" data-testid="title-art-check-alternate">
			{t('This alternate has no check rows: the agent measured only the first option.')}
		</p>
	);
}
