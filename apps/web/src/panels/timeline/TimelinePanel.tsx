// Timeline panel (S02, S05 §16.7): tabs, header (timecode readout + toolbar), ruler, split V/A regions
// with track headers, virtualized clips, overlays, playhead and zoom bar. All timeline state is scoped
// to this instance (TL-006); document edits go through the TimelineController (gestures) or UI commands.
import { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	LABEL_COLORS,
	type MediaAsset,
	type ProjectItem,
	type Sequence,
	sequenceDuration,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState, useStoreSelector } from '@jasper/session/react';
import { LABEL_DISPLAY_NAMES } from '@jasper/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createCommandContext } from '../../commands/context.ts';
import { runCommand } from '../../commands/registry.ts';
import { PROJECT_ITEMS_MIME } from '../../state/services.ts';
import type { PanelProps } from '../types.ts';
import { ContextMenu, GestureTooltip, SequenceTabs, Toolbar, ZoomBar } from './components/Chrome.tsx';
import { PlayheadLine, TimecodeReadout } from './components/Playhead.tsx';
import { RULER_H, Ruler } from './components/Ruler.tsx';
import { TrackArea } from './components/TrackArea.tsx';
import { TrackHeaders } from './components/TrackHeaders.tsx';
import {
	registerTimelineInstance,
	type TimelineHandle,
	touchTimelineInstance,
	useOptionalEngineClient,
	useTimelineEnv,
} from './env.tsx';
import { mediaCacheVersion } from './media/media-cache.ts';
import { itemDurationFrames } from './model/drop.ts';
import { computeLayout, hitY, regionIndexAt } from './model/layout.ts';
import { renderSegments } from './model/renderbar.ts';
import { boundaryFrameAt, extentEnd, followPage, followSmooth, type Viewport } from './model/viewport.ts';
import { type Geometry, type PointerInfo, TimelineController } from './state/controller.ts';
import { timelineGesturePreview } from './state/gesture-preview.ts';
import { HEADER_MAX, HEADER_MIN, setPrefs, timelinePrefs } from './state/prefs.ts';
import { type ContextMenuItem, createTimelineUiStore } from './state/ui-store.ts';

const EMPTY: readonly string[] = [];

function mods(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }, mac: boolean) {
	return { shift: e.shiftKey, ctrl: mac ? e.metaKey : e.ctrlKey, alt: e.altKey };
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

export function TimelinePanel(props: PanelProps) {
	const session = useSessionOrNull();
	if (!session)
		return (
			<div
				className="flex h-full items-center justify-center text-pr-small text-pr-muted"
				data-testid="timeline-empty"
			>
				Open a project to edit its sequences.
			</div>
		);
	return <TimelineForSession {...props} session={session} />;
}

function TimelineForSession(props: PanelProps & { session: EditorSession }) {
	const { session } = props;
	const paramSeq = typeof props.params?.sequenceId === 'string' ? props.params.sequenceId : null;
	const activeSeq = useSessionState((s) => s.activeSequenceId);
	const seqId = paramSeq ?? activeSeq;
	const hasSeq = useSessionState((s) => !!(seqId && s.document.sequences[seqId]));
	if (!seqId || !hasSeq)
		return (
			<div className="flex h-full flex-col" data-testid="timeline-empty">
				<SequenceTabs session={session} activeId={null} />
				<div className="flex flex-1 items-center justify-center text-pr-small text-pr-muted">
					No sequence open. Double-click a sequence in the Project panel.
				</div>
			</div>
		);
	return <TimelineBody {...props} seqId={seqId} />;
}

function TimelineBody(props: PanelProps & { session: EditorSession; seqId: string }) {
	const { session, seqId } = props;
	const env = useTimelineEnv();
	const engine = useOptionalEngineClient();
	const [ui] = useState(createTimelineUiStore);
	const prefs = useStoreSelector(timelinePrefs(), (s) => s);
	const mac = useMemo(isMac, []);

	// ------------------------------------------------------------ store selections (no transport!)
	const seq = useSessionState((s) => (s.transient ?? s.document).sequences[seqId] as Sequence);
	const committedSeq = useSessionState((s) => s.document.sequences[seqId] as Sequence);
	const committedDoc = useSessionState((s) => s.document);
	const view = useSessionState((s) => s.views[seqId]!);
	const selectedClips = useSessionState((s) => s.selection.timeline.clips);
	const gaps = useSessionState((s) => s.selection.timeline.gaps);
	const selectedMarkers = useSessionState((s) => s.selection.markers ?? EMPTY);
	const media = useSessionState((s) => (s.transient ?? s.document).media as Record<string, MediaAsset>);
	const runtime = useSessionState((s) => s.media);
	const mediaVersion = useStoreSelector(mediaCacheVersion, (s) => s.v);
	const overlays = useStoreSelector(
		ui,
		(s) => ({
			marquee: s.marquee,
			snapFrame: s.snapFrame,
			razor: s.razor,
			insertAt: s.insertAt,
			limit: s.limit,
			editPoints: s.editPoints,
			drop: s.drop,
			flash: s.flash,
		}),
		(a, b) =>
			a.marquee === b.marquee &&
			a.snapFrame === b.snapFrame &&
			a.razor === b.razor &&
			a.insertAt === b.insertAt &&
			a.limit === b.limit &&
			a.editPoints === b.editPoints &&
			a.drop === b.drop &&
			a.flash === b.flash,
	);
	const cursor = useStoreSelector(ui, (s) => s.cursor);
	const tooltip = useStoreSelector(ui, (s) => s.tooltip);
	const menu = useStoreSelector(ui, (s) => s.contextMenu);
	const size = useStoreSelector(
		ui,
		(s) => ({ w: s.width, h: s.trackAreaHeight }),
		(a, b) => a.w === b.w && a.h === b.h,
	);
	const readoutFrames = useStoreSelector(ui, (s) => s.readoutFrames);
	const snapping = useSessionState((s) => s.toggles.snapping);

	// ------------------------------------------------------------ geometry
	const viewport: Viewport = useMemo(
		() => ({ scrollFrame: view.scrollFrame, pxPerFrame: view.pxPerFrame, width: size.w }),
		[view.scrollFrame, view.pxPerFrame, size.w],
	);
	const layout = useMemo(
		() =>
			computeLayout({
				width: size.w,
				height: size.h,
				dividerRatio: view.dividerRatio,
				videoTracks: seq.videoTracks,
				audioTracks: seq.audioTracks,
				heights: view.trackHeights,
				scrollYVideo: view.scrollYVideo,
				scrollYAudio: view.scrollYAudio,
			}),
		[
			size,
			view.dividerRatio,
			seq.videoTracks,
			seq.audioTracks,
			view.trackHeights,
			view.scrollYVideo,
			view.scrollYAudio,
		],
	);
	const geomRef = useRef<Geometry>({ viewport, layout });
	geomRef.current = { viewport, layout };
	const viewportRef = useRef<Viewport>(viewport);
	viewportRef.current = viewport;

	const toast = useCallback(
		(kind: 'info' | 'warning' | 'error', message: string) => env.toast({ kind, message }),
		[env],
	);
	const controller = useMemo(
		() =>
			new TimelineController({
				session,
				sequenceId: () => seqId,
				ui,
				geometry: () => geomRef.current,
				toast,
				platform: { mac, wheelHorizontal: timelinePrefs().getState().wheelHorizontal },
			}),
		[session, seqId, ui, toast, mac],
	);

	// ------------------------------------------------------------ registration (services, commands)
	useEffect(() => {
		const handle: TimelineHandle = {
			instanceId: props.instanceId,
			controller,
			ui,
			sequenceId: () => seqId,
			cancelGesture: () => controller.cancel(),
		};
		const offs = [
			registerTimelineInstance(handle),
			env.services.register('timelinePanel', props.instanceId, handle),
			env.services.register('timelineViewport', props.instanceId, {
				scrollToFrame: (f: number) => controller.reveal(f),
				frameAtClientX: (x: number) => {
					const el = areaRef.current;
					const left = el ? el.getBoundingClientRect().left : 0;
					return boundaryFrameAt(geomRef.current.viewport, x - left);
				},
				getScrollContainer: () => areaRef.current,
			}),
			env.services.register('timelineGesturePreview', props.instanceId, {
				get: () => timelineGesturePreview.getState().preview,
				subscribe: (cb: () => void) => timelineGesturePreview.subscribe(cb),
			}),
		];
		return () => {
			for (const off of offs) off();
		};
	}, [controller, ui, seqId, env.services, props.instanceId]);

	// Agent flash (TL-954): 200 ms outline pulse on clips an agent changed.
	useEffect(
		() =>
			session.on('agent.flash', ({ clipIds }) => {
				ui.setState({ flash: clipIds });
				setTimeout(() => ui.setState({ flash: [] }), 400);
			}),
		[session, ui],
	);

	// ------------------------------------------------------------ measuring
	const areaRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = areaRef.current;
		if (!el) return;
		const measure = () => {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) ui.setState({ width: r.width, trackAreaHeight: r.height });
		};
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [ui]);

	// ------------------------------------------------------------ pointer input (coalesced per frame, TL-156)
	const pending = useRef<PointerInfo | null>(null);
	const raf = useRef<number | null>(null);
	const local = useCallback((e: { clientX: number; clientY: number }) => {
		const r = areaRef.current?.getBoundingClientRect();
		return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
	}, []);
	const flush = useCallback(() => {
		raf.current = null;
		const p = pending.current;
		pending.current = null;
		if (p) controller.pointerMove(p);
		if (controller.dragging) {
			controller.tick();
			raf.current = requestAnimationFrame(flush);
		}
	}, [controller]);
	useEffect(
		() => () => {
			if (raf.current !== null) cancelAnimationFrame(raf.current);
		},
		[],
	);

	// Escape / S during a pointer gesture: a gesture-local listener (the keymap owns other keys).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!controller.dragging) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				controller.cancel();
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	}, [controller]);

	// Wheel needs a non-passive listener to prevent page scroll.
	useEffect(() => {
		const el = areaRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const p = local(e);
			controller.wheel({
				deltaX: e.deltaX,
				deltaY: e.deltaY,
				deltaMode: e.deltaMode,
				ctrlKey: mac ? e.metaKey : e.ctrlKey,
				altKey: e.altKey,
				shiftKey: e.shiftKey,
				x: p.x,
				y: p.y,
				pinch: mac && e.ctrlKey,
			});
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, [controller, mac, local]);

	// ------------------------------------------------------------ follow playhead during playback (TL-119)
	const followRef = useRef(prefs.follow);
	followRef.current = prefs.follow;
	const lastFrame = useRef(session.transport.getState().frame);
	const onFrame = useCallback(
		(frame: number, playing: boolean) => {
			const prev = lastFrame.current;
			lastFrame.current = frame;
			if (!playing || controller.dragging) return;
			const v = geomRef.current.viewport;
			const mode = followRef.current;
			if (mode === 'none') return;
			const next = mode === 'page' ? followPage(v, frame, frame >= prev ? 1 : -1) : followSmooth(v, frame);
			if (next !== null) controller.setScroll(next);
		},
		[controller],
	);

	// ------------------------------------------------------------ derived
	const selectedSet = useMemo(() => new Set(selectedClips), [selectedClips]);
	const segments = useMemo(() => renderSegments(committedDoc, seqId), [committedDoc, seqId]);
	const extent = useMemo(() => {
		const lastMarker = committedSeq.markers.length
			? Math.max(...committedSeq.markers.map((m) => m.frame + m.duration))
			: null;
		return extentEnd(viewport, {
			end: sequenceDuration(committedSeq),
			playhead: 0,
			outPoint: committedSeq.outPoint,
			lastMarker,
		});
	}, [committedSeq, viewport]);
	const display = useMemo(
		() => ({
			thumbnails: prefs.thumbnails,
			videoNames: prefs.showVideoNames,
			audioNames: prefs.showAudioNames,
			waveforms: prefs.showWaveforms,
			rectified: prefs.rectifiedWaveforms,
			fxBadges: prefs.showFxBadges,
			engineBadges: prefs.showEngineBadges,
			labelColors: prefs.showLabelColors,
			clipMarkers: prefs.showClipMarkers,
		}),
		[prefs],
	);

	// ------------------------------------------------------------ commands from menus
	const run = useCallback(
		(id: string, args?: unknown) => {
			const ctx = createCommandContext({
				engine: engine ?? new EngineClient({ baseUrl: '' }),
				session,
				services: env.services,
				focus: { panel: 'timeline', instanceId: props.instanceId },
				toast: env.toast,
				openDialog: env.openDialog,
			});
			void runCommand(id, ctx, args);
		},
		[engine, session, env, props.instanceId],
	);
	const openMenu = useCallback(
		(x: number, y: number, items: ContextMenuItem[]) => ui.setState({ contextMenu: { x, y, items } }),
		[ui],
	);
	const apply = useCallback(
		(label: string, commands: unknown[]) => {
			const r = session.apply({ label, origin: 'user', sequenceId: seqId, commands: commands as never[] });
			if (!r.ok) toast('warning', r.errors[0]?.message ?? `${label} failed`);
			return r;
		},
		[session, seqId, toast],
	);

	const clipMenu = (c: Clip): ContextMenuItem[] => {
		const linked = !!c.linkId;
		return [
			{ kind: 'item', label: 'Clear', shortcut: 'Delete', run: () => run('timeline.clear') },
			{
				kind: 'item',
				label: 'Ripple Delete',
				shortcut: 'Shift+Delete',
				run: () => run('timeline.rippleDelete'),
			},
			{ kind: 'separator' },
			{ kind: 'item', label: 'Enable', checked: c.enabled, run: () => run('timeline.toggleEnable') },
			{ kind: 'item', label: linked ? 'Unlink' : 'Link', run: () => run('timeline.linkUnlink') },
			{ kind: 'item', label: 'Duplicate', run: () => run('timeline.duplicate') },
			{ kind: 'separator' },
			{
				kind: 'submenu',
				label: 'Label',
				items: LABEL_COLORS.map((l) => ({
					kind: 'item' as const,
					label: LABEL_DISPLAY_NAMES[l],
					checked: c.label === l,
					run: () =>
						apply('Label', [
							{
								type: 'clip.update',
								clipIds: session.getState().selection.timeline.clips,
								patch: { label: l },
							},
						]),
				})),
			},
			{
				kind: 'item',
				label: 'Rename…',
				run: () => {
					const name = typeof window !== 'undefined' ? window.prompt('Clip name', c.name) : null;
					if (name) apply('Rename', [{ type: 'clip.update', clipId: c.id, patch: { name } }]);
				},
			},
			{
				kind: 'item',
				label: 'Scale to Frame Size',
				run: () => apply('Scale to Frame Size', [{ type: 'clip.fitToFrame', clipIds: [c.id], mode: 'fit' }]),
			},
			{
				kind: 'item',
				label: 'Set to Frame Size (Fill)',
				run: () => apply('Set to Frame Size', [{ type: 'clip.fitToFrame', clipIds: [c.id], mode: 'fill' }]),
			},
		];
	};

	// ------------------------------------------------------------ track-area handlers
	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		touchTimelineInstance(props.instanceId);
		if (e.button === 2) return;
		const p = { ...local(e), ...mods(e, mac), button: e.button };
		if (controller.pointerDown(p)) {
			e.currentTarget.setPointerCapture?.(e.pointerId);
			if (raf.current === null && typeof requestAnimationFrame !== 'undefined')
				raf.current = requestAnimationFrame(flush);
		}
	};
	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const p = { ...local(e), ...mods(e, mac), button: e.button };
		if (!controller.dragging) {
			controller.hover(p);
			return;
		}
		pending.current = p;
		if (raf.current === null) {
			if (typeof requestAnimationFrame === 'undefined') controller.pointerMove(p);
			else raf.current = requestAnimationFrame(flush);
		}
	};
	const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		if (pending.current) {
			controller.pointerMove(pending.current);
			pending.current = null;
		}
		controller.pointerUp({ ...local(e), ...mods(e, mac), button: e.button });
	};
	const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		e.preventDefault();
		const p = local(e);
		const g = geomRef.current;
		const yh = hitY(g.layout, p.y);
		if (yh.kind !== 'track') return;
		const frame = Math.floor(g.viewport.scrollFrame + p.x / g.viewport.pxPerFrame);
		const c = Object.values(seq.clips).find(
			(x) => x.trackId === yh.row.trackId && x.start <= frame && frame < x.start + x.duration,
		);
		if (c) {
			// TL-931: right-clicking an unselected clip selects it first.
			if (!selectedSet.has(c.id)) session.select('timeline', [c.id], 'replace', { primary: c.id });
			openMenu(e.clientX, e.clientY, clipMenu(c));
			return;
		}
		const gap = committedSeq && gapAtFrame(committedSeq, yh.row.trackId, frame);
		if (gap)
			openMenu(e.clientX, e.clientY, [
				{
					kind: 'item',
					label: 'Ripple Delete',
					run: () => apply('Close Gap', [{ type: 'gap.close', trackId: gap.trackId, at: gap.start }]),
				},
			]);
	};

	// ------------------------------------------------------------ drops (TL-492…496)
	const dropTarget = (e: React.DragEvent) => {
		const p = local(e);
		const g = geomRef.current;
		const frame = Math.max(0, boundaryFrameAt(g.viewport, p.x));
		const yh = hitY(g.layout, p.y);
		let region: 'video' | 'audio' = p.y < g.layout.dividerTop ? 'video' : 'audio';
		if (yh.kind === 'track') region = yh.row.kind;
		const index = regionIndexAt(g.layout, region, p.y);
		const label = `${region === 'video' ? 'V' : 'A'}${index + 1}`;
		return { frame, region, index, label, insert: mac ? e.metaKey : e.ctrlKey };
	};
	const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
		const types = Array.from(e.dataTransfer?.types ?? []);
		if (!types.includes(PROJECT_ITEMS_MIME) && !types.includes('Files')) return;
		e.preventDefault();
		const t = dropTarget(e);
		const d = ui.getState().drop;
		if (!d || d.frame !== t.frame || d.trackLabel !== t.label || d.insert !== t.insert)
			ui.setState({ drop: { frame: t.frame, trackLabel: t.label, insert: t.insert } });
	};
	const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		const t = dropTarget(e);
		ui.setState({ drop: null });
		const raw = e.dataTransfer.getData(PROJECT_ITEMS_MIME);
		if (raw) {
			let itemIds: string[] = [];
			try {
				const parsed = JSON.parse(raw) as { itemIds?: string[] } | string[];
				itemIds = Array.isArray(parsed) ? parsed : (parsed.itemIds ?? []);
			} catch {
				itemIds = [];
			}
			placeItems(itemIds, t);
			return;
		}
		const files = Array.from(e.dataTransfer.files ?? []);
		if (files.length === 0) return;
		const svc = env.services.get('importService');
		if (!svc) {
			toast('warning', 'Importing files is not available yet (import service not mounted).');
			return;
		}
		const trackId =
			(t.region === 'video' ? committedSeq.videoTracks : committedSeq.audioTracks)[t.index]?.id ?? t.label;
		void svc
			.importFiles(
				{ files },
				{
					kind: 'timeline',
					sequenceId: seqId,
					at: t.frame,
					trackId,
					mode: t.insert ? 'insert' : 'overwrite',
				},
			)
			.catch((err: unknown) => toast('error', err instanceof Error ? err.message : String(err)));
	};
	const placeItems = (itemIds: string[], t: ReturnType<typeof dropTarget>) => {
		const doc = session.getCommitted();
		const commands: unknown[] = [];
		let at = t.frame;
		for (const id of itemIds) {
			const item = doc.items[id] as ProjectItem | undefined;
			if (!item) continue;
			const dur = itemDurationFrames(doc, item, committedSeq.settings.frameRate);
			if (dur === null) continue;
			const asset = item.kind === 'media' ? (doc.media[item.mediaId] as MediaAsset | undefined) : undefined;
			const hasVideo = asset ? asset.probe.streams.some((s) => s.type === 'video') : true;
			const hasAudio = asset ? asset.probe.streams.some((s) => s.type === 'audio') : false;
			// TL-493/494: pointer track for its kind; the other kind mirrors the index; retarget to V1/A1.
			const tracks: Record<string, unknown> = {};
			if (t.region === 'video') {
				tracks.video = hasVideo ? t.label : 'V1';
				if (hasAudio) tracks.audio = hasVideo ? `A${t.index + 1}` : 'A1';
			} else {
				tracks.audio = hasAudio ? t.label : 'A1';
				if (hasVideo) tracks.video = hasAudio ? `V${t.index + 1}` : 'V1';
			}
			commands.push({
				type: 'clip.place',
				source: { projectItemId: id },
				at,
				tracks,
				mode: t.insert ? 'insert' : 'overwrite',
				createTracks: true,
			});
			at += dur;
		}
		if (commands.length === 0) return;
		apply(commands.length === 1 ? 'Place Clip' : `Place ${commands.length} Clips`, commands);
	};

	// ------------------------------------------------------------ render
	const rate = seq.settings.frameRate;
	const headerWidth = Math.min(HEADER_MAX, Math.max(HEADER_MIN, prefs.headerWidth));
	const rulerMenu = (m: import('@jasper/project').Marker | null): ContextMenuItem[] =>
		m
			? [
					{ kind: 'item', label: 'Edit…', run: () => editMarker(m) },
					{
						kind: 'submenu',
						label: 'Color',
						items: LABEL_COLORS.map((l) => ({
							kind: 'item' as const,
							label: LABEL_DISPLAY_NAMES[l],
							checked: m.color === l,
							run: () => apply('Edit Marker', [{ type: 'marker.update', markerId: m.id, color: l }]),
						})),
					},
					{
						kind: 'item',
						label: 'Delete',
						run: () => apply('Clear Marker', [{ type: 'marker.remove', markerIds: [m.id] }]),
					},
					{
						kind: 'item',
						label: 'Ripple Sequence Markers',
						checked: session.getState().toggles.rippleMarkers,
						run: () => session.setToggles({ rippleMarkers: !session.getState().toggles.rippleMarkers }),
					},
				]
			: [
					{ kind: 'item', label: 'Add Marker', shortcut: 'M', run: () => run('timeline.addMarker') },
					{ kind: 'item', label: 'Clear In and Out', run: () => run('timeline.clearInOut') },
					{
						kind: 'item',
						label: 'Show Frames',
						checked: ui.getState().readoutFrames,
						run: () => ui.setState({ readoutFrames: !ui.getState().readoutFrames }),
					},
					{
						kind: 'item',
						label: 'Render In to Out',
						shortcut: 'Enter',
						run: () => run('timeline.renderInToOut'),
					},
				];
	const editMarker = (m: import('@jasper/project').Marker) => {
		if (env.openDialog) {
			env.openDialog('marker', { sequenceId: seqId, markerId: m.id });
			return;
		}
		const name = typeof window !== 'undefined' ? window.prompt('Marker name', m.name) : null;
		if (name !== null) apply('Edit Marker', [{ type: 'marker.update', markerId: m.id, name }]);
	};

	return (
		<div
			className="relative flex h-full min-h-0 flex-col bg-pr-panel text-pr-text select-none"
			data-testid="timeline-panel"
			data-sequence-id={seqId}
			onPointerDownCapture={() => touchTimelineInstance(props.instanceId)}
		>
			<SequenceTabs session={session} activeId={seqId} />
			<div className="flex shrink-0" style={{ height: RULER_H }}>
				<div
					className="flex shrink-0 flex-col justify-between border-r border-pr-border px-2 pt-[2px]"
					style={{ width: headerWidth }}
				>
					<TimecodeReadout
						transport={session.transport}
						rate={rate}
						dropFrame={seq.settings.dropFrame}
						startFrames={seq.settings.startTimecodeFrames}
						frames={readoutFrames}
						onToggleFrames={() => ui.setState({ readoutFrames: !readoutFrames })}
						onSeek={(f) => {
							session.transport.seek(f);
							controller.reveal(f);
						}}
					/>
					<Toolbar
						session={session}
						prefs={prefs}
						openMenu={openMenu}
						onAddMarker={() => run('timeline.addMarker')}
					/>
				</div>
				<div className="relative min-w-0 flex-1">
					<Ruler
						seq={seq}
						viewport={viewport}
						session={session}
						controller={controller}
						segments={segments}
						selectedMarkers={selectedMarkers}
						snapPlayhead={prefs.snapPlayhead && snapping}
						onContextMenu={(e, m) => openMenu(e.clientX, e.clientY, rulerMenu(m))}
						onEditMarker={editMarker}
					/>
				</div>
			</div>
			<div className="flex min-h-0 flex-1">
				<div className="relative shrink-0 border-r border-pr-border" style={{ width: headerWidth }}>
					<TrackHeaders
						seq={seq}
						layout={layout}
						view={view}
						session={session}
						controller={controller}
						ui={ui}
						openMenu={openMenu}
						toast={toast}
					/>
					<div
						className="absolute top-0 right-[-3px] bottom-0 w-[6px] cursor-col-resize"
						onPointerDown={(e) => {
							const el = e.currentTarget;
							el.setPointerCapture?.(e.pointerId);
							const x0 = e.clientX;
							const w0 = headerWidth;
							const move = (ev: PointerEvent) =>
								setPrefs({ headerWidth: Math.min(HEADER_MAX, Math.max(HEADER_MIN, w0 + ev.clientX - x0)) });
							const up = () => {
								el.removeEventListener('pointermove', move);
								el.removeEventListener('pointerup', up);
							};
							el.addEventListener('pointermove', move);
							el.addEventListener('pointerup', up);
						}}
						data-header-resize
					/>
				</div>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: pointer editing surface; keyboard access goes through keymap commands */}
				<div
					ref={areaRef}
					className="relative min-w-0 flex-1 overflow-hidden"
					style={{ cursor, touchAction: 'none' }}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={() => controller.cancel()}
					onPointerLeave={() => controller.leave()}
					onContextMenu={onContextMenu}
					onDragOver={onDragOver}
					onDragLeave={() => ui.setState({ drop: null })}
					onDrop={onDrop}
					data-testid="timeline-clip-area"
				>
					<TrackArea
						seq={seq}
						layout={layout}
						viewport={viewport}
						selected={selectedSet}
						gaps={gaps}
						targeting={view.targeting}
						media={media}
						runtime={runtime}
						engine={engine}
						display={display}
						mediaVersion={mediaVersion}
						overlays={overlays}
					/>
					<GestureTooltip tooltip={tooltip} width={size.w} />
				</div>
			</div>
			<div className="flex shrink-0">
				<div className="shrink-0" style={{ width: headerWidth }} />
				<div className="min-w-0 flex-1">
					<ZoomBar viewport={viewport} extent={extent} controller={controller} />
				</div>
			</div>
			<PlayheadOverlay
				headerWidth={headerWidth}
				transport={session.transport}
				viewportRef={viewportRef}
				onFrame={onFrame}
				tabsOffset={session.getState().tabs.open.length > 0}
				controller={controller}
			/>
			{menu ? (
				<ContextMenu
					x={menu.x}
					y={menu.y}
					items={menu.items}
					onClose={() => ui.setState({ contextMenu: null })}
				/>
			) : null}
		</div>
	);
}

/** Positions the playhead over the ruler + track area column. */
function PlayheadOverlay(props: {
	headerWidth: number;
	transport: EditorSession['transport'];
	viewportRef: React.RefObject<Viewport>;
	onFrame(frame: number, playing: boolean): void;
	tabsOffset: boolean;
	controller: TimelineController;
}) {
	const scrub = useRef(false);
	return (
		<div
			className="pointer-events-none absolute right-0 overflow-hidden"
			style={{ left: props.headerWidth, top: props.tabsOffset ? 'var(--pr-tab-h)' : 0, bottom: 14 }}
		>
			<PlayheadLine
				transport={props.transport}
				viewportRef={props.viewportRef}
				rulerHeight={RULER_H}
				onFrame={props.onFrame}
				onHeadPointerDown={(e) => {
					e.stopPropagation();
					const el = e.currentTarget as HTMLElement;
					el.setPointerCapture?.(e.pointerId);
					scrub.current = true;
					const left = el.parentElement!.parentElement!.getBoundingClientRect().left;
					const move = (ev: PointerEvent) => {
						if (scrub.current) props.controller.scrubTo(ev.clientX - left, ev.shiftKey);
					};
					const up = () => {
						scrub.current = false;
						el.removeEventListener('pointermove', move);
						el.removeEventListener('pointerup', up);
					};
					el.addEventListener('pointermove', move);
					el.addEventListener('pointerup', up);
				}}
			/>
		</div>
	);
}

function gapAtFrame(
	seq: Sequence,
	trackId: string,
	frame: number,
): { trackId: string; start: number; end: number } | null {
	const clips = Object.values(seq.clips)
		.filter((c) => c.trackId === trackId)
		.sort((a, b) => a.start - b.start);
	let cursor = 0;
	for (const c of clips) {
		if (c.start > cursor && frame >= cursor && frame < c.start)
			return { trackId, start: cursor, end: c.start };
		cursor = Math.max(cursor, c.start + c.duration);
	}
	return null;
}
