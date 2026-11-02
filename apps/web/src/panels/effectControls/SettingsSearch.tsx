// Spec 19 TL-095: search in Effect Controls. Results are built from the rows the panel draws, and effects that could be added
// rank first, because "I want a glow" is the usual question. Choosing a setting opens its section and scrolls to it; adding
// an effect adds it to the clip shown. The selection never moves.
import type { EffectSpec } from '@jasper/project';
import { cx } from '@jasper/ui';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { fuzzyScore } from '../../shell/palette/fuzzy.ts';
import { type EcGroup, type FxSection, sectionRows } from './items.ts';

export type SearchHit =
	| { kind: 'add'; key: string; label: string; detail: string; effect: EffectSpec; score: number }
	| {
			kind: 'row';
			key: string;
			label: string;
			detail: string;
			section: FxSection;
			rowId: string;
			score: number;
	  };

const MAX_ADD = 5;
const MAX_ROWS = 12;

/** Effects to add, ranked by match; then the settings shown, ranked by match. */
export function settingsHits(
	query: string,
	groups: readonly EcGroup[],
	effects: readonly EffectSpec[],
	audio: boolean,
): SearchHit[] {
	const q = query.trim();
	if (!q) return [];
	const add: SearchHit[] = [];
	for (const e of effects) {
		if (e.internal || (e.appliesTo === 'audio') !== audio) continue;
		const score = fuzzyScore(q, [e.label, ...(e.keywords ?? [])].join(' '));
		if (score === null) continue;
		add.push({ kind: 'add', key: `add:${e.id}`, label: e.label, detail: e.category, effect: e, score });
	}
	const rows: SearchHit[] = [];
	for (const g of groups)
		for (const s of g.sections)
			for (const r of sectionRows(s)) {
				const score = fuzzyScore(q, `${r.label} ${s.title}`);
				if (score === null) continue;
				rows.push({
					kind: 'row',
					key: `row:${s.id}:${r.id}`,
					label: r.label,
					detail: s.title,
					section: s,
					rowId: r.id,
					score,
				});
			}
	const best = (a: SearchHit, b: SearchHit) => b.score - a.score;
	return [...add.sort(best).slice(0, MAX_ADD), ...rows.sort(best).slice(0, MAX_ROWS)];
}

export function SettingsSearch(props: {
	groups: readonly EcGroup[];
	effects: readonly EffectSpec[];
	audio: boolean;
	onAdd(effect: EffectSpec): void;
	onReveal(section: FxSection, rowId: string): void;
}) {
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const hits = useMemo(
		() => settingsHits(query, props.groups, props.effects, props.audio),
		[query, props.groups, props.effects, props.audio],
	);
	const index = Math.min(active, Math.max(0, hits.length - 1));
	const choose = (h: SearchHit | undefined) => {
		if (!h) return;
		setQuery('');
		setActive(0);
		if (h.kind === 'add') props.onAdd(h.effect);
		else props.onReveal(h.section, h.rowId);
	};
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (hits.length) setActive((index + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			choose(hits[index]);
		} else if (e.key === 'Escape') {
			if (query) {
				e.preventDefault();
				e.stopPropagation();
				setQuery('');
			} else e.currentTarget.blur();
		}
	};
	return (
		<div className="relative min-w-[120px] max-w-[220px] flex-1">
			<input
				type="search"
				aria-label="Search settings and effects"
				placeholder="Search settings"
				className="h-[20px] w-full rounded-pr-control bg-pr-field-deep px-2 text-pr-ui text-pr-text placeholder:text-pr-dim"
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setActive(0);
				}}
				onKeyDown={onKeyDown}
				data-testid="ec-search"
			/>
			{query.trim() ? (
				<div
					className="absolute top-full right-0 z-20 mt-[2px] max-h-[280px] w-[280px] overflow-y-auto rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 shadow-pr-overlay"
					role="listbox"
					aria-label="Results"
					data-testid="ec-search-results"
				>
					{hits.length === 0 ? <p className="px-2 py-1 text-pr-small text-pr-muted">No matches.</p> : null}
					{hits.map((h, i) => (
						<button
							key={h.key}
							type="button"
							role="option"
							aria-selected={i === index}
							data-kind={h.kind}
							className={cx(
								'flex w-full items-baseline gap-2 px-2 py-[2px] text-left text-pr-ui',
								i === index ? 'bg-pr-accent-fill text-pr-on-accent' : 'text-pr-text',
							)}
							onMouseMove={() => setActive(i)}
							// Before the input's blur, so the click lands.
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => choose(h)}
						>
							<span className="min-w-0 truncate">{h.kind === 'add' ? `Add ${h.label}` : h.label}</span>
							<span
								className={cx(
									'ml-auto shrink-0 truncate text-pr-small',
									i === index ? 'text-pr-on-accent' : 'text-pr-muted',
								)}
							>
								{h.detail}
							</span>
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
