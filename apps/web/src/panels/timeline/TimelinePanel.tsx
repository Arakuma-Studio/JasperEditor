// Timeline panel (S02, S05 §16.7): tabs, header (timecode readout + toolbar), ruler, split V/A regions
// with track headers, virtualized clips, overlays, playhead and zoom bar. All timeline state is scoped
// to this instance (TL-006); document edits go through the TimelineController (gestures) or UI commands.

import { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	defaultTransitionFrames,
	formatTimecode,
	gapAt,
	isMulticamClip,
	LABEL_COLORS,
	type MediaAsset,
	type ProjectItem,
	parseTimecodeEntry,
	type Rational,
	type Sequence,
	sequenceDuration,
	TRANSITION_SPECS,
	type Transition,
	trackLabel,
	transitionSpec,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState, useStoreSelector } from '@jasper/session/react';
import { LABEL_DISPLAY_NAMES } from '@jasper/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { registerUiLocator } from '../../agent-bridge/ui-automation.ts';
import { remixClip } from '../../audio-fx/ops.ts';
import { dropLutItems } from '../../color/actions.ts';
import { createCommandContext } from '../../commands/context.ts';
import { cameraMenuEntries } from '../../commands/multicam.ts';
import { runCommand } from '../../commands/registry.ts';
import { revealNested } from '../../commands/structure.ts';
import { clipMenuExtensions, collectMenuItems } from '../../extensions/index.ts';
import { useEngineOrNull } from '../../state/engine.tsx';
import { getImportService, PROJECT_ITEMS_MIME } from '../../state/services.ts';
import {
	applyMessage,
	applyTextAnimation,
	dropSide,
	isTextAnimationDrag,
	readTextAnimationDrag,
} from '../../text-animation/actions.ts';
import {
	applyEffectToClips,
	endTransitionDrag,
	isEffectDrag,
	isTransitionDrag,
	readEffectDragPayload,
	readTransitionDragPayload,
	transitionDragId,
} from '../effects/drag.ts';
import { setDefaultTransition, TRANSITION_ALIGNMENTS } from '../effects/transition-prefs.ts';
import { insertMotionTemplate, MG_TEMPLATE_MIME, readMgTemplateDrag } from '../motionTemplates/insert.ts';
import { projectItemOf } from '../program/layer-ops.ts';
import type { PanelProps } from '../types.ts';
import { CaptionLanes } from './components/CaptionLanes.tsx';
import { ContextMenu, GestureTooltip, SequenceTabs, Toolbar, ZoomBar } from './components/Chrome.tsx';
import { PlayheadLine, TimecodeReadout } from './components/Playhead.tsx';
import { RULER_H, Ruler } from './components/Ruler.tsx';
import { TrackArea } from './components/TrackArea.tsx';
import { TrackHeaders } from './components/TrackHeaders.tsx';
import { exposeForDev, insertSampleClips } from './dev.ts';
import {
	registerTimelineInstance,
	type TimelineHandle,
	touchTimelineInstance,
	useTimelineEnv,
} from './env.tsx';
import { mediaCacheVersion } from './media/media-cache.ts';
import { itemAvKinds, itemDurationFrames } from './model/drop.ts';
import { hitTest } from './model/hit.ts';
import { computeLayout, hitY, regionIndexAt } from './model/layout.ts';
import { renderSegments } from './model/renderbar.ts';
import {
	type DropTarget,
	dropCommand,
	hitTransition,
	resolveTransitionDrop,
	type TransitionGeom,
	transitionIndex,
} from './model/transitions.ts';
import { boundaryFrameAt, extentEnd, followPage, followSmooth, type Viewport } from './model/viewport.ts';
import { type Geometry, type PointerInfo, TimelineController } from './state/controller.ts';
import { timelineGesturePreview } from './state/gesture-preview.ts';
import { HEADER_MAX, HEADER_MIN, setPrefs, timelinePrefs } from './state/prefs.ts';
import { enterTrimMode, refreshEditPoints } from './state/trim-mode.ts';
import { type ContextMenuItem, createTimelineUiStore, type TransitionGhost } from './state/ui-store.ts';

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
	const engine = useEngineOrNull()?.client ?? null;
	const [ui] = useState(createTimelineUiStore);
	const prefs = useStoreSelector(timelinePrefs(), (s) => s);
	const mac = useMemo(isMac, []);

	// ------------------------------------------------------------ store selections (no transport!)
	const seq = useSessionState((s) => (s.transient ?? s.document).sequences[seqId] as Sequence);
	const committedSeq = useSessionState((s) => s.document.sequences[seqId] as Sequence);
	// edit-structure: Sequence ▸ Show Through Edits.
	const showThroughEdits = useSessionState((s) => s.toggles.showThroughEdits !== false);
	const committedDoc = useSessionState((s) => s.document);
	const view = useSessionState((s) => s.views[seqId]!);
	const selectedClips = useSessionState((s) => s.selection.timeline.clips);
	const selectedTransitionIds = useSessionState((s) => s.selection.timeline.transitions);
	// The sequence tab strip only shows with 2+ open sequences (SequenceTabs hideSingle); the playhead
	// overlay starts below it.
	const openTabs = useSessionState((s) => s.tabs.open.length);
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
			transitionGhost: s.transitionGhost,
		}),
		(a, b) =>
			a.marquee === b.marquee &&
			a.snapFrame === b.snapFrame &&
			a.razor === b.razor &&
			a.insertAt === b.insertAt &&
			a.limit === b.limit &&
			a.editPoints === b.editPoints &&
			a.drop === b.drop &&
			a.flash === b.flash &&
			a.transitionGhost === b.transitionGhost,
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

	// The controller must outlive env identity changes (a shell re-render mid-drag would otherwise
	// replace it and orphan the active session gesture), so toasts go through a ref.
	const envRef = useRef(env);
	envRef.current = env;
	const engineRef = useRef(engine);
	engineRef.current = engine;
	const toast = useCallback(
		(kind: 'info' | 'warning' | 'error', message: string) => envRef.current.toast({ kind, message }),
		[],
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
				// audio-fx: the Remix tool's release plans the remix on the engine and commits `clip.remix`.
				remix: (clipId, targetFrames) => {
					const engine = engineRef.current;
					if (!engine || !seqId) return toast('error', 'The engine is not connected');
					const seq = session.getCommitted().sequences[seqId];
					if (!seq) return;
					const secs = (targetFrames * seq.settings.frameRate.den) / seq.settings.frameRate.num;
					const clip = seq.clips[clipId] as { remix?: { segments: number; variations: number } } | undefined;
					remixClip(session, engine, seqId, clipId, secs, {
						...(clip?.remix ? { segments: clip.remix.segments, variations: clip.remix.variations } : {}),
					}).then(
						(r) =>
							toast(
								'info',
								`Remixed to ${r.lengthSeconds.toFixed(2)} s (${r.pieces} segments, ${Math.round(r.bpm)} BPM)`,
							),
						(e: Error) => toast('error', e.message),
					);
				},
			}),
		[session, seqId, ui, toast, mac],
	);

	// A replaced or unmounted controller must not leave its session gesture open (every later
	// beginGesture would throw and agent submits would queue forever).
	useEffect(
		() => () => {
			controller.cancel();
		},
		[controller],
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

	useEffect(() => {
		if (import.meta.env.DEV) exposeForDev(session);
	}, [session]);

	// edit-ux: selected edit points follow their clips through edits, undo and redo (trim mode).
	useEffect(
		() =>
			session.on('doc.changed', () => {
				const s = seqId ? session.getCommitted().sequences[seqId] : undefined;
				if (s) refreshEditPoints(ui, s);
			}),
		[session, ui, seqId],
	);

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

	// mcp-cli (live-UI automation): time ↔ x and track ↔ y for agents (ui_locate / ui_hit, ui_click {timeline}).
	const seqRef = useRef(seq);
	seqRef.current = seq;
	useEffect(() => {
		const area = () => areaRef.current;
		const rowOf = (track: string) => {
			const s = seqRef.current;
			const t = [...s.videoTracks, ...s.audioTracks].find(
				(x) => x.id === track || trackLabel(s, x.id) === track,
			);
			if (!t) throw new Error(`No track "${track}" in this sequence`);
			const g = geomRef.current.layout;
			const row = [...g.video.rows, ...g.audio.rows].find((r) => r.trackId === t.id);
			if (!row) throw new Error(`Track ${track} is not laid out`);
			return { row, label: trackLabel(s, t.id) ?? track };
		};
		const tc = (f: number) => {
			const st = seqRef.current.settings;
			return formatTimecode(f, st.frameRate as Rational, {
				dropFrame: st.dropFrame,
				startFrames: st.startTimecodeFrames,
			});
		};
		return registerUiLocator(props.instanceId, {
			kind: 'timeline',
			element: () => areaRef.current?.closest('[data-panel-body]') ?? areaRef.current,
			impl: {
				sequenceId: () => seqRef.current.id,
				view: () => {
					const r = area()?.getBoundingClientRect();
					const v = geomRef.current.viewport;
					return {
						scrollFrame: v.scrollFrame,
						pxPerFrame: v.pxPerFrame,
						area: { x: r?.left ?? 0, y: r?.top ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 },
						visibleFrames: [Math.floor(v.scrollFrame), Math.ceil(v.scrollFrame + v.width / v.pxPerFrame)],
					};
				},
				locate: (a) => {
					const r = area()?.getBoundingClientRect();
					if (!r) throw new Error('The timeline is not laid out');
					const v = geomRef.current.viewport;
					const xOf = (f: number) => r.left + (f - v.scrollFrame) * v.pxPerFrame;
					if (a.clipId) {
						const c = seqRef.current.clips[a.clipId];
						if (!c) throw new Error(`No clip ${a.clipId} in this sequence`);
						const { row, label } = rowOf(c.trackId);
						const inset = Math.min(4, (c.duration * v.pxPerFrame) / 4);
						const x =
							a.edge === 'in'
								? xOf(c.start) + inset / 2
								: a.edge === 'out'
									? xOf(c.start + c.duration) - inset / 2
									: xOf(c.start + c.duration / 2);
						return { x, y: r.top + row.y + row.height / 2, frame: c.start, track: label };
					}
					const frame = a.frame ?? Math.round(v.scrollFrame + v.width / v.pxPerFrame / 2);
					// A frame's cell centre, so a click there lands on that frame.
					const x = xOf(frame + 0.5);
					if (!a.track) return { x, y: r.top + 4, frame };
					const { row, label } = rowOf(a.track);
					return { x, y: r.top + row.y + row.height / 2, frame, track: label };
				},
				hit: (x, y) => {
					const r = area()?.getBoundingClientRect();
					if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
					const { viewport: v, layout } = geomRef.current;
					const s = seqRef.current;
					const h = hitTest(s, layout, v, x - r.left, y - r.top);
					const exact = v.scrollFrame + (x - r.left) / v.pxPerFrame;
					const frame = Math.max(0, Math.floor(exact));
					const row = 'row' in h ? h.row : null;
					return {
						frame,
						exactFrame: Math.round(exact * 100) / 100,
						timecode: tc(frame),
						track: row ? trackLabel(s, row.trackId) : null,
						trackId: row?.trackId ?? null,
						clipId: h.kind === 'clip' ? h.clip.id : null,
						...(h.kind === 'clip' ? { zone: h.zone } : {}),
					};
				},
			},
		});
	}, [props.instanceId]);

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

	// Escape during a pointer gesture: a gesture-local listener (the keymap owns other keys).
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
	// S10:TUI-004: per-track transition index of the drawn sequence (follows gestures, TUI-005).
	const transitions = useMemo(() => transitionIndex(seq, media), [seq, media]);
	const selectedTransitions = useMemo(() => new Set(selectedTransitionIds), [selectedTransitionIds]);
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
		const readOnly = session.getState().readOnly;
		return [
			// wp-clipboard (S01 §20, Premiere clip menu order).
			{ kind: 'item', label: 'Cut', shortcut: 'Ctrl+X', disabled: readOnly, run: () => run('timeline.cut') },
			{ kind: 'item', label: 'Copy', shortcut: 'Ctrl+C', run: () => run('timeline.copy') },
			{
				kind: 'item',
				label: 'Paste Attributes…',
				shortcut: 'Ctrl+Alt+V',
				disabled: readOnly,
				run: () => run('timeline.pasteAttributes'),
			},
			{
				kind: 'item',
				label: 'Remove Attributes…',
				disabled: readOnly,
				run: () => run('timeline.removeAttributes'),
			},
			{ kind: 'separator' },
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
			// edit-structure (Premiere clip menu): Group / Ungroup, Nest…, Make Subsequence, frame holds.
			{
				kind: 'item',
				label: 'Group',
				shortcut: 'Ctrl+G',
				disabled: readOnly,
				run: () => run('timeline.group'),
			},
			{
				kind: 'item',
				label: 'Ungroup',
				shortcut: 'Ctrl+Shift+G',
				disabled: readOnly || !c.groupId,
				run: () => run('timeline.ungroup'),
			},
			{ kind: 'item', label: 'Duplicate', run: () => run('timeline.duplicate') },
			{ kind: 'separator' },
			{ kind: 'item', label: 'Nest…', disabled: readOnly, run: () => run('clip.nest') },
			...(c.kind === 'nest-video' || c.kind === 'nest-audio'
				? [
						{ kind: 'item' as const, label: 'Unnest', disabled: readOnly, run: () => run('clip.unnest') },
						{
							kind: 'item' as const,
							label: 'Reveal Nested Sequence',
							shortcut: 'Ctrl+Shift+F',
							run: () => run('timeline.revealNested'),
						},
					]
				: []),
			// wp-multicam (Premiere clip context menu: Synchronize…, Multi-Camera ▸ Enable / Flatten / camera N)
			{ kind: 'item', label: 'Synchronize…', disabled: readOnly, run: () => run('clip.synchronize') },
			...(c.kind === 'nest-video' || c.kind === 'nest-audio'
				? [
						{
							kind: 'submenu' as const,
							label: 'Multi-Camera',
							items: [
								{
									kind: 'item' as const,
									label: 'Enable',
									checked: isMulticamClip(c) && c.multicam.enabled,
									disabled: readOnly,
									run: () => run('multicam.enable'),
								},
								{
									kind: 'item' as const,
									label: 'Flatten',
									disabled: readOnly || !(isMulticamClip(c) && c.multicam.enabled),
									run: () => run('multicam.flatten'),
								},
								...(cameraMenuEntries(session, c).length ? [{ kind: 'separator' as const }] : []),
								...cameraMenuEntries(session, c).map((m) => ({
									kind: 'item' as const,
									label: m.label,
									checked: m.checked,
									disabled: readOnly || !(isMulticamClip(c) && c.multicam.enabled),
									run: () => run('multicam.switchCamera', { camera: m.camera }),
								})),
								{ kind: 'separator' as const },
								{
									kind: 'item' as const,
									label: 'Edit Cameras…',
									disabled: readOnly || !isMulticamClip(c),
									run: () => run('multicam.editCameras'),
								},
							],
						},
					]
				: []),
			{
				kind: 'item',
				label: 'Make Subsequence',
				shortcut: 'Shift+U',
				disabled: readOnly,
				run: () => run('sequence.makeSubsequence'),
			},
			{
				kind: 'item',
				label: 'Join Through Edits',
				disabled: readOnly,
				run: () => run('timeline.joinThroughEdits'),
			},
			...(c.kind !== 'audio' &&
			c.kind !== 'nest-audio' &&
			c.kind !== 'synthetic-audio' &&
			c.kind !== 'adjustment'
				? [
						{
							kind: 'submenu' as const,
							label: 'Video Options',
							items: [
								{
									kind: 'item' as const,
									label: 'Frame Hold Options…',
									disabled: readOnly,
									run: () => run('timeline.frameHoldOptions'),
								},
								{
									kind: 'item' as const,
									label: 'Add Frame Hold',
									disabled: readOnly,
									run: () => run('timeline.addFrameHold'),
								},
								{
									kind: 'item' as const,
									label: 'Insert Frame Hold Segment',
									disabled: readOnly,
									run: () => run('timeline.insertFrameHoldSegment'),
								},
							],
						},
					]
				: []),
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
			// wp-clipboard-2 (S02:TL-930, S05 timeline clip menu): only clips that come from a project item.
			{
				kind: 'item',
				label: 'Reveal in Project',
				disabled: !projectItemOf(session.getCommitted(), c),
				run: () => run('clip.revealInProject', { clipId: c.id }),
			},
			// M2 entries registered by feature packages (Process…, Track…; ARCHITECTURE §19.10).
			...collectMenuItems(clipMenuExtensions.list(), {
				session,
				clip: c,
				selection: session.getState().selection.timeline.clips,
			}),
		];
	};

	// ------------------------------------------------------------ transitions (S10)
	const updateTransition = (label: string, t: Transition, patch: Record<string, unknown>) => {
		const r = apply(label, [{ type: 'transition.update', transitionId: t.id, ...patch }]);
		if (r.ok && r.warnings.length) toast('info', r.warnings[0]!.message);
	};
	/** TUI-045: Set Duration…, Alignment ▸, Replace With ▸, Clear, Set as Default Transition. */
	const transitionMenu = (g: TransitionGeom): ContextMenuItem[] => {
		const t = g.t;
		const medium = g.spec?.appliesTo ?? 'video';
		const ids = () => {
			const sel = session.getState().selection.timeline.transitions;
			return sel.includes(t.id) ? sel : [t.id];
		};
		return [
			// edit-structure (S01:TRN-003): keep the full length with repeated edge frames when media is short.
			...(medium === 'video' && !g.oneSided
				? [
						{
							kind: 'item' as const,
							label: 'Repeat Frames for Short Media',
							checked: t.freezeHandles === true,
							run: () =>
								updateTransition('Transition Handles', t, {
									handles: t.freezeHandles ? 'shorten' : 'freeze',
									duration: t.duration,
								}),
						},
					]
				: []),
			{
				kind: 'item',
				label: 'Set Duration…',
				run: () => {
					const rate = committedSeq.settings.frameRate;
					const text =
						typeof window !== 'undefined'
							? window.prompt('Transition duration (timecode or frames)', String(t.duration))
							: null;
					if (!text) return;
					const n = /^\d+$/.test(text.trim())
						? Number(text.trim())
						: parseTimecodeEntry(text, rate, {
								current: t.duration,
								dropFrame: committedSeq.settings.dropFrame,
							});
					if (n && n > 0) updateTransition('Transition Duration', t, { duration: Math.round(n) });
					else toast('warning', `Not a duration: ${text}`);
				},
			},
			{
				kind: 'submenu',
				label: 'Alignment',
				items: TRANSITION_ALIGNMENTS.map(({ value: a, label }) => ({
					kind: 'item' as const,
					label,
					checked: t.alignment === a,
					disabled: !!g.oneSided,
					run: () => updateTransition('Transition Alignment', t, { alignment: a }),
				})),
			},
			{
				kind: 'submenu',
				label: 'Replace With',
				// Transition framework: grouped by Effects-panel bin (Premiere bins, Sapphire Transitions ▸ sub-bin).
				items: replaceWithItems(medium, t.effectId, (effectId) =>
					updateTransition('Replace Transition', t, { effectId }),
				),
			},
			{ kind: 'separator' },
			{
				kind: 'item',
				label: 'Clear',
				shortcut: 'Delete',
				run: () => {
					const list = ids();
					const r = apply(list.length > 1 ? 'Clear Transitions' : 'Clear Transition', [
						{ type: 'transition.remove', transitionIds: list },
					]);
					if (r.ok) session.select('transitions', [], 'replace');
				},
			},
			{
				kind: 'item',
				label: 'Set as Default Transition',
				disabled: !g.spec,
				run: () => {
					if (setDefaultTransition(t.effectId))
						toast('info', `${g.spec?.label ?? t.effectId} is the default ${medium} transition`);
				},
			},
			// M3 (TUI-031): the dialog with the default types, alignment and durations.
			{ kind: 'item', label: 'Transition Defaults…', run: () => run('sequence.transitionDefaults') },
		];
	};

	/** TUI-011: double-click a transition → Effect Controls shows it. */
	const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
		const p = local(e);
		const g = geomRef.current;
		const yh = hitY(g.layout, p.y);
		if (yh.kind !== 'track') return;
		const th = hitTransition(transitions, yh.row, g.viewport, p.x, p.y - yh.row.y);
		if (!th) {
			// edit-structure: double-clicking a nest clip opens its sequence at the frame under the pointer.
			const hit = hitTest(committedSeq, g.layout, g.viewport, p.x, p.y);
			// edit-ux (Premiere): double-clicking an edit point opens the Trim Monitor (trim mode).
			if (hit.kind === 'clip' && hit.zone !== 'body' && ui.getState().editPoints.length) {
				enterTrimMode(committedSeq.id);
				return;
			}
			if (hit.kind === 'clip' && (hit.clip.kind === 'nest-video' || hit.clip.kind === 'nest-audio'))
				revealNested(session, committedSeq, hit.clip, boundaryFrameAt(g.viewport, p.x));
			return;
		}
		session.select('timeline', [], 'replace');
		session.select('transitions', [th.geom.t.id], 'replace');
		run('panel.focus.effectControls');
	};

	/** TUI-021/022: drop target (on the committed sequence) for a transition dragged over the tracks. */
	const transitionDropAt = (e: React.DragEvent, effectId: string | null): DropTarget | null | 'unknown' => {
		if (!effectId) return 'unknown';
		const spec = transitionSpec(effectId);
		if (!spec) return null;
		const p = local(e);
		const g = geomRef.current;
		const yh = hitY(g.layout, p.y);
		if (yh.kind !== 'track') return null;
		const track = [...committedSeq.videoTracks, ...committedSeq.audioTracks].find(
			(t) => t.id === yh.row.trackId,
		);
		if (!track || track.locked) return null;
		const committedIndex = transitionIndex(committedSeq, committedDoc.media);
		const over = hitTransition(committedIndex, yh.row, g.viewport, p.x, p.y - yh.row.y)?.geom ?? null;
		return resolveTransitionDrop({
			seq: committedSeq,
			media: committedDoc.media,
			trackId: track.id,
			trackKind: yh.row.kind,
			spec,
			v: g.viewport,
			x: p.x,
			over,
			// S10:TUI-032: the project's default length of the transition's medium (Preferences ▸ Timeline).
			wanted: defaultTransitionFrames(committedDoc.settings, spec.appliesTo),
		});
	};
	const showTransitionGhost = (
		ghost: TransitionGhost | null,
		lines: string[] | null,
		x: number,
		y: number,
	) => {
		const cur = ui.getState();
		if (
			JSON.stringify(cur.transitionGhost) !== JSON.stringify(ghost) ||
			JSON.stringify(cur.tooltip?.lines ?? null) !== JSON.stringify(lines)
		)
			ui.setState({ transitionGhost: ghost, tooltip: lines ? { x, y, lines } : null, drop: null });
	};
	const onTransitionDragOver = (e: React.DragEvent<HTMLDivElement>) => {
		const effectId = transitionDragId(e.dataTransfer);
		const target = transitionDropAt(e, effectId);
		const p = local(e);
		if (target === 'unknown') {
			// A drag whose id is not readable before the drop (a browser that hides custom types, or another app).
			e.preventDefault();
			e.dataTransfer.dropEffect = 'copy';
			return;
		}
		if (!target || target.refused) {
			// TUI-022: refused (N = 0) or not a track of this medium → no drop, cursor not-allowed.
			e.dataTransfer.dropEffect = 'none';
			showTransitionGhost(
				target?.kind === 'add'
					? {
							trackId: target.trackId,
							wanted: target.feedback.wanted,
							fitted: null,
							bands: target.feedback.bands,
							missing: target.feedback.missing,
							refused: true,
						}
					: null,
				target?.refused ? ['Insufficient media: the transition cannot be added', target.refused] : null,
				p.x,
				p.y,
			);
			return;
		}
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		const rate = committedSeq.settings.frameRate;
		const dropFrame = committedSeq.settings.dropFrame;
		if (target.kind === 'replace') {
			const geom = (transitions.get(target.transition.trackId) ?? []).find(
				(x) => x.t.id === target.transition.id,
			);
			const span = geom ? { start: geom.start, end: geom.end } : { start: 0, end: 0 };
			showTransitionGhost(
				{
					trackId: target.transition.trackId,
					wanted: span,
					fitted: span,
					bands: [],
					missing: [],
					refused: false,
					replace: true,
				},
				[`Replace with ${transitionSpec(effectId ?? '')?.label ?? 'transition'}`],
				p.x,
				p.y,
			);
			return;
		}
		const f = target.feedback;
		const where = target.oneSided
			? target.oneSided === 'in'
				? 'Fade in'
				: 'Fade out'
			: (TRANSITION_ALIGNMENTS.find(({ value }) => value === target.alignment)?.label ?? '');
		const lines = [`${where} · ${formatDuration(f.fittedDuration, rate, dropFrame)}`];
		if (f.fittedDuration < f.wantedDuration)
			lines.push(`Insufficient media: the transition will be ${f.fittedDuration} frames`);
		showTransitionGhost(
			{
				trackId: target.trackId,
				wanted: f.wanted,
				fitted: f.fitted,
				bands: f.bands,
				missing: f.missing,
				refused: false,
			},
			lines,
			p.x,
			p.y,
		);
	};
	/** TUI-023/024: one entry "Add Transition" / "Replace Transition"; shortening warnings as toasts. */
	const onTransitionDrop = (e: React.DragEvent<HTMLDivElement>) => {
		const payload = readTransitionDragPayload(e.dataTransfer);
		endTransitionDrag();
		ui.setState({ transitionGhost: null, tooltip: null });
		if (!payload) return;
		const spec = transitionSpec(payload.effectId);
		if (!spec) {
			toast('warning', `Unknown transition ${payload.effectId}`);
			return;
		}
		const target = transitionDropAt(e, payload.effectId);
		if (target === 'unknown' || !target) {
			toast('warning', `${spec.label} cannot be dropped there.`);
			return;
		}
		if (target.refused) {
			toast('warning', target.refused);
			return;
		}
		const r = apply(target.kind === 'replace' ? 'Replace Transition' : 'Add Transition', [
			dropCommand(target, spec.id),
		]);
		if (!r.ok) return;
		for (const w of r.warnings) toast('warning', w.message);
		const id =
			target.kind === 'replace'
				? target.transition.id
				: (r.results[0] as { transitionId?: string }).transitionId;
		if (id) {
			session.select('timeline', [], 'replace');
			session.select('transitions', [id], 'replace');
		}
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
		const th = hitTransition(transitions, yh.row, g.viewport, p.x, p.y - yh.row.y);
		if (th) {
			// TUI-045: right-clicking a transition selects it and opens its menu.
			if (!selectedTransitions.has(th.geom.t.id)) {
				session.select('timeline', [], 'replace');
				session.select('transitions', [th.geom.t.id], 'replace');
			}
			openMenu(e.clientX, e.clientY, transitionMenu(th.geom));
			return;
		}
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
		const gap = gapAt(committedSeq, yh.row.trackId, frame);
		// wp-clipboard: Paste / Paste Insert at the playhead from an empty spot (S01:CLB-003/004).
		const paste: ContextMenuItem[] = [
			{ kind: 'item', label: 'Paste', shortcut: 'Ctrl+V', run: () => run('timeline.paste') },
			{
				kind: 'item',
				label: 'Paste Insert',
				shortcut: 'Ctrl+Shift+V',
				run: () => run('timeline.pasteInsert'),
			},
		];
		openMenu(e.clientX, e.clientY, [
			...(gap
				? [
						{
							kind: 'item' as const,
							label: 'Ripple Delete',
							run: () => apply('Close Gap', [{ type: 'gap.close', trackId: gap.trackId, at: gap.start }]),
						},
						{ kind: 'separator' as const },
					]
				: []),
			...paste,
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
		if (isTransitionDrag(e.dataTransfer)) {
			onTransitionDragOver(e);
			return;
		}
		// Effects (WP-2D) and text animations (M2, wp-m2-text-anim) drop onto the clip under the pointer; no
		// insert/overwrite indicator.
		if (isEffectDrag(e.dataTransfer) || isTextAnimationDrag(e.dataTransfer)) {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'copy';
			return;
		}
		if (!types.includes(PROJECT_ITEMS_MIME) && !types.includes(MG_TEMPLATE_MIME) && !types.includes('Files'))
			return;
		e.preventDefault();
		const t = dropTarget(e);
		const d = ui.getState().drop;
		if (!d || d.frame !== t.frame || d.trackLabel !== t.label || d.insert !== t.insert)
			ui.setState({ drop: { frame: t.frame, trackLabel: t.label, insert: t.insert } });
	};
	const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		if (isTransitionDrag(e.dataTransfer)) {
			onTransitionDrop(e);
			return;
		}
		const t = dropTarget(e);
		ui.setState({ drop: null });
		const effect = readEffectDragPayload(e.dataTransfer);
		if (effect) {
			const p = local(e);
			const g = geomRef.current;
			const hit = hitTest(committedSeq, g.layout, g.viewport, p.x, p.y);
			if (hit.kind !== 'clip') return;
			const r = applyEffectToClips(session, effect.effectId, [hit.clip.id]);
			if (!r) toast('warning', 'This effect cannot be applied to that clip.');
			else if (!r.ok) toast('error', r.errors[0]?.message ?? 'Could not apply the effect.');
			return;
		}
		// M2 (wp-m2-text-anim, S11:TXA-020): a text animation preset applies to the text clip under the pointer; the
		// drop position picks the side (first half of the clip = In, second half = Out).
		const textAnim = readTextAnimationDrag(e.dataTransfer);
		if (textAnim) {
			const p = local(e);
			const hit = hitTest(committedSeq, geomRef.current.layout, geomRef.current.viewport, p.x, p.y);
			if (hit.kind !== 'clip' || hit.clip.kind !== 'text') {
				toast('warning', 'Drop text animations onto a text clip.');
				return;
			}
			const side = dropSide(hit.clip, t.frame);
			const m = applyMessage(applyTextAnimation(session, [hit.clip.id], { side, ...textAnim }));
			if (m) toast(m.kind, m.text);
			return;
		}
		const mg = readMgTemplateDrag(e.dataTransfer);
		if (mg) {
			const trackId = (t.region === 'video' ? committedSeq.videoTracks : [])[t.index]?.id;
			try {
				insertMotionTemplate(session, mg.template, { at: t.frame, ...(trackId ? { trackId } : {}) });
			} catch (err) {
				toast('error', err instanceof Error ? err.message : String(err));
			}
			return;
		}
		const raw = e.dataTransfer.getData(PROJECT_ITEMS_MIME);
		if (raw) {
			let itemIds: string[] = [];
			try {
				const parsed = JSON.parse(raw) as { itemIds?: string[] } | string[];
				itemIds = Array.isArray(parsed) ? parsed : (parsed.itemIds ?? []);
			} catch {
				itemIds = [];
			}
			// LUT items dropped on a clip apply as its Look (S06:LUT-002, wp-m2-color).
			const lutHit = hitTest(
				committedSeq,
				geomRef.current.layout,
				geomRef.current.viewport,
				local(e).x,
				local(e).y,
			);
			if (dropLutItems(session, itemIds, lutHit.kind === 'clip' ? lutHit.clip.id : null)) return;
			placeItems(itemIds, t);
			return;
		}
		const files = Array.from(e.dataTransfer.files ?? []);
		if (files.length === 0) return;
		// WP-2E registers the import service module-wide (state/services.ts); a panel-scoped one wins.
		const svc = env.services.get('importService') ?? getImportService();
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
			// edit-structure: sequences (nests or individual clips) and synthetics with sound have both kinds.
			const av = itemAvKinds(doc, item);
			const hasVideo = asset ? asset.probe.streams.some((s) => s.type === 'video') : av.video;
			const hasAudio = asset ? asset.probe.streams.some((s) => s.type === 'audio') : av.audio;
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
				...(item.kind === 'sequence'
					? { nest: session.getState().toggles.insertSequencesAsNests !== false }
					: {}),
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
			<SequenceTabs session={session} activeId={seqId} hideSingle />
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
						extraMenu={
							import.meta.env.DEV
								? [
										{
											kind: 'item',
											label: 'Dev: Insert Sample Clips',
											run: () => insertSampleClips(session, seqId),
										},
									]
								: undefined
						}
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
			{/* wp captions: caption tracks above the video tracks */}
			<CaptionLanes
				seq={seq}
				session={session}
				viewport={viewport}
				headerWidth={headerWidth}
				selected={selectedSet}
				openMenu={openMenu}
				toast={toast}
				run={run}
				openCaption={(clipId) => {
					session.select('timeline', [clipId], 'replace', { primary: clipId });
					run('captions.openPanel');
				}}
			/>
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
						data-testid="timeline-header-resize"
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
					onDragLeave={() => ui.setState({ drop: null, transitionGhost: null, tooltip: null })}
					onDoubleClick={onDoubleClick}
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
						transitions={transitions}
						selectedTransitions={selectedTransitions}
						showThroughEdits={showThroughEdits}
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
				tabsOffset={openTabs > 1}
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

function formatDuration(frames: number, rate: Rational, dropFrame: boolean): string {
	return `${formatTimecode(frames, rate, { dropFrame })} (${frames})`;
}

/** "Replace With" submenu (S10:TUI-045): the transitions of a medium, one submenu per bin (flat when one bin). */
function replaceWithItems(
	medium: 'video' | 'audio',
	current: string,
	replace: (effectId: string) => void,
): ContextMenuItem[] {
	const bins = new Map<string, ContextMenuItem[]>();
	for (const s of TRANSITION_SPECS) {
		if (s.appliesTo !== medium) continue;
		const bin = s.subBin ? `${s.bin} ▸ ${s.subBin}` : s.bin;
		bins.set(bin, [
			...(bins.get(bin) ?? []),
			{ kind: 'item', label: s.label, checked: current === s.id, run: () => replace(s.id) },
		]);
	}
	if (bins.size === 1) return [...bins.values()][0]!;
	return [...bins.entries()]
		.sort(
			([a], [b]) => Number(a.startsWith('Sapphire')) - Number(b.startsWith('Sapphire')) || a.localeCompare(b),
		)
		.map(([label, items]) => ({ kind: 'submenu', label, items }));
}
