// Timeline chrome: sequence tabs (S05:TLC-001), header toolbar (TLC-002/003), zoom scroll bar
// (TL-112, TLC-030), context menu and gesture tooltip. Menus are local until WP-2A's primitives land.
import type { EditorSession } from '@jasper/session';
import { useSessionState } from '@jasper/session/react';
import { IconButton, labelColor, Z } from '@jasper/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { frameToX, type Viewport } from '../model/viewport.ts';
import type { TimelineController } from '../state/controller.ts';
import { setPrefs, type TimelinePrefs } from '../state/prefs.ts';
import type { ContextMenuItem, Tooltip } from '../state/ui-store.ts';

// ---------------------------------------------------------------- sequence tabs

export function SequenceTabs(props: { session: EditorSession; activeId: string | null }) {
	const tabs = useSessionState((s) => s.tabs.open);
	const names = useSessionState(
		(s) =>
			tabs.map((id) => {
				const item = Object.values(s.document.items).find(
					(i) => (i as { sequenceId?: string }).sequenceId === id,
				);
				return { id, name: item?.name ?? 'Sequence', label: item?.label ?? 'forest' };
			}),
		(a, b) => JSON.stringify(a) === JSON.stringify(b),
	);
	if (names.length === 0) return null;
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
						style={{ background: labelColor(t.label as never) }}
					/>
					<button type="button" onClick={() => props.session.openSequence(t.id)}>
						{t.name}
					</button>
				</div>
			))}
		</div>
	);
}

// ---------------------------------------------------------------- header toolbar

export function Toolbar(props: {
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
}

// ---------------------------------------------------------------- zoom scroll bar

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
				props.controller.zoomBy(Math.exp(-e.deltaY * 0.0025), frameToX(v, e.nativeEvent.offsetX / scale || 0))
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
			>
				<div
					className="absolute top-[-1px] left-[-1px] size-[10px] cursor-ew-resize rounded-full border border-pr-border-strong bg-pr-panel"
					onPointerDown={(e) => onDown(e, 'left')}
				/>
				<div
					className="absolute top-[-1px] right-[-1px] size-[10px] cursor-ew-resize rounded-full border border-pr-border-strong bg-pr-panel"
					onPointerDown={(e) => onDown(e, 'right')}
				/>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------- context menu

export function ContextMenu(props: { x: number; y: number; items: ContextMenuItem[]; onClose(): void }) {
	const ref = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ x: props.x, y: props.y });
	// Keep the menu inside the window (flip up/left when it would overflow).
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || typeof window === 'undefined') return;
		const r = el.getBoundingClientRect();
		const x =
			r.width && props.x + r.width > window.innerWidth
				? Math.max(0, window.innerWidth - r.width - 4)
				: props.x;
		const y = r.height && props.y + r.height > window.innerHeight ? Math.max(0, props.y - r.height) : props.y;
		setPos({ x, y });
	}, [props.x, props.y]);
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
	return (
		<div
			ref={ref}
			role="menu"
			className="fixed min-w-[200px] rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 text-pr-ui text-pr-text shadow-pr-overlay"
			style={{ left: pos.x, top: pos.y, zIndex: Z.popover }}
			data-testid="timeline-context-menu"
		>
			<MenuItems items={props.items} onClose={props.onClose} />
		</div>
	);
}

function MenuItems(props: { items: ContextMenuItem[]; onClose(): void }) {
	return (
		<>
			{props.items.map((it, i) => {
				if (it.kind === 'separator')
					// biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
					return <div key={`sep-${i}`} className="my-1 h-px bg-pr-border" />;
				if (it.kind === 'submenu')
					return (
						<div key={it.label} className="group relative">
							<div className="flex h-[22px] items-center px-3 hover:bg-pr-hover">
								<span className="flex-1">{it.label}</span>
								<span className="text-pr-muted">▸</span>
							</div>
							<div className="absolute top-0 left-full hidden min-w-[180px] rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 shadow-pr-overlay group-hover:block">
								<MenuItems items={it.items} onClose={props.onClose} />
							</div>
						</div>
					);
				return (
					<button
						key={it.label}
						type="button"
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

// ---------------------------------------------------------------- tooltip

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
