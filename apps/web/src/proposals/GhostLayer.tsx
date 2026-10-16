// The proposal ghost layer of the Timeline (spec 12 §2.7 "Review", P3-R6 ghost part): ghost clips, removal washes,
// ghost track rows and headers of the proposal under review (`ghosts.ts`), drawn over the track area and never part of
// the document. Clicking a ghost selects its item and opens its card; resting on one shows the card (why-line, facts,
// Accept / Reject / Alternate n/m / Play / Note, and Apply for the accepted items). Keyboard: the review items are one
// tab stop (a listbox with `aria-activedescendant`): Left / Right / Home / End move between items in time order,
// Enter accepts, Delete / Backspace rejects, U clears, A toggles "Hear proposal", the context-menu key, Shift+F10 or
// I opens the card (focus moves into it), Esc closes it. Nothing animates (reduced motion has nothing to stop).
import type { Sequence } from '@jasper/project';
import type { EditorSession, ProposalsController, ReviewItem } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { Button, Z } from '@jasper/ui';
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/runtime.ts';
import type { TrackAreaLayout } from '../panels/timeline/model/layout.ts';
import { frameToX, type Viewport } from '../panels/timeline/model/viewport.ts';
import { inContextStore, playTimelineWindow } from '../sound/in-context.ts';
import { soundLibraryPrefs } from '../sound/prefs.ts';
import {
	GHOST_STATE_LABELS,
	type GhostItem,
	type GhostModel,
	type GhostRow,
	ghostAriaLabel,
	ghostPaint,
	layoutGhosts,
	neighbourItem,
	stateGlyph,
	whyLines,
} from './ghosts.ts';
import { useProposals, useProposalsController } from './state.ts';

/** Whether the high-contrast theme is on (`data-pr-contrast="high"` on the root element). */
function readContrast(): boolean {
	return typeof document !== 'undefined' && document.documentElement.getAttribute('data-pr-contrast') === 'high';
}
function subscribeContrast(cb: () => void): () => void {
	if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined;
	const mo = new MutationObserver(cb);
	mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-pr-contrast'] });
	return () => mo.disconnect();
}
export function useHighContrast(): boolean {
	return useSyncExternalStore(subscribeContrast, readContrast, () => false);
}

const HOVER_MS = 350;
const LEAVE_MS = 250;

type Card = { itemId: string; x: number; y: number; pinned: boolean; focus: boolean };

export type GhostLayerProps = {
	session: EditorSession;
	/** The drawn sequence. */
	seq: Sequence;
	model: GhostModel;
	layout: TrackAreaLayout;
	viewport: Viewport;
	instanceId: string;
	/** Scrolls the timeline so a frame is in view. */
	reveal(frame: number): void;
	toast(kind: 'info' | 'warning' | 'error', message: string): void;
	/** Opens an item's card from outside (a ghost cue on the Cue Seam): set by the layer. */
	cardRef?: { current: ((itemId: string, x: number, y: number) => void) | null };
};

/** Plays an item in context: "Hear proposal" on for the window (pre-roll before it, 1 s after it), then as it was. */
export function playItem(
	session: EditorSession,
	controller: ProposalsController,
	seq: Sequence,
	item: Pick<GhostItem, 'start' | 'end' | 'label'>,
): void {
	const was = controller.getState().hear;
	controller.setHear(true);
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const span = fps > 0 ? Math.max(0, (item.end - item.start) / fps) : 0;
	playTimelineWindow(session, seq, {
		center: item.start,
		returnTo: Math.round(session.transport.getState().frame),
		title: item.label,
		before: soundLibraryPrefs.get().preRollSec,
		after: span + 1,
	});
	if (was) return;
	let started = inContextStore.getState().active;
	const off = inContextStore.subscribe((s) => {
		if (s.active) started = true;
		if (started && !s.active && !s.loading) {
			off();
			controller.setHear(false);
		}
	});
}

export function ProposalGhostLayer(p: GhostLayerProps) {
	const { session, model, layout, viewport: v, seq } = p;
	const controller = useProposalsController(session);
	const selection = useProposals(session, (s) => s.selection);
	const items = useProposals(session, (s) => s.items);
	const hc = useHighContrast();
	const selected = useMemo(() => new Set(selection), [selection]);
	const placed = useMemo(() => layoutGhosts(model, layout, v), [model, layout, v]);
	const [active, setActive] = useState<string | null>(null);
	const [focused, setFocused] = useState(false);
	const [card, setCard] = useState<Card | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const idPrefix = `ghost-${p.instanceId}-`;
	const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);

	useEffect(() => {
		if (active && !model.byItem[active]) setActive(null);
		if (card && !model.byItem[card.itemId]) setCard(null);
	}, [model, active, card]);
	useEffect(
		() => () => {
			if (hoverTimer.current) clearTimeout(hoverTimer.current);
		},
		[],
	);
	useEffect(() => {
		if (!p.cardRef) return;
		p.cardRef.current = (itemId, x, y) => {
			controller.select([itemId]);
			setActive(itemId);
			setCard({ itemId, x, y, pinned: true, focus: false });
		};
		return () => {
			if (p.cardRef) p.cardRef.current = null;
		};
	}, [p.cardRef, controller]);

	const clearHover = () => {
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		hoverTimer.current = null;
	};
	const openAt = (itemId: string, el: Element | null, pinned: boolean, focus = false) => {
		const r = el?.getBoundingClientRect();
		setCard({ itemId, x: r ? r.left : 0, y: r ? r.bottom + 4 : 0, pinned, focus });
	};
	const onGhostDown = (e: ReactPointerEvent<HTMLElement>, itemId: string) => {
		e.stopPropagation();
		if (e.button !== 0) return;
		clearHover();
		controller.select([itemId], e.shiftKey ? 'toggle' : 'replace');
		setActive(itemId);
		openAt(itemId, e.currentTarget, true);
	};
	const onGhostEnter = (e: ReactPointerEvent<HTMLElement>, itemId: string) => {
		clearHover();
		const el = e.currentTarget;
		hoverTimer.current = setTimeout(() => {
			setCard((c) => (c?.pinned ? c : { ...placeOf(el), itemId, pinned: false, focus: false }));
		}, HOVER_MS);
	};
	const onGhostLeave = () => {
		clearHover();
		hoverTimer.current = setTimeout(() => setCard((c) => (c?.pinned ? c : null)), LEAVE_MS);
	};

	const decide = async (ids: string[], d: 'accept' | 'reject' | 'clear') => {
		const r = await controller.setItemDecision(ids, d);
		if (!r.ok) p.toast('warning', r.message);
	};
	const move = (dir: 1 | -1 | 'first' | 'last') => {
		const id = neighbourItem(model, active, dir, session.transport.getState().frame);
		if (!id) return;
		setActive(id);
		controller.select([id]);
		const it = model.byItem[id];
		if (it) p.reveal(it.start);
		if (card) setCard(null);
	};
	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
		const id = active ?? selection.at(-1) ?? null;
		let handled = true;
		if (plain && e.key === 'ArrowRight') move(1);
		else if (plain && e.key === 'ArrowLeft') move(-1);
		else if (plain && e.key === 'Home') move('first');
		else if (plain && e.key === 'End') move('last');
		else if (plain && !e.shiftKey && (e.key === 'Enter' || e.code === 'NumpadEnter') && id) void decide([id], 'accept');
		else if (plain && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace') && id) void decide([id], 'reject');
		else if (plain && !e.shiftKey && (e.key === 'u' || e.key === 'U') && id) void decide([id], 'clear');
		else if (plain && !e.shiftKey && (e.key === 'a' || e.key === 'A')) controller.toggleHear();
		else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10') || (plain && e.key === 'i')) && id) {
			const el = listRef.current?.parentElement?.querySelector(`[data-ghost-item="${CSS.escape(id)}"]`) ?? null;
			openAt(id, el, true, true);
		} else if (plain && e.key === 'Escape' && (card || selection.length)) {
			if (card) setCard(null);
			else controller.select([]);
		} else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	};

	const rowsVideo = placed.rows.filter((r) => r.region === 'video');
	const rowsAudio = placed.rows.filter((r) => r.region === 'audio');
	const regionBox = (r: 'video' | 'audio') =>
		r === 'video'
			? { top: layout.video.top, height: layout.video.height }
			: { top: layout.audio.top, height: Math.max(0, layout.height - layout.audio.top) };
	const ghostsIn = (r: 'video' | 'audio') => {
		const box = regionBox(r);
		const rows = r === 'video' ? rowsVideo : rowsAudio;
		return (
			<div
				className="pointer-events-none absolute right-0 left-0 overflow-hidden"
				style={{ top: box.top, height: box.height, zIndex: 3 }}
				data-ghost-region={r}
			>
				{rows.map((row) => (
					<GhostTrackLane key={row.trackId} row={row} top={box.top} hc={hc} />
				))}
				{placed.removals
					.filter((x) => x.region === r)
					.map((x) => (
						<div
							key={x.key}
							className="absolute"
							style={{
								left: x.x,
								width: x.w,
								top: x.y - box.top + 1,
								height: Math.max(4, x.h - 2),
								background: 'var(--pr-ghost-remove)',
								borderRadius: 'var(--pr-radius-clip)',
							}}
							data-ghost-remove={x.change}
							data-ghost-item={x.itemId}
							aria-hidden="true"
						/>
					))}
				{placed.clips
					.filter((x) => x.region === r)
					.map((x) => {
						const it = model.byItem[x.itemId];
						if (!it) return null;
						const sel = selected.has(x.itemId);
						const paint = ghostPaint(it.state, { highContrast: hc, selected: sel });
						const glyph = stateGlyph(it.state, hc);
						const isActive = focused && active === x.itemId;
						return (
							<div
								key={x.key}
								className="pointer-events-auto absolute cursor-pointer overflow-hidden"
								style={{
									left: x.x,
									width: x.w,
									top: x.y - box.top + 1,
									height: Math.max(8, x.h - 2),
									background: 'var(--pr-ghost-fill)',
									backgroundImage: paint.hatch
										? 'repeating-linear-gradient(135deg, var(--pr-ghost-stroke) 0 1px, transparent 1px 6px)'
										: undefined,
									border: `${paint.borderWidth}px ${paint.borderStyle} ${paint.borderColor}`,
									borderLeft: model.agent ? '3px solid var(--pr-agent)' : undefined,
									borderRadius: 'var(--pr-radius-clip)',
									opacity: paint.opacity,
									outline: isActive ? '2px solid var(--pr-focus-ring)' : undefined,
									outlineOffset: 1,
								}}
								onPointerDown={(e) => onGhostDown(e, x.itemId)}
								onPointerEnter={(e) => onGhostEnter(e, x.itemId)}
								onPointerLeave={onGhostLeave}
								onDoubleClick={(e) => e.stopPropagation()}
								onContextMenu={(e) => {
									e.preventDefault();
									e.stopPropagation();
									controller.select([x.itemId]);
									setActive(x.itemId);
									openAt(x.itemId, e.currentTarget, true);
								}}
								data-ghost-item={x.itemId}
								data-ghost-clip={x.clipId}
								data-ghost-change={x.change}
								data-ghost-state={it.state}
								data-ghost-agent={model.agent || undefined}
								data-ghost-new-track={x.newTrack || undefined}
								data-selected={sel || undefined}
								aria-hidden="true"
							>
								<span className="absolute top-0 left-1 truncate text-pr-small whitespace-nowrap text-pr-text">
									{x.name}
								</span>
								{glyph ? (
									<span
										className="absolute top-0 right-1 text-pr-small font-semibold"
										style={{ color: paint.glyphColor }}
										data-ghost-glyph={glyph}
									>
										{glyph}
									</span>
								) : null}
							</div>
						);
					})}
			</div>
		);
	};

	const activeItem = active ? model.byItem[active] : undefined;
	const seqTc = seq;
	return (
		<>
			{ghostsIn('video')}
			{ghostsIn('audio')}
			<div
				ref={listRef}
				role="listbox"
				aria-label={t('Proposal review: {0} items', model.items.length)}
				aria-activedescendant={activeItem ? `${idPrefix}${activeItem.id}` : undefined}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a composite widget (listbox, one tab stop, aria-activedescendant)
				tabIndex={0}
				data-keymap-local
				data-testid="proposal-ghost-items"
				className="pointer-events-none absolute top-0 left-0 h-px w-px overflow-hidden outline-none"
				onKeyDown={onKeyDown}
				onFocus={() => {
					setFocused(true);
					if (!active) {
						const id = selection.at(-1) ?? neighbourItem(model, null, 1, session.transport.getState().frame);
						if (id) setActive(id);
					}
				}}
				onBlur={() => setFocused(false)}
			>
				{model.items.map((it) => {
					const review = byId.get(it.id);
					const why = review ? whyLines(review, model, seqTc, undefined).why : null;
					return (
						<div
							key={it.id}
							id={`${idPrefix}${it.id}`}
							role="option"
							aria-selected={selected.has(it.id)}
							aria-label={ghostAriaLabel(it, why, seq)}
							data-ghost-option={it.id}
							data-ghost-state={it.state}
						/>
					);
				})}
			</div>
			{card ? (
				<GhostCard
					key={card.itemId}
					session={session}
					controller={controller}
					seq={seq}
					model={model}
					card={card}
					onClose={() => setCard(null)}
					onEnter={clearHover}
					onLeave={card.pinned ? undefined : onGhostLeave}
					toast={p.toast}
				/>
			) : null}
		</>
	);
}

function placeOf(el: Element): { x: number; y: number } {
	const r = el.getBoundingClientRect();
	return { x: r.left, y: r.bottom + 4 };
}

/** The lane of a track the proposal creates: a dashed band across the track area. */
function GhostTrackLane(props: { row: GhostRow; top: number; hc: boolean }) {
	const { row } = props;
	return (
		<div
			className="absolute right-0 left-0"
			style={{
				top: row.y - props.top,
				height: row.height,
				borderTop: `${props.hc ? 2 : 1}px ${props.hc ? 'solid' : 'dashed'} var(--pr-ghost-stroke)`,
				borderBottom: `${props.hc ? 2 : 1}px ${props.hc ? 'solid' : 'dashed'} var(--pr-ghost-stroke)`,
				background: 'var(--pr-bg-panel-alt)',
			}}
			data-ghost-lane={row.trackId}
			data-ghost-item={row.track.itemId}
			aria-hidden="true"
		/>
	);
}

/** Ghost track headers ("A4 · SFX 1 (new)") in the header column, at the rows of the ghost lanes. */
export function GhostTrackHeaders(props: { session: EditorSession; model: GhostModel; layout: TrackAreaLayout }) {
	const hc = useHighContrast();
	const items = useProposals(props.session, (s) => s.items);
	const rows = useMemo(() => layoutGhosts(props.model, props.layout, { scrollFrame: 0, pxPerFrame: 1, width: 0 }).rows, [props.model, props.layout]);
	if (!rows.length) return null;
	const stateOf = new Map(items.map((it) => [it.id, it.state]));
	return (
		<>
			{(['video', 'audio'] as const).map((r) => {
				const box =
					r === 'video'
						? { top: props.layout.video.top, height: props.layout.video.height }
						: { top: props.layout.audio.top, height: Math.max(0, props.layout.height - props.layout.audio.top) };
				const list = rows.filter((x) => x.region === r);
				if (!list.length) return null;
				return (
					<div
						key={r}
						className="pointer-events-none absolute right-0 left-0 overflow-hidden"
						style={{ top: box.top, height: box.height, zIndex: 3 }}
					>
						{list.map((row) => {
							const st = stateOf.get(row.track.itemId);
							const glyph = st && st !== 'applied' ? stateGlyph(st, hc) : null;
							return (
								<div
									key={row.trackId}
									className="absolute right-1 left-1 flex items-center gap-1 px-2 text-pr-small text-pr-text"
									style={{
										top: row.y - box.top + 1,
										height: row.height - 2,
										border: `${hc ? 2 : 1}px ${hc ? 'solid' : 'dashed'} var(--pr-ghost-stroke)`,
										borderLeft: props.model.agent ? '3px solid var(--pr-agent)' : undefined,
										borderRadius: 'var(--pr-radius-control)',
										background: 'var(--pr-bg-panel)',
										opacity: st === 'rejected' ? 0.35 : 1,
									}}
									data-ghost-header={row.trackId}
									data-ghost-item={row.track.itemId}
								>
									<span className="truncate">{t('{0} · {1} (new)', row.track.label, row.track.name)}</span>
									{glyph ? <span aria-hidden="true">{glyph}</span> : null}
								</div>
							);
						})}
					</div>
				);
			})}
		</>
	);
}

function GhostCard(props: {
	session: EditorSession;
	controller: ProposalsController;
	seq: Sequence;
	model: GhostModel;
	card: Card;
	onClose(): void;
	onEnter(): void;
	onLeave?: () => void;
	toast(kind: 'info' | 'warning' | 'error', message: string): void;
}) {
	const { controller, card, model, seq } = props;
	const ref = useRef<HTMLDivElement>(null);
	const item = useProposals(props.session, (s) => s.items.find((it) => it.id === card.itemId));
	const accepted = useProposals(props.session, (s) => (s.activeId ? (s.accepted[s.activeId] ?? []).length : 0));
	const total = useProposals(props.session, (s) => s.items.length);
	const busy = useProposals(props.session, (s) => s.busy);
	const previewSeq = useProposals(props.session, (s) => s.preview?.result.document.sequences[seq.id]);
	const readOnly = useSessionState((s) => s.readOnly);
	const [noteOpen, setNoteOpen] = useState(false);
	const [note, setNote] = useState(item?.note ?? '');
	useEffect(() => {
		if (card.focus) ref.current?.querySelector<HTMLElement>('button')?.focus();
	}, [card.focus]);
	useEffect(() => {
		if (!card.pinned) return;
		const onDown = (e: PointerEvent) => {
			if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
			const el = e.target instanceof Element ? e.target.closest('[data-ghost-item]') : null;
			if (el) return;
			props.onClose();
		};
		window.addEventListener('pointerdown', onDown, true);
		return () => window.removeEventListener('pointerdown', onDown, true);
	}, [card.pinned, props.onClose]);
	if (!item || item.state === 'applied') return null;
	const gi = model.byItem[item.id];
	const lines = whyLines(item, model, seq, previewSeq);
	const decide = async (d: 'accept' | 'reject' | 'clear') => {
		const r = await controller.setItemDecision([item.id], d);
		if (!r.ok) props.toast('warning', r.message);
	};
	const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
	const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
	const left = Math.max(4, Math.min(card.x, vw - 340));
	const top = card.y + 220 > vh ? Math.max(4, card.y - 250) : card.y;
	const body: ReactNode = (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover keeps the transient card open; the card is a dialog
		<div
			ref={ref}
			role="dialog"
			aria-label={t('Proposal item: {0}', item.label)}
			className="fixed flex w-[320px] flex-col gap-1 rounded-pr-menu border border-pr-menu-border bg-pr-menu p-2 text-pr-small text-pr-text shadow-pr-overlay"
			style={{ left, top, zIndex: Z.popover }}
			onPointerEnter={props.onEnter}
			onPointerLeave={props.onLeave}
			onPointerDown={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					props.onClose();
				}
			}}
			data-testid="proposal-ghost-card"
			data-ghost-card={item.id}
			data-keymap-local
		>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate font-semibold text-pr-strong">{item.label}</span>
				<span className="shrink-0 text-pr-muted" data-ghost-card-state={item.state}>
					{stateGlyph(item.state, true)} {GHOST_STATE_LABELS[item.state]}
				</span>
			</div>
			{lines.why ? (
				<div className="text-pr-text" data-ghost-why>
					{lines.why}
				</div>
			) : null}
			{lines.facts.length ? (
				<ul className="list-none text-pr-muted">
					{lines.facts.map((f) => (
						<li key={f}>{f}</li>
					))}
				</ul>
			) : null}
			{lines.problem ? (
				<div className="text-pr-warning" data-ghost-problem>
					! {lines.problem}
				</div>
			) : null}
			{item.note && !noteOpen ? <div className="text-pr-muted italic">✎ {item.note}</div> : null}
			<div className="flex flex-wrap gap-1 pt-1">
				<Button
					variant={item.state === 'accepted' ? 'primary' : 'secondary'}
					aria-pressed={item.state === 'accepted'}
					disabled={item.state === 'invalid'}
					onClick={() => void decide(item.state === 'accepted' ? 'clear' : 'accept')}
					data-ghost-action="accept"
				>
					✓ {t('Accept')}
				</Button>
				<Button
					variant={item.state === 'rejected' ? 'primary' : 'secondary'}
					aria-pressed={item.state === 'rejected'}
					onClick={() => void decide(item.state === 'rejected' ? 'clear' : 'reject')}
					data-ghost-action="reject"
				>
					✕ {t('Reject')}
				</Button>
				<Button
					variant="secondary"
					disabled={item.alternatives < 2}
					disabledReason={item.alternatives < 2 ? t('No alternates for this item') : undefined}
					title={item.alternativeLabels[(item.selectedAlternative + 1) % item.alternatives]}
					onClick={async () => {
						const r = await controller.cycleAlternative(item.id, 1);
						if (!r.ok) props.toast('warning', r.message);
					}}
					data-ghost-action="alternate"
				>
					⇄ {t('Alternate {0}/{1}', item.selectedAlternative + 1, item.alternatives)}
				</Button>
				<Button
					variant="secondary"
					disabled={!gi}
					onClick={() => gi && playItem(props.session, controller, seq, gi)}
					data-ghost-action="play"
				>
					▶ {t('Play')}
				</Button>
				<Button
					variant="secondary"
					aria-expanded={noteOpen}
					onClick={() => {
						setNote(item.note ?? '');
						setNoteOpen((o) => !o);
					}}
					data-ghost-action="note"
				>
					✎ {t('Note')}
				</Button>
			</div>
			{noteOpen ? (
				<div className="flex flex-col gap-1">
					<textarea
						className="h-14 resize-none rounded-pr-control border border-pr-border bg-pr-field p-1 text-pr-small text-pr-text"
						aria-label={t('Note for the agent')}
						maxLength={4000}
						value={note}
						onChange={(e) => setNote(e.target.value)}
						onKeyDown={(e) => e.stopPropagation()}
						data-ghost-note-input
					/>
					<div className="flex justify-end gap-1">
						<Button variant="quiet" onClick={() => setNoteOpen(false)}>
							{t('Cancel')}
						</Button>
						<Button
							variant="primary"
							onClick={async () => {
								const r = await controller.note(item.id, note.trim() ? note : null);
								if (!r.ok) props.toast('warning', r.message);
								else setNoteOpen(false);
							}}
							data-ghost-action="save-note"
						>
							{t('Save Note')}
						</Button>
					</div>
				</div>
			) : null}
			{accepted > 0 ? (
				<div className="flex items-center justify-end gap-2 border-t border-pr-border pt-1">
					<Button
						variant="primary"
						busy={busy}
						disabled={readOnly}
						disabledReason={readOnly ? t('The project is read-only') : undefined}
						onClick={async (e) => {
							const r = await controller.apply({ trusted: e.nativeEvent.isTrusted });
							if (!r.ok) props.toast(r.code === 'E_UNTRUSTED' ? 'error' : 'warning', r.message);
							else {
								props.toast(
									'info',
									r.stale.length
										? t('{0} — {1} stale items left in review', r.label ?? t('Applied'), r.stale.length)
										: (r.label ?? t('Applied')),
								);
								props.onClose();
							}
						}}
						data-ghost-action="apply"
					>
						{t('Apply {0} of {1}', accepted, total)}
					</Button>
				</div>
			) : null}
		</div>
	);
	return typeof document !== 'undefined' ? createPortal(body, document.body) : body;
}

/** Where the ghost of an item starts (x in track-area px), for cards opened from elsewhere. */
export function ghostItemX(model: GhostModel, itemId: string, v: Viewport): number | null {
	const it = model.byItem[itemId];
	return it ? frameToX(v, it.start) : null;
}

export type { ReviewItem };
