// Source monitor (S03 §7, S05:PGM-010): previews one project item with AssetComposition in its own
// Player and its own TransportStore, sets In/Out marks on the item (document, undoable) and hands edits
// to the timeline with Insert (,) / Overwrite (.) via `clip.place`.
import {
	AssetComposition,
	type AssetCompositionProps,
	assetCanvas,
	assetDurationFrames,
	type RenderDoc,
	SequenceComposition,
} from '@jasper/compositions';
import { type Sequence, SYNTHETIC_INFO, sequenceDuration } from '@jasper/project';
import { type EditorSession, TransportStore } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { Player, type PlayerRef } from '@remotion/player';
import { X } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chordFromEvent, runCommand } from '../../commands/index.ts';
import { registerFullscreenTarget } from '../../commands/monitor-view.ts';
import { useEngineOrNull } from '../../state/engine.tsx';
import {
	durationLabel,
	MiniRuler,
	MonitorSelect,
	SettingsMenu,
	TimecodeDisplay,
	type TimecodeFormat,
	useElementSize,
	useTransportPlaying,
} from '../program/MonitorChrome.tsx';
import { checkerboard } from '../program/monitor.tokens.ts';
import { detectPlatform, handleMonitorKey, useMonitorCommandCtx } from '../program/monitor-commands.ts';
import { monitorStores } from '../program/monitor-store.ts';
import { PlaybackDriver } from '../program/playback-driver.ts';
import { buildProgramDoc, resolveMediaHandle } from '../program/render-doc.ts';
import { TransportBar } from '../program/TransportBar.tsx';
import { registerDriver, setSourceTransport } from '../program/transport-registry.ts';
import { computeView, ZOOM_PRESETS } from '../program/viewport.ts';
import { markerVar } from '../timeline/components/ClipView.tsx';
import type { PanelProps } from '../types.ts';
import {
	assetFps,
	closeSource,
	flicksToSourceFrames,
	openInSource,
	setSourceMarks,
	sourceAsset,
	sourceItem,
	sourceMonitorState,
	syntheticPreviewDoc,
} from './source-state.ts';

export function SourceMonitor(props: PanelProps) {
	const session = useSessionOrNull();
	if (!session) {
		return (
			<div
				className="flex h-full items-center justify-center text-pr-small text-pr-muted"
				data-panel-kind="source"
			>
				No project open
			</div>
		);
	}
	return <SourceMonitorBody session={session} instanceId={props.instanceId} />;
}

function SourceMonitorBody({ session, instanceId }: { session: EditorSession; instanceId: string }) {
	const engine = useEngineOrNull()?.client ?? null;
	const src = useStoreSelector(sourceMonitorState, (s) => s);
	const doc = useStoreSelector(session.store, (s) => s.document);
	const media = useStoreSelector(session.store, (s) => s.media);
	const useProxies = useStoreSelector(session.store, (s) => s.toggles.useProxies);
	const seqRate = useStoreSelector(session.store, (s) => {
		const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
		return seq?.settings.frameRate;
	}) ?? { num: 30, den: 1 };
	const monitor = useStoreSelector(monitorStores.source, (s) => s);
	const item = sourceItem(doc, src.itemId);
	const asset = sourceAsset(doc, item);
	// wp-multicam: source clip markers of a media item (sync points of Merge Clips / multi-camera).
	const itemMarkerList = (item as { markers?: { id: string; flicks: number; color: string }[] } | null)
		?.markers;
	const handle = useMemo(() => (asset ? resolveMediaHandle(asset, media[asset.id]) : null), [asset, media]);
	// edit-structure: sequences and synthetic sources are drawn by the sequence composition.
	const activeSettings = useStoreSelector(session.store, (s) => {
		const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
		return seq?.settings ?? Object.values(s.document.sequences)[0]?.settings;
	});
	const seqDoc = useMemo<{ doc: RenderDoc; fps: number; frames: number; w: number; h: number } | null>(() => {
		if (item?.kind === 'sequence') {
			const sq = doc.sequences[item.sequenceId] as Sequence | undefined;
			if (!sq) return null;
			const r = sq.settings.frameRate;
			return {
				doc: buildProgramDoc({ doc, sequenceId: sq.id, media }, null),
				fps: r.num / r.den,
				frames: Math.max(1, sequenceDuration(sq)),
				w: sq.settings.width,
				h: sq.settings.height,
			};
		}
		if (item?.kind === 'synthetic' && activeSettings) {
			const syn = doc.synthetics[item.syntheticId];
			const r = activeSettings.frameRate;
			const fpsN = r.num / r.den;
			const secs = syn ? (SYNTHETIC_INFO[syn.kind].defaultSeconds ?? 10) : 10;
			const frames = Math.max(1, Math.round(Math.max(secs, 10) * fpsN));
			const d = syntheticPreviewDoc(doc, item, activeSettings, frames);
			return d ? { doc: d, fps: fpsN, frames, w: activeSettings.width, h: activeSettings.height } : null;
		}
		return null;
	}, [item, doc, media, activeSettings]);
	const fps = seqDoc ? seqDoc.fps : assetFps(asset, seqRate.num / seqRate.den);
	const props = useMemo<AssetCompositionProps | null>(
		() => (handle ? { asset: handle, fps, name: item?.name, useProxies } : null),
		[handle, fps, item?.name, useProxies],
	);
	const seqProps = useMemo(
		() =>
			seqDoc
				? { doc: seqDoc.doc, options: { isPreview: true, useProxies, transparentBackground: false } }
				: null,
		[seqDoc, useProxies],
	);
	const duration = seqDoc ? seqDoc.frames : props ? assetDurationFrames(props) : 1;
	const canvas = seqDoc
		? { width: seqDoc.w, height: seqDoc.h }
		: handle
			? assetCanvas(handle)
			: { width: 1280, height: 720 };
	const transport = useMemo(() => new TransportStore(), []);
	const ctx = useMonitorCommandCtx({ session, panel: 'source', instanceId, engine });
	useEffect(() => registerFullscreenTarget('source', () => viewportRef.current));
	const [viewportRef, viewport] = useElementSize<HTMLDivElement>();
	const view = computeView(viewport, canvas, monitor.zoom, [0, 0]);

	// Mirror marks (document, flicks) → source frames for the transport commands.
	const seqItem = item?.kind === 'sequence' ? doc.sequences[item.sequenceId] : undefined;
	const marks = item && item.kind !== 'sequence' ? item.marks : null;
	const sourceMarkers = useMemo(
		() =>
			(itemMarkerList ?? []).map((m) => ({
				id: m.id,
				frame: flicksToSourceFrames(m.flicks, fps),
				color: `var(--pr-marker-${markerVar(m.color as never)})`,
			})),
		[itemMarkerList, fps],
	);
	// edit-ux: a subclip without marks shows its own range as In/Out.
	const sub = item?.kind === 'subclip' ? item : null;
	const markIn = seqItem
		? seqItem.inPoint
		: marks?.in
			? flicksToSourceFrames(marks.in.flicks, fps)
			: sub
				? flicksToSourceFrames(sub.range.in, fps)
				: null;
	const markOut = seqItem
		? seqItem.outPoint
		: marks?.out
			? flicksToSourceFrames(marks.out.flicks, fps)
			: sub
				? flicksToSourceFrames(sub.range.out, fps)
				: null;
	// edit-ux (Mark Split): the video/audio marks on the mini ruler.
	const split = (marks as { split?: Record<string, { flicks: number } | null | undefined> } | null)?.split;
	const splitMarkers = useMemo(
		() =>
			Object.entries(split ?? {})
				.filter((e): e is [string, { flicks: number }] => !!e[1])
				.map(([k, v]) => ({
					id: `split-${k}`,
					frame: flicksToSourceFrames(v.flicks, fps) - (k.endsWith('Out') ? 1 : 0),
					color: k.startsWith('video') ? 'var(--pr-trim-regular)' : 'var(--pr-trim-ripple)',
				})),
		[split, fps],
	);
	useEffect(() => {
		sourceMonitorState.setState({ fps, durationFrames: duration, markIn, markOut });
		transport.setMaxFrame(Math.max(0, duration - 1));
	}, [fps, duration, markIn, markOut, transport]);

	// Local transport ↔ Player.
	const live = useRef({ duration, markIn, markOut, fps });
	live.current = { duration, markIn, markOut, fps };
	const [rate, setRate] = useState(1);
	const driver = useMemo(
		() =>
			new PlaybackDriver({
				transport,
				getFps: () => live.current.fps,
				getRange: () => {
					const end = Math.max(0, live.current.duration - 1);
					return { end, loopStart: live.current.markIn ?? 0, loopEnd: live.current.markOut ?? end };
				},
				setPlayerRate: setRate,
			}),
		[transport],
	);
	useEffect(() => {
		const detach = transport.attachPlayer(driver);
		const unregister = registerDriver(transport, driver);
		setSourceTransport(transport);
		return () => {
			detach();
			unregister();
			setSourceTransport(null);
			driver.dispose();
		};
	}, [transport, driver]);
	const playerRef = useCallback((p: PlayerRef | null) => driver.setPlayer(p), [driver]);
	// A new item starts at its In mark (or 0).
	const itemId = src.itemId;
	useEffect(() => {
		void itemId;
		transport.pause();
		transport.seek(live.current.markIn ?? 0);
	}, [itemId, transport]);

	const playing = useTransportPlaying(transport);
	const vs = asset?.kind === 'video' ? asset.probe.streams.find((st) => st.type === 'video') : undefined;
	const ownRate = seqItem?.settings.frameRate ?? null;
	const rateNum = ownRate ? ownRate.num : vs?.type === 'video' ? vs.frameRate.num : seqRate.num;
	const rateDen = ownRate ? ownRate.den : vs?.type === 'video' ? vs.frameRate.den : seqRate.den;
	const format: TimecodeFormat = useMemo(
		() => ({ rate: { num: rateNum, den: rateDen }, dropFrame: false }),
		[rateNum, rateDen],
	);
	const seek = (f: number) => {
		if (transport.getState().playing) transport.pause();
		transport.seek(Math.max(0, Math.min(duration - 1, f)));
	};
	const frameNow = () => transport.getState().frame;
	// edit-ux: through the commands (three/four-point editing, Fit Clip dialog, toasts).
	const _edit = (mode: 'insert' | 'overwrite') =>
		void runCommand(mode === 'insert' ? 'timeline.insertFromSource' : 'timeline.overwriteFromSource', ctx);
	const mediaItems = useMemo(
		() =>
			Object.values(doc.items)
				.filter(
					(it) =>
						it.kind === 'media' || it.kind === 'synthetic' || it.kind === 'sequence' || it.kind === 'subclip',
				)
				.map((it) => ({ value: it.id, label: it.name })),
		[doc.items],
	);
	const playerStyle = useMemo<CSSProperties>(
		() => ({ width: canvas.width, height: canvas.height }),
		[canvas.width, canvas.height],
	);

	const onKey = (e: React.KeyboardEvent, phase: 'down' | 'up') => {
		if (phase === 'down' && !e.defaultPrevented && item) {
			// Marks in Source act on the item, whatever timeline.* commands do (S03:SRC-003).
			const chord = chordFromEvent(e.nativeEvent, detectPlatform());
			const local: Record<string, () => void> = {
				KeyI: () => setSourceMarks(session, { in: frameNow() }, 'Mark In'),
				KeyO: () => setSourceMarks(session, { out: frameNow() + 1 }, 'Mark Out'),
				'Shift+KeyI': () => seek(markIn ?? 0),
				'Shift+KeyO': () => seek(markOut !== null ? markOut - 1 : duration - 1),
				'Alt+KeyI': () => setSourceMarks(session, { in: null }, 'Clear In'),
				'Alt+KeyO': () => setSourceMarks(session, { out: null }, 'Clear Out'),
				'Ctrl+Shift+KeyI': () => setSourceMarks(session, { in: null }, 'Clear In'),
				'Ctrl+Shift+KeyO': () => setSourceMarks(session, { out: null }, 'Clear Out'),
				'Ctrl+Shift+KeyX': () => setSourceMarks(session, { in: null, out: null }, 'Clear In and Out'),
			};
			const fn = local[chord];
			if (fn) {
				e.preventDefault();
				fn();
				return;
			}
		}
		handleMonitorKey(e.nativeEvent, phase, ctx, 'source');
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the monitor is a keyboard scope (S05:KB-002)
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel outline-none"
			data-panel-kind="source"
			data-testid="source-monitor"
			tabIndex={-1}
			onKeyDown={(e) => onKey(e, 'down')}
			onKeyUp={(e) => onKey(e, 'up')}
		>
			<div className="flex h-[24px] shrink-0 items-center gap-2 border-b border-pr-border-subtle px-2">
				<MonitorSelect
					label="Open in Source"
					value={src.itemId ?? ''}
					options={[{ value: '', label: 'Choose a clip…' }, ...mediaItems]}
					testId="source-item"
					onChange={(id) => id && openInSource(session, id)}
				/>
				{src.itemId ? (
					<button
						type="button"
						aria-label="Close"
						title="Close"
						className="inline-flex size-[20px] items-center justify-center rounded-pr-control text-pr-icon hover:bg-pr-hover"
						onClick={() => closeSource()}
					>
						<X size={12} />
					</button>
				) : null}
			</div>
			<div
				ref={viewportRef}
				className="relative min-h-0 flex-1 overflow-hidden"
				data-testid="source-viewport"
			>
				{!props && !seqProps ? (
					<div className="absolute inset-0 flex items-center justify-center px-4 text-center text-pr-small text-pr-muted">
						{item && !handle
							? 'Media Offline'
							: 'Open a clip from the Project panel (double-click) or choose one above.'}
					</div>
				) : (
					<>
						{monitor.transparencyGrid ? (
							<div
								className="pointer-events-none absolute"
								style={{
									left: view.x,
									top: view.y,
									width: canvas.width * view.scale,
									height: canvas.height * view.scale,
									...checkerboard(),
								}}
							/>
						) : null}
						<div
							className="absolute top-0 left-0"
							style={{
								width: canvas.width,
								height: canvas.height,
								transformOrigin: '0 0',
								transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
							}}
						>
							{seqProps ? (
								<Player
									key={src.itemId ?? ''}
									ref={playerRef}
									component={SequenceComposition}
									inputProps={seqProps}
									durationInFrames={duration}
									compositionWidth={canvas.width}
									compositionHeight={canvas.height}
									fps={fps}
									style={playerStyle}
									controls={false}
									clickToPlay={false}
									doubleClickToFullscreen={false}
									spaceKeyToPlayOrPause={false}
									moveToBeginningWhenEnded={false}
									playbackRate={rate}
									acknowledgeRemotionLicense
								/>
							) : (
								<Player
									key={src.itemId ?? ''}
									ref={playerRef}
									component={AssetComposition}
									inputProps={props!}
									durationInFrames={duration}
									compositionWidth={canvas.width}
									compositionHeight={canvas.height}
									fps={fps}
									style={playerStyle}
									controls={false}
									clickToPlay={false}
									doubleClickToFullscreen={false}
									spaceKeyToPlayOrPause={false}
									moveToBeginningWhenEnded={false}
									playbackRate={rate}
									acknowledgeRemotionLicense
								/>
							)}
						</div>
					</>
				)}
			</div>
			<div className="flex h-[28px] shrink-0 items-center gap-2 px-2">
				<TimecodeDisplay transport={transport} format={format} onSeek={seek} testId="source-timecode" />
				<MonitorSelect
					label="Select Zoom Level"
					value={monitor.zoom}
					options={[
						{ value: 'fit' as const, label: 'Fit' },
						...ZOOM_PRESETS.map((z) => ({ value: z, label: `${z}%` })),
					]}
					onChange={(z) => monitorStores.source.setState({ zoom: z })}
				/>
				<div className="flex-1" />
				<SettingsMenu
					items={[
						{
							type: 'toggle',
							label: 'Transparency Grid',
							checked: monitor.transparencyGrid,
							onToggle: () =>
								monitorStores.source.setState((s) => ({ transparencyGrid: !s.transparencyGrid })),
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
					data-testid="source-duration"
					style={{ fontVariantNumeric: 'tabular-nums' }}
				>
					{/* No clip loaded: show a zero duration, not the 1-frame placeholder length. */}
					{durationLabel(format, props || seqProps ? duration : 0, markIn, markOut)}
				</span>
			</div>
			<MiniRuler
				transport={transport}
				duration={duration}
				markIn={markIn}
				markOut={markOut}
				markers={splitMarkers.length ? [...sourceMarkers, ...splitMarkers] : sourceMarkers}
				fps={fps}
				onSeek={seek}
				testId="source-ruler"
			/>
			{/* edit-ux: data-driven transport row with the Button Editor. */}
			<TransportBar
				monitor="source"
				ctx={() => ctx}
				playing={playing}
				testId="source-transport"
				disabled={(btn) => !item || (btn.id === 'play' && !props && !seqProps)}
			/>
		</div>
	);
}
