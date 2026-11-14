// Clean Up findings list (spec 14 TC-041): grouped by kind with counts, accept / reject per item and per kind, the
// current finding highlighted and kept in view; virtualised (fixed row heights: only the rows in view are in the DOM,
// so an hour of speech with thousands of findings scrolls freely). Keyboard: the Text panel's Clean Up commands
// (↑ ↓ move, Enter accept, Backspace reject, Shift+Enter / Shift+Backspace the whole kind, Space ±1 s preview).
import {
	type CleanupFinding,
	cleanupFindingFrames,
	type FindingKind,
	readSequenceCleanup,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../../i18n/runtime.ts';
import { type CleanupUiState, cleanupFor } from './controller.ts';
import {
	clockText,
	findingAccepted,
	groupFindings,
	KIND_COLOR,
	KIND_LABELS,
	listLayout,
	reasonText,
	visibleEntries,
} from './model.ts';

/** Row heights from the root font size (12 px: the editor's UI scale). */
function metrics(): { header: number; row: number } {
	const rem =
		typeof document !== 'undefined' && typeof getComputedStyle !== 'undefined'
			? Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 12
			: 12;
	return { header: Math.round(rem * 2), row: Math.round(rem * 2.75) };
}

export function FindingsList({
	session,
	seq,
	st,
}: {
	session: EditorSession;
	seq: Sequence;
	st: CleanupUiState;
}) {
	const c = cleanupFor(session);
	const a = st.analysis!;
	const remembered = useMemo(() => new Set(readSequenceCleanup(seq).rejected ?? []), [seq]);
	const groups = useMemo(() => groupFindings(a, st.decisions, remembered), [a, st.decisions, remembered]);
	const [collapsed, setCollapsed] = useState<ReadonlySet<FindingKind>>(new Set());
	const m = useMemo(metrics, []);
	const layout = useMemo(() => listLayout(groups, collapsed, m), [groups, collapsed, m]);
	const ref = useRef<HTMLDivElement>(null);
	const [view, setView] = useState({ top: 0, height: 0 });
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const update = () => setView({ top: el.scrollTop, height: el.clientHeight });
		update();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	// keep the current finding in view
	useEffect(() => {
		const el = ref.current;
		if (!el || !st.current) return;
		const i = layout.rowIndex.get(st.current);
		if (i === undefined) return;
		const e = layout.entries[i]!;
		if (e.top - layout.header < el.scrollTop) el.scrollTop = Math.max(0, e.top - layout.header);
		else if (el.clientHeight > 0 && e.top + layout.row > el.scrollTop + el.clientHeight)
			el.scrollTop = e.top + layout.row - el.clientHeight;
	}, [st.current, layout]);
	const { start, end } = visibleEntries(layout, view.top, view.height || 480);
	const shown = layout.entries.slice(start, end);
	const cur = st.current !== null ? layout.rowIndex.get(st.current) : undefined;
	if (cur !== undefined && (cur < start || cur >= end)) shown.push(layout.entries[cur]!);
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const timeOf = (f: CleanupFinding) => {
		const at = cleanupFindingFrames(seq, a, f);
		return at ? clockText(at.start / fps) : '';
	};
	if (!a.findings.length)
		return (
			<p className="m-0 px-2 py-2 text-pr-small text-pr-muted" data-testid="text.cleanup.findings.empty">
				Nothing to clean up was found with these settings.
			</p>
		);
	return (
		<div
			ref={ref}
			className="relative min-h-0 flex-1 overflow-auto"
			onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
			data-testid="text.cleanup.findings"
		>
			<ul
				className="relative m-0 list-none p-0"
				style={{ height: layout.total }}
				aria-label="Clean Up findings"
			>
				{shown.map((e) => {
					if (e.type === 'header') {
						const g = e.group;
						const kindOn = st.decisions.acceptKinds.includes(g.kind);
						const kindOff = st.decisions.rejectKinds.includes(g.kind);
						return (
							<li
								key={`h-${g.kind}`}
								className="absolute inset-x-0 flex items-center gap-1 border-b border-pr-border-subtle bg-pr-panel-alt px-2 text-pr-small"
								style={{ top: e.top, height: layout.header }}
								data-testid={`text.cleanup.kind.${g.kind}`}
							>
								<button
									type="button"
									className="flex min-w-0 flex-1 items-center gap-1 text-left font-semibold text-pr-text"
									onClick={() =>
										setCollapsed((s) => {
											const n = new Set(s);
											if (n.has(g.kind)) n.delete(g.kind);
											else n.add(g.kind);
											return n;
										})
									}
									aria-expanded={!collapsed.has(g.kind)}
								>
									<span aria-hidden="true">{collapsed.has(g.kind) ? '▸' : '▾'}</span>
									<span
										className="inline-block h-2 w-2 shrink-0 rounded-pr-pill"
										style={{ background: KIND_COLOR[g.kind] }}
										aria-hidden="true"
									/>
									<span className="truncate">{KIND_LABELS[g.kind]}</span>
									<span
										className="pr-tabular font-normal text-pr-muted"
										data-testid={`text.cleanup.kind.${g.kind}.count`}
									>
										{t('{0} of {1} cut', g.accepted, g.findings.length)}
									</span>
								</button>
								<button
									type="button"
									className={`rounded-pr-control px-1 ${kindOn ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:text-pr-text'}`}
									onClick={() => c.decideKind(kindOn ? 'clear' : 'accept', g.kind)}
									title={
										g.kind === 'edge'
											? t('Repair every {0}', KIND_LABELS[g.kind])
											: t('Cut every {0}', KIND_LABELS[g.kind])
									}
									aria-pressed={kindOn}
									data-testid={`text.cleanup.kind.${g.kind}.accept`}
								>
									{g.kind === 'edge' ? t('Repair all') : t('Cut all')}
								</button>
								<button
									type="button"
									className={`rounded-pr-control px-1 ${kindOff ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:text-pr-text'}`}
									onClick={() => c.decideKind(kindOff ? 'clear' : 'reject', g.kind)}
									title={t('Keep every {0}', KIND_LABELS[g.kind])}
									aria-pressed={kindOff}
									data-testid={`text.cleanup.kind.${g.kind}.reject`}
								>
									Keep all
								</button>
							</li>
						);
					}
					const f = e.finding;
					const on = findingAccepted(f, st.decisions, remembered);
					const item = st.decisions.accept.includes(f.id)
						? 'accept'
						: st.decisions.reject.includes(f.id)
							? 'reject'
							: null;
					const current = st.current === f.id;
					const skipped = a.plan.skipped.some((s) => s.findingId === f.id);
					// an edge repair moves an edit (the clip grows or is trimmed), it does not cut a passage
					const repair = f.kind === 'edge';
					return (
						<li
							key={f.id}
							id={`cleanup-finding-${f.id}`}
							aria-current={current ? 'true' : undefined}
							aria-setsize={layout.order.length}
							aria-posinset={e.position + 1}
							className={`absolute inset-x-0 flex items-center gap-1 border-b border-pr-border-subtle px-2 text-pr-small ${current ? 'bg-pr-selected' : 'hover:bg-pr-hover'}`}
							style={{ top: e.top, height: layout.row }}
							data-testid={`text.cleanup.finding.${f.id}`}
							data-state={on ? 'cut' : 'kept'}
						>
							<button
								type="button"
								className="flex min-w-0 flex-1 items-center gap-1 text-left"
								onClick={() => c.select(f.id)}
								onDoubleClick={() => c.previewFinding(f.id)}
								data-testid={`text.cleanup.finding.${f.id}.select`}
							>
								<span
									className="w-4 shrink-0 text-center"
									style={{ color: on ? KIND_COLOR[f.kind] : undefined }}
									title={
										on
											? repair
												? t('Repaired')
												: t('Cut')
											: f.suggested === 'review'
												? repair
													? t('For review: left as cut unless you repair it')
													: t('For review: kept unless you cut it')
												: t('Kept')
									}
								>
									{on ? (repair ? '⇥' : '✂') : f.suggested === 'review' ? '?' : '○'}
								</span>
								<span className="pr-tabular w-12 shrink-0 text-pr-muted">{timeOf(f)}</span>
								<span
									className={`min-w-0 flex-1 truncate ${on && !repair ? 'text-pr-text line-through' : 'text-pr-text'}`}
									title={reasonText(f)}
								>
									{reasonText(f)}
									{skipped ? <span className="ml-1 text-pr-warning">{t('(kept: harsh cut)')}</span> : null}
								</span>
								<span className="pr-tabular w-9 shrink-0 text-right text-pr-muted" title={t('Confidence')}>
									{Math.round(f.confidence * 100)} %
								</span>
							</button>
							<button
								type="button"
								className={`shrink-0 rounded-pr-control px-1 ${item === 'accept' ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:text-pr-text'}`}
								onClick={(ev) => {
									ev.stopPropagation();
									c.decide(item === 'accept' ? 'clear' : 'accept', f.id);
								}}
								aria-pressed={item === 'accept'}
								aria-label={repair ? t('Repair this') : t('Cut this')}
								title={repair ? t('Repair this (Enter)') : t('Cut this (Enter)')}
								data-testid={`text.cleanup.finding.${f.id}.accept`}
							>
								{repair ? '⇥' : '✂'}
							</button>
							<button
								type="button"
								className={`shrink-0 rounded-pr-control px-1 ${item === 'reject' ? 'bg-pr-selected text-pr-strong' : 'text-pr-muted hover:text-pr-text'}`}
								onClick={(ev) => {
									ev.stopPropagation();
									c.decide(item === 'reject' ? 'clear' : 'reject', f.id);
								}}
								aria-pressed={item === 'reject'}
								aria-label={t('Keep this')}
								title={t('Keep this (Backspace)')}
								data-testid={`text.cleanup.finding.${f.id}.reject`}
							>
								↺
							</button>
							<button
								type="button"
								className="shrink-0 rounded-pr-control px-1 text-pr-muted hover:text-pr-text"
								onClick={(ev) => {
									ev.stopPropagation();
									c.previewFinding(f.id);
								}}
								aria-label={t('Play 1 s around it')}
								title={t('Play 1 s around it (Space)')}
								data-testid={`text.cleanup.finding.${f.id}.play`}
							>
								▶
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
