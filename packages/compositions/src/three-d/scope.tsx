// three-d: 3D runs in the composition (preview and Remotion renders alike).
// - A track holding a 3D clip wraps everything below it in a `Scene3DScope` (like the GL blend scope): the composite
//   below is captured through HTML-in-Canvas, and at frames where a 3D run tops out on this track, the run's layers
//   (on this track and the tracks below, without a 2D layer between them) deliver their finished layer-space pictures
//   to the scope's hub instead of drawing themselves, and the scope's canvas effect renders them with the 3D renderer
//   (renderClassicGL) over the captured backdrop. Elsewhere the effect chain is empty and the backdrop passes through.
// - Renders hold the frame until every run member delivered its picture of that frame (determinism, as blend scopes).
// - Where the scope cannot run (no WebGL2 / lost context, no HTML-in-Canvas: a Player in a browser without the flag),
//   3D layers draw themselves through their 3D homography (CSS matrix3d: no depth sort across layers, no lights,
//   shadows or depth of field) with a chip saying so; renders fail with WEBGL_UNAVAILABLE / THREE_D_UNSUPPORTED.
import {
	activeCameraAt,
	type CameraState,
	type ClassicSetup,
	clipContentTime,
	dissolveSeed,
	invertMat3,
	type LightState,
	layerMapOf,
	layerWorldMatrix,
	lightsAt,
	type Mat3,
	type MaterialState,
	mat3FromMat2D,
	materialAt,
	multiplyMat3,
	planeHomography,
	prepareClassicPlane,
	type RenderScene3D,
	type RenderSnapshot,
	type RenderVisualClip,
	type ResolvedLayerProps,
	resolveCachedLayerProps,
	runBottomTracks,
	runs3d,
	stackAt,
} from '@jasper/project';
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from 'react';
import {
	AbsoluteFill,
	cancelRender,
	continueRender,
	createEffect,
	delayRender,
	getRemotionEnvironment,
	HtmlInCanvas,
	useCurrentFrame,
} from 'remotion';
import { CompositeChip } from '../fx/composite.tsx';
import { fxHost } from '../fx/host.ts';
import type { FxGpuState } from '../fx/status.ts';
import type { LayerTap } from '../types.ts';
import { type GlPlane, renderClassicGL } from './gl.ts';

// ---------------------------------------------------------------- hub

type HubPicture = {
	canvas: HTMLCanvasElement;
	version: number;
	frame: number;
	width: number;
	height: number;
	/** Sequence px → picture px (null: degenerate layer map, nothing drawn). */
	compToCanvas: readonly number[] | null;
	opacity: number;
};

/** The pictures a scope's run members delivered (latest per clip, with the sequence frame it shows). */
export class Scene3DHub {
	readonly pictures = new Map<string, HubPicture>();
	private readonly listeners = new Set<() => void>();
	private readonly taps = new Map<string, LayerTap>();
	private version = 0;

	tap(key: string, frame: number): LayerTap {
		const id = `${key}@${frame}`;
		const hit = this.taps.get(id);
		if (hit) return hit;
		if (this.taps.size > 256) this.taps.clear();
		const t: LayerTap = {
			side: key,
			deliver: (picture, width, height, meta) => {
				const prev = this.pictures.get(key);
				const canvas = prev?.canvas ?? document.createElement('canvas');
				const w = Math.max(1, Math.round(width));
				const h = Math.max(1, Math.round(height));
				if (canvas.width !== w) canvas.width = w;
				if (canvas.height !== h) canvas.height = h;
				const ctx = canvas.getContext('2d')!;
				ctx.globalCompositeOperation = 'copy';
				ctx.drawImage(picture, 0, 0, w, h);
				ctx.globalCompositeOperation = 'source-over';
				this.pictures.set(key, {
					canvas,
					frame,
					version: ++this.version,
					width: w,
					height: h,
					compToCanvas: meta.compToCanvas,
					opacity: meta.opacity,
				});
				for (const l of this.listeners) l();
			},
		};
		this.taps.set(id, t);
		return t;
	}

	subscribe = (cb: () => void): (() => void) => {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	};

	getVersion = (): number => this.version;
}

// ---------------------------------------------------------------- per-frame runs

/** How the 3D scopes run here. */
export type Scene3DMode = { mode: 'gpu' } | { mode: 'fallback'; reason: string };

export function scene3dRunMode(env: { gpu: FxGpuState; htmlInCanvas: boolean }): Scene3DMode {
	if (env.gpu !== 'ok')
		return {
			mode: 'fallback',
			reason:
				env.gpu === 'lost'
					? '3D renderer paused (GPU context lost)'
					: '3D layers need WebGL2 (no WebGL2 here)',
		};
	if (!env.htmlInCanvas)
		return {
			mode: 'fallback',
			reason: '3D layers need HTML-in-Canvas here (chrome://flags/#canvas-draw-element)',
		};
	return { mode: 'gpu' };
}

/** A run at a frame: its members bottom → top and the track whose scope draws it. */
export type Run3D = { members: string[]; topTrack: number; bottomTrack: number };

export type Scene3DValue = {
	mode: Scene3DMode;
	doc: Pick<RenderSnapshot, 'settings' | 'scene3d' | 'videoTracks'>;
	/** The hub of the scope of track `trackIndex` (tracks holding 3D clips). */
	hubOf(trackIndex: number): Scene3DHub | undefined;
	/** The runs at an absolute sequence frame (cached). */
	runsAt(frame: number): Run3D[];
	/** Render clips by id. */
	clips: ReadonlyMap<string, RenderVisualClip>;
	/** The camera 3D layers are seen through at a frame (the active camera, or the preview's 3D view). */
	cameraAt(frame: number): CameraState;
};

export const Scene3DContext = createContext<Scene3DValue | null>(null);

export function makeScene3D(
	doc: Scene3DValue['doc'],
	mode: Scene3DMode,
	hubs: Map<number, Scene3DHub>,
	layerFilter?: readonly string[],
	view?: CameraState | null,
): Scene3DValue {
	const cache = new Map<number, Run3D[]>();
	const clips = new Map<string, RenderVisualClip>();
	for (const t of doc.videoTracks) for (const c of t.clips) clips.set(c.clipId, c);
	return {
		mode,
		doc,
		clips,
		hubOf: (i) => hubs.get(i),
		cameraAt: (frame) => view ?? activeCameraAt(doc, frame),
		runsAt: (frame) => {
			const hit = cache.get(frame);
			if (hit) return hit;
			const runs = runs3d(stackAt(doc.videoTracks, frame, layerFilter ? { layerFilter } : {}));
			if (cache.size > 512) cache.clear();
			cache.set(frame, runs);
			return runs;
		},
	};
}

/** The 3D tap of a clip at an absolute sequence frame (null: not a 3D layer drawn by a scope there). */
export function useScene3DTap(clipId: string, frame: number): LayerTap | null {
	const ctx = useContext(Scene3DContext);
	if (!ctx || ctx.mode.mode !== 'gpu') return null;
	const run = ctx.runsAt(frame).find((r) => r.members.includes(clipId));
	if (!run) return null;
	return ctx.hubOf(run.bottomTrack)?.tap(clipId, frame) ?? null;
}

// ---------------------------------------------------------------- scene evaluation

/** Lights of the scene at a frame (none in Draft 3D previews). */
export function sceneLightsAt(
	doc: Pick<RenderSnapshot, 'settings' | 'scene3d'>,
	frame: number,
	draft: boolean,
): LightState[] {
	return draft ? [] : lightsAt(doc.scene3d, frame, doc.settings.fps);
}

/** World matrix and layer → picture map of a run member at a frame. */
export function memberPlane(
	clip: RenderVisualClip,
	frame: number,
	fps: RenderSnapshot['settings']['fps'],
	camera: CameraState,
): { world: number[]; props: ResolvedLayerProps; contentTime: number } {
	const t = clipContentTime(clip, frame, fps);
	const props = resolveCachedLayerProps(clip, t);
	const world = layerWorldMatrix(clip, t, { cameraEye: camera.eye });
	return { world, props, contentTime: t };
}

/**
 * Fallback drawing (no GPU scope): the map from a 3D layer's box to the frame through the active camera, or null when
 * it is seen edge-on (not drawn).
 */
export function fallbackProjective(
	clip: RenderVisualClip,
	props: ResolvedLayerProps,
	frame: number,
	doc: Pick<RenderSnapshot, 'settings' | 'scene3d'>,
	camera?: CameraState,
): Mat3 | null {
	const cam = camera ?? activeCameraAt(doc, frame);
	const t = clipContentTime(clip, frame, doc.settings.fps);
	const world = layerWorldMatrix(clip, t, { cameraEye: cam.eye });
	const h = planeHomography(cam, doc.settings.width, doc.settings.height, world);
	if (!h) return null;
	// The corner pin (if any) acts in layer space, before the 3D transform.
	const pin = props.projective
		? multiplyMat3(invertMat3(mat3FromMat2D(props.matrix)) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], props.projective)
		: null;
	return pin ? multiplyMat3(h, pin) : h;
}

// ---------------------------------------------------------------- the effect

type Fx3DParams = {
	key: string;
	setup: ClassicSetup;
	members: {
		clip: RenderVisualClip;
		world: number[];
		props: ResolvedLayerProps;
		material: MaterialState;
		localFrame: number;
	}[];
	pictures: ReadonlyMap<string, HubPicture>;
	preview: boolean;
};

/** Renders a 3D run over the captured backdrop (the chain's source) on the fx GPU host. */
export const fx3dRun = createEffect<Fx3DParams, null>({
	type: 'jasper.three-d-run',
	label: '3D layers (Classic 3D)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p?.members) throw new Error('fx3dRun needs {key, setup, members, pictures}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const h = fxHost();
		const out = (target as HTMLCanvasElement | OffscreenCanvas).getContext('2d') as CanvasRenderingContext2D;
		if (!h) throw new Error('WEBGL_UNAVAILABLE: 3D layers need WebGL2');
		const setup = { ...params.setup, width, height, scale: width / Math.max(1, params.setup.frame.width) };
		const planes: GlPlane[] = [];
		params.members.forEach((m, order) => {
			const pic = params.pictures.get(m.clip.clipId);
			if (!pic?.compToCanvas || pic.opacity <= 0) return;
			const layerToPicture = multiplyMat3(
				pic.compToCanvas.slice(0, 9) as Mat3,
				mat3FromMat2D(m.props.matrix),
			);
			const td = m.clip.threeD!;
			const p = prepareClassicPlane(setup, {
				key: m.clip.clipId,
				width: pic.width,
				height: pic.height,
				layerToPicture,
				world: m.world,
				material: m.material,
				opacity: Math.min(1, Math.max(0, pic.opacity)),
				mode: m.clip.blendMode,
				seed: dissolveSeed(m.clip.clipId, m.localFrame),
				order,
				draw: td.material.castsShadows !== 'only',
			});
			if (p) planes.push({ ...p, picture: pic.canvas, pictureWidth: pic.width, pictureHeight: pic.height });
		});
		try {
			renderClassicGL(h, { setup, planes, backdrop: source as TexImageSource }, out);
		} catch (e) {
			if (!params.preview) throw e;
			console.error('[3d]', e);
			out.globalCompositeOperation = 'copy';
			out.drawImage(source as CanvasImageSource, 0, 0, width, height);
			out.globalCompositeOperation = 'source-over';
		}
	},
	cleanup: () => {},
});

// ---------------------------------------------------------------- scope

const FILL: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };

/**
 * Everything below a track that holds a 3D clip: captured; at frames where a run tops out on this track the run is
 * drawn over it. `offset` = the doc frame at the enclosing Sequence's frame 0.
 */
export function Scene3DScope({
	scene,
	trackIndex,
	comp,
	offset,
	isPreview,
	children,
}: {
	scene: Scene3DValue;
	trackIndex: number;
	comp: { width: number; height: number };
	offset: number;
	isPreview: boolean;
	children?: ReactNode;
}) {
	const frame = useCurrentFrame() + offset;
	const rendering = getRemotionEnvironment().isRendering;
	const hub = scene.hubOf(trackIndex)!;
	const gpu = scene.mode.mode === 'gpu';
	const run = gpu ? scene.runsAt(frame).find((r) => r.bottomTrack === trackIndex) : undefined;
	const version = useSyncExternalStore(hub.subscribe, hub.getVersion, () => 0);
	const pictures = new Map<string, HubPicture>();
	let complete = true;
	for (const id of run?.members ?? []) {
		const p = hub.pictures.get(id);
		if (p && (p.frame === frame || !rendering)) pictures.set(id, p);
		else complete = false;
	}
	const pictureKey = [...pictures.entries()].map(([k, p]) => `${k}:${p.version}`).join(',');
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the frame's run and delivered pictures
	const effects = useMemo(() => {
		if (!run || (rendering && !complete)) return [];
		const { doc } = scene;
		const camera = scene.cameraAt(frame);
		const draft = isPreview && !!doc.scene3d?.draft;
		const members = run.members
			.map((id) => scene.clips.get(id))
			.filter((c): c is RenderVisualClip => !!c?.threeD)
			.map((clip) => {
				const m = memberPlane(clip, frame, doc.settings.fps, camera);
				return {
					clip,
					world: m.world,
					props: m.props,
					material: materialAt(clip.threeD!.material, m.contentTime),
					localFrame: frame - clip.start,
				};
			});
		const setup: ClassicSetup = {
			width: comp.width,
			height: comp.height,
			scale: 1,
			frame: { width: doc.settings.width, height: doc.settings.height },
			camera,
			lights: sceneLightsAt(doc, frame, draft),
			draft,
		};
		const key = `${frame}|${run.members.join(',')}|${pictureKey}`;
		return [fx3dRun({ key, setup, members, pictures, preview: isPreview })];
	}, [frame, run, pictureKey, complete, rendering, isPreview, version, scene, comp.width, comp.height]);
	const hold = useRef<number | null>(null);
	if (rendering && run && !complete && hold.current === null)
		hold.current = delayRender(`3D layers at frame ${frame}`);
	useEffect(() => {
		if ((!run || complete) && hold.current !== null) {
			continueRender(hold.current);
			hold.current = null;
		}
	});
	useEffect(
		() => () => {
			if (hold.current !== null) continueRender(hold.current);
		},
		[],
	);
	if (!gpu)
		return (
			<div data-scene3d-scope="bypass" style={FILL}>
				{children}
			</div>
		);
	return (
		<HtmlInCanvas
			width={comp.width}
			height={comp.height}
			effects={effects}
			style={{ ...FILL, display: 'block' }}
			showInTimeline={false}
		>
			<div
				data-scene3d-scope="canvas"
				data-track-index={trackIndex}
				style={{ position: 'absolute', left: 0, top: 0, width: comp.width, height: comp.height }}
			>
				{children}
			</div>
		</HtmlInCanvas>
	);
}

/** The fallback chip (Player without the GPU scope) at frames where 3D layers are drawn; renders cancel. */
export function Scene3DFallback({
	scene,
	offset,
	isPreview,
}: {
	scene: Scene3DValue;
	offset: number;
	isPreview: boolean;
}) {
	const frame = useCurrentFrame() + offset;
	if (scene.mode.mode !== 'fallback') return null;
	if (scene.runsAt(frame).length === 0) return null;
	const reason = scene.mode.reason;
	if (!isPreview)
		cancelRender(
			new Error(
				reason.includes('WebGL2') || reason.includes('context lost')
					? `WEBGL_UNAVAILABLE: ${reason}`
					: `THREE_D_UNSUPPORTED: ${reason}`,
			),
		);
	return (
		<AbsoluteFill style={{ pointerEvents: 'none' }}>
			<CompositeChip text={`${reason}: previewed without depth sorting, lights or depth of field`} />
		</AbsoluteFill>
	);
}

export type { RenderScene3D };
export { layerMapOf, runBottomTracks };
