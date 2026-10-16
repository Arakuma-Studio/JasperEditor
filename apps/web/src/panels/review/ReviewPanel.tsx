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
import type { ProposalSummary } from '@jasper/api';
import type { Sequence } from '@jasper/project';
import type { EditorSession, ReviewItem } from '@jasper/session';
import { useSessionOrNull, useSessionState } from '@jasper/session/react';
import { Button, Icon, Select } from '@jasper/ui';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createCommandContext } from '../../commands/context.ts';
import type { CommandCtx } from '../../commands/types.ts';
import { t } from '../../i18n/runtime.ts';
import {
	acceptAll,
	applyReview,
	cycleAlternative,
	decide,
	focusItem,
	openReview,
	playReviewItem,
	REVIEW_STATE_LABELS,
	rejectAll,
} from '../../proposals/actions.ts';
import { whyLines } from '../../proposals/ghosts.ts';
import { isOwnKey, runScopedKey } from '../../proposals/keys.ts';
import {
	authorName,
	buildReviewModel,
	kindName,
	type ReviewRow,
	reviewCounts,
} from '../../proposals/review.ts';
import { useGhostModel, useProposals, useProposalsController } from '../../proposals/state.ts';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import { glyphPath, KIND_GLYPH } from '../../sound/cues/model.ts';
import { useEngine } from '../../state/engine.tsx';
import type { PanelProps } from '../types.ts';

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
				Open a project to review proposals.
			</div>
		);
	return <ReviewBody {...props} session={session} />;
}

function fmtTc(seq: Sequence | undefined, frame: number | null): string {
	if (frame === null || !seq) return '—';
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	if (!(fps > 0)) return String(frame);
	const s = frame / fps;
	const ff = Math.round(frame - Math.floor(s) * fps);
	const two = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
	return `${two(s / 3600)}:${two((s / 60) % 60)}:${two(s % 60)}:${two(ff)}`;
}

function ProposalOptionLabel(p: ProposalSummary): string {
	const left = p.counts.pending + p.counts.stale;
	return t('{0} · {1} · {2} to review', p.title, authorName(p.author), left);
}

function ReviewBody(props: PanelProps & { session: EditorSession }) {
	const { session } = props;
	const runtime = useShellRuntimeOrNull();
	const { client: engine, status: engineStatus } = useEngine();
	const c = useProposalsController(session);
	const list = useProposals(session, (s) => s.list);
	const status = useProposals(session, (s) => s.status);
	const activeId = useProposals(session, (s) => s.activeId);
	const proposal = useProposals(session, (s) => s.proposal);
	const items = useProposals(session, (s) => s.items);
	const selection = useProposals(session, (s) => s.selection);
	const busy = useProposals(session, (s) => s.busy);
	const hear = useProposals(session, (s) => s.hear);
	const readOnly = useSessionState((s) => s.readOnly);
	const activeSeq = useSessionState((s) => s.activeSequenceId);
	const seqId = proposal?.sequenceId ?? activeSeq ?? '';
	const seq = useSessionState((s) => s.document.sequences[seqId] as Sequence | undefined);
	const ghost = useGhostModel(session, seqId);
	const previewSeq = useProposals(session, (s) => s.preview?.result.document.sequences[seqId]);
	const model = useMemo(() => buildReviewModel(items, ghost), [items, ghost]);
	const counts = useMemo(() => reviewCounts(items), [items]);
	const listRef = useRef<HTMLDivElement>(null);
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
				engine,
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

	// keep the current row in view
	useEffect(() => {
		if (!current) return;
		const el = listRef.current?.querySelector(`[data-review-row="${CSS.escape(current)}"]`);
		(el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
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
							? t('{0} proposals have items to review. Choose one above.', proposals.length)
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
							{counts.applied ? <span>{t('{0} applied', counts.applied)}</span> : null}
						</div>
						{activeSummary?.waiting ? (
							<div className="text-pr-agent" data-testid="review-waiting">
								{t('{0} is waiting for your review', activeSummary.waiting.agent)}
							</div>
						) : null}
					</div>
					<div
						ref={listRef}
						role="listbox"
						tabIndex={0}
						aria-label={t('Items of {0}', proposal.title)}
						aria-activedescendant={current ? `${idPrefix}${current}` : undefined}
						className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-pr-focus"
						onKeyDown={onListKeyDown}
						onFocus={() => {
							if (!current && model.listOrder[0]) choose(model.listOrder[0]);
						}}
						data-testid="review-list"
					>
						{model.groups.map((g) => (
							// biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox (WAI-ARIA listbox grouping)
							<div key={g.id} role="group" aria-labelledby={`${idPrefix}g-${g.id}`}>
								<div
									id={`${idPrefix}g-${g.id}`}
									className="sticky top-0 z-[1] bg-pr-panel-alt px-2 py-0.5 text-pr-small font-semibold text-pr-muted"
								>
									{g.label} · {g.rows.length}
								</div>
								{g.rows.map((row) => (
									<Row
										key={row.item.id}
										id={`${idPrefix}${row.item.id}`}
										row={row}
										seq={seq}
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
								))}
							</div>
						))}
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
							session={session}
							row={currentRow}
							why={why}
							readOnly={readOnly}
							noteRequest={noteFor === currentRow.item.id}
							onNoteHandled={() => setNoteFor(null)}
							idPrefix={idPrefix}
						/>
					) : null}
					<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-pr-border px-2 py-1.5">
						<Button
							variant="secondary"
							disabled={readOnly || counts.open === 0}
							onClick={() => void acceptAll(session)}
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

function gainText(db: number | null): string {
	if (db === null) return '';
	return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** The accessible name of a row: "Hit on the cut, accepted, at 00:00:02:15. Crunch, support, −3.0 dB. <reason>". */
export function rowAriaLabel(row: ReviewRow, seq: Sequence | undefined): string {
	const it = row.item;
	const parts = [`${it.label}, ${REVIEW_STATE_LABELS[it.state]}`];
	if (row.frame !== null) parts[0] += `, ${t('at {0}', fmtTc(seq, row.frame))}`;
	const what = [
		row.kind ? kindName(row.kind) : null,
		row.sound,
		row.role,
		row.gainDb !== null ? gainText(row.gainDb) : null,
	]
		.filter(Boolean)
		.join(', ');
	if (what) parts.push(what);
	if (it.alternatives > 1) parts.push(t('alternate {0} of {1}', it.selectedAlternative + 1, it.alternatives));
	if ((it.state === 'stale' || it.state === 'invalid') && it.reason) parts.push(it.reason);
	else if (row.reason) parts.push(row.reason);
	if (it.note) parts.push(t('note: {0}', it.note));
	return parts.join('. ');
}

function Row(p: {
	id: string;
	row: ReviewRow;
	seq: Sequence | undefined;
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
	const decided = it.state === 'applied';
	const seg = (d: 'accept' | 'reject' | 'clear', glyph: string, label: string, on: boolean) => (
		<button
			type="button"
			tabIndex={-1}
			aria-hidden="true"
			title={label}
			disabled={p.readOnly || decided || (d === 'accept' && it.state === 'invalid')}
			onPointerDown={(e) => e.stopPropagation()}
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
		// biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys
		<div
			id={p.id}
			role="option"
			aria-selected={p.selected}
			aria-label={rowAriaLabel(row, p.seq)}
			onClick={p.onChoose}
			className={`flex cursor-default flex-col border-b border-pr-border-subtle px-2 py-0.5 ${
				p.current ? 'bg-pr-selected' : 'hover:bg-pr-hover'
			} ${it.state === 'rejected' ? 'opacity-60' : ''}`}
			style={p.current ? { boxShadow: 'inset 2px 0 0 var(--pr-focus-ring)' } : undefined}
			data-review-row={it.id}
			data-review-state={it.state}
		>
			<div className="flex min-w-0 items-center gap-1.5">
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
				{row.role ? <span className="shrink-0 text-pr-small text-pr-muted">{row.role}</span> : null}
				{row.gainDb !== null ? (
					<span className="w-[52px] shrink-0 text-right text-pr-small text-pr-muted pr-tabular">
						{gainText(row.gainDb)}
					</span>
				) : null}
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
				<span className="w-[56px] shrink-0 text-right text-pr-small" data-review-state-word>
					<span aria-hidden="true">{STATE_GLYPH[it.state]} </span>
					<span className={warn ? 'text-pr-warning' : 'text-pr-muted'}>{REVIEW_STATE_LABELS[it.state]}</span>
				</span>
			</div>
			{warn && it.reason ? (
				<div className="truncate pl-[146px] text-pr-small text-pr-warning" title={it.reason}>
					! {it.reason}
				</div>
			) : row.reason ? (
				<div className="truncate pl-[146px] text-pr-small text-pr-muted" title={row.reason}>
					{row.reason}
				</div>
			) : null}
			{row.setup.length ? (
				<div className="pl-[146px] text-pr-small text-pr-muted">
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
								<div key={s.id} className="truncate pl-3" data-review-setup={s.id}>
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
	why: ReturnType<typeof whyLines> | null;
	readOnly: boolean;
	noteRequest: boolean;
	onNoteHandled(): void;
	idPrefix: string;
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
			className="flex max-h-[45%] shrink-0 flex-col gap-1 overflow-auto border-t border-pr-border px-2 py-1.5 text-pr-small"
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
				<span className="text-pr-muted pr-tabular" data-review-alt-label>
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
				<div className="text-pr-muted">
					{t('Comes with: {0}', p.row.setup.map((s) => s.label).join(', '))}
				</div>
			) : null}
		</section>
	);
}
