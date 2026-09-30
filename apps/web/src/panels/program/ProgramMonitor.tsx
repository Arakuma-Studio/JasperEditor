// Program monitor (S03 §6, S05 §16.3): plays the active sequence in the Remotion Player with our own
// transport, zoom/pan, overlays and on-canvas transform. The Player is sized at the composition size
// and scaled by one CSS transform (S03:PGM-002) so overlays share its geometry exactly.

import type { FontCatalog } from '@jasper/api';
import {
	DEFAULT_RENDER_OPTIONS,
	type RenderDoc,
	type RenderOptions,
	SequenceComposition,
} from '@jasper/compositions';
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState, useStoreSelector } from '@jasper/session/react';
import { Player, type PlayerRef } from '@remotion/player';
import {
	ArrowLeftToLine,
	ArrowRightToLine,
	ArrowUpFromLine,
	Bookmark,
	Play,
	Scissors,
	Square,
	StepBack,
	StepForward,
} from 'lucide-react';
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { runCommand } from '../../commands/index.ts';
import { useEngine } from '../../state/engine.tsx';
import type { PanelProps } from '../types.ts';
import { addMarkerAt, liftOrExtract, setSequenceMark } from './edits.ts';
import {
	durationLabel,
	MiniRuler,
	MonitorSelect,
	SettingsMenu,
	TimecodeDisplay,
	type TimecodeFormat,
	TransportButton,
	useTransportPlaying,
} from './MonitorChrome.tsx';
import { checkerboard } from './monitor.tokens.ts';
import {
	handleMonitorKey,
	monitorPanelServices,
	runWithFallback,
	useMonitorCommandCtx,
} from './monitor-commands.ts';
import {
	monitorStores,
	PLAYBACK_RESOLUTIONS,
	type PlaybackResolution,
	resolutionToProxy,
} from './monitor-store.ts';
import { PlaybackDriver } from './playback-driver.ts';
import { buildProgramDoc, playerDurationFrames, usesProxies } from './render-doc.ts';
import { TransformOverlay } from './TransformOverlay.tsx';
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

function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, Size] {
	const ref = useRef<T>(null);
	const [size, setSize] = useState<Size>({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () =>
			setSize((s) =>
				s.width === el.clientWidth && s.height === el.clientHeight
					? s
					: { width: el.clientWidth, height: el.clientHeight },
			);
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, size];
}

/** The engine client when an EngineProvider is mounted (tests and Storybook-like hosts may omit it). */
export function useOptionalEngineClient(): EngineClient | null {
	try {
		// biome-ignore lint/correctness/useHookAtTopLevel: always called; only the missing-provider throw is caught
		return useEngine().client;
	} catch {
		return null;
	}
}

function useFontCatalog(engine: EngineClient | null): FontCatalog | null {
	const [catalog, setCatalog] = useState<FontCatalog | null>(null);
	useEffect(() => {
		if (!engine) return;
		let cancelled = false;
		engine
			.listFonts()
			.then((c) => !cancelled && setCatalog(c))
			.catch(() => undefined); // engine without the fonts route: text uses the fallback stack
		return () => {
			cancelled = true;
		};
	}, [engine]);
	return catalog;
}

function ProgramMonitorBody({ session, instanceId }: { session: EditorSession; instanceId: string }) {
	const engine = useOptionalEngineClient();
	const transport = session.transport;
	const seqId = useSessionState((s) => s.activeSequenceId);
	const drawn = useSessionState((s) => s.transient ?? s.document);
	const media = useSessionState((s) => s.media);
	const useProxies = useSessionState((s) => s.toggles.useProxies);
	const monitor = useStoreSelector(monitorStores.program, (s) => s);
	const fontCatalog = useFontCatalog(engine);
	const seq = seqId ? drawn.sequences[seqId] : undefined;
	const prevDoc = useRef<RenderDoc | null>(null);
	const tier = resolutionToProxy(monitor.playbackResolution).tier;
	const doc = useMemo(() => {
		if (!seqId || !seq) return null;
		const d = buildProgramDoc(
			{ doc: drawn, sequenceId: seqId, media, useProxies, proxyTier: tier, fontCatalog },
			prevDoc.current,
		);
		prevDoc.current = d;
		return d;
	}, [drawn, seqId, seq, media, useProxies, tier, fontCatalog]);
	const transparent = (seq?.settings.backgroundColor[3] ?? 1) === 0;
	const options = useMemo<RenderOptions>(
		() => ({ ...DEFAULT_RENDER_OPTIONS, isPreview: true, useProxies, transparentBackground: transparent }),
		[useProxies, transparent],
	);
	const inputProps = useMemo(() => (doc ? { doc, options } : null), [doc, options]);
	const duration = seqId ? playerDurationFrames(drawn, seqId) : 1;
	const end = seq ? Math.max(0, duration - 1) : 0;
	const fps = seq ? seq.settings.frameRate.num / seq.settings.frameRate.den : 30;
	const fw = seq?.settings.width ?? 1920;
	const fh = seq?.settings.height ?? 1080;
	const frameSize = useMemo<Size>(() => ({ width: fw, height: fh }), [fw, fh]);
	const [viewportRef, viewport] = useElementSize<HTMLDivElement>();
	const view = computeView(viewport, frameSize, monitor.zoom, monitor.pan);
	const ctx = useMonitorCommandCtx({ session, panel: 'program', instanceId, engine });

	// ------------------------------------------------------------------ Player ↔ TransportStore (ARC-010)
	const live = useRef({ seq, end, fps });
	live.current = { seq, end, fps };
	const [playerRate, setPlayerRate] = useState(1);
	const [buffering, setBuffering] = useState(false);
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
				setPlayerRate: (r) => setPlayerRate(r),
				onBuffering: setBuffering,
			}),
		[transport],
	);
	useEffect(() => {
		const detach = transport.attachPlayer(driver);
		const unregister = registerDriver(transport, driver);
		return () => {
			detach();
			unregister();
			driver.dispose();
		};
	}, [transport, driver]);
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

	// ------------------------------------------------------------------ zoom / pan (PGM-010…015)
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

	// ------------------------------------------------------------------ chrome
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
				color: `var(--pr-label-${m.color})`,
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
	const frameNow = () => transport.getState().frame;
	const proxyChip = doc ? usesProxies(doc, options) : false;
	const playerStyle = useMemo<CSSProperties>(
		() => ({ width: frameSize.width, height: frameSize.height }),
		[frameSize.width, frameSize.height],
	);

	if (!seq || !doc || !inputProps) {
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
				className="relative min-h-0 flex-1 overflow-hidden"
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
					<Player
						ref={playerRef}
						component={SequenceComposition}
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
				</div>
				<TransformOverlay
					session={session}
					doc={doc}
					view={view}
					viewport={viewport}
					transport={transport}
					monitor={monitor}
					onPan={setPan}
				/>
				{proxyChip ? (
					<span
						className="pointer-events-none absolute top-2 right-2 rounded-pr-control bg-pr-raised px-1.5 text-pr-small text-pr-strong"
						data-testid="program-proxy-chip"
					>
						PROXY
					</span>
				) : null}
				{buffering && playing ? (
					<span
						className="pointer-events-none absolute top-2 left-2 size-2 rounded-full bg-pr-warning"
						title="Buffering"
						data-testid="program-buffering"
					/>
				) : null}
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
			<div
				className="flex h-[36px] shrink-0 flex-wrap items-center justify-center gap-0.5 overflow-hidden px-2"
				data-testid="program-transport"
			>
				<TransportButton
					label="Add Marker"
					shortcut="M"
					testId="btn-add-marker"
					onClick={() =>
						void runWithFallback('timeline.addMarker', ctx, () => addMarkerAt(session, frameNow()))
					}
				>
					<Bookmark size={16} />
				</TransportButton>
				<TransportButton
					label="Mark In"
					shortcut="I"
					testId="btn-mark-in"
					onClick={() =>
						void runWithFallback('timeline.markIn', ctx, () => setSequenceMark(session, 'in', frameNow()))
					}
				>
					<span className="font-pr text-[15px] leading-none">{'{'}</span>
				</TransportButton>
				<TransportButton
					label="Mark Out"
					shortcut="O"
					testId="btn-mark-out"
					onClick={() =>
						void runWithFallback('timeline.markOut', ctx, () => setSequenceMark(session, 'out', frameNow()))
					}
				>
					<span className="font-pr text-[15px] leading-none">{'}'}</span>
				</TransportButton>
				<TransportButton
					label="Go to In"
					shortcut="Shift+I"
					testId="btn-go-in"
					onClick={() => void runWithFallback('timeline.goToIn', ctx, () => seek(seq.inPoint ?? 0))}
				>
					<ArrowLeftToLine size={16} />
				</TransportButton>
				<TransportButton
					label="Step Back 1 Frame"
					shortcut="Left"
					testId="btn-step-back"
					onClick={() => run('transport.stepBack')}
				>
					<StepBack size={16} />
				</TransportButton>
				<TransportButton
					label={playing ? 'Stop' : 'Play'}
					shortcut="Space"
					testId="btn-play"
					active={playing}
					onClick={() => run('transport.playStop')}
				>
					{playing ? <Square size={14} /> : <Play size={16} />}
				</TransportButton>
				<TransportButton
					label="Step Forward 1 Frame"
					shortcut="Right"
					testId="btn-step-forward"
					onClick={() => run('transport.stepForward')}
				>
					<StepForward size={16} />
				</TransportButton>
				<TransportButton
					label="Go to Out"
					shortcut="Shift+O"
					testId="btn-go-out"
					onClick={() =>
						void runWithFallback('timeline.goToOut', ctx, () =>
							seek(seq.outPoint !== null ? seq.outPoint - 1 : end),
						)
					}
				>
					<ArrowRightToLine size={16} />
				</TransportButton>
				<TransportButton
					label="Lift"
					shortcut=";"
					testId="btn-lift"
					onClick={() =>
						void runWithFallback('timeline.lift', ctx, () => reportEdit(liftOrExtract(session, 'lift')))
					}
				>
					<ArrowUpFromLine size={16} />
				</TransportButton>
				<TransportButton
					label="Extract"
					shortcut="'"
					testId="btn-extract"
					onClick={() =>
						void runWithFallback('timeline.extract', ctx, () => reportEdit(liftOrExtract(session, 'extract')))
					}
				>
					<Scissors size={16} />
				</TransportButton>
				{/* Export Frame (PGM-006) stays hidden until the engine stills route exists (WP-2F). */}
			</div>
		</div>
	);
}

function reportEdit(r: { ok: boolean; message?: string }) {
	if (!r.ok) console.info(`[program] ${r.message ?? 'edit failed'}`);
}
