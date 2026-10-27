// Review panel (spec 12 §2.7 "Review", P3-R6; WP3.3b): the proposal selector (the project's proposals with items left
// to review), the items of the one under review grouped by role (Hero / Support / Bed / Layers / … / Tracks; setup
// items folded under the row that needs them) in time order, each row with its decision (✓ / ✕ / ·), timecode, cue
// kind, sound, role, gain, short reason, ▶ in context, ⇄ alternates n/m and ✎ note, stale / invalid rows with why;
// the current item's details (why-line, facts, alternates, note editor, setup items); Accept all, Reject all and
// "Apply n of m" (a trusted click or Ctrl+Enter only). Clicking a row selects its ghost, moves the playhead to its
// anchor and shows its why-line. Keyboard (the Review scope): the list is one tab stop (listbox,
// `aria-activedescendant`); Enter accept, Backspace / Delete reject, U clear, A A/B, Space ▶, Shift+Space the range,
// Ctrl+Enter Apply, Esc exit, Up / Down / Home / End move. Decisions and Apply are announced (aria-live). Nothing
// animates; state is told by glyph and word, never by colour alone.
// Sound Check of the proposal (spec 12 §4 P6-E5): "Check proposal" runs the check on the preview of the items not
// rejected (nothing applied); "Sound Check of this proposal: fixes 3 · introduces 1" with each introduced finding linked
// to its item (click: that item), "fixes n · introduces m" on each row and in the details; an agent's check kept on the
// proposal shows the same; stale when the mix or the decisions changed since.
import type { ProposalSummary, SoundCheckDeltaFinding, SoundCheckProposalSummary } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import type { Sequence } from '@jasper/project';
import type { EditorSession, ReviewItem } from '@jasper/session';
import { useSessionOrNull, useSessionState, useStoreSelector } from '@jasper/session/react';
import { Button, Icon, Select } from '@jasper/ui';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createCommandContext } from '../../commands/context.ts';
import type { CommandCtx } from '../../commands/types.ts';
import { t } from '../../i18n/runtime.ts';
import {
	acceptAll,
	applyReview,
	cycleAlternative,
	decide,
	focusItem,
	isRerollable,
	openReview,
	playReviewItem,
	REVIEW_STATE_LABELS,
	refreshReview,
	rejectAll,
	rerollReviewItem,
} from '../../proposals/actions.ts';
import { useProposalFeature } from '../../proposals/feature-state.ts';
import { whyLines } from '../../proposals/ghosts.ts';
import { isOwnKey, runScopedKey } from '../../proposals/keys.ts';
import {
	authorName,
	buildReviewModel,
	kindName,
	type ReviewRow,
	reviewCounts,
} from '../../proposals/review.ts';
import {
	cancelProposalCheck,
	checkProposal,
	itemCheck,
	itemCheckText,
	type ProposalCheckEngine,
	proposalCheckItems,
	proposalCheckStaleText,
	proposalCheckStatus,
	proposalCheckStore,
	proposalCheckText,
	storedProposalCheck,
} from '../../proposals/sound-check.ts';
import { problemText } from '../../proposals/stale-text.ts';
import { useGhostModel, useProposals, useProposalsController } from '../../proposals/state.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import { messageText, SEVERITY_ICON, SEVERITY_LABELS, SEVERITY_TONE } from '../../sound/check-model.ts';
import { glyphPath, KIND_GLYPH } from '../../sound/cues/model.ts';
import { seqTimecode } from '../../sound/design-model.ts';
import { reviewGainText } from '../../sound/mix-model.ts';
import { useEngineOrNull } from '../../state/engine.tsx';
import type { PanelProps } from '../types.ts';
import {
	pinnedGroup,
	type ReviewListEntry,
	type ReviewListLayout,
	reviewListLayout,
	reviewListMetrics,
	reviewRowHeight,
	scrollToShow,
	visibleEntries,
} from './list-layout.ts';

const STATE_GLYPH: Record<ReviewItem['state'], string> = {
	pending: '·',
	accepted: '✓',
	rejected: '✕',
	stale: '!',
	invalid: '!',
	applied: '✓',
};

export function ReviewPanel(props: PanelProps) {
	const session = useSessionOrNull();
	if (!session)
		return (
			<div
				className="flex h-full items-center justify-center p-4 text-center text-pr-small text-pr-muted"
				data-testid="review-panel"
			>
				{t('Open a project to review proposals.')}
			</div>
		);
	return <ReviewBody {...props} session={session} />;
}

function fmtTc(seq: Sequence | undefined, frame: number | null): string {
	if (frame === null || !seq) return '—';
	return seqTimecode(seq, frame);
}

function ProposalOptionLabel(p: ProposalSummary): string {
	// (the summary's counts include setup items: the panel shows the reviewer's own counts once it is open)
	return t('{0} · {1}', p.title, authorName(p.author));
}

function ReviewBody(props: PanelProps & { session: EditorSession }) {
	const { session } = props;
	const runtime = useShellRuntimeOrNull();
	const engineState = useEngineOrNull();
	const engine = engineState?.client ?? (session.engine as EngineClient | undefined) ?? null;
	const engineStatus = engineState?.status;
	const c = useProposalsController(session);
	const list = useProposals(session, (s) => s.list);
	const status = useProposals(session, (s) => s.status);
	const activeId = useProposals(session, (s) => s.activeId);
	const proposal = useProposals(session, (s) => s.proposal);
	const items = useProposals(session, (s) => s.items);
	const selection = useProposals(session, (s) => s.selection);
	const busy = useProposals(session, (s) => s.busy);
	const hear = useProposals(session, (s) => s.hear);
	// a large proposal's preview (ghosts, what A/B plays) is built over several frames: say so meanwhile
	const previewing = useProposals(session, (s) => s.previewing);
	const readOnly = useSessionState((s) => s.readOnly);
	const activeSeq = useSessionState((s) => s.activeSequenceId);
	const seqId = proposal?.sequenceId ?? activeSeq ?? '';
	const seq = useSessionState((s) => s.document.sequences[seqId] as Sequence | undefined);
	const ghost = useGhostModel(session, seqId);
	const previewSeq = useProposals(session, (s) => s.preview?.result.document.sequences[seqId]);
	const feature = proposal?.feature;
	const model = useMemo(() => buildReviewModel(items, ghost, feature), [items, ghost, feature]);
	// spec 15 EA-003: whether the feature's producer re-plans stale items ("Refresh proposal")
	const featureInfo = useProposalFeature(engine, session.projectId, feature);
	// P6-E5: the proposal's Sound Check — the newer of the one kept on it and the last one run here
	const checkLast = useStoreSelector(proposalCheckStore(session), (s) => s.last);
	const check = useMemo((): SoundCheckProposalSummary | null => {
		if (!proposal) return null;
		const kept = storedProposalCheck(proposal);
		const here = checkLast && checkLast.proposalId === proposal.id ? checkLast : null;
		if (!kept) return here;
		if (!here) return kept;
		return here.at > kept.at ? here : kept;
	}, [proposal, checkLast]);
	const counts = useMemo(() => reviewCounts(items), [items]);
	const listRef = useRef<HTMLDivElement>(null);
	const pointing = useRef(false);
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
	// a row's ✎ opens the note editor of the details below the list
	const [noteFor, setNoteFor] = useState<string | null>(null);
	const idPrefix = `review-${props.instanceId}-`;
	const current = (() => {
		const id = selection.at(-1);
		return id && model.byId[id] ? id : null;
	})();

	useEffect(() => {
		if (status === 'idle') void c.load();
	}, [c, status]);

	const ctx = useCallback(
		(): CommandCtx =>
			runtime?.getCtx() ??
			createCommandContext({
				engine: engine as EngineClient,
				session,
				capabilities: engineStatus === 'connected' ? ['engine'] : [],
			}),
		[runtime, engine, session, engineStatus],
	);
	const reveal = useCallback(
		(f: number) => runtime?.services.get('timelineViewport')?.scrollToFrame(f),
		[runtime],
	);
	const choose = (id: string) => focusItem(session, id, reveal);

	// the list is virtualised: only the rows in view (and the current one) are in the DOM
	// row heights follow the UI scale (the root font size the rem-based line heights use)
	const remPx = rootFontPx();
	const layout = useMemo(() => reviewListLayout(model, open, reviewListMetrics(remPx)), [model, open, remPx]);
	const [view, setView] = useState({ top: 0, height: 0 });
	const listShown = !!(activeId && proposal);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list element mounts when a review opens
	useEffect(() => {
		const el = listRef.current;
		if (!el) return;
		const measure = () =>
			setView((v) =>
				v.top === el.scrollTop && v.height === el.clientHeight
					? v
					: { top: el.scrollTop, height: el.clientHeight },
			);
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [listShown]);
	// keep the current row in view (it may not be rendered: scroll by its computed place)
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the current item changes, not on every layout
	useEffect(() => {
		if (!current) return;
		const el = listRef.current;
		const entry = layout.entries[layout.rowIndex[current] ?? -1];
		if (!el || !entry) return;
		const to = scrollToShow(entry, el.scrollTop, el.clientHeight || UNMEASURED_PX, layout.metrics.header);
		if (to !== null) {
			el.scrollTop = to;
			setView({ top: el.scrollTop, height: el.clientHeight });
		}
	}, [current]);

	const proposals = useMemo(
		() =>
			list
				.filter((p) => !p.decided || p.id === activeId)
				.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
		[list, activeId],
	);
	const options = useMemo(
		() => proposals.map((p) => ({ value: p.id, label: ProposalOptionLabel(p) })),
		[proposals],
	);
	const activeSummary = list.find((p) => p.id === activeId) ?? null;

	const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
		if (plain && (e.key === 'Home' || e.key === 'End')) {
			const order = model.listOrder;
			const id = e.key === 'Home' ? order[0] : order.at(-1);
			if (id) choose(id);
			e.preventDefault();
			return;
		}
		runScopedKey(e, 'review', ctx(), runtime ?? {});
	};
	const onRootKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		// buttons, fields and the selector keep their own Enter / Space / typing; the rest is the Review scope
		if (isOwnKey(e)) e.stopPropagation();
	};

	const apply = async (e: { nativeEvent: Event }) => {
		await applyReview(session, { trusted: e.nativeEvent.isTrusted });
	};

	const reviewing = !!(activeId && proposal);
	const currentRow = current ? model.byId[current] : undefined;
	const why = currentRow && ghost && seq ? whyLines(currentRow.item, ghost, seq, previewSeq) : null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: keeps Enter / Space on the panel's own buttons and fields (the Review scope runs for the rest)
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel text-pr-ui text-pr-text"
			data-testid="review-panel"
			data-panel-kind="review"
			data-instance-id={props.instanceId}
			data-keymap-local
			onKeyDown={onRootKeyDown}
		>
			<div className="flex shrink-0 items-center gap-2 border-b border-pr-border px-2 py-1.5">
				<Select
					label={t('Proposal to review')}
					value={activeId ?? ''}
					placeholder={
						status === 'loading'
							? t('Loading proposals…')
							: proposals.length
								? t('Choose a proposal to review')
								: t('No proposals to review')
					}
					disabled={!proposals.length}
					onValueChange={(v) => void openReview(session, v)}
					options={options}
					className="min-w-0 flex-1"
				/>
				{reviewing ? (
					<Button
						variant="quiet"
						onClick={() => c.exit()}
						data-testid="review-exit"
						title={t('Exit review (Esc)')}
					>
						{t('Exit')}
					</Button>
				) : null}
			</div>
			{!reviewing ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-pr-small text-pr-muted">
					<p>
						{proposals.length
							? proposals.length === 1
								? t('1 proposal has items to review. Choose it above.')
								: t('{0} proposals have items to review. Choose one above.', proposals.length)
							: t('No proposals to review. Agents’ proposals and Auto Sound Pass results appear here.')}
					</p>
					<Button
						variant="secondary"
						disabled={readOnly || !activeSeq}
						onClick={() => void runtime?.run('sound.autoSoundPass')}
						data-testid="review-auto-pass"
					>
						{t('Auto Sound Pass…')}
					</Button>
				</div>
			) : (
				<>
					<div className="flex shrink-0 flex-col gap-0.5 border-b border-pr-border px-2 py-1 text-pr-small">
						<div className="flex items-center gap-1.5">
							{typeof proposal.author === 'object' ? (
								<span className="inline-flex text-pr-agent" aria-hidden="true">
									<Icon id="agent.sparkle" size={14} />
								</span>
							) : null}
							<span className="truncate font-semibold text-pr-strong" title={proposal.title}>
								{proposal.title}
							</span>
							<span className="shrink-0 text-pr-muted">· {authorName(proposal.author)}</span>
						</div>
						<div
							className="flex flex-wrap items-center gap-x-2 text-pr-muted pr-tabular"
							data-testid="review-counts"
						>
							<span>{t('{0} items', counts.total)}</span>
							<span>✓ {t('{0} accepted', counts.accepted)}</span>
							<span>✕ {t('{0} rejected', counts.rejected)}</span>
							<span>· {t('{0} pending', counts.pending)}</span>
							{counts.stale + counts.invalid ? (
								<span className="text-pr-warning">
									! {t('{0} stale or invalid', counts.stale + counts.invalid)}
								</span>
							) : null}
							{counts.stale ? (
								<Button
									variant="quiet"
									busy={busy}
									disabled={readOnly || !featureInfo?.refreshable}
									disabledReason={
										readOnly
											? t('The project is read-only')
											: !featureInfo?.refreshable
												? t('Its producer cannot re-plan items: ask for a new proposal instead')
												: undefined
									}
									title={t('Re-plan the stale items on the current edit (nothing is applied)')}
									onClick={() => void refreshReview(session)}
									data-testid="review-refresh"
								>
									↻ {t('Refresh proposal')}
								</Button>
							) : null}
							{counts.applied ? <span>{t('{0} applied', counts.applied)}</span> : null}
							{previewing ? (
								<span role="status" data-testid="review-previewing">
									{t('Updating the preview…')}
								</span>
							) : null}
						</div>
						{activeSummary?.waiting ? (
							<div className="text-pr-agent" data-testid="review-waiting">
								{t('{0} is waiting for your review', activeSummary.waiting.agent)}
							</div>
						) : null}
					</div>
					<ProposalCheckBar
						session={session}
						engine={engine as ProposalCheckEngine | null}
						connected={engineStatus === 'connected' || !engineState}
						proposalId={proposal.id}
						sequenceId={proposal.sequenceId}
						check={check}
						items={items}
						labelOf={(id) => model.byId[id]?.item.label ?? id}
						onItem={choose}
					/>
					<div
						ref={listRef}
						role="listbox"
						tabIndex={0}
						aria-label={t('Items of {0}', proposal.title)}
						aria-activedescendant={current ? `${idPrefix}${current}` : undefined}
						className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-pr-focus"
						onKeyDown={onListKeyDown}
						onScroll={(e) => {
							const el = e.currentTarget;
							setView((v) =>
								v.top === el.scrollTop && v.height === el.clientHeight
									? v
									: { top: el.scrollTop, height: el.clientHeight },
							);
						}}
						data-review-rows={layout.rows}
						onPointerDown={() => {
							pointing.current = true;
						}}
						onFocus={() => {
							// keyboard focus starts on the first row; a click chooses its own row
							if (!pointing.current && !current && model.listOrder[0]) choose(model.listOrder[0]);
							pointing.current = false;
						}}
						data-testid="review-list"
					>
						<VirtualRows
							layout={layout}
							view={view}
							current={current}
							render={(row) => (
								<Row
									key={row.item.id}
									checkText={itemCheckText(check, row.item.id)}
									introduces={itemCheck(check, row.item.id).introduces.length}
									id={`${idPrefix}${row.item.id}`}
									row={row}
									seq={seq}
									position={layout.entries[layout.rowIndex[row.item.id]!]!}
									setSize={layout.rows}
									metrics={layout.metrics}
									current={row.item.id === current}
									selected={selection.includes(row.item.id)}
									readOnly={readOnly}
									expanded={open.has(row.item.id)}
									onExpand={() =>
										setOpen((s) => {
											const n = new Set(s);
											if (n.has(row.item.id)) n.delete(row.item.id);
											else n.add(row.item.id);
											return n;
										})
									}
									onChoose={() => choose(row.item.id)}
									onDecide={(d) => void decide(session, d, [row.item.id])}
									onPlay={() => {
										choose(row.item.id);
										playReviewItem(session, row.item.id);
									}}
									onAlternate={() => void cycleAlternative(session, 1, row.item.id)}
									onNote={() => {
										choose(row.item.id);
										setNoteFor(row.item.id);
									}}
								/>
							)}
						/>
					</div>
					{model.orphans.length ? (
						<section
							aria-label={t('Setup items nothing in the list needs')}
							className="max-h-24 shrink-0 overflow-auto border-t border-pr-border-subtle"
						>
							<div className="sticky top-0 bg-pr-panel-alt px-2 py-0.5 text-pr-small font-semibold text-pr-muted">
								{t('Setup')} · {model.orphans.length}
							</div>
							{model.orphans.map((it) => (
								<div
									key={it.id}
									className="flex items-center gap-2 px-2 py-0.5 text-pr-small text-pr-muted"
									data-review-setup={it.id}
								>
									<span aria-hidden="true">{STATE_GLYPH[it.state]}</span>
									<span className="truncate">{it.label}</span>
									<span className="ml-auto">{REVIEW_STATE_LABELS[it.state]}</span>
								</div>
							))}
						</section>
					) : null}
					{currentRow ? (
						<Details
							key={currentRow.item.id}
							check={check}
							session={session}
							row={currentRow}
							why={why}
							readOnly={readOnly}
							noteRequest={noteFor === currentRow.item.id}
							onNoteHandled={() => setNoteFor(null)}
							idPrefix={idPrefix}
							refreshable={!!featureInfo?.refreshable}
						/>
					) : null}
					<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-pr-border px-2 py-1.5">
						<Button
							variant="secondary"
							disabled={readOnly || counts.open === 0}
							onClick={() => void acceptAll(session)}
							title={t('Accept every selected item (items offered unselected stay pending)')}
							data-testid="review-accept-all"
						>
							✓ {t('Accept all')}
						</Button>
						<Button
							variant="secondary"
							disabled={readOnly || counts.open + counts.accepted === 0}
							onClick={() => void rejectAll(session)}
							data-testid="review-reject-all"
						>
							✕ {t('Reject all')}
						</Button>
						<Button
							variant={hear ? 'primary' : 'secondary'}
							aria-pressed={hear}
							onClick={() => c.toggleHear()}
							title={t('Hear the proposal in the Program monitor (A)')}
							data-testid="review-ab"
						>
							A/B
						</Button>
						<Button
							variant="primary"
							className="ml-auto"
							busy={busy}
							disabled={readOnly || counts.accepted === 0}
							disabledReason={
								readOnly
									? t('The project is read-only')
									: counts.accepted === 0
										? t('Accept items first')
										: undefined
							}
							onClick={(e) => void apply(e)}
							title={t('Apply the accepted items as one undo step (Ctrl+Enter)')}
							data-testid="review-apply"
						>
							{t('Apply {0} of {1}', counts.accepted, counts.total)}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}

/** Viewport height assumed before the list is measured (jsdom, the first render). */
const UNMEASURED_PX = 480;

/** The root font size in px (the UI scale; 12 when it cannot be read). */
function rootFontPx(): number {
	if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return 12;
	const v = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
	return Number.isFinite(v) && v > 0 ? v : 12;
}

/**
 * The visible part of the list: each group with rows in view is a WAI-ARIA group (labelled "Hero · 3") positioned at
 * its place, its header and rows inside it at theirs; the current row is always rendered (aria-activedescendant names
 * it). The label of the group at the top stays pinned while its rows scroll.
 */
function VirtualRows(p: {
	layout: ReviewListLayout;
	view: { top: number; height: number };
	current: string | null;
	render(row: ReviewRow): ReactNode;
}) {
	const { layout, view } = p;
	const { start, end } = visibleEntries(layout, view.top, view.height || UNMEASURED_PX);
	const shown = new Set<number>();
	for (let i = start; i < end; i++) shown.add(i);
	const cur = p.current !== null ? layout.rowIndex[p.current] : undefined;
	if (cur !== undefined) shown.add(cur);
	const byGroup = new Map<string, ReviewListEntry[]>();
	for (const i of [...shown].sort((a, b) => a - b)) {
		const e = layout.entries[i]!;
		const list = byGroup.get(e.group.id);
		if (list) list.push(e);
		else byGroup.set(e.group.id, [e]);
	}
	const pinned = pinnedGroup(layout, view.top);
	return (
		<>
			{pinned ? (
				<div className="pointer-events-none sticky top-0 z-[2] h-0" aria-hidden="true">
					<div
						className="bg-pr-panel-alt px-2 text-pr-small font-semibold leading-5 text-pr-muted"
						style={{ height: layout.metrics.header }}
						data-review-pinned-group={pinned.id}
					>
						{pinned.label} · {pinned.rows.length}
					</div>
				</div>
			) : null}
			<div className="relative" style={{ height: layout.total }}>
				{layout.groups.map((g) => {
					const entries = byGroup.get(g.group.id);
					if (!entries) return null;
					return (
						// biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox (WAI-ARIA listbox grouping)
						<div
							key={g.group.id}
							role="group"
							aria-label={`${g.group.label} · ${g.group.rows.length}`}
							className="absolute inset-x-0"
							style={{ top: g.top, height: g.height }}
						>
							{entries.map((e) =>
								e.kind === 'header' ? (
									<div
										key={`h-${g.group.id}`}
										aria-hidden="true"
										className="absolute inset-x-0 bg-pr-panel-alt px-2 text-pr-small font-semibold leading-5 text-pr-muted"
										style={{ top: e.top - g.top, height: e.height }}
										data-review-group={g.group.id}
									>
										{g.group.label} · {g.group.rows.length}
									</div>
								) : (
									<div
										key={e.row.item.id}
										className="absolute inset-x-0"
										style={{ top: e.top - g.top, height: e.height }}
									>
										{p.render(e.row)}
									</div>
								),
							)}
						</div>
					);
				})}
			</div>
		</>
	);
}

function KindGlyph({ kind }: { kind: ReviewRow['kind'] }) {
	if (!kind) return <span className="inline-block w-3" aria-hidden="true" />;
	const shape = KIND_GLYPH[kind];
	const closed = shape !== 'plus' && shape !== 'dash';
	return (
		<svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true" className="shrink-0">
			<title>{kindName(kind)}</title>
			<path
				d={glyphPath(shape, 9)}
				fill={closed ? 'var(--pr-cue)' : 'none'}
				stroke="var(--pr-cue)"
				strokeWidth={1.5}
			/>
		</svg>
	);
}

/** The row's gain with what limited it ("−16.2 dB · limited by dialogue A2"; Phase 4 levels from the item's meta). */
function gainText(row: ReviewRow): string {
	return reviewGainText(row.gainDb, row.item.meta, row.item.selectedAlternative > 0);
}

/** The accessible name of a row: "Hit on the cut, accepted, at 00:00:02:15. Crunch, support, −3.0 dB. <reason>". */
export function rowAriaLabel(row: ReviewRow, seq: Sequence | undefined): string {
	const it = row.item;
	const parts = [`${it.label}, ${REVIEW_STATE_LABELS[it.state]}`];
	if (row.frame !== null) parts[0] += `, ${t('at {0}', fmtTc(seq, row.frame))}`;
	const what = [row.kind ? kindName(row.kind) : null, row.sound, row.role, gainText(row) || null]
		.filter(Boolean)
		.join(', ');
	if (what) parts.push(what);
	if (it.alternatives > 1) parts.push(t('alternate {0} of {1}', it.selectedAlternative + 1, it.alternatives));
	const problem = problemText(it, seq);
	if (problem) parts.push(problem);
	else if (row.reason) parts.push(row.reason);
	if (it.note) parts.push(t('note: {0}', it.note));
	return parts.join('. ');
}

function Row(p: {
	id: string;
	row: ReviewRow;
	/** The proposal check's badge for this item ("fixes 2 · introduces 1"), null when it says nothing about it. */
	checkText: string | null;
	introduces: number;
	seq: Sequence | undefined;
	/** Its place in the list (aria-posinset) and the rows in all (aria-setsize): the list is virtualised. */
	position: ReviewListEntry;
	setSize: number;
	metrics: ReturnType<typeof reviewListMetrics>;
	current: boolean;
	selected: boolean;
	readOnly: boolean;
	expanded: boolean;
	onExpand(): void;
	onChoose(): void;
	onDecide(d: 'accept' | 'reject' | 'clear'): void;
	onPlay(): void;
	onAlternate(): void;
	onNote(): void;
}) {
	const { row } = p;
	const it = row.item;
	const warn = it.state === 'stale' || it.state === 'invalid';
	const problem = warn ? problemText(it, p.seq) : null;
	const decided = it.state === 'applied';
	// spec 17 SC-061: offered unselected (a Maybe transcript fix): Accept all leaves it out until accepted here
	const unselected = !it.selected && (it.state === 'pending' || it.state === 'stale');
	const seg = (d: 'accept' | 'reject' | 'clear', glyph: string, label: string, on: boolean) => (
		<button
			type="button"
			tabIndex={-1}
			aria-hidden="true"
			title={label}
			disabled={p.readOnly || decided || (d === 'accept' && it.state === 'invalid')}
			onPointerDown={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.preventDefault()}
			onClick={(e) => {
				e.stopPropagation();
				p.onDecide(d);
			}}
			className={`inline-flex size-5 items-center justify-center text-pr-small disabled:opacity-40 ${
				on ? 'bg-pr-accent-fill text-pr-on-accent' : 'text-pr-muted hover:bg-pr-hover hover:text-pr-text'
			}`}
			data-review-decide={d}
		>
			{glyph}
		</button>
	);
	const tool = (key: string, glyph: string, label: string, run: () => void, disabled = false) => (
		<button
			type="button"
			tabIndex={-1}
			aria-hidden="true"
			title={label}
			disabled={disabled}
			onPointerDown={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.preventDefault()}
			onClick={(e) => {
				e.stopPropagation();
				run();
			}}
			className="inline-flex h-5 min-w-5 items-center justify-center rounded-pr-control px-0.5 text-pr-small text-pr-muted hover:bg-pr-hover hover:text-pr-text disabled:opacity-40"
			data-review-tool={key}
		>
			{glyph}
		</button>
	);
	return (
		// biome-ignore lint/a11y/useFocusableInteractive: listbox options are reached with aria-activedescendant
		<div
			id={p.id}
			role="option"
			aria-selected={p.selected}
			aria-label={`${rowAriaLabel(row, p.seq)}${unselected ? `. ${t('Not selected')}` : ''}${p.checkText ? `. ${t('Sound Check: {0}', p.checkText)}` : ''}`}
			aria-posinset={p.position.kind === 'row' ? p.position.position + 1 : undefined}
			aria-setsize={p.setSize}
			onPointerDown={(e) => {
				// on press, not on click: the details below the list appear and move the rows before the release
				if (e.button === 0) p.onChoose();
			}}
			className={`box-border flex cursor-default flex-col overflow-hidden border-b border-pr-border-subtle px-2 py-0.5 ${
				p.current ? 'bg-pr-selected' : 'hover:bg-pr-hover'
			} ${it.state === 'rejected' ? 'opacity-60' : ''}`}
			style={{
				height: reviewRowHeight(row, p.expanded, p.metrics),
				...(p.current ? { boxShadow: 'inset 2px 0 0 var(--pr-focus-ring)' } : {}),
			}}
			data-review-row={it.id}
			data-review-state={it.state}
		>
			<div className="flex h-5 min-w-0 shrink-0 items-center gap-1.5">
				<span
					className="inline-flex shrink-0 overflow-hidden rounded-pr-control border border-pr-border"
					data-review-seg
				>
					{seg('accept', '✓', t('Accept (Enter)'), it.state === 'accepted' || it.state === 'applied')}
					{seg('reject', '✕', t('Reject (Backspace)'), it.state === 'rejected')}
					{seg('clear', '·', t('Back to pending (U)'), it.state === 'pending')}
				</span>
				<span className="w-[74px] shrink-0 text-pr-small text-pr-muted pr-tabular">
					{fmtTc(p.seq, row.frame)}
				</span>
				<KindGlyph kind={row.kind} />
				<span className="min-w-0 flex-1 truncate" title={row.sound ?? it.label}>
					{row.sound ?? it.label}
				</span>
				{tool('play', '▶', t('Play in context (Space)'), p.onPlay, row.frame === null)}
				{tool(
					'alternate',
					`⇄ ${it.selectedAlternative + 1}/${it.alternatives}`,
					it.alternatives > 1
						? t(
								'Next alternate: {0}',
								it.alternativeLabels[(it.selectedAlternative + 1) % it.alternatives] ?? '',
							)
						: t('No alternates for this item'),
					p.onAlternate,
					p.readOnly || decided || it.alternatives < 2,
				)}
				{tool(
					'note',
					it.note ? '✎•' : '✎',
					it.note ? t('Note: {0}', it.note) : t('Write a note for the agent'),
					p.onNote,
					decided,
				)}
				<span className="shrink-0 text-right text-pr-small" data-review-state-word>
					<span aria-hidden="true">{STATE_GLYPH[it.state]} </span>
					<span className={warn ? 'text-pr-warning' : 'text-pr-muted'}>{REVIEW_STATE_LABELS[it.state]}</span>
				</span>
			</div>
			<div className="flex h-[1.375rem] min-w-0 shrink-0 items-center gap-1.5 pl-[66px] text-pr-small leading-[1.375rem] text-pr-muted">
				{unselected ? (
					<span
						className="shrink-0 rounded-pr-control border border-pr-border px-1"
						title={t('Not selected: Accept all leaves it out; accept it here (Enter) to apply it')}
						data-review-unselected
					>
						{t('Not selected')}
					</span>
				) : null}
				{row.role ? <span className="shrink-0">{row.role}</span> : null}
				{gainText(row) ? (
					<span className="max-w-[60%] shrink-0 truncate pr-tabular" title={gainText(row)} data-review-gain>
						{gainText(row)}
					</span>
				) : null}
				{p.checkText ? (
					<span
						className={`shrink-0 pr-tabular ${p.introduces ? 'text-pr-warning' : 'text-pr-success'}`}
						title={t('Sound Check of this proposal: {0}', p.checkText)}
						data-review-check={p.checkText}
					>
						{p.introduces ? '▲ ' : '✓ '}
						{p.checkText}
					</span>
				) : null}
				{warn && problem ? (
					<span className="min-w-0 truncate text-pr-warning" title={problem} data-review-problem>
						! {problem}
					</span>
				) : row.reason ? (
					<span className="min-w-0 truncate" title={row.reason}>
						{row.reason}
					</span>
				) : null}
			</div>
			{row.setup.length ? (
				<div className="shrink-0 pl-[66px] text-pr-small leading-[1.375rem] text-pr-muted">
					<button
						type="button"
						tabIndex={-1}
						aria-hidden="true"
						onPointerDown={(e) => e.stopPropagation()}
						onClick={(e) => {
							e.stopPropagation();
							p.onExpand();
						}}
						className="hover:text-pr-text"
						data-review-setup-toggle={it.id}
					>
						{p.expanded ? '▾' : '▸'} {t('{0} setup items', row.setup.length)}
					</button>
					{p.expanded
						? row.setup.map((s) => (
								<div key={s.id} className="h-[1.375rem] truncate pl-3" data-review-setup={s.id}>
									{STATE_GLYPH[s.state]} {s.label}
								</div>
							))
						: null}
				</div>
			) : null}
		</div>
	);
}

/** The current item: why-line, facts, problem, alternates, note editor, setup items, ▶. */
function Details(p: {
	session: EditorSession;
	row: ReviewRow;
	check: SoundCheckProposalSummary | null;
	why: ReturnType<typeof whyLines> | null;
	readOnly: boolean;
	noteRequest: boolean;
	onNoteHandled(): void;
	idPrefix: string;
	/** The feature's producer re-plans items (Refresh proposal, Reroll). */
	refreshable: boolean;
}) {
	const it = p.row.item;
	const c = useProposalsController(p.session);
	const [editing, setEditing] = useState(false);
	const [note, setNote] = useState(it.note ?? '');
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (!p.noteRequest) return;
		setNote(it.note ?? '');
		setEditing(true);
		p.onNoteHandled();
	}, [p.noteRequest, it.note, p.onNoteHandled]);
	useEffect(() => {
		if (editing) ref.current?.focus();
	}, [editing]);
	const decided = it.state === 'applied';
	const save = async () => {
		const r = await c.note(it.id, note.trim() ? note : null);
		if (r.ok) setEditing(false);
	};
	return (
		<section
			className="flex max-h-[40%] shrink-0 flex-col gap-1 overflow-auto border-t border-pr-border px-2 py-1.5 text-pr-small"
			aria-label={t('Details of {0}', it.label)}
			data-testid="review-details"
		>
			<div className="font-semibold text-pr-strong">{it.label}</div>
			{p.why?.why ? <div data-review-why>{p.why.why}</div> : null}
			{p.why?.facts.length ? (
				<ul className="list-none text-pr-muted">
					{p.why.facts.map((f) => (
						<li key={f}>{f}</li>
					))}
				</ul>
			) : null}
			{p.why?.problem ? <div className="text-pr-warning">! {p.why.problem}</div> : null}
			<ItemCheck check={p.check} itemId={it.id} />
			<div className="flex flex-wrap items-center gap-1">
				<Button
					variant="secondary"
					onClick={() => playReviewItem(p.session, it.id)}
					data-review-detail="play"
				>
					▶ {t('Play in context')}
				</Button>
				<Button
					variant="secondary"
					disabled={p.readOnly || decided || it.alternatives < 2}
					disabledReason={it.alternatives < 2 ? t('No alternates for this item') : undefined}
					onClick={() => void cycleAlternative(p.session, -1, it.id)}
					aria-label={t('Previous alternate')}
					data-review-detail="alt-prev"
				>
					◀
				</Button>
				<span
					className="min-w-0 flex-1 truncate text-pr-muted pr-tabular"
					data-review-alt-label
					title={it.alternativeLabels[it.selectedAlternative] ?? ''}
				>
					⇄ {t('Alternate {0}/{1}', it.selectedAlternative + 1, it.alternatives)}
					{it.alternatives > 1 ? `: ${it.alternativeLabels[it.selectedAlternative] ?? ''}` : ''}
				</span>
				<Button
					variant="secondary"
					disabled={p.readOnly || decided || it.alternatives < 2}
					disabledReason={it.alternatives < 2 ? t('No alternates for this item') : undefined}
					onClick={() => void cycleAlternative(p.session, 1, it.id)}
					aria-label={t('Next alternate')}
					data-review-detail="alt-next"
				>
					▶
				</Button>
				{isRerollable(p.row.item) ? (
					<Button
						variant="secondary"
						disabled={
							p.readOnly ||
							!p.refreshable ||
							!['pending', 'stale', 'invalid'].includes(p.row.item.engineState) ||
							it.state === 'accepted'
						}
						disabledReason={
							!p.refreshable
								? t('Its producer cannot re-plan items')
								: it.state === 'accepted' || it.state === 'applied'
									? t('Only items still under review can be rerolled')
									: undefined
						}
						onClick={() => void rerollReviewItem(p.session, it.id)}
						aria-label={t('Reroll: plan this item again with its next seed')}
						data-review-detail="reroll"
					>
						⟳ {t('Reroll')}
					</Button>
				) : null}
			</div>
			{editing ? (
				<div className="flex flex-col gap-1">
					<textarea
						ref={ref}
						id={`${p.idPrefix}note`}
						className="h-14 resize-none rounded-pr-control border border-pr-border bg-pr-field p-1 text-pr-small text-pr-text"
						aria-label={t('Note for the agent')}
						maxLength={4000}
						value={note}
						onChange={(e) => setNote(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Escape') {
								e.preventDefault();
								e.stopPropagation();
								setEditing(false);
							} else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								e.stopPropagation();
								void save();
							}
						}}
						data-review-note-input
					/>
					<div className="flex justify-end gap-1">
						<Button variant="quiet" onClick={() => setEditing(false)}>
							{t('Cancel')}
						</Button>
						<Button variant="primary" onClick={() => void save()} data-review-detail="save-note">
							{t('Save Note')}
						</Button>
					</div>
				</div>
			) : (
				<div className="flex items-center gap-1">
					{it.note ? <span className="min-w-0 flex-1 italic text-pr-muted">✎ {it.note}</span> : null}
					<Button
						variant="quiet"
						disabled={decided || p.readOnly}
						onClick={() => {
							setNote(it.note ?? '');
							setEditing(true);
						}}
						data-review-detail="note"
					>
						✎ {it.note ? t('Edit Note') : t('Note')}
					</Button>
				</div>
			)}
			{p.row.setup.length ? (
				<div className="truncate text-pr-muted" title={p.row.setup.map((s) => s.label).join(', ')}>
					{t('Comes with: {0}', p.row.setup.map((s) => s.label).join(', '))}
				</div>
			) : null}
		</section>
	);
}

// ── Sound Check of the proposal (P6-E5) ─────────────────────────────────────────────────────────────────────────

/** Most introduced findings listed under the bar (the rest: "n more"; every one is in its item's details). */
const CHECK_LIST_MAX = 5;

function findingLine(f: SoundCheckDeltaFinding): string {
	return `${f.code}${f.timecode ? ` ${f.timecode}` : ''}: ${messageText(f.message)}`;
}

/** "Sound Check of this proposal: fixes 3 · introduces 1", Check proposal / Cancel, and the introduced findings. */
function ProposalCheckBar(p: {
	session: EditorSession;
	engine: ProposalCheckEngine | null;
	connected: boolean;
	proposalId: string;
	sequenceId: string | null;
	check: SoundCheckProposalSummary | null;
	items: readonly ReviewItem[];
	labelOf(itemId: string): string;
	onItem(itemId: string): void;
}) {
	const { session, check } = p;
	const running = useStoreSelector(proposalCheckStore(session), (s) => s.running);
	const error = useStoreSelector(proposalCheckStore(session), (s) => s.error);
	const doc = useSessionState((s) => s.document);
	const status = useMemo(() => proposalCheckStatus(check, doc, p.items), [check, doc, p.items]);
	const stale = proposalCheckStaleText(status);
	const mine = running && running.proposalId === p.proposalId ? running : null;
	const wanted = proposalCheckItems(p.items);
	const run = () => {
		if (!p.engine) return;
		void checkProposal(session, p.engine, {
			proposalId: p.proposalId,
			sequenceId: p.sequenceId,
			itemIds: wanted,
		});
	};
	const introduced = check?.delta.introduced ?? [];
	return (
		<div
			className="flex shrink-0 flex-col gap-0.5 border-b border-pr-border px-2 py-1 text-pr-small"
			data-testid="review-check"
			data-check-state={status.state}
		>
			<div className="flex items-center gap-1.5">
				{check ? (
					<span
						className={`flex min-w-0 flex-1 items-center gap-1 font-semibold ${check.delta.introducedCount ? 'text-pr-warning' : 'text-pr-strong'}`}
						data-testid="review-check-summary"
						data-fixes={check.delta.fixedCount}
						data-introduces={check.delta.introducedCount}
						title={t('Verdict {0} → {1}', check.delta.verdict.before, check.delta.verdict.after)}
					>
						<Icon id={check.delta.introducedCount ? 'status.warning' : 'status.success'} size={12} />
						<span className="min-w-0 truncate">{proposalCheckText(check)}</span>
					</span>
				) : (
					<span className="min-w-0 flex-1 truncate text-pr-muted" data-testid="review-check-summary">
						{t('Sound Check of this proposal: not run yet')}
					</span>
				)}
				{mine ? (
					<>
						<span className="shrink-0 text-pr-muted pr-tabular" role="status">
							{mine.stage ?? t('Checking…')}
							{mine.progress !== null ? ` ${Math.round(mine.progress * 100)} %` : ''}
						</span>
						<Button
							variant="quiet"
							onClick={() => cancelProposalCheck(session)}
							data-testid="review-check-cancel"
						>
							{t('Cancel')}
						</Button>
					</>
				) : (
					<Button
						variant="secondary"
						disabled={!p.engine || !p.connected || !wanted.length}
						disabledReason={
							!p.connected
								? t('The engine is not connected')
								: !wanted.length
									? t('Nothing left to check: every item is rejected or applied')
									: undefined
						}
						title={t(
							'Run Sound Check on the proposal’s preview (the items you have not rejected): what it fixes and introduces. Nothing is applied',
						)}
						onClick={run}
						data-testid="review-check-run"
					>
						{check ? t('Check again') : t('Check proposal')}
					</Button>
				)}
			</div>
			{stale ? (
				<div className="flex items-center gap-1 text-pr-warning" data-testid="review-check-stale">
					<Icon id="status.warning" size={12} />
					{stale}
				</div>
			) : null}
			{error && error.proposalId === p.proposalId && !mine ? (
				<div role="alert" className="text-pr-danger">
					{error.message}
				</div>
			) : null}
			{check?.skipped.length ? (
				<div
					className="truncate text-pr-muted"
					title={check.skipped.map((x) => `${x.itemId}: ${x.reason}`).join('\n')}
				>
					{t('Not checked: {0}', check.skipped.map((x) => p.labelOf(x.itemId)).join(', '))}
				</div>
			) : null}
			{introduced.length ? (
				<ul className="m-0 flex list-none flex-col p-0" data-testid="review-check-introduced">
					{introduced.slice(0, CHECK_LIST_MAX).map((f) => (
						<li key={f.key} className="flex min-w-0 items-center gap-1" data-check-key={f.key}>
							<span className={`inline-flex shrink-0 items-center gap-0.5 ${SEVERITY_TONE[f.severity]}`}>
								<Icon id={SEVERITY_ICON[f.severity]} size={12} />
								<span className="sr-only">{t(SEVERITY_LABELS[f.severity])}</span>
							</span>
							<span className="min-w-0 flex-1 truncate" title={findingLine(f)}>
								{findingLine(f)}
							</span>
							{f.itemId ? (
								<button
									type="button"
									className="max-w-[40%] shrink-0 truncate text-pr-accent underline-offset-2 hover:underline"
									title={t('Go to the item: {0}', p.labelOf(f.itemId))}
									onClick={() => p.onItem(f.itemId!)}
									data-check-item={f.itemId}
								>
									→ {p.labelOf(f.itemId)}
								</button>
							) : (
								<span className="shrink-0 text-pr-muted">{t('the whole mix')}</span>
							)}
						</li>
					))}
					{introduced.length > CHECK_LIST_MAX ? (
						<li className="text-pr-muted">
							{t('{0} more in the items’ details', introduced.length - CHECK_LIST_MAX)}
						</li>
					) : null}
				</ul>
			) : null}
		</div>
	);
}

/** The current item's part of the proposal check: what it fixes and introduces. */
function ItemCheck(p: { check: SoundCheckProposalSummary | null; itemId: string }) {
	const c = itemCheck(p.check, p.itemId);
	if (!c.fixes.length && !c.introduces.length) return null;
	return (
		<div className="flex flex-col" data-testid="review-item-check">
			{c.introduces.map((f) => (
				<div
					key={f.key}
					className={`flex items-start gap-1 ${SEVERITY_TONE[f.severity]}`}
					data-check-introduces={f.key}
				>
					<Icon id={SEVERITY_ICON[f.severity]} size={12} />
					<span>{t('Introduces {0}', findingLine(f))}</span>
				</div>
			))}
			{c.fixes.map((f) => (
				<div key={f.key} className="flex items-start gap-1 text-pr-success" data-check-fixes={f.key}>
					<Icon id="status.success" size={12} />
					<span>{t('Fixes {0}', findingLine(f))}</span>
				</div>
			))}
		</div>
	);
}
