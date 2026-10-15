// The Cue Seam (spec 12 §2.7, P2-R7): an 18 px lane in the widened video/audio divider of the Timeline that does not
// scroll vertically. One glyph per cue (kind → shape, weight → size, state → stroke / fill / dash / underline), span
// bars for windows, builds and stop-befores, and a 1 px connector from each filled cue to the peak of the clip that
// fills it (an arrow when that clip's row is scrolled out of view).
//
// Editing: click selects (Shift adds/removes), drag moves (snapping first to the cue's own picture event, then to the
// timeline's targets), Alt-drag duplicates, Delete removes, double-click / Enter opens the Sound Library to fill the
// cue (`soundLibrary.fillCue`), right-click opens the cue menu. Keyboard: the lane is one tab stop (role toolbar with
// `aria-activedescendant`), Left/Right/Home/End move between cues (Shift extends the selection), Enter fills, Delete
// removes, the context-menu key or Shift+F10 opens the menu, Esc deselects. Every edit is a `soundCue.*` command.
import {
	type Clip,
	type Command,
	formatTimecode,
	type MediaAsset,
	type Rational,
	type Sequence,
	type SoundCue,
	trackLabel,
} from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { collectMenuItems, cueMenuExtensions } from '../../extensions/index.ts';
import { t } from '../../i18n/runtime.ts';
import { rowOf, type TrackAreaLayout } from '../../panels/timeline/model/layout.ts';
import {
	collectSnapTargets,
	findSnap,
	SNAP_PRIORITY,
	type SnapTarget,
	thresholdFrames,
} from '../../panels/timeline/model/snapping.ts';
import { deltaFramesFromPx, frameToX, type Viewport } from '../../panels/timeline/model/viewport.ts';
import type { ContextMenuItem, TimelineUiStore } from '../../panels/timeline/state/ui-store.ts';
import { endSoundDrag, isSoundDrag, readSoundDrag } from '../insert.ts';
import {
	CUE_ALIGN_LABELS,
	CUE_WEIGHT_LABELS,
	type CueGeom,
	clipPeakFrame,
	cueAriaLabel,
	cuesOf,
	cueTooltip,
	glyphPaint,
	glyphPath,
	heroConflicts,
	hitCue,
	kindLabel,
	layoutCues,
	neighbourCue,
	openGlyph,
	SEAM_PX,
	VISUAL_TAGS,
} from './model.ts';
import {
	anchorFrame,
	cuesToMarkersCommands,
	duplicateCueCommands,
	moveCueCommands,
	removeCueCommands,
	STOP_BEFORE_DEFAULT,
	updateCuesCommands,
} from './seam.ts';

const EMPTY: readonly string[] = [];
const DRAG_START_PX = 3;

export type CueSeamProps = {
	session: EditorSession;
	/** The drawn sequence (follows gestures). */
	seq: Sequence;
	layout: TrackAreaLayout;
	viewport: Viewport;
	media: Record<string, MediaAsset>;
	ui: TimelineUiStore;
	instanceId: string;
	snapping: boolean;
	run(commandId: string, args?: unknown): void;
	openMenu(x: number, y: number, items: ContextMenuItem[]): void;
	toast(kind: 'info' | 'warning' | 'error', message: string): void;
	/** Scrolls the timeline so a frame is in view. */
	reveal(frame: number): void;
	/** Proposal cues drawn as ghosts (P3); never edited here. */
	ghosts?: readonly SoundCue[];
};

type Drag = {
	pointerId: number;
	grabbed: SoundCue;
	cues: SoundCue[];
	x0: number;
	duplicate: boolean;
	moved: boolean;
	delta: number;
	gesture: Gesture | null;
	targets: SnapTarget[];
	/** Pointer-up on an already selected cue without moving reduces the selection to it. */
	reduceTo: string | null;
};

const tcOf = (seq: Sequence) => (f: number) =>
	formatTimecode(Math.max(0, Math.floor(f)), seq.settings.frameRate as Rational, {
		dropFrame: seq.settings.dropFrame,
		startFrames: seq.settings.startTimecodeFrames,
	});

export function CueSeam(p: CueSeamProps) {
	const { session, seq, layout, viewport: v } = p;
	const laneRef = useRef<HTMLDivElement>(null);
	const drag = useRef<Drag | null>(null);
	const selectedIds = useSessionState((s) => s.selection.cues ?? EMPTY);
	const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
	const [active, setActive] = useState<string | null>(null);
	// spec 12 §2.7 Fill: a library sound dragged over a cue glyph highlights it; dropping fills that cue.
	const [dropCue, setDropCue] = useState<string | null>(null);
	const cues = useMemo(() => cuesOf(seq), [seq]);
	const rate = seq.settings.frameRate as Rational;
	const conflicts = useMemo(() => heroConflicts(cues, rate), [cues, rate]);
	const ghostCues = p.ghosts ?? [];
	const geoms = useMemo(
		() =>
			layoutCues([...cues, ...ghostCues], v, {
				rate,
				selected,
				conflicts,
				ghosts: new Set(ghostCues.map((g) => g.id)),
				clips: seq.clips,
			}),
		[cues, ghostCues, v, rate, selected, conflicts, seq.clips],
	);
	const tc = tcOf(seq);
	const byId = useMemo(() => new Map(cues.map((c) => [c.id, c])), [cues]);
	const idPrefix = `cue-${p.instanceId}-`;
	const readOnly = useSessionState((s) => s.readOnly);

	// The keyboard focus follows the selection when it changes from elsewhere (Next Cue, agents).
	useEffect(() => {
		if (active && byId.has(active)) return;
		const last = selectedIds[selectedIds.length - 1];
		setActive(last && byId.has(last) ? last : null);
	}, [active, byId, selectedIds]);

	// Selecting clips deselects cues (one selection the Delete key acts on).
	useEffect(
		() =>
			session.on('selection.changed', ({ selection }) => {
				if (selection.timeline.clips.length && selection.cues?.length) session.select('cues', [], 'replace');
			}),
		[session],
	);

	const apply = (label: string, commands: Command[]) => {
		if (!commands.length) return null;
		const r = session.apply({ label, origin: 'user', sequenceId: seq.id, commands });
		if (!r.ok) p.toast('warning', r.errors[0]?.message ?? t('{0} failed', label));
		return r;
	};
	const selectCue = (id: string, mode: 'replace' | 'toggle' | 'add') => {
		if (mode === 'replace') session.select('timeline', [], 'replace');
		session.select('cues', [id], mode);
		setActive(id);
	};
	const selection = (): SoundCue[] => {
		const ids = new Set(session.getState().selection.cues ?? []);
		return cues.filter((c) => ids.has(c.id));
	};
	const removeSelected = () => {
		const ids = selection().map((c) => c.id);
		if (!ids.length) return;
		const r = apply(
			ids.length > 1 ? t('Delete Cues ({0})', ids.length) : t('Delete Cue'),
			removeCueCommands(ids),
		);
		if (r?.ok) session.select('cues', [], 'replace');
	};
	const fill = (id: string) => p.run('soundLibrary.fillCue', { cueId: id });

	// ---- pointer
	const localX = (e: { clientX: number }) => e.clientX - (laneRef.current?.getBoundingClientRect().left ?? 0);
	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.stopPropagation();
		if (e.button !== 0) return;
		const id = hitCue(geoms, localX(e));
		const cue = id ? byId.get(id) : undefined;
		if (!cue) {
			if (!e.shiftKey) session.select('cues', [], 'replace');
			return;
		}
		const was = selected.has(cue.id);
		let reduceTo: string | null = null;
		if (e.shiftKey) selectCue(cue.id, 'toggle');
		else if (!was) selectCue(cue.id, 'replace');
		else {
			setActive(cue.id);
			reduceTo = cue.id;
		}
		const ids = new Set(session.getState().selection.cues ?? []);
		if (!ids.has(cue.id) || readOnly) return;
		const moving = cues.filter((c) => ids.has(c.id));
		const at = anchorFrame(session.getCommitted(), session.getCommitted().sequences[seq.id] ?? seq, cue);
		e.currentTarget.setPointerCapture?.(e.pointerId);
		drag.current = {
			pointerId: e.pointerId,
			grabbed: cue,
			cues: moving,
			x0: e.clientX,
			duplicate: e.altKey,
			moved: false,
			delta: 0,
			gesture: null,
			targets: collectSnapTargets(seq, {
				playhead: session.transport.getState().frame,
				excludeCues: e.altKey ? new Set() : ids,
				extra: at !== null ? [{ frame: at, kind: 'anchor', priority: SNAP_PRIORITY.anchor }] : [],
			}),
			reduceTo,
		};
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d || d.pointerId !== e.pointerId) return;
		const dx = e.clientX - d.x0;
		if (!d.moved && Math.abs(dx) < DRAG_START_PX) return;
		d.moved = true;
		const raw = deltaFramesFromPx(dx, v.pxPerFrame);
		let delta = raw;
		let snapFrame: number | null = null;
		if (p.snapping) {
			const s = findSnap(d.targets, [d.grabbed.frame + raw], thresholdFrames(v.pxPerFrame));
			if (s) {
				delta = raw + s.offset;
				snapFrame = s.target.frame;
			}
		}
		const minFrame = Math.min(...d.cues.map((c) => c.frame));
		if (minFrame + delta < 0) {
			delta = -minFrame;
			snapFrame = null;
		}
		const to = d.grabbed.frame + delta;
		const committedSeq = session.getCommitted().sequences[seq.id] ?? seq;
		const at = anchorFrame(session.getCommitted(), committedSeq, d.grabbed);
		const lines = [
			`${tc(to)}  ${delta >= 0 ? '+' : ''}${delta}`,
			...(d.duplicate
				? [t('Duplicate')]
				: d.grabbed.anchor && at !== null && at !== to
					? [t('Detached from its picture event')]
					: []),
		];
		p.ui.setState({ snapFrame, tooltip: { x: frameToX(v, to), y: layout.dividerTop + SEAM_PX, lines } });
		if (delta === d.delta && d.gesture) return;
		d.delta = delta;
		if (!d.gesture) {
			try {
				d.gesture = session.beginGesture(
					d.duplicate
						? d.cues.length > 1
							? t('Duplicate Cues ({0})', d.cues.length)
							: t('Duplicate Cue')
						: d.cues.length > 1
							? t('Move Cues ({0})', d.cues.length)
							: t('Move Cue'),
				);
			} catch {
				drag.current = null;
				return;
			}
		}
		const commands = d.duplicate
			? duplicateCueCommands(d.cues, delta)
			: moveCueCommands(session.getCommitted(), committedSeq, d.cues, delta);
		const r = d.gesture.update(delta === 0 && !d.duplicate ? [] : commands);
		if (!r.ok)
			p.ui.setState({
				tooltip: { x: frameToX(v, to), y: layout.dividerTop + SEAM_PX, lines: [r.errors[0]?.message ?? ''] },
			});
	};
	const endDrag = (commit: boolean) => {
		const d = drag.current;
		drag.current = null;
		p.ui.setState({ snapFrame: null, tooltip: null });
		if (!d) return;
		if (!d.moved) {
			if (d.reduceTo) selectCue(d.reduceTo, 'replace');
			return;
		}
		if (!d.gesture) return;
		if (!commit || (d.delta === 0 && !d.duplicate)) {
			d.gesture.cancel();
			return;
		}
		const r = d.gesture.commit();
		if (r && !r.ok) {
			p.toast('warning', r.errors[0]?.message ?? t('Edit failed'));
			return;
		}
		if (r?.ok && d.duplicate) {
			const ids = (r.results[0] as { cueIds?: string[] } | undefined)?.cueIds ?? [];
			if (ids.length) {
				session.select('cues', ids, 'replace');
				setActive(ids[ids.length - 1]!);
			}
		}
	};

	// ---- menu
	const cueMenu = (cue: SoundCue): ContextMenuItem[] => {
		const ids = selected.has(cue.id) ? [...selected] : [cue.id];
		const sel = cues.filter((c) => ids.includes(c.id));
		const set = (label: string, patch: Parameters<typeof updateCuesCommands>[1]) =>
			apply(label, updateCuesCommands(ids, patch));
		const allStop = sel.every((c) => !!c.stopBefore);
		const ext = collectMenuItems(cueMenuExtensions.list(), {
			session,
			sequenceId: seq.id,
			cueId: cue.id,
			selection: ids,
			runCommand: (id: string, args?: unknown) => p.run(id, args),
		}) as ContextMenuItem[];
		return [
			{
				kind: 'submenu',
				label: t('Role'),
				items: (['hero', 'support', 'ambient'] as const).map((w) => ({
					kind: 'item' as const,
					label: CUE_WEIGHT_LABELS[w],
					checked: sel.every((c) => c.weight === w),
					disabled: readOnly,
					run: () => set(t('Cue Role'), { weight: w }),
				})),
			},
			{
				kind: 'submenu',
				label: t('Visual Tag'),
				items: VISUAL_TAGS.map((k) => ({
					kind: 'item' as const,
					label: kindLabel(k),
					checked: sel.every((c) => c.kind === k),
					disabled: readOnly,
					run: () => set(t('Cue Visual Tag'), { kind: k }),
				})),
			},
			{
				kind: 'submenu',
				label: t('Align'),
				items: (['peak', 'start', 'end'] as const).map((a) => ({
					kind: 'item' as const,
					label: CUE_ALIGN_LABELS[a],
					checked: sel.every((c) => (c.align ?? 'peak') === a),
					disabled: readOnly,
					run: () => set(t('Cue Align'), { align: a }),
				})),
			},
			{
				kind: 'item',
				label: t('Stop Before Next'),
				checked: allStop,
				disabled: readOnly,
				run: () => set(t('Stop Before Next'), { stopBefore: allStop ? null : { ...STOP_BEFORE_DEFAULT } }),
			},
			{
				kind: 'item',
				label: t('Mute Cue'),
				checked: sel.every((c) => !!c.muted),
				disabled: readOnly,
				run: () => set(t('Mute Cue'), { muted: !sel.every((c) => !!c.muted) }),
			},
			...ext,
			{ kind: 'separator' },
			{
				kind: 'item',
				label: t('Convert to Marker'),
				disabled: readOnly,
				run: () => {
					const r = apply(
						sel.length > 1 ? t('Convert Cues to Markers ({0})', sel.length) : t('Convert Cue to Marker'),
						cuesToMarkersCommands(sel),
					);
					if (r?.ok) session.select('cues', [], 'replace');
				},
			},
			{
				kind: 'item',
				label: t('Delete'),
				shortcut: 'Delete',
				disabled: readOnly,
				run: removeSelected,
			},
		];
	};
	const openCueMenu = (cue: SoundCue, x: number, y: number) => {
		if (!selected.has(cue.id)) selectCue(cue.id, 'replace');
		p.openMenu(x, y, cueMenu(cue));
	};
	const laneMenu = (x: number, y: number) =>
		p.openMenu(x, y, [
			{ kind: 'item', label: t('Add Sound Cue'), shortcut: 'Alt+Shift+C', run: () => p.run('sound.addCue') },
			{ kind: 'item', label: t('Suggest Cues…'), run: () => p.run('sound.suggestCues') },
			{ kind: 'item', label: t('Clear Unfilled Cues'), run: () => p.run('sound.clearUnfilledCues') },
			{ kind: 'separator' },
			{ kind: 'item', label: t('Hide Cue Seam'), run: () => p.run('sound.toggleCueSeam') },
		]);
	const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		const id = hitCue(geoms, localX(e));
		const cue = id ? byId.get(id) : undefined;
		if (cue) openCueMenu(cue, e.clientX, e.clientY);
		else laneMenu(e.clientX, e.clientY);
	};
	const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
		if (!isSoundDrag(e.dataTransfer)) return;
		const x = localX(e);
		const id = Number.isFinite(x) ? hitCue(geoms, x) : null;
		const ok = !!id && byId.has(id) && !session.getState().readOnly;
		setDropCue(ok ? id : null);
		if (!ok) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = 'copy';
	};
	const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
		const id = dropCue;
		setDropCue(null);
		if (!id || !isSoundDrag(e.dataTransfer)) return;
		e.preventDefault();
		e.stopPropagation();
		const payload = readSoundDrag(e.dataTransfer);
		endSoundDrag();
		if (payload) p.run('sound.fillCue', { cueId: id, soundId: payload.soundId });
	};
	const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
		e.stopPropagation();
		const id = hitCue(geoms, localX(e));
		if (id && byId.has(id)) fill(id);
	};

	// ---- keyboard
	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const move = (dir: 1 | -1 | 'first' | 'last') => {
			const id = neighbourCue(cues, active, dir, session.transport.getState().frame);
			if (!id) return;
			if (e.shiftKey) {
				session.select('cues', [id], 'add');
				setActive(id);
			} else selectCue(id, 'replace');
			const c = byId.get(id);
			if (c) p.reveal(c.frame);
		};
		const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
		let handled = true;
		if (plain && e.key === 'ArrowRight') move(1);
		else if (plain && e.key === 'ArrowLeft') move(-1);
		else if (plain && e.key === 'Home') move('first');
		else if (plain && e.key === 'End') move('last');
		else if (plain && !e.shiftKey && (e.key === 'Enter' || e.code === 'NumpadEnter') && active) fill(active);
		else if (plain && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace') && selected.size)
			removeSelected();
		else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && active) {
			const g = geoms.find((x) => x.id === active);
			const r = laneRef.current?.getBoundingClientRect();
			const cue = byId.get(active);
			if (cue) openCueMenu(cue, (r?.left ?? 0) + (g?.x ?? 0), (r?.top ?? 0) + SEAM_PX);
		} else if (plain && !e.shiftKey && e.key === 'Escape' && selected.size)
			session.select('cues', [], 'replace');
		else handled = false;
		if (handled) {
			e.preventDefault();
			e.stopPropagation();
		}
	};

	// ---- connectors (filled cues → the peak of each clip that fills them)
	const audio = layout.audio;
	const connectors: { key: string; x0: number; x1: number; y1: number }[] = [];
	const arrows: { key: string; x: number; dir: 'down' | 'up' }[] = [];
	for (const g of geoms) {
		const c = byId.get(g.id);
		if (!c?.placedClipIds?.length) continue;
		for (const clipId of c.placedClipIds) {
			const clip = seq.clips[clipId] as Clip | undefined;
			if (!clip) continue;
			const row = rowOf(layout, clip.trackId);
			const peak = clipPeakFrame(clip as never, p.media[(clip as { mediaId?: string }).mediaId ?? ''], rate);
			const x1 = frameToX(v, peak ?? clip.start);
			if (row?.kind !== 'audio') continue;
			if (row.y + 2 > audio.top + audio.height)
				arrows.push({ key: `${g.id}:${clipId}`, x: g.x, dir: 'down' });
			else if (row.y + row.height < audio.top) arrows.push({ key: `${g.id}:${clipId}`, x: g.x, dir: 'up' });
			else connectors.push({ key: `${g.id}:${clipId}`, x0: g.x, x1, y1: Math.max(0, row.y - audio.top) + 1 });
		}
	}

	return (
		<>
			<div
				ref={laneRef}
				role="toolbar"
				aria-label={t('Cue Seam: {0} cues', cues.length)}
				aria-orientation="horizontal"
				aria-activedescendant={
					active && geoms.some((g) => g.id === active) ? `${idPrefix}${active}` : undefined
				}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a composite widget (role toolbar, one tab stop, aria-activedescendant)
				tabIndex={0}
				data-keymap-local
				data-testid="cue-seam"
				className="absolute right-0 left-0 overflow-hidden outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--pr-focus-ring)]"
				style={{ top: layout.dividerTop, height: SEAM_PX, background: 'var(--pr-bg-app)', zIndex: 4 }}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={() => endDrag(true)}
				onPointerCancel={() => endDrag(false)}
				onLostPointerCapture={() => {
					if (drag.current) endDrag(true);
				}}
				onContextMenu={onContextMenu}
				onDoubleClick={onDoubleClick}
				onKeyDown={onKeyDown}
				onDragOver={onDragOver}
				onDragLeave={() => setDropCue(null)}
				onDrop={onDrop}
			>
				<svg
					className="pointer-events-none absolute inset-0"
					width="100%"
					height={SEAM_PX}
					aria-hidden="true"
					data-testid="cue-seam-spans"
				>
					{geoms.map((g) => (
						<g key={`spans:${g.id}`}>
							{g.window ? (
								<g data-cue-window={g.id} opacity={0.65}>
									<line
										x1={g.window.x0}
										x2={g.window.x1}
										y1={SEAM_PX - 2.5}
										y2={SEAM_PX - 2.5}
										stroke="var(--pr-cue)"
										strokeWidth={1}
									/>
									<line
										x1={g.window.x0}
										x2={g.window.x0}
										y1={SEAM_PX - 5}
										y2={SEAM_PX}
										stroke="var(--pr-cue)"
									/>
									<line
										x1={g.window.x1}
										x2={g.window.x1}
										y1={SEAM_PX - 5}
										y2={SEAM_PX}
										stroke="var(--pr-cue)"
									/>
								</g>
							) : null}
							{g.build ? (
								<polygon
									data-cue-build={g.id}
									points={`${g.build.x0},${SEAM_PX - 1} ${g.build.x1},${SEAM_PX - 1} ${g.build.x1},${SEAM_PX - 5}`}
									fill="var(--pr-cue)"
									opacity={0.5}
								/>
							) : null}
							{g.stopBefore ? (
								<g data-cue-stop={g.id}>
									<rect
										x={g.stopBefore.x0}
										y={1}
										width={Math.max(1, g.stopBefore.x1 - g.stopBefore.x0)}
										height={2}
										fill="var(--pr-cue)"
										opacity={0.6}
									/>
									<line
										x1={g.stopBefore.x1}
										x2={g.stopBefore.x1}
										y1={0}
										y2={5}
										stroke="var(--pr-cue)"
										strokeWidth={1.5}
									/>
								</g>
							) : null}
						</g>
					))}
				</svg>
				{geoms.map((g) => (
					<CueGlyph
						key={g.id}
						g={g}
						id={`${idPrefix}${g.id}`}
						active={active === g.id}
						dropTarget={dropCue === g.id}
						cue={byId.get(g.id) ?? ghostCues.find((x) => x.id === g.id)}
						seq={seq}
						tc={tc}
					/>
				))}
				{arrows.map((a) => (
					<svg
						key={`arrow:${a.key}`}
						className="pointer-events-none absolute"
						style={{ left: a.x - 3, top: a.dir === 'down' ? SEAM_PX - 4 : 0, width: 6, height: 4 }}
						viewBox="0 0 6 4"
						aria-hidden="true"
						data-cue-arrow={a.dir}
					>
						<polygon points={a.dir === 'down' ? '0,0 6,0 3,4' : '0,4 6,4 3,0'} fill="var(--pr-cue)" />
					</svg>
				))}
			</div>
			{connectors.length ? (
				<svg
					className="pointer-events-none absolute right-0 left-0"
					style={{ top: audio.top, height: audio.height, width: '100%', zIndex: 3 }}
					aria-hidden="true"
					data-testid="cue-seam-connectors"
				>
					{connectors.map((c) => (
						<line
							key={c.key}
							x1={c.x0}
							y1={0}
							x2={c.x1}
							y2={c.y1}
							stroke="var(--pr-cue)"
							strokeWidth={1}
							data-cue-connector={c.key}
						/>
					))}
				</svg>
			) : null}
		</>
	);
}

function CueGlyph(props: {
	g: CueGeom;
	id: string;
	active: boolean;
	/** A library sound is dragged over it: dropping fills it. */
	dropTarget?: boolean;
	cue: SoundCue | undefined;
	seq: Sequence;
	tc: (f: number) => string;
}) {
	const { g, cue, seq } = props;
	if (!cue) return null;
	const paint = glyphPaint(g.weight, g.shape, g.state);
	const box = g.size + 6;
	const h = box / 2;
	const placedNames = (cue.placedClipIds ?? [])
		.map((id) => seq.clips[id])
		.filter((c): c is Clip => !!c)
		.map((c) => `${trackLabel(seq, c.trackId) ?? ''} ${c.name}`.trim());
	const label = cueAriaLabel(cue, {
		timecode: props.tc(cue.frame),
		placedNames,
		conflict: g.state.conflict,
		clips: seq.clips,
	});
	return (
		// biome-ignore lint/a11y/useSemanticElements: an item of the seam's composite (aria-activedescendant); the lane owns focus and keys
		<div
			id={props.id}
			role="button"
			tabIndex={-1}
			aria-label={label}
			aria-pressed={g.state.selected}
			title={cueTooltip(cue, props.tc(cue.frame), seq.clips).join('\n')}
			className="absolute"
			style={{ left: g.x - h, top: SEAM_PX / 2 - h, width: box, height: box }}
			data-cue-id={g.id}
			data-cue-kind={cue.kind}
			data-cue-weight={g.weight}
			data-cue-frame={cue.frame}
			data-cue-state={[
				g.state.filled ? 'filled' : 'unfilled',
				g.state.agent ? 'agent' : '',
				g.state.ghost ? 'ghost' : '',
				g.state.conflict ? 'conflict' : '',
				g.state.muted ? 'muted' : '',
			]
				.filter(Boolean)
				.join(' ')}
			data-selected={g.state.selected || undefined}
			data-drop-target={props.dropTarget || undefined}
		>
			<svg
				width={box}
				height={box}
				viewBox={`${-h} ${-h} ${box} ${box}`}
				aria-hidden="true"
				overflow="visible"
			>
				{props.dropTarget ? (
					<circle
						r={h + 1}
						fill="var(--pr-accent-fill)"
						stroke="var(--pr-accent)"
						strokeWidth={1.5}
						opacity={0.9}
					/>
				) : null}
				{g.state.selected || props.active ? (
					<rect
						x={-h + 0.5}
						y={-h + 0.5}
						width={box - 1}
						height={box - 1}
						rx={2}
						fill={g.state.selected ? 'var(--pr-bg-selected-row)' : 'none'}
						stroke={props.active ? 'var(--pr-focus-ring)' : 'var(--pr-text-strong)'}
						strokeWidth={1}
						strokeDasharray={props.active && !g.state.selected ? '2 1' : undefined}
					/>
				) : null}
				<path
					d={glyphPath(g.shape, g.size)}
					fill={openGlyph(g.shape) ? 'none' : paint.fill}
					stroke={paint.stroke}
					strokeWidth={paint.strokeWidth}
					strokeDasharray={paint.dash ?? undefined}
					strokeLinejoin="round"
					opacity={paint.opacity}
				/>
				{paint.agentTick ? (
					<line x1={0} x2={0} y1={-h} y2={-h + 2} stroke="var(--pr-agent)" strokeWidth={1.5} />
				) : null}
				{paint.strike ? (
					<line
						x1={-g.size / 2}
						y1={g.size / 2}
						x2={g.size / 2}
						y2={-g.size / 2}
						stroke="var(--pr-text-strong)"
						strokeWidth={1}
					/>
				) : null}
				{paint.underline ? (
					<rect x={-h + 1} y={h - 2} width={box - 2} height={2} fill="var(--pr-warning)" data-cue-conflict />
				) : null}
			</svg>
		</div>
	);
}

/** The header cell next to the seam (in the track header column): its name and cue count. */
export function CueSeamHeader(props: { seq: Sequence }) {
	const n = cuesOf(props.seq).length;
	return (
		<span
			className="pointer-events-none truncate px-2 text-[10px] leading-[18px] text-pr-muted"
			data-cue-seam-header
		>
			{t('Cues')}
			{n ? ` · ${n}` : ''}
		</span>
	);
}
