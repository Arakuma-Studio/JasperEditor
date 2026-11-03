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
	advancedNeedsFloat,
	type CameraState,
	type ClassicSetup,
	clipContentTime,
	dissolveSeed,
	invertMat3,
	type LightState,
	layerMapOf,
	layerSurfacesAt,
	layerWorldMatrix,
	lightsAt,
	type Mat3,
	type MaterialState,
	mat3FromMat2D,
	mat4Mul,
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
	type SurfaceState,
	sceneLookAt,
	stackAt,
	THREE_D_ASSET_MISSING,
	THREE_D_FLOAT_MESSAGE,
	THREE_D_NEEDS_FLOAT,
} from '@jasper/project';
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useReducer,
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
	useCurrentFrame,
} from 'remotion';
import { ScopedHtmlInCanvas } from '../fx/canvas-scope.tsx';
import { CompositeChip } from '../fx/composite.tsx';
import { usePublishFlatChain } from '../fx/flat.tsx';
import { fxHost } from '../fx/host.ts';
import type { FxGpuState } from '../fx/status.ts';
import type { LayerTap } from '../types.ts';
import {
	type AdvancedEnvironment,
	type AdvancedLook,
	type AdvancedMember,
	renderAdvancedGL,
} from './advanced.ts';
import { hdrAt, type LoadedHdr } from './env-loader.ts';
import { extrudedMesh, geometryAt } from './extruded.ts';
import { type GlPlane, renderClassicGL } from './gl.ts';
import { type LoadedModel, modelAt, modelToLayer } from './model-loader.ts';

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
			// Per frame: the layer's tap step (keyed by `side`) re-runs and delivers every frame, even when its picture is static.
			side: id,
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

/** How the 3D scopes run here. */
export type Scene3DMode = { mode: 'gpu' } | { mode: 'fallback'; reason: string; code?: string };

export function scene3dRunMode(env: {
	gpu: FxGpuState;
	htmlInCanvas: boolean;
	/** The document draws its 3D in floating point, and whether this browser can (TL-076). */
	needsFloat?: boolean;
	floatTargets?: boolean;
}): Scene3DMode {
	if (env.gpu === 'ok' && env.needsFloat && env.floatTargets === false)
		return { mode: 'fallback', reason: THREE_D_FLOAT_MESSAGE, code: THREE_D_NEEDS_FLOAT };
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
	doc: Pick<RenderSnapshot, 'settings' | 'scene3d' | 'videoTracks'> & Partial<Pick<RenderSnapshot, 'media'>>;
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
	if (ctx?.mode.mode !== 'gpu') return null;
	const run = ctx.runsAt(frame).find((r) => r.members.includes(clipId));
	if (!run) return null;
	return ctx.hubOf(run.bottomTrack)?.tap(clipId, frame) ?? null;
}

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

type Fx3DParams = {
	key: string;
	setup: ClassicSetup;
	members: {
		clip: RenderVisualClip;
		world: number[];
		props: ResolvedLayerProps;
		material: MaterialState;
		/** Physically based surfaces per mesh slot (spec 19 TL-071). */
		surfaces: (SurfaceState | null)[];
		localFrame: number;
		contentTime: number;
	}[];
	pictures: ReadonlyMap<string, HubPicture>;
	preview: boolean;
	renderer: 'classic' | 'advanced';
	environment: AdvancedEnvironment | null;
	look: AdvancedLook;
	/** Loaded models of the run's model layers, by clip id. */
	models: ReadonlyMap<string, LoadedModel>;
	shadowMapSize: number;
};

/** Renders a 3D run over the captured backdrop (the chain's source) on the fx GPU host. */
export const fx3dRun = createEffect<Fx3DParams, null>({
	type: 'jasper.three-d-run',
	label: '3D layers (Classic / Advanced 3D)',
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
		if (params.renderer === 'advanced') {
			const members: AdvancedMember[] = [];
			for (const m of params.members) {
				const pic = params.pictures.get(m.clip.clipId);
				if (!pic?.compToCanvas || pic.opacity <= 0) continue;
				const layerToPicture = multiplyMat3(
					pic.compToCanvas.slice(0, 9) as Mat3,
					mat3FromMat2D(m.props.matrix),
				);
				const g = geometryAt(m.clip, m.contentTime);
				const model = m.clip.kind === 'model' ? params.models.get(m.clip.clipId) : undefined;
				if (m.clip.kind === 'model') {
					if (!model) continue;
					members.push({
						key: m.clip.clipId,
						picture: pic.canvas,
						pictureWidth: 1,
						pictureHeight: 1,
						layerToPicture: [1, 0, 0, 0, 1, 0, 0, 0, 1],
						world: mat4Mul(m.world, modelToLayer(model.model.bounds, setup.frame)),
						mesh: null,
						model,
						material: m.material,
						opacity: Math.min(1, Math.max(0, pic.opacity)),
						draw: m.clip.threeD!.material.castsShadows !== 'only',
					});
					continue;
				}
				const physical = m.surfaces.some((s) => !!s);
				members.push({
					key: m.clip.clipId,
					picture: pic.canvas,
					pictureWidth: pic.width,
					pictureHeight: pic.height,
					layerToPicture,
					world: m.world,
					mesh: g ? extrudedMesh(m.clip.clipId, pic, layerToPicture, g, setup.scale) : null,
					material: m.material,
					...(physical ? { surfaces: m.surfaces } : {}),
					opacity: Math.min(1, Math.max(0, pic.opacity)),
					draw: m.clip.threeD!.material.castsShadows !== 'only',
				});
			}
			try {
				renderAdvancedGL(
					h,
					{
						setup,
						members,
						backdrop: source as TexImageSource,
						environment: params.environment,
						shadowMapSize: params.shadowMapSize,
						look: params.look,
					},
					out,
				);
			} catch (e) {
				if (!params.preview) throw e;
				console.error('[3d]', e);
				out.globalCompositeOperation = 'copy';
				out.drawImage(source as CanvasImageSource, 0, 0, width, height);
				out.globalCompositeOperation = 'source-over';
			}
			return;
		}
		const planes: GlPlane[] = [];
		params.members.forEach((m, order) => {
			const pic = params.pictures.get(m.clip.clipId);
			// Classic 3D draws no models (the snapshot warns: THREE_D_MODEL_CLASSIC).
			if (!pic?.compToCanvas || pic.opacity <= 0 || m.clip.kind === 'model') return;
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

/** A short fingerprint of the 3D state an effect draws (rounded numbers; FNV-1a). */
function sceneFingerprint(
	setup: ClassicSetup,
	members: {
		clip: RenderVisualClip;
		world: number[];
		material: MaterialState;
		surfaces: readonly (SurfaceState | null)[];
		contentTime: number;
	}[],
	scene3d: RenderScene3D | undefined,
	look: AdvancedLook,
): string {
	let h = 0x811c9dc5;
	const mix = (v: unknown) => {
		const s = typeof v === 'number' ? (Math.round(v * 1e4) / 1e4).toString() : String(v);
		for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
		h = Math.imul(h ^ 0x7c, 0x01000193) >>> 0;
	};
	const deep = (v: unknown): void => {
		if (Array.isArray(v)) for (const x of v) deep(x);
		else if (v && typeof v === 'object')
			for (const [k, x] of Object.entries(v)) {
				mix(k);
				deep(x);
			}
		else mix(v);
	};
	deep([
		setup.camera.view,
		setup.camera.zoom,
		setup.camera.ortho,
		setup.camera.dof,
		setup.lights,
		setup.draft,
	]);
	for (const m of members) {
		mix(m.clip.clipId);
		deep(m.world);
		deep(m.material);
		deep(m.surfaces);
		const g = m.clip.threeD?.geometry;
		if (g) deep([geometryAt(m.clip, m.contentTime)]);
	}
	deep([scene3d?.renderer, scene3d?.shadowMapSize, scene3d?.draft, look]);
	return h.toString(36);
}

const envImages = new Map<string, HTMLImageElement | 'error'>();

/** The decoded HDR of a URL (null while loading; renders fail when it cannot be read). */
function useEnvironmentHdr(
	url: string | null,
	rendering: boolean,
): { hdr: LoadedHdr | null; error: string | null } {
	const [, bump] = useReducer((n: number) => n + 1, 0);
	const entry = url ? hdrAt(url, bump) : null;
	const loading = entry?.state === 'loading' ? url : null;
	useEffect(() => {
		if (!rendering || !loading) return;
		const handle = delayRender(`environment HDR ${loading}`);
		return () => continueRender(handle);
	}, [loading, rendering]);
	if (entry?.state === 'error' && rendering)
		cancelRender(
			new Error(`${THREE_D_ASSET_MISSING}: the HDR environment could not be read: ${entry.error}`),
		);
	return {
		hdr: entry?.state === 'ready' ? entry.value : null,
		error: entry?.state === 'error' ? entry.error : null,
	};
}

/** Loaded models by clip id (absent while loading); renders hold until they are loaded and fail when one cannot be. */
function useModels(urls: ReadonlyMap<string, string>, rendering: boolean): Map<string, LoadedModel> {
	const [, bump] = useReducer((n: number) => n + 1, 0);
	const out = new Map<string, LoadedModel>();
	const pending: string[] = [];
	for (const [id, url] of urls) {
		const e = modelAt(url, bump);
		if (e.state === 'ready') out.set(id, e.value);
		else if (e.state === 'loading') pending.push(url);
		else if (rendering)
			cancelRender(new Error(`${THREE_D_ASSET_MISSING}: the 3D model could not be loaded: ${e.error}`));
	}
	const key = pending.join(',');
	useEffect(() => {
		if (!rendering || !key) return;
		const handle = delayRender(`3D models ${key}`);
		return () => continueRender(handle);
	}, [key, rendering]);
	return out;
}

/** The decoded environment image of a URL (null while loading; renders fail when it cannot be loaded). */
function useEnvironmentImage(url: string | null, rendering: boolean): HTMLImageElement | null {
	const hit = url ? envImages.get(url) : undefined;
	const [, bump] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (!url || envImages.has(url)) return;
		const handle = rendering ? delayRender(`environment image ${url}`) : null;
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.onload = () => {
			envImages.set(url, img);
			bump();
			if (handle !== null) continueRender(handle);
		};
		img.onerror = () => {
			envImages.set(url, 'error');
			if (rendering)
				cancelRender(
					new Error(`${THREE_D_ASSET_MISSING}: the environment image could not be loaded (${url})`),
				);
			bump();
		};
		img.src = url;
	}, [url, rendering]);
	return hit && hit !== 'error' ? hit : null;
}

const FILL: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };

/**
 * The 3D run a scope draws at the current frame over its backdrop (the chain's source): the run topping out on track
 * `trackIndex`, its members' delivered pictures, models and environment image, and the `fx3dRun` descriptor (empty
 * while a render still waits for a picture). Shared by `Scene3DScope` (HTML-in-Canvas capture of the stack below) and
 * the flat compositor (fx/flat.tsx), which runs the descriptor on its accumulated composite.
 */
export function useScene3DRun(
	scene: Scene3DValue,
	trackIndex: number,
	comp: { width: number; height: number },
	offset: number,
	isPreview: boolean,
) {
	const frame = useCurrentFrame() + offset;
	const rendering = getRemotionEnvironment().isRendering;
	const hub = scene.hubOf(trackIndex)!;
	const gpu = scene.mode.mode === 'gpu';
	const run = gpu ? scene.runsAt(frame).find((r) => r.bottomTrack === trackIndex) : undefined;
	const version = useSyncExternalStore(hub.subscribe, hub.getVersion, () => 0);
	// Advanced 3D: the environment of the first environment light that is on: its media, or its procedural preset.
	const envLight =
		run && scene.doc.scene3d?.renderer === 'advanced' && !(isPreview && scene.doc.scene3d?.draft)
			? (lightsAt(scene.doc.scene3d, frame, scene.doc.settings.fps, { environment: true }).find(
					(l) => l.type === 'environment',
				) ?? null)
			: null;
	const envMediaId = envLight?.environment?.mediaId ?? null;
	const envMedia = envMediaId ? scene.doc.media?.[envMediaId] : null;
	// An export never quietly loses its environment: the planner's blocker comes first, this is the backstop.
	if (rendering && envMediaId && !envMedia)
		cancelRender(new Error(`${THREE_D_ASSET_MISSING}: environment media ${envMediaId} is missing`));
	const envIsHdr = envMedia?.kind === 'hdri';
	const envUrl = envMedia ? (isPreview && envMedia.proxyUrl ? envMedia.proxyUrl : envMedia.url) : null;
	const envImage = useEnvironmentImage(envIsHdr ? null : envUrl, rendering);
	const { hdr: envHdr, error: envHdrError } = useEnvironmentHdr(envIsHdr ? envUrl : null, rendering);
	/** What preview says it cannot show: exports refuse the same things. */
	const problem = envHdrError
		? `The HDR environment could not be read: ${envHdrError}`
		: envMediaId && !envMedia
			? 'The environment media is missing'
			: null;
	// Advanced 3D: the models of the run's model layers.
	const modelUrls = new Map<string, string>();
	if (run && scene.doc.scene3d?.renderer === 'advanced')
		for (const id of run.members) {
			const c = scene.clips.get(id);
			const mid = c?.kind === 'model' && 'mediaId' in c.source ? c.source.mediaId : null;
			const h = mid ? scene.doc.media?.[mid] : null;
			if (h) modelUrls.set(id, h.url);
			else if (mid && rendering)
				cancelRender(new Error(`${THREE_D_ASSET_MISSING}: 3D model ${mid} is missing`));
		}
	const models = useModels(modelUrls, rendering);
	const pictures = new Map<string, HubPicture>();
	let complete = true;
	for (const id of run?.members ?? []) {
		const p = hub.pictures.get(id);
		if (p && (p.frame === frame || !rendering)) pictures.set(id, p);
		else complete = false;
	}
	if (rendering && run && envUrl && !envImage && !envHdr) complete = false;
	if (rendering && run && models.size < modelUrls.size) complete = false;
	const modelKey = [...models.keys()].join(',');
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
					surfaces:
						doc.scene3d?.renderer === 'advanced' && clip.kind !== 'model'
							? layerSurfacesAt(clip.threeD!, m.contentTime)
							: [],
					localFrame: frame - clip.start,
					contentTime: m.contentTime,
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
		const renderer = doc.scene3d?.renderer === 'advanced' ? 'advanced' : 'classic';
		const envRest = envLight
			? {
					rotation: envLight.environment?.rotation ?? 0,
					color: envLight.color,
					background: !!envLight.environment?.background,
				}
			: null;
		const preset = envLight?.environment?.preset ?? 0;
		const environment: AdvancedEnvironment | null =
			renderer !== 'advanced' || !envRest
				? null
				: envHdr
					? {
							...envRest,
							source: { kind: 'float', width: envHdr.width, height: envHdr.height, data: envHdr.data },
							key: `hdr:${envUrl}`,
						}
					: envImage
						? { ...envRest, image: envImage, key: `image:${envUrl}` }
						: envMediaId
							? null
							: { ...envRest, source: { kind: 'preset', preset }, key: `preset:${preset}` };
		const lookAt = sceneLookAt(doc.scene3d, frame, doc.settings.fps);
		const look: AdvancedLook = {
			toneMapping: lookAt.toneMapping,
			exposure: lookAt.exposure,
			glint: lookAt.glint,
			supersampling: doc.scene3d?.supersampling ?? 1,
		};
		// The effect re-runs when its key changes: the pictures, and everything 3D that moves without changing them
		// (world matrices, materials, the camera, the lights, the renderer settings).
		const key = `${frame}|${run.members.join(',')}|${pictureKey}|${renderer}|${environment?.key ?? ''}|${modelKey}|${sceneFingerprint(setup, members, doc.scene3d, look)}`;
		return [
			fx3dRun({
				key,
				setup,
				members,
				pictures,
				preview: isPreview,
				renderer,
				environment,
				look,
				models,
				shadowMapSize: doc.scene3d?.shadowMapSize ?? 1024,
			}),
		];
	}, [
		frame,
		run,
		pictureKey,
		complete,
		rendering,
		isPreview,
		version,
		scene,
		comp.width,
		comp.height,
		envImage,
		envHdr,
		modelKey,
	]);
	return { frame, run, complete, effects, problem };
}

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
	const rendering = getRemotionEnvironment().isRendering;
	const gpu = scene.mode.mode === 'gpu';
	const { frame, run, complete, effects, problem } = useScene3DRun(
		scene,
		trackIndex,
		comp,
		offset,
		isPreview,
	);
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
	const chip = problem ? (
		<AbsoluteFill style={{ pointerEvents: 'none' }}>
			<CompositeChip text={problem} />
		</AbsoluteFill>
	) : null;
	return (
		<>
			<ScopedHtmlInCanvas
				scope="3D layers"
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
			</ScopedHtmlInCanvas>
			{chip}
		</>
	);
}

/**
 * compositor: a 3D run bottom of a flat stack (fx/flat.tsx): nothing is captured, the run's `fx3dRun` at the current
 * frame is published for the compositor, which draws it over the composite of everything below.
 */
export function FlatRun3D({
	scene,
	trackIndex,
	comp,
	offset,
	isPreview,
}: {
	scene: Scene3DValue;
	trackIndex: number;
	comp: { width: number; height: number };
	offset: number;
	isPreview: boolean;
}) {
	const { frame, run, complete, effects, problem } = useScene3DRun(
		scene,
		trackIndex,
		comp,
		offset,
		isPreview,
	);
	usePublishFlatChain(`run3d:${trackIndex}`, {
		frame,
		effects,
		layout: null,
		ready: !run || (complete && effects.length > 0),
		key: effects.length ? ((effects[0]!.params as { key?: string }).key ?? 'run') : run ? 'pending' : 'idle',
	});
	return problem ? (
		<AbsoluteFill style={{ pointerEvents: 'none' }}>
			<CompositeChip text={problem} />
		</AbsoluteFill>
	) : null;
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
				scene.mode.code
					? `${scene.mode.code}: ${reason}`
					: reason.includes('WebGL2') || reason.includes('context lost')
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
export { advancedNeedsFloat, layerMapOf, runBottomTracks };
