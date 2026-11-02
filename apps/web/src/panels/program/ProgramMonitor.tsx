// Program monitor (S03 §6, S05 §16.3): plays the active sequence in the Remotion Player with our own
// transport, zoom/pan, overlays and on-canvas transform. The Player is sized at the composition size
// and scaled by one CSS transform (S03:PGM-002) so overlays share its geometry exactly.

import {
	activeMixGraph,
	DEFAULT_RENDER_OPTIONS,
	MissingAssetReporterContext,
	type MixGraph,
	type RenderDoc,
	type RenderOptions,
	SequenceComposition,
} from '@jasper/compositions';
import { type EditorSession, type GestureFrames, gestureFrames } from '@jasper/session';
import {
	useDerivedPreviewDocument,
	useGestureFrameDocument,
	useSessionOrNull,
	useSessionState,
	useStoreSelector,
} from '@jasper/session/react';
import { Player, type PlayerRef } from '@remotion/player';
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { registerUiLocator } from '../../agent-bridge/ui-automation.ts';
import { useAudioStartWait, useMixGraph } from '../../audio/runtime.ts';
import { useAudioSessionServices } from '../../audio/session.ts';
import { useColorBypass } from '../../color/actions.ts';
import { gamutOverlay } from '../../delivery/GamutOverlay.tsx';
import { runCommand } from '../../commands/index.ts';
import { registerFullscreenTarget } from '../../commands/monitor-view.ts';
import { useExpressionsFor } from '../../expressions/engine.ts';
import { programOverlays } from '../../extensions/index.ts';
import { useRegistry } from '../../extensions/react.ts';
import { useFonts } from '../../fonts/hooks.ts';
import { useMissingFontsNotice } from '../../fonts/notice.ts';
import { buildMulticamViewDoc, multicamClipAt, multicamTrack } from '../../multicam/logic.ts';
import { MulticamOverlay } from '../../multicam/MulticamOverlay.tsx';
import { installMulticamRecorder } from '../../multicam/recorder.ts';
import { multicamViewStore } from '../../multicam/state.ts';
import { usePlaybackPreviews } from '../../previews/hooks.ts';
import { registerProgramPerf } from '../../previews/perf.ts';
import { useHeardDocument } from '../../proposals/state.ts';
import { useRemoteAssetsEpoch } from '../../remote-assets/font-catalog.ts';
import {
	TemplateAssetWarning,
	useLayerAssetReports,
	useTemplateAssetPrefetch,
} from '../../remote-assets/issues.tsx';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import { useEngineOrNull } from '../../state/engine.tsx';
import { threeDViews, viewCamOf } from '../../three-d/view-store.ts';
import { ContextMenu } from '../timeline/components/Chrome.tsx';
import { markerVar } from '../timeline/components/ClipView.tsx';
import type { PanelProps } from '../types.ts';
import { ProgramComparison } from './ComparisonView.tsx';
import { GuidesOverlay } from './GuidesOverlay.tsx';
import { programLayerMenu } from './layer-menu.ts';
import {
	durationLabel,
	MiniRuler,
	MonitorSelect,
	SettingsMenu,
	TimecodeDisplay,
	type TimecodeFormat,
	useElementSize,
	useTransportPlaying,
} from './MonitorChrome.tsx';
import { MgRenderStateProvider } from './mg-render-state.tsx';
import { checkerboard } from './monitor.tokens.ts';
import { handleMonitorKey, monitorPanelServices, useMonitorCommandCtx } from './monitor-commands.ts';
import {
	monitorStores,
	PLAYBACK_RESOLUTIONS,
	type PlaybackResolution,
	resolutionToProxy,
} from './monitor-store.ts';
import { monitorExtras } from './monitor-view.ts';
import { PlaybackDriver } from './playback-driver.ts';
import { buildProgramDoc, playerDurationFrames, usesProxies } from './render-doc.ts';
import { TransformOverlay } from './TransformOverlay.tsx';
import { TransportBar } from './TransportBar.tsx';
import { TrimMonitor, useTrimMonitorVisible } from './TrimMonitor.tsx';
import { registerDriver } from './transport-registry.ts';
import {
	clampPan,
	computeView,
	type Size,
	type Vec2,
	WHEEL_ZOOM_STEP,
	ZOOM_PRESETS,
	zoomAround,
	zoomPercent,
} from './viewport.ts';

const RES_LABEL: Record<PlaybackResolution, string> = {
	full: 'Full',
	'1/2': '1/2',
	'1/4': '1/4',
	'1/8': '1/8',
};

export function ProgramMonitor(props: PanelProps) {
	const session = useSessionOrNull();
	if (!session) {
		return (
			<div
				className="flex h-full items-center justify-center text-pr-small text-pr-muted"
				data-panel-kind="program"
			>
				No project open
			</div>
		);
	}
	return <ProgramMonitorBody session={session} instanceId={props.instanceId} />;
}

/** Resolution of GPU shader-effect canvases per playback resolution (RenderOptions.fxPreviewScale). */
const FX_PREVIEW_SCALE: Record<PlaybackResolution, number> = {
	full: 1,
	'1/2': 0.5,
	'1/4': 0.25,
	'1/8': 0.125,
};

function ProgramMonitorBody({ session, instanceId }: { session: EditorSession; instanceId: string }) {
	const engine = useEngineOrNull()?.client ?? null;
	const transport = session.transport;
	// automation passes and audio scrubbing follow this session's transport.
	useAudioSessionServices(session);
	const overlays = useRegistry(programOverlays);
	const gamutEnabled = useStoreSelector(gamutOverlay, (s) => s.enabled);
	const seqId = useSessionState((s) => s.activeSequenceId);
	// gesture frames reach the Player as often as it can afford (useGestureFrameDocument); commits at once.
	const gestureDrawn = useGestureFrameDocument();
	// spec 12 §2.5: while "Hear proposal" is on, picture AND sound come from the proposal's preview document (never
	// committed; the session's document and History are untouched). Toggling swaps the Player's document in place:
	// unchanged clips keep their players, so playback goes on.
	const heard = useHeardDocument(session);
	// spec 14 TC-042: "Play result" / "Play removed" of Clean Up play a derived timeline (never committed) the same way.
	const derived = useDerivedPreviewDocument(session);
	const drawn = heard ?? derived ?? gestureDrawn;
	const media = useSessionState((s) => s.media);
	const autoProxies = useSessionState((s) => s.toggles.useProxies);
	// gaps (PRJ-8): Toggle Proxies plays attached proxies.
	const attachedProxies = useSessionState((s) => !!s.toggles.attachedProxies);
	const useProxies = autoProxies || attachedProxies;
	const monitor = useStoreSelector(monitorStores.program, (s) => s);
	// wp fonts: the catalog follows `fonts.changed`, so installing a font redraws text set in it; social-comment §7.8:
	// it also follows `remoteAssets.changed` (platform fonts, emoji and images of the templates), counted by the epoch.
	const fontCatalog = useFonts().catalog;
	useMissingFontsNotice(session, fontCatalog);
	const assetEpoch = useRemoteAssetsEpoch();
	const seq = seqId ? drawn.sequences[seqId] : undefined;
	const prevDoc = useRef<RenderDoc | null>(null);
	const tier = resolutionToProxy(monitor.playbackResolution).tier;
	// the Multi-Camera view plays a virtual document — the angle grid next to the program — in the same
	// Player. Which multi-camera track/source it follows changes only when the playhead crosses clips.
	const mcState = useStoreSelector(multicamViewStore, (s) => s);
	const [mcKey, setMcKey] = useState<{ key: string; frame: number }>({ key: '', frame: 0 });
	useEffect(() => {
		if (!mcState.view || !seq) return;
		const keyAt = (f: number) => {
			const t = multicamTrack(seq, f, mcState.topDown);
			const c = multicamClipAt(seq, f, mcState.topDown);
			return `${t ?? ''}:${c?.clip.sequenceId ?? ''}`;
		};
		const update = (f: number) =>
			setMcKey((prev) => {
				const k = keyAt(f);
				return k === prev.key ? prev : { key: k, frame: f };
			});
		update(transport.getState().frame);
		let last = 0;
		return transport.subscribe((st) => {
			const now = Date.now();
			if (now - last < 120) return;
			last = now;
			update(st.frame);
		});
	}, [mcState.view, mcState.topDown, seq, transport]);
	const mcView = useMemo(() => {
		if (!mcState.view || !seqId || !seq) return null;
		return buildMulticamViewDoc(drawn, seqId, mcKey.frame, {
			showPreview: mcState.showPreview,
			topDown: mcState.topDown,
			layout: mcState.layout,
			page: mcState.page,
		});
	}, [
		drawn,
		seqId,
		seq,
		mcKey,
		mcState.view,
		mcState.showPreview,
		mcState.topDown,
		mcState.layout,
		mcState.page,
	]);
	useEffect(() => installMulticamRecorder(session), [session]);
	// Wave expressions: the engine loads on demand; the doc is rebuilt (bound) once it is ready.
	const expressionsReady = useExpressionsFor(drawn);
	// biome-ignore lint/correctness/useExhaustiveDependencies: expressionsReady changes what buildRenderSnapshot binds
	const doc = useMemo(() => {
		if (!seqId || !seq) return null;
		const d = buildProgramDoc(
			mcView
				? {
						doc: mcView.doc,
						sequenceId: mcView.sequenceId,
						media,
						proxyTier: tier,
						fontCatalog,
						attachedProxies,
						autoProxies,
					}
				: {
						doc: drawn,
						sequenceId: seqId,
						media,
						proxyTier: tier,
						fontCatalog,
						attachedProxies,
						autoProxies,
					},
			prevDoc.current,
		);
		prevDoc.current = d;
		return d;
	}, [drawn, seqId, seq, media, tier, fontCatalog, expressionsReady, mcView, attachedProxies, autoProxies]);
	// social-comment §7.8: template fonts / emoji — downloaded ahead of drawing, failures reported by the layers.
	const assetReports = useLayerAssetReports();
	const assetPrefetch = useTemplateAssetPrefetch(engine, doc, assetEpoch);
	const transparent = (seq?.settings.backgroundColor[3] ?? 1) === 0;
	// Before/after (S06:CGU-005, wp-m2-color): clips whose colour effects the preview bypasses.
	const colorBypass = useColorBypass();
	// GPU shader effects follow the playback resolution (1/2 → canvases at half size), keeping heavy stacks interactive.
	const fxPreviewScale = FX_PREVIEW_SCALE[monitor.playbackResolution];
	// the selected 3D view (View ▸ Switch 3D View) draws the 3D layers through its camera.
	const views3d = useStoreSelector(threeDViews, (s) => (seqId ? s.bySequence[seqId] : undefined));
	// biome-ignore lint/correctness/useExhaustiveDependencies: the view store entry carries the view cameras
	const view3d = useMemo(
		() =>
			seqId && seq
				? viewCamOf(seqId, views3d?.view ?? 'activeCamera', seq.settings.width, seq.settings.height)
				: null,
		[seqId, views3d, seq?.settings.width, seq?.settings.height],
	);
	// previews: rendered segments play from their files (committed document only: a gesture draws live).
	const committed = useSessionState((s) => s.document);
	const previews = usePlaybackPreviews(committed, seqId, !mcView && !!seqId);
	const playPreviews = previews && drawn === committed && !mcView ? previews : null;
	const options = useMemo<RenderOptions>(
		() => ({
			...DEFAULT_RENDER_OPTIONS,
			isPreview: true,
			useProxies,
			transparentBackground: transparent,
			...(colorBypass.length ? { colorBypassClipIds: colorBypass } : {}),
			...(fxPreviewScale < 1 ? { fxPreviewScale } : {}),
			...(view3d && !mcView ? { view3d } : {}),
			...(playPreviews ? { previews: playPreviews } : {}),
		}),
		[useProxies, transparent, colorBypass, fxPreviewScale, view3d, mcView, playPreviews],
	);
	// The Player gets the same props object for the life of the monitor and the composition reads the document from
	// `live`: Remotion's video config includes the props, and its playback loop restarts its clock from the current frame
	// whenever the config changes — every edit made while playing (an agent's, Hear proposal) dropped the time since the
	// last frame plus the edit's render from the picture, which then lagged the audio (and Remotion re-anchored every
	// player to it: the audio jumped ≈ 185 ms back; sound-design Phase 6).
	const [playerDoc] = useState(() => liveProps(doc ? { doc, options } : null));
	useLayoutEffect(() => playerDoc.set(doc ? { doc, options } : null), [playerDoc, doc, options]);
	const inputProps = useMemo(() => ({ live: playerDoc }), [playerDoc]);
	const duration = seqId ? playerDurationFrames(drawn, seqId) : 1;
	const end = seq ? Math.max(0, duration - 1) : 0;
	const fps = seq ? seq.settings.frameRate.num / seq.settings.frameRate.den : 30;
	const fw = mcView?.width ?? seq?.settings.width ?? 1920;
	const fh = mcView?.height ?? seq?.settings.height ?? 1080;
	const frameSize = useMemo<Size>(() => ({ width: fw, height: fh }), [fw, fh]);
	const [viewportRef, viewport] = useElementSize<HTMLDivElement>();
	const view = computeView(viewport, frameSize, monitor.zoom, monitor.pan);
	const ctx = useMonitorCommandCtx({ session, panel: 'program', instanceId, engine });
	const trimVisible = useTrimMonitorVisible(session, seqId);
	// S03:XF-050 (wp-clipboard): layer context menu; inside the shell its commands get the live context (toasts).
	const shell = useShellRuntimeOrNull();
	const [layerMenu, setLayerMenu] = useState<{ x: number; y: number; clipId: string | null } | null>(null);
	const menuCtx = () => shell?.getCtx() ?? ctx;
	// transport buttons run with the shell's live context focused on this monitor.
	const barCtx = () => {
		const c = shell?.getCtx();
		return c ? { ...c, focus: { panel: 'program' as const, instanceId } } : ctx;
	};

	const live = useRef({ seq, end, fps });
	live.current = { seq, end, fps };
	const [playerRate, setPlayerRate] = useState(1);
	const [buffering, setBuffering] = useState(false);
	const [dropped, setDropped] = useState(0);
	const extras = useStoreSelector(monitorExtras, (s) => s);
	useEffect(() => registerFullscreenTarget('program', () => viewportRef.current), [viewportRef]);
	const driver = useMemo(
		() =>
			new PlaybackDriver({
				transport,
				getFps: () => live.current.fps,
				getRange: () => {
					const s = live.current.seq;
					const e = live.current.end;
					return { end: e, loopStart: s?.inPoint ?? 0, loopEnd: s?.outPoint ?? e };
				},
				setPlayerRate,
				onBuffering: setBuffering,
				onDroppedFrames: setDropped,
				// sound-design Phase 6: seeks while playing restart primed (sample-exact audio after the seek)
				audio: () => {
					const g = activeMixGraph();
					return g
						? {
								whenPaused: () => g.whenPaused(),
								afterSeek: () => g.afterSeek(),
								get startWaiting() {
									return g.startWaiting;
								},
							}
						: null;
				},
			}),
		[transport],
	);
	// A latency added while playing (an insert, normalisation) restarts playback primed, so the Mix is not late by it
	// until the stop; a primed start that waits long for the program shows as buffering.
	const mixGraph = useMixGraph();
	useEffect(
		() => (mixGraph ? mixGraph.onRestartRequest(() => driver.restart()) : undefined),
		[mixGraph, driver],
	);
	useEffect(() => {
		const detach = transport.attachPlayer(driver);
		const unregister = registerDriver(transport, driver);
		const unregisterPerf = registerProgramPerf(session, driver);
		return () => {
			detach();
			unregister();
			unregisterPerf();
			driver.dispose();
		};
	}, [transport, driver, session]);
	const playerRef = useCallback((p: PlayerRef | null) => driver.setPlayer(p), [driver]);
	useEffect(() => {
		void drawn; // the session resets the bound on every commit
		transport.setMaxFrame(end);
	}, [transport, end, drawn]);
	useEffect(() => {
		const off = monitorPanelServices().register('programPlayer', instanceId, {
			seekTo: (f) => transport.seek(f),
			play: () => transport.play(1),
			pause: () => transport.pause(),
			getContainer: () => viewportRef.current,
		});
		return off;
	}, [instanceId, transport, viewportRef]);

	// mcp-cli (live-UI automation): sequence pixels ↔ window points for agents (ui_locate / ui_hit, ui_click {program}).
	const viewRef = useRef(view);
	viewRef.current = view;
	const frameSizeRef = useRef(frameSize);
	frameSizeRef.current = frameSize;
	useEffect(
		() =>
			registerUiLocator(instanceId, {
				kind: 'program',
				element: () => viewportRef.current,
				impl: {
					toWindow: (x, y) => {
						const r = viewportRef.current?.getBoundingClientRect();
						const v = viewRef.current;
						return { x: (r?.left ?? 0) + v.x + x * v.scale, y: (r?.top ?? 0) + v.y + y * v.scale };
					},
					toSequence: (x, y) => {
						const r = viewportRef.current?.getBoundingClientRect();
						const v = viewRef.current;
						return { x: (x - (r?.left ?? 0) - v.x) / v.scale, y: (y - (r?.top ?? 0) - v.y) / v.scale };
					},
					view: () => {
						const r = viewportRef.current?.getBoundingClientRect();
						const v = viewRef.current;
						const f = frameSizeRef.current;
						const left = r?.left ?? 0;
						const top = r?.top ?? 0;
						return {
							frame: { x: left + v.x, y: top + v.y, width: f.width * v.scale, height: f.height * v.scale },
							scale: v.scale,
							sequence: { width: f.width, height: f.height },
							viewport: { x: left, y: top, width: r?.width ?? 0, height: r?.height ?? 0 },
						};
					},
				},
			}),
		[instanceId, viewportRef],
	);

	// Dev handle for manual checks, playback benchmarks (scripts/performance.mjs) and agents (window.__jasperMonitor);
	// also in builds where the agent bridge is enabled (`localStorage['jasper:agent-bridge'] = '1'`).
	useEffect(() => {
		if (typeof window === 'undefined') return;
		let bridge = false;
		try {
			bridge = window.localStorage.getItem('jasper:agent-bridge') === '1';
		} catch {
			// storage unavailable
		}
		if (!import.meta.env.DEV && !bridge) return;
		const w = window as Window & {
			__jasperMonitor?: { session: EditorSession; driver: PlaybackDriver; gestureFrames: GestureFrames };
		};
		w.__jasperMonitor = { session, driver, gestureFrames: gestureFrames(session.store) };
		return () => {
			if (w.__jasperMonitor?.session === session) delete w.__jasperMonitor;
		};
	}, [session, driver]);

	const setPan = useCallback(
		(pan: Vec2) =>
			monitorStores.program.setState((s) => ({
				pan: clampPan(pan, viewport, frameSize, computeView(viewport, frameSize, s.zoom, s.pan).scale),
			})),
		[viewport, frameSize],
	);
	useEffect(() => {
		const el = viewportRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			const s = monitorStores.program.getState();
			const r = el.getBoundingClientRect();
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				const current = zoomPercent(s.zoom, viewport, frameSize);
				const next = e.deltaY < 0 ? current * WHEEL_ZOOM_STEP : current / WHEEL_ZOOM_STEP;
				monitorStores.program.setState(
					zoomAround(viewport, frameSize, s, next, [e.clientX - r.left, e.clientY - r.top]),
				);
				return;
			}
			if (s.zoom === 'fit') return;
			e.preventDefault();
			const scale = computeView(viewport, frameSize, s.zoom, s.pan).scale;
			const d: Vec2 = e.shiftKey ? [-e.deltaY, 0] : [-e.deltaX, -e.deltaY];
			monitorStores.program.setState({
				pan: clampPan([s.pan[0] + d[0], s.pan[1] + d[1]], viewport, frameSize, scale),
			});
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	}, [viewportRef, viewport, frameSize]);

	const playing = useTransportPlaying(transport);
	const format: TimecodeFormat = useMemo(
		() => ({
			rate: seq?.settings.frameRate ?? { num: 30, den: 1 },
			dropFrame: !!seq?.settings.dropFrame,
			startFrames: seq?.settings.startTimecodeFrames,
		}),
		[seq?.settings.frameRate, seq?.settings.dropFrame, seq?.settings.startTimecodeFrames],
	);
	const seek = (f: number) => {
		if (transport.getState().playing) transport.pause();
		transport.seek(Math.max(0, Math.min(end, f)));
	};
	const setResolution = (r: PlaybackResolution) => {
		monitorStores.program.setState({ playbackResolution: r });
		session.setToggles({ useProxies: resolutionToProxy(r).useProxies });
	};
	const markers = useMemo(
		() =>
			(seq?.markers ?? []).map((m) => ({
				id: m.id,
				frame: m.frame,
				// Same marker palette as the Timeline ruler (R-PUI §3.3), not the darker clip label bodies.
				color: `var(--pr-marker-${markerVar(m.color)})`,
			})),
		[seq?.markers],
	);
	const zoomOptions = useMemo(
		() => [
			{ value: 'fit' as const, label: 'Fit' },
			...ZOOM_PRESETS.map((z) => ({ value: z, label: `${z}%` })),
		],
		[],
	);
	const run = (id: string) => void runCommand(id, ctx);
	const proxyChip = doc ? usesProxies(doc, options) : false;
	const playerStyle = useMemo<CSSProperties>(
		() => ({ width: frameSize.width, height: frameSize.height }),
		[frameSize.width, frameSize.height],
	);

	if (!seq || !doc) {
		return (
			<div
				className="flex h-full items-center justify-center text-pr-small text-pr-muted"
				data-panel-kind="program"
			>
				No sequence
			</div>
		);
	}
	const frameScreen = {
		left: view.x,
		top: view.y,
		width: frameSize.width * view.scale,
		height: frameSize.height * view.scale,
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the monitor is a keyboard scope (S05:KB-002)
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel outline-none"
			data-panel-kind="program"
			data-testid="program-monitor"
			tabIndex={-1}
			onKeyDown={(e) => handleMonitorKey(e.nativeEvent, 'down', ctx, 'program')}
			onKeyUp={(e) => handleMonitorKey(e.nativeEvent, 'up', ctx, 'program')}
		>
			<div
				ref={viewportRef}
				className="relative min-h-0 flex-1 overflow-hidden select-none"
				data-testid="program-viewport"
			>
				{monitor.transparencyGrid || transparent ? (
					<div
						className="pointer-events-none absolute"
						style={{ ...frameScreen, ...checkerboard() }}
						data-testid="program-transparency-grid"
					/>
				) : null}
				<div
					className="absolute top-0 left-0"
					style={{
						width: frameSize.width,
						height: frameSize.height,
						transformOrigin: '0 0',
						transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
					}}
					data-testid="program-player-wrapper"
				>
					<MgRenderStateProvider>
						<MissingAssetReporterContext.Provider value={assetReports.reporter}>
							<Player
								ref={playerRef}
								component={LiveSequenceComposition}
								inputProps={inputProps}
								durationInFrames={duration}
								compositionWidth={frameSize.width}
								compositionHeight={frameSize.height}
								fps={fps}
								style={playerStyle}
								controls={false}
								clickToPlay={false}
								doubleClickToFullscreen={false}
								spaceKeyToPlayOrPause={false}
								moveToBeginningWhenEnded={false}
								loop={false}
								playbackRate={playerRate}
								numberOfSharedAudioTags={8}
								acknowledgeRemotionLicense
								errorFallback={({ error }: { error: Error }) => (
									<div className="flex h-full items-center justify-center bg-pr-app p-8 text-center text-pr-ui text-pr-danger">
										Preview error: {error.message}
									</div>
								)}
							/>
						</MissingAssetReporterContext.Provider>
					</MgRenderStateProvider>
				</div>
				{mcView ? (
					<MulticamOverlay
						session={session}
						sequenceId={seq.id}
						mc={mcView}
						view={view}
						toast={(kind, message, detail) =>
							(shell?.getCtx() ?? ctx).ui.toast({ kind, message, ...(detail ? { detail } : {}) })
						}
					/>
				) : (
					<TransformOverlay
						session={session}
						doc={doc}
						view={view}
						viewport={viewport}
						transport={transport}
						monitor={monitor}
						onPan={setPan}
						onContextMenu={setLayerMenu}
					/>
				)}
				{/* M2 overlays registered by feature packages (tracker, corner pin handles; ARCHITECTURE §19.10). */}
				{overlays
					.filter((o) => !mcView && o.active(session))
					.map((o) => (
						<o.component
							key={o.id}
							session={session}
							doc={doc}
							view={view}
							viewport={viewport}
							transport={transport}
							monitor={monitor}
						/>
					))}
				{/* edit-ux: rulers and guides; the comparison view; the Trim Monitor replaces the picture in trim mode. */}
				{seqId && !trimVisible && !mcView ? (
					<GuidesOverlay sequenceId={seqId} view={view} viewport={viewport} frame={frameSize} />
				) : null}
				{extras.comparison.enabled && !playing && !trimVisible && !mcView && seqId ? (
					<ProgramComparison session={session} sequenceId={seqId} doc={drawn} />
				) : null}
				{trimVisible && seqId ? <TrimMonitor session={session} sequenceId={seqId} ctx={barCtx()} /> : null}
				{extras.showDroppedFrames ? (
					<button
						type="button"
						className={`absolute top-2 left-6 size-[10px] rounded-full ${dropped > 0 ? 'bg-pr-warning' : 'bg-pr-success'}`}
						title={`Dropped frames: ${dropped} (click to reset)`}
						aria-label={`Dropped frames: ${dropped}`}
						onClick={() => driver.resetDroppedFrames()}
						data-testid="program-dropped-frames"
						data-dropped={dropped}
					/>
				) : null}
				{proxyChip ? (
					<span
						className="pointer-events-none absolute top-2 right-2 rounded-pr-control bg-pr-raised px-1.5 text-pr-small text-pr-strong"
						data-testid="program-proxy-chip"
					>
						PROXY
					</span>
				) : null}
				<BufferingDot graph={mixGraph} buffering={buffering} playing={playing} />
				{/* social-comment §7.8: template fonts / emoji that are not available (panel warning, Retry). */}
				<TemplateAssetWarning doc={doc} reported={assetReports.reported} engine={assetPrefetch} />
			</div>
			<div className="flex h-[28px] shrink-0 items-center gap-2 px-2">
				<TimecodeDisplay transport={transport} format={format} onSeek={seek} testId="program-timecode" />
				<MonitorSelect
					label="Select Zoom Level"
					value={monitor.zoom}
					options={zoomOptions}
					testId="program-zoom"
					onChange={(z) => monitorStores.program.setState({ zoom: z, pan: [0, 0] })}
				/>
				<div className="flex-1" />
				<MonitorSelect
					label="Select Playback Resolution"
					value={monitor.playbackResolution}
					options={PLAYBACK_RESOLUTIONS.map((r) => ({ value: r, label: RES_LABEL[r] }))}
					testId="program-resolution"
					onChange={setResolution}
				/>
				<SettingsMenu
					testId="program-settings"
					items={[
						{
							type: 'toggle',
							label: 'Safe Margins',
							checked: monitor.safeMargins,
							onToggle: () => monitorStores.program.setState((s) => ({ safeMargins: !s.safeMargins })),
						},
						{
							type: 'toggle',
							label: 'Gamut Warning',
							checked: gamutEnabled,
							onToggle: () => gamutOverlay.setState((s) => ({ enabled: !s.enabled })),
						},
						{
							type: 'toggle',
							label: 'Transparency Grid',
							checked: monitor.transparencyGrid,
							onToggle: () =>
								monitorStores.program.setState((s) => ({ transparencyGrid: !s.transparencyGrid })),
						},
						{ type: 'separator' },
						{
							type: 'toggle',
							label: 'Snap in Program Monitor',
							shortcut: 'Ctrl+Shift+;',
							checked: monitor.snapInMonitor,
							onToggle: () => monitorStores.program.setState((s) => ({ snapInMonitor: !s.snapInMonitor })),
						},
						{
							type: 'toggle',
							label: 'Loop',
							checked: transport.getState().loop,
							onToggle: () => transport.setLoop(!transport.getState().loop),
						},
						// edit-ux (Premiere wrench menu): rulers, guides, comparison view, dropped frame indicator
						{ type: 'separator' },
						{
							type: 'toggle',
							label: 'Show Rulers',
							shortcut: 'Ctrl+R',
							checked: extras.showRulers,
							onToggle: () => monitorExtras.setState((v) => ({ showRulers: !v.showRulers })),
						},
						{
							type: 'toggle',
							label: 'Show Guides',
							shortcut: 'Ctrl+;',
							checked: extras.showGuides,
							onToggle: () => monitorExtras.setState((v) => ({ showGuides: !v.showGuides })),
						},
						{
							type: 'toggle',
							label: 'Lock Guides',
							checked: extras.lockGuides,
							onToggle: () => monitorExtras.setState((v) => ({ lockGuides: !v.lockGuides })),
						},
						{
							type: 'toggle',
							label: 'Comparison View',
							checked: extras.comparison.enabled,
							onToggle: () => void runCommand('program.toggleComparisonView', menuCtx()),
						},
						{
							type: 'toggle',
							label: 'Show Dropped Frame Indicator',
							checked: extras.showDroppedFrames,
							onToggle: () => monitorExtras.setState((v) => ({ showDroppedFrames: !v.showDroppedFrames })),
						},
						// wp-multicam (Premiere: Program monitor settings ▸ Multi-Camera and its options)
						{ type: 'separator' },
						{
							type: 'toggle',
							label: 'Multi-Camera',
							shortcut: 'Shift+0',
							checked: mcState.view,
							onToggle: () => multicamViewStore.setState((v) => ({ view: !v.view })),
						},
						{
							type: 'toggle',
							label: 'Show Multi-Camera Preview Monitor',
							checked: mcState.showPreview,
							onToggle: () => multicamViewStore.setState((v) => ({ showPreview: !v.showPreview })),
						},
						{
							type: 'toggle',
							label: 'Show Camera Names',
							checked: mcState.showNames,
							onToggle: () => multicamViewStore.setState((v) => ({ showNames: !v.showNames })),
						},
						{
							type: 'toggle',
							label: 'Multi-Camera Selection Top Down',
							checked: mcState.topDown,
							onToggle: () => multicamViewStore.setState((v) => ({ topDown: !v.topDown })),
						},
						{
							type: 'toggle',
							label: 'Multi-Camera Audio Follows Video',
							checked: mcState.audioFollowsVideo,
							onToggle: () =>
								multicamViewStore.setState((v) => ({ audioFollowsVideo: !v.audioFollowsVideo })),
						},
						...(['auto', 2, 3, 4] as const).map((l) => ({
							type: 'toggle' as const,
							label: `Multi-Camera Layout: ${l === 'auto' ? 'Automatic' : `${l}×${l}`}`,
							checked: mcState.layout === l,
							onToggle: () => multicamViewStore.setState({ layout: l, page: 0 }),
						})),
						{
							type: 'toggle',
							label: 'Edit Cameras…',
							checked: false,
							onToggle: () => run('multicam.editCameras'),
						},
					]}
				/>
				<span
					className="pr-tabular text-[length:var(--pr-font-size-monitor-tc)] text-pr-text"
					data-testid="program-duration"
					style={{ fontVariantNumeric: 'tabular-nums' }}
				>
					{durationLabel(format, end, seq.inPoint, seq.outPoint)}
				</span>
			</div>
			<MiniRuler
				transport={transport}
				duration={end}
				markIn={seq.inPoint}
				markOut={seq.outPoint}
				markers={markers}
				fps={fps}
				onSeek={seek}
				testId="program-ruler"
			/>
			<TransportBar monitor="program" ctx={barCtx} playing={playing} testId="program-transport" />
			{/* Portaled: the dock's split views clip and stack their panels' fixed descendants. */}
			{layerMenu
				? createPortal(
						<ContextMenu
							x={layerMenu.x}
							y={layerMenu.y}
							testId="program-context-menu"
							items={programLayerMenu(
								menuCtx(),
								(layerMenu.clipId && session.getCommitted().sequences[seq.id]?.clips[layerMenu.clipId]) ||
									null,
								(id, args) => void runCommand(id, menuCtx(), args),
							)}
							onClose={() => setLayerMenu(null)}
						/>,
						document.body,
					)
				: null}
		</div>
	);
}

type LiveValue = { doc: RenderDoc; options: RenderOptions } | null;
type LiveProps = { get(): LiveValue; set(v: LiveValue): void; subscribe(cb: () => void): () => void };

/** The Program monitor's document and render options, for the Player's composition (`LiveSequenceComposition`). */
function liveProps(initial: LiveValue): LiveProps {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		set: (v) => {
			if (v === value || (v && value && v.doc === value.doc && v.options === value.options)) return;
			value = v;
			for (const cb of [...listeners]) cb();
		},
		subscribe: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	};
}

/** The Program monitor's composition: SequenceComposition with the document of `live` (stable Player props). */
function LiveSequenceComposition({ live }: { live: LiveProps }) {
	const v = useSyncExternalStore(live.subscribe, live.get, live.get);
	return v ? <SequenceComposition doc={v.doc} options={v.options} /> : null;
}

/**
 * The buffering indicator: the Player buffering, or the audio holding the picture at a primed start (`useAudioStartWait`).
 * Its own component: a monitor re-render while the Player starts (the wait ending) disturbed Remotion's start.
 */
function BufferingDot({
	graph,
	buffering,
	playing,
}: {
	graph: MixGraph | null;
	buffering: boolean;
	playing: boolean;
}) {
	const audioWait = useAudioStartWait(graph);
	return (buffering || audioWait) && playing ? (
		<span
			className="pointer-events-none absolute top-2 left-2 size-2 rounded-full bg-pr-warning"
			title="Buffering"
			data-testid="program-buffering"
		/>
	) : null;
}
