// Composition clip layer (M2, S08:MGC-020…025, MGC-033).
// Renders (isPreview false, engine): the pre-rendered ProRes 4444 master through <OffthreadVideo transparent>
// (`prerender.masterUrl`, a signed URL the engine puts in the snapshot). Preview (Player), in order of
// preference: the cached VP9-alpha preview of the clip's current props (played like a media layer: exact
// timing, cheap), else the live frame host — the bundle's own Remotion page in a sandboxed <iframe> (opaque
// origin, security review MG-1), driven frame by frame through the renderer-page protocol by the page's host agent
// (mg-host/agent.ts) over a MessagePort (mg-host/remote.ts). Effects, Motion, opacity and blend apply
// through LayerBox like for any layer; colour effects need pixels, so they wait for the preview WebM
// ("Grade pending", MGC-025).
// HTML compositions (`bundle.html`): the live host is the page itself, driven with `window.__seek` by the HTML host
// agent (mg-host/html-agent.ts) over the same port API; renders and previews are the engine's masters as above.
// fx framework: GPU shader effects run on the master (renders) and on the preview WebM (`FxPicture`, fed by
// the same media elements); the live host (an iframe) cannot be captured, so they wait for the preview like colour
// effects do ("Grade pending").

import {
	defaultEffectRegistry,
	FLICKS_PER_SECOND,
	gaussianBlurRepeatsEdge,
	type RenderCompositionSource,
	type RenderVisualClip,
} from '@jasper/project';
import { Video } from '@remotion/media';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { OffthreadVideo, Sequence } from 'remotion';
import { FxPicture } from '../fx/FxPicture.tsx';
import { FxVideoSources } from '../fx/sources.tsx';
import { useLayerFx } from '../fx/stage.ts';
import { bundleServeUrl, hostPageUrl, htmlHostPageUrl, MG_HOST_SANDBOX } from '../mg-host/protocol.ts';
import { connectMgHost, type MgHostRemote } from '../mg-host/remote.ts';
import { type CompositionPreviewRuntime, useCompositionPreviewRuntime } from '../mg-host/runtime.ts';
import type { LayerProps } from '../types.ts';
import { GradeChip, LayerBox } from './LayerBox.tsx';

const FILL: CSSProperties = { width: '100%', height: '100%', display: 'block' };

/** Composition frame (at the sequence rate) shown at content time `t` (flicks). */
export function compositionFrameOf(contentTime: number, fps: number): number {
	return Math.floor((contentTime * fps) / FLICKS_PER_SECOND + 1e-6);
}

/** Length of the composition at the sequence rate (renders and previews run at it, MGC-005). */
export function compositionFramesAt(info: { fps: number; durationInFrames: number }, fps: number): number {
	return Math.abs(info.fps - fps) > 1e-3
		? Math.max(1, Math.round((info.durationInFrames * fps) / info.fps))
		: info.durationInFrames;
}

/** The clip carries effects that read pixels (colour ops, S06): they wait for the preview WebM. */
export function hasPixelEffects(clip: RenderVisualClip): boolean {
	return clip.effects.some((fx) => {
		if (!fx.enabled) return false;
		const spec = defaultEffectRegistry.get(fx.effectId, fx.effectVersion);
		return !!spec?.color || !!spec?.gpu || gaussianBlurRepeatsEdge(fx);
	});
}

export function CompositionLayer(layer: LayerProps) {
	const { clip, options } = layer;
	const src = 'composition' in clip.source ? clip.source.composition : null;
	if (!src?.bundle)
		return <Offline layer={layer} code="MG_BUNDLE_MISSING" title="Composition bundle missing" />;
	if (src.info === null || src.info === undefined)
		return (
			<Offline
				layer={layer}
				code="MG_COMPOSITION_MISSING"
				title={`Composition ${src.compositionId} not in bundle`}
			/>
		);
	if (!options.isPreview) return <MasterLayer layer={layer} src={src} />;
	return <PreviewLayer layer={layer} src={src} />;
}

/**
 * AGENTS §4: the offline card is the Program monitor's (preview) only. A render (`isPreview: false`: exports, stills,
 * bakes) never encodes it in place of the composition: it fails with the reason. The export planner refuses such
 * clips before rendering (MG_BUNDLE_MISSING / MG_COMPOSITION_MISSING) and renders missing masters first; this catches
 * whatever still reaches a render without its master.
 */
function Offline({ layer, code, title }: { layer: LayerProps; code: string; title: string }) {
	if (!layer.options.isPreview)
		throw new Error(`${code}: ${title} (composition clip "${layer.clip.name}", ${layer.clip.clipId})`);
	return <CompositionCard layer={layer} title={title} />;
}

/** Engine renders: the master (frame 0 = sequence frame `prerender.startFrame`). */
function MasterLayer({ layer, src }: { layer: LayerProps; src: RenderCompositionSource }) {
	const { clip } = layer;
	const fx = useLayerFx(layer);
	const url = src.prerender?.masterUrl;
	if (!url) return <Offline layer={layer} code="MG_RENDER_FAILED" title="Composition master not rendered" />;
	const layerStart = clip.start - (clip.headHandle ?? 0);
	const offset = (src.prerender?.startFrame ?? layerStart) - layerStart;
	if (fx.mode === 'active')
		return (
			<LayerBox layer={layer} effects={fx.cssEffects} masksInChain>
				<FxPicture stage={fx.stage}>
					<Sequence from={offset} layout="none" name="Composition master">
						<FxVideoSources
							layer={layer}
							stage={fx.stage}
							src={url}
							trimBefore={0}
							playbackRate={1}
							freezeBase={-offset}
							offthread={{ transparent: true }}
						/>
					</Sequence>
				</FxPicture>
			</LayerBox>
		);
	return (
		<LayerBox layer={layer}>
			<Sequence from={offset} layout="none" name="Composition master">
				<OffthreadVideo src={url} transparent muted style={FILL} showInTimeline={false} />
			</Sequence>
		</LayerBox>
	);
}

function PreviewLayer({ layer, src }: { layer: LayerProps; src: RenderCompositionSource }) {
	const { clip, fps } = layer;
	const runtime = useCompositionPreviewRuntime();
	const preview = runtime?.previewFor(clip, src, fps) ?? null;
	const pixelFx = hasPixelEffects(clip);
	const fx = useLayerFx(layer);
	// The preview covers composition frames `startFrame…`; the clip's Sequence starts at the frame shown at
	// `start − headHandle`.
	const first = compositionFrameOf(clip.sourceIn, fps) - (clip.headHandle ?? 0);
	const trim = preview ? first - preview.startFrame : 0;
	if (preview && fx.mode === 'active')
		return (
			<LayerBox
				layer={layer}
				effects={fx.cssEffects}
				masksInChain
				overlay={fx.chip ? <GradeChip layer={layer} text={fx.chip} /> : null}
			>
				<FxPicture stage={fx.stage}>
					<Sequence key="preview" from={trim < 0 ? -trim : 0} layout="none" name="Composition preview">
						<FxVideoSources
							layer={layer}
							stage={fx.stage}
							src={preview.url}
							trimBefore={Math.max(0, trim)}
							playbackRate={1}
							freezeBase={trim < 0 ? trim : 0}
						/>
					</Sequence>
				</FxPicture>
			</LayerBox>
		);
	// One LayerBox for both: while the preview plays, the live host stays loaded (hidden, idle) so a props edit
	// switches back to it without reloading the page (MGC-022: edits show within 300 ms).
	return (
		<LayerBox layer={layer}>
			{preview ? (
				<Sequence key="preview" from={trim < 0 ? -trim : 0} layout="none" name="Composition preview">
					<Video
						src={preview.url}
						trimBefore={Math.max(0, trim)}
						muted
						objectFit="fill"
						style={FILL}
						showInTimeline={false}
					/>
				</Sequence>
			) : null}
			<LiveHost
				key="host"
				layer={layer}
				src={src}
				runtime={runtime}
				hidden={!!preview}
				gradePending={pixelFx && !preview}
			/>
		</LayerBox>
	);
}

type HostState = {
	state: 'loading' | 'rendering' | 'ready' | 'error';
	message?: string;
	/** Composition frame drawn (ready). wp-m3-mgtext: the on-canvas text editor waits for the playhead's. */
	frame?: number;
};

/**
 * The live frame host: one iframe per mounted clip (at most 4 at once, MGC-024), transparent, never
 * interactive. Paused → the exact playhead frame (a subtle spinner until ready); playing → the newest frame
 * the page manages (frames may drop, preview only). Props changes reconfigure the page in place. `hidden`
 * keeps the page loaded but idle (a cached preview is shown instead).
 */
function LiveHost({
	layer,
	src,
	runtime,
	hidden,
	gradePending,
}: {
	layer: LayerProps;
	src: RenderCompositionSource;
	runtime: CompositionPreviewRuntime | null;
	hidden: boolean;
	gradePending: boolean;
}) {
	const { clip, fps, contentTime } = layer;
	const info = src.info!;
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const driverRef = useRef<MgHostRemote | null>(null);
	const want = useRef<{ frame: number; key: string; hidden: boolean } | null>(null);
	const busy = useRef(false);
	const [host, setHost] = useState<HostState>({ state: 'loading' });
	const [acquired, setAcquired] = useState(true);
	const bundleUrl = runtime?.bundleUrl?.(src.bundle!.key ?? '') ?? bundleServeUrl(src.bundle!.key ?? '');
	const total = compositionFramesAt(info, fps);
	const frame = Math.max(0, Math.min(total - 1, compositionFrameOf(contentTime, fps)));
	const config = useMemo(
		() => ({
			compositionId: src.compositionId,
			props: src.props,
			override: { width: src.canvas.width, height: src.canvas.height, fps, durationInFrames: total },
		}),
		[src.compositionId, src.props, src.canvas.width, src.canvas.height, fps, total],
	);
	const configKey = useMemo(() => JSON.stringify(config), [config]);

	// Live host budget (MGC-024). wp-m3-mgtext: runtimes with `hostAllowed` decide per render (a clip being edited
	// on canvas takes a slot, the clip farthest from the playhead gives it up).
	useEffect(() => {
		const release = runtime?.acquireHost?.(clip.clipId);
		if (release === null) {
			setAcquired(false);
			return;
		}
		setAcquired(true);
		return () => release?.();
	}, [runtime, clip.clipId]);
	const allowed = runtime?.hostAllowed ? runtime.hostAllowed(clip.clipId) : acquired;

	// Everything the (stable) pump needs lives in refs: it outlives the render that started it.
	const live = useRef({ config, hidden, report: (_s: HostState) => {} });
	live.current = {
		config,
		hidden,
		report: (s: HostState) => {
			setHost(s);
			runtime?.reportHost?.(clip.clipId, s);
		},
	};

	// Drives the page: configure (props) then seek; always to the newest wanted frame. Idle while hidden.
	const pump = useRef(() => {});
	pump.current = () => {
		if (busy.current) return;
		const driver = driverRef.current;
		const target = want.current;
		if (!driver || !target) return;
		busy.current = true;
		const { config: cfg, report } = live.current;
		if (live.current.hidden) {
			// Warm the hidden page (evaluated + configured) so showing it later only re-applies props.
			void driver
				.configure(cfg)
				.catch(() => undefined)
				.finally(() => {
					busy.current = false;
					if (!live.current.hidden) pump.current();
				});
			return;
		}
		report({ state: 'rendering' });
		void (async () => {
			try {
				await driver.configure(cfg);
				await driver.seek(cfg.compositionId, target.frame);
				if (want.current === target) live.current.report({ state: 'ready', frame: target.frame });
			} catch (e) {
				live.current.report({
					state: 'error',
					message: e instanceof Error ? e.message : String(e),
				});
			} finally {
				busy.current = false;
				if (want.current && want.current !== target) pump.current();
			}
		})();
	};

	useEffect(() => {
		want.current = { frame, key: configKey, hidden };
		pump.current();
	}, [frame, configKey, hidden]);

	// The page has an opaque origin (MG-1), and the browser pauses the rendering of cross-origin frames that are not
	// in the viewport (a Program monitor in a hidden tab group, a scrolled-away panel): a frame asked for meanwhile
	// times out. When the frame comes back into view, a failed request is made again.
	const failed = host.state === 'error';
	useEffect(() => {
		const f = iframeRef.current;
		if (!f || !failed || typeof IntersectionObserver === 'undefined') return;
		const io = new IntersectionObserver((entries) => {
			if (!entries.some((e) => e.isIntersecting) || !want.current) return;
			want.current = { ...want.current };
			pump.current();
		});
		io.observe(f);
		return () => io.disconnect();
	}, [failed]);

	// Security review MG-1: the page is sandboxed (opaque origin). It is driven through its host agent over a
	// MessagePort, connected anew on every load of the page.
	const onLoad = () => {
		const f = iframeRef.current;
		if (!f) return;
		driverRef.current = null;
		connectMgHost(f).then(
			(remote) => {
				if (iframeRef.current !== f) return remote.dispose();
				driverRef.current = remote;
				pump.current();
			},
			(e) => live.current.report({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
		);
	};
	useEffect(
		() => () => {
			driverRef.current?.dispose();
			driverRef.current = null;
		},
		[],
	);

	if (!allowed) return hidden ? null : <IdleCard layer={layer} />;
	return (
		<>
			<iframe
				ref={iframeRef}
				title={`Composition ${src.compositionId}`}
				src={src.bundle?.html ? htmlHostPageUrl(bundleUrl, src.bundle.html) : hostPageUrl(bundleUrl)}
				sandbox={MG_HOST_SANDBOX}
				referrerPolicy="no-referrer"
				onLoad={onLoad}
				data-mg-host={src.compositionId}
				data-mg-host-clip={clip.clipId}
				data-mg-host-state={hidden ? 'idle' : host.state}
				data-mg-host-frame={hidden || host.state !== 'ready' ? undefined : host.frame}
				tabIndex={-1}
				aria-hidden="true"
				style={{
					position: 'absolute',
					left: 0,
					top: 0,
					width: src.canvas.width,
					height: src.canvas.height,
					border: 0,
					background: 'transparent',
					colorScheme: 'light',
					pointerEvents: 'none',
					visibility: hidden ? 'hidden' : 'visible',
				}}
			/>
			{hidden ? null : <HostChips layer={layer} host={host} gradePending={gradePending} />}
		</>
	);
}

/** Over the live-host budget: a hatched placeholder in the layer's box (MGC-024). */
function IdleCard({ layer }: { layer: LayerProps }) {
	const h = layer.props.box.height;
	return (
		<div
			data-mg-card="idle"
			style={{
				position: 'absolute',
				inset: 0,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background:
					'repeating-linear-gradient(45deg, rgba(120,60,160,0.35) 0 14px, rgba(90,40,130,0.35) 14px 28px)',
				color: 'white',
				fontFamily: '"Source Sans 3", Arial, sans-serif',
				fontSize: Math.max(14, h / 14),
			}}
		>
			{layer.clip.name}
		</div>
	);
}

function HostChips({
	layer,
	host,
	gradePending,
}: {
	layer: LayerProps;
	host: HostState;
	gradePending: boolean;
}) {
	const size = Math.max(10, Math.round(layer.props.box.height / 54));
	const chip: CSSProperties = {
		padding: `${size / 4}px ${size / 2}px`,
		borderRadius: size / 3,
		background: 'rgba(20, 20, 20, 0.72)',
		color: 'rgba(255, 255, 255, 0.92)',
		fontFamily: '"Source Sans 3", Arial, sans-serif',
		fontSize: size,
		lineHeight: 1.2,
		whiteSpace: 'nowrap',
	};
	return (
		<div
			style={{
				position: 'absolute',
				right: size / 2,
				top: size / 2,
				display: 'flex',
				gap: size / 3,
				pointerEvents: 'none',
			}}
		>
			{host.state === 'rendering' || host.state === 'loading' ? (
				<div data-mg-host-spinner="" style={{ ...chip, opacity: 0.8 }}>
					<span
						style={{
							display: 'inline-block',
							width: size * 0.8,
							height: size * 0.8,
							border: `${Math.max(1, size / 8)}px solid rgba(255,255,255,0.35)`,
							borderTopColor: 'white',
							borderRadius: '50%',
							verticalAlign: 'middle',
							animation: 'jasper-mg-spin 0.8s linear infinite',
						}}
					/>
					<style>{'@keyframes jasper-mg-spin{to{transform:rotate(360deg)}}'}</style>
				</div>
			) : null}
			{gradePending ? (
				<div data-mg-grade-pending="" style={chip}>
					Grade pending
				</div>
			) : null}
			{host.state === 'error' ? (
				<div
					data-mg-host-error=""
					title={host.message}
					style={{ ...chip, background: 'rgba(179, 38, 30, 0.85)' }}
				>
					Composition error
				</div>
			) : null}
		</div>
	);
}

/** A card in the layer's box for a missing bundle, composition or rendered master. */
function CompositionCard({ layer, title }: { layer: LayerProps; title: string }) {
	const h = layer.props.box.height;
	return (
		<LayerBox layer={layer} style={{ background: 'rgb(179, 38, 30)' }}>
			<div
				data-mg-card="offline"
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					gap: Math.max(4, h / 60),
					color: 'white',
					fontFamily: '"Source Sans 3", Arial, sans-serif',
					textAlign: 'center',
					padding: '0 5%',
				}}
			>
				<div style={{ fontSize: Math.max(14, h / 14), fontWeight: 600 }}>{title}</div>
				<div style={{ fontSize: Math.max(10, h / 30), opacity: 0.85 }}>{layer.clip.name}</div>
			</div>
		</LayerBox>
	);
}
