// Timeline chrome: sequence tabs (S05:TLC-001), header toolbar (TLC-002/003), zoom scroll bar
// (TL-112, TLC-030), context menu and gesture tooltip.
import type { ProjectItem } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { cx, IconButton, labelColor, PointMenu, placeBeside, useMenuFit, Z } from '@jasper/ui';
import { memo, useEffect, useRef, useState } from 'react';
import { trackHeightDisplayMenu } from '../../../gaps/track-height-menu.ts';
import { frameToX, type Viewport, wheelZoomFactor } from '../model/viewport.ts';
import type { TimelineController } from '../state/controller.ts';
import { setPrefs, type TimelinePrefs } from '../state/prefs.ts';
import type { ContextMenuItem, Tooltip } from '../state/ui-store.ts';

/** Sequence id → the first item naming it, per `items` record (ui-perf: the tab selector runs on every update). */
const bySequence = new WeakMap<object, Map<string, ProjectItem>>();
function itemsBySequence(items: Record<string, ProjectItem>): Map<string, ProjectItem> {
	let m = bySequence.get(items);
	if (!m) {
		m = new Map();
		for (const it of Object.values(items)) {
			const id = (it as { sequenceId?: string }).sequenceId;
			if (id !== undefined && !m.has(id)) m.set(id, it);
		}
		bySequence.set(items, m);
	}
	return m;
}

export function SequenceTabs(props: {
	session: EditorSession;
	activeId: string | null;
	/**
	 * Hide the strip while only one sequence is open: the dock tab already names it (Premiere shows a
	 * single "Sequence 01" tab), so a second row would duplicate it and cost 28 px of track space.
	 */
	hideSingle?: boolean;
}) {
	const tabs = useSessionState((s) => s.tabs.open);
	const names = useSessionState(
		(s) =>
			tabs.map((id) => {
				const item = itemsBySequence(s.document.items).get(id);
				return { id, name: item?.name ?? 'Sequence', label: item?.label ?? 'forest' };
			}),
		(a, b) => JSON.stringify(a) === JSON.stringify(b),
	);
	if (names.length === 0 || (props.hideSingle && names.length === 1)) return null;
	return (
		<div
			className="flex h-[var(--pr-tab-h)] shrink-0 items-end gap-px bg-pr-panel-alt px-1"
			data-testid="timeline-tabs"
		>
			{names.map((t) => (
				<div
					key={t.id}
					className={`flex h-[24px] items-center gap-1 rounded-t-[3px] px-2 text-pr-small ${t.id === props.activeId ? 'bg-pr-panel text-pr-text' : 'text-pr-muted hover:bg-pr-hover'}`}
					data-sequence-tab={t.id}
				>
					<button
						type="button"
						className="text-pr-dim hover:text-pr-text"
						aria-label={`Close ${t.name}`}
						onClick={() => props.session.closeSequenceTab(t.id)}
					>
						×
					</button>
					<span
						className="inline-block size-[8px] rounded-[2px]"
						style={{ background: labelColor(t.label) }}
					/>
					<button type="button" onClick={() => props.session.openSequence(t.id)}>
						{t.name}
					</button>
				</div>
			))}
		</div>
	);
}

/** memoised (its tooltip buttons do not re-render on every gesture frame of the timeline). */
export const Toolbar = memo(function Toolbar(props: {
	session: EditorSession;
	prefs: TimelinePrefs;
	openMenu(x: number, y: number, items: ContextMenuItem[]): void;
	onAddMarker(): void;
	/** Extra entries appended to the display settings menu (dev helpers). */
	extraMenu?: ContextMenuItem[];
}) {
	const snapping = useSessionState((s) => s.toggles.snapping);
	const linked = useSessionState((s) => s.toggles.linkedSelection);
	const p = props.prefs;
	const check = (label: string, key: keyof TimelinePrefs, value: boolean): ContextMenuItem => ({
		kind: 'item',
		label,
		checked: value,
		run: () => setPrefs({ [key]: !value } as Partial<TimelinePrefs>),
	});
	const displayMenu = (): ContextMenuItem[] => [
		{
			kind: 'submenu',
			label: 'Show Video Thumbnails',
			items: (['off', 'head', 'head-tail', 'continuous'] as const).map((s) => ({
				kind: 'item' as const,
				label: { off: 'Off', head: 'Head', 'head-tail': 'Head and Tail', continuous: 'Continuous' }[s],
				checked: p.thumbnails === s,
				run: () => setPrefs({ thumbnails: s }),
			})),
		},
		check('Show Video Names', 'showVideoNames', p.showVideoNames),
		check('Show Audio Waveform', 'showWaveforms', p.showWaveforms),
		check('Rectified Audio Waveforms', 'rectifiedWaveforms', p.rectifiedWaveforms),
		check('Show Audio Names', 'showAudioNames', p.showAudioNames),
		check('Show Clip Markers', 'showClipMarkers', p.showClipMarkers),
		check('Show fx Badges', 'showFxBadges', p.showFxBadges),
		check('Show Engine Badges', 'showEngineBadges', p.showEngineBadges),
		check('Show Label Colors', 'showLabelColors', p.showLabelColors),
		{ kind: 'separator' },
		{
			kind: 'submenu',
			label: 'Playback Auto-Scroll',
			items: (['page', 'smooth', 'none'] as const).map((f) => ({
				kind: 'item' as const,
				label: { page: 'Page Scroll', smooth: 'Smooth Scroll', none: 'No Scroll' }[f],
				checked: p.follow === f,
				run: () => setPrefs({ follow: f }),
			})),
		},
		check('Snap Playhead When Snap Is On', 'snapPlayhead', p.snapPlayhead),
		// gaps: Premiere's Show Audio Time Units (Project Settings ▸ Audio Display Format).
		check('Show Audio Time Units', 'showAudioTimeUnits', !!p.showAudioTimeUnits),
		// gaps (TL-10): Expand / Minimize All Tracks and the track height presets.
		{ kind: 'separator' },
		...trackHeightDisplayMenu(props.session),
		...(props.extraMenu?.length ? [{ kind: 'separator' as const }, ...props.extraMenu] : []),
	];
	return (
		<div className="flex items-center gap-[2px]" data-testid="timeline-toolbar">
			<IconButton
				icon="timeline.snap"
				label="Snap in Timeline"
				shortcut="S"
				toggled={snapping ? 'on' : 'off'}
				onClick={() => props.session.setToggles({ snapping: !snapping })}
				data-control="snap"
			/>
			<IconButton
				icon={linked ? 'timeline.link' : 'timeline.unlink'}
				label="Linked Selection"
				toggled={linked ? 'on' : 'off'}
				onClick={() => props.session.setToggles({ linkedSelection: !linked })}
				data-control="linked-selection"
			/>
			<IconButton icon="panel.markers" label="Add Marker" shortcut="M" onClick={props.onAddMarker} />
			<IconButton
				icon="panel.properties"
				label="Timeline Display Settings"
				onClick={(e) => {
					const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
					props.openMenu(r.left, r.bottom, displayMenu());
				}}
			/>
		</div>
	);
});

export function ZoomBar(props: { viewport: Viewport; extent: number; controller: TimelineController }) {
	const { viewport: v, extent } = props;
	const total = Math.max(extent, v.scrollFrame + v.width / v.pxPerFrame, 1);
	const scale = v.width / total;
	const x0 = Math.max(0, v.scrollFrame * scale);
	const x1 = Math.min(v.width, (v.scrollFrame + v.width / v.pxPerFrame) * scale);
	const drag = useRef<{ kind: 'pan' | 'left' | 'right'; x: number; v: Viewport } | null>(null);
	const onDown = (e: React.PointerEvent, kind: 'pan' | 'left' | 'right') => {
		e.stopPropagation();
		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
		drag.current = { kind, x: e.clientX, v };
	};
	const onMove = (e: React.PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const dFrames = (e.clientX - d.x) / scale;
		if (d.kind === 'pan') {
			props.controller.setScroll(d.v.scrollFrame + dFrames);
			return;
		}
		// End handles change zoom keeping the opposite end fixed (TL-112).
		const start = d.v.scrollFrame;
		const end = d.v.scrollFrame + d.v.width / d.v.pxPerFrame;
		const nStart = d.kind === 'left' ? Math.min(end - 1, start + dFrames) : start;
		const nEnd = d.kind === 'right' ? Math.max(start + 1, end + dFrames) : end;
		const p = d.v.width / (nEnd - nStart);
		props.controller.setView({ pxPerFrame: Math.min(48, Math.max(1e-4, p)), scrollFrame: nStart });
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer editing surface; keyboard access goes through keymap commands
		<div
			className="relative h-[14px] w-full bg-pr-panel"
			onWheel={(e) =>
				props.controller.zoomBy(wheelZoomFactor(e.deltaY), frameToX(v, e.nativeEvent.offsetX / scale || 0))
			}
			onDoubleClick={() => props.controller.toggleZoomToSequence()}
			onPointerMove={onMove}
			onPointerUp={() => {
				drag.current = null;
			}}
			data-testid="timeline-zoombar"
		>
			<div
				className="absolute top-[3px] h-[8px] rounded-pr-pill bg-pr-hover"
				style={{ left: x0, width: Math.max(12, x1 - x0) }}
				onPointerDown={(e) => onDown(e, 'pan')}
				data-testid="timeline-zoombar-thumb"
			>
				<div
					className="absolute top-[-1px] left-[-1px] size-[10px] cursor-ew-resize rounded-full border border-pr-border-strong bg-pr-panel"
					onPointerDown={(e) => onDown(e, 'left')}
					data-testid="timeline-zoombar-start"
				/>
				<div
					className="absolute top-[-1px] right-[-1px] size-[10px] cursor-ew-resize rounded-full border border-pr-border-strong bg-pr-panel"
					onPointerDown={(e) => onDown(e, 'right')}
					data-testid="timeline-zoombar-end"
				/>
			</div>
		</div>
	);
}

export function ContextMenu(props: {
	x: number;
	y: number;
	items: ContextMenuItem[];
	onClose(): void;
	testId?: string;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const down = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				props.onClose();
			}
		};
		window.addEventListener('pointerdown', down, true);
		window.addEventListener('keydown', key, true);
		return () => {
			window.removeEventListener('pointerdown', down, true);
			window.removeEventListener('keydown', key, true);
		};
	}, [props.onClose]);
	// PointMenu: in a portal (`fixed` inside the docked panel was relative to the panel, workstream `time`), and kept
	// inside the window: flipped left / up, or pinned to the edge and scrolling when taller than the window (wp fixups).
	return (
		<PointMenu
			x={props.x}
			y={props.y}
			menuRef={ref}
			className="min-w-[200px] rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 text-pr-ui text-pr-text shadow-pr-overlay"
			data-testid={props.testId ?? 'timeline-context-menu'}
		>
			<MenuItems items={props.items} onClose={props.onClose} />
		</PointMenu>
	);
}

function MenuItems(props: { items: ContextMenuItem[]; onClose(): void }) {
	// One open submenu per level, opened on hover (CSS group-hover would open every nested level at once).
	const [openSub, setOpenSub] = useState<string | null>(null);
	return (
		<>
			{props.items.map((it, i) => {
				if (it.kind === 'separator')
					// biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
					return <div key={`sep-${i}`} className="my-1 h-px bg-pr-border" />;
				if (it.kind === 'submenu')
					return (
						<SubmenuRow
							key={it.label}
							item={it}
							open={openSub === it.label}
							onOpen={() => setOpenSub(it.label)}
							onClose={props.onClose}
						/>
					);
				return (
					<button
						key={it.label}
						type="button"
						onMouseEnter={() => setOpenSub(null)}
						role="menuitem"
						disabled={it.disabled}
						className="flex h-[22px] w-full items-center gap-2 px-3 text-left hover:bg-pr-hover disabled:text-pr-dim"
						onClick={() => {
							props.onClose();
							it.run();
						}}
					>
						<span className="w-3 text-pr-accent">{it.checked ? '✓' : ''}</span>
						<span className="flex-1">{it.label}</span>
						{it.shortcut ? <span className="text-pr-muted">{it.shortcut}</span> : null}
					</button>
				);
			})}
		</>
	);
}

function SubmenuRow(props: {
	item: Extract<ContextMenuItem, { kind: 'submenu' }>;
	open: boolean;
	onOpen(): void;
	onClose(): void;
}) {
	const rowRef = useRef<HTMLDivElement>(null);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover opens the submenu (pointer menus)
		<div ref={rowRef} className="relative" onMouseEnter={props.onOpen}>
			<div className={cx('flex h-[22px] items-center px-3 hover:bg-pr-hover', props.open && 'bg-pr-hover')}>
				<span className="flex-1">{props.item.label}</span>
				<span className="text-pr-muted">▸</span>
			</div>
			{props.open ? <Submenu row={rowRef} items={props.item.items} onClose={props.onClose} /> : null}
		</div>
	);
}

/** A submenu panel: `fixed` beside its row, flipped left / slid up / scrolling to stay inside the window. */
function Submenu(props: {
	row: React.RefObject<HTMLDivElement | null>;
	items: ContextMenuItem[];
	onClose(): void;
}) {
	const { ref, fit } = useMenuFit<HTMLDivElement>((size, viewport) => {
		const r = props.row.current?.getBoundingClientRect();
		return placeBeside(r ?? { left: 0, top: 0, right: 0, bottom: 0 }, size, viewport);
	});
	const r0 = props.row.current?.getBoundingClientRect();
	return (
		<div
			ref={ref}
			role="menu"
			className="fixed min-w-[180px] overflow-y-auto rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 shadow-pr-overlay"
			style={{
				left: fit?.left ?? r0?.right ?? 0,
				top: fit?.top ?? r0?.top ?? 0,
				maxHeight: fit?.maxHeight,
				zIndex: Z.popover,
			}}
		>
			<MenuItems items={props.items} onClose={props.onClose} />
		</div>
	);
}

export function GestureTooltip(props: { tooltip: Tooltip | null; width: number }) {
	const t = props.tooltip;
	if (!t) return null;
	return (
		<div
			className="pointer-events-none absolute rounded-[3px] bg-pr-tooltip px-2 py-1 text-pr-small whitespace-nowrap text-pr-text shadow-pr-floating tabular-nums"
			style={{
				left: Math.min(Math.max(0, t.x + 12), props.width - 140),
				top: Math.max(0, t.y - 34),
				zIndex: 30,
			}}
			data-testid="timeline-tooltip"
		>
			{t.lines.map((l) => (
				<div key={l}>{l}</div>
			))}
		</div>
	);
}
