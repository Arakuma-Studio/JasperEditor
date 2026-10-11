// The GL blend compositor (keyframes-blend): draws the blend modes CSS cannot draw exactly (see composite-plan.ts).
// - `BlendScope` wraps everything below a track that holds a GL item: the composite below is drawn through Remotion's
//   `<HtmlInCanvas>` (the captured backdrop, as an adjustment layer's scope) whose canvas effect chain composites the
//   track's layers onto it at the frames where a GL item is drawn (`fxBlendComposite`); elsewhere the chain is empty
//   and the backdrop passes through. The element structure never changes over time (no remounts below).
// - `CompositeHub` (one per scope): the pictures the track's layers deliver through their taps, per frame.
// - `BlendTrackContext`: what the track's clips and transition stages ask per frame ("am I captured?").
// Determinism (S11 §2): a render holds the frame (delayRender) until every layer of the frame delivered its picture of
// that frame; the chain's draw then runs with them before the hold is released (its layout effect runs first), as
// the track mattes do. Where the scope cannot run (no WebGL2 / lost context, no HTML-in-Canvas) the Player draws the
// track the CSS way with a chip naming the modes it cannot preview (they draw as Normal); renders fail with
// WEBGL_UNAVAILABLE / BLEND_UNSUPPORTED — never a silently different picture.
import { blendModeInfo } from '@jasper/project';
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
	useCurrentFrame,
} from 'remotion';
import type { LayerTap } from '../types.ts';
import { ScopedHtmlInCanvas } from './canvas-scope.tsx';
import {
	type CompositeItem,
	type CompositePicture,
	type CompositeTrackInput,
	compositeItemsAt,
	type LinearBlendCurve,
	linearGroupItemsAt,
	planComposite,
} from './composite-plan.ts';
import { canUseHtmlInCanvas } from './FxPicture.tsx';
import { FxShaderError, type FxTextureInput, fxHost, runShaderPlan } from './host.ts';
import { type FxGpuState, fxStatus, useFxStatus } from './status.ts';

type HubPicture = { canvas: HTMLCanvasElement; version: number; frame: number; pic: CompositePicture };

/** The pictures a track's layers delivered (latest per layer, with the sequence frame it shows). */
export class CompositeHub {
	readonly pictures = new Map<string, HubPicture>();
	private readonly listeners = new Set<() => void>();
	private readonly taps = new Map<string, LayerTap>();
	private version = 0;

	/** The tap of layer `key` at sequence frame `frame` (stable per key and frame). */
	tap(key: string, frame: number): LayerTap {
		const id = `${key}@${frame}`;
		const hit = this.taps.get(id);
		if (hit) return hit;
		if (this.taps.size > 256) this.taps.clear();
		const t: LayerTap = {
			// Per frame (as the 3D scope's taps): the layer's tap step is keyed by `side`, so it re-runs and delivers every
			// frame even when the layer's picture is static (text, shapes). Keyed by the clip alone, a render of a static
			// DOM layer in a GL blend mode delivered only on each page's first frame and the scope's delayRender timed
			// out at the next one (verify workstream: "Blend modes at frame 6").
			side: id,
			deliver: (p, w, h, meta) => this.deliver(key, frame, p, w, h, meta),
		};
		this.taps.set(id, t);
		return t;
	}

	subscribe = (cb: () => void): (() => void) => {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	};

	getVersion = (): number => this.version;

	deliver(
		key: string,
		frame: number,
		picture: CanvasImageSource,
		width: number,
		height: number,
		meta: { compToCanvas: readonly number[] | null; opacity: number },
	): void {
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
			// A degenerate layer map (scale 0) leaves the layer out of the frame.
			pic: {
				width: w,
				height: h,
				compToCanvas: meta.compToCanvas ?? [0, 0, 0, 0, 0, 0, 0, 0, 1],
				opacity: meta.compToCanvas ? meta.opacity : 0,
			},
		});
		for (const l of this.listeners) l();
	}
}

/** color-mgmt: the pseudo mode naming linear blending in chips and render errors. */
export const LINEAR_MARK = '@linear';

/** How a scope runs here: on the GPU (layers captured) or as the Player's CSS fallback. */
export type CompositeMode = { mode: 'gpu' } | { mode: 'fallback'; reason: string };

/** Pure: whether a blend scope can run in this environment. */
export function compositeRunMode(
	env: { gpu: FxGpuState; htmlInCanvas: boolean },
	glModes: readonly string[],
): CompositeMode {
	const names = [
		...new Set(
			glModes.map((m) => (m === LINEAR_MARK ? 'Blend using 1.0 gamma' : (blendModeInfo(m)?.label ?? m))),
		),
	].join(', ');
	if (env.gpu !== 'ok')
		return {
			mode: 'fallback',
			reason:
				env.gpu === 'lost'
					? `Blend mode ${names} paused (GPU context lost)`
					: `Blend mode ${names} needs WebGL2 (no WebGL2 here)`,
		};
	if (!env.htmlInCanvas)
		return {
			mode: 'fallback',
			reason: `Blend mode ${names} needs HTML-in-Canvas here (chrome://flags/#canvas-draw-element)`,
		};
	return { mode: 'gpu' };
}

export type BlendTrackValue = {
	hub: CompositeHub;
	mode: CompositeMode;
	/** color-mgmt: Blend using 1.0 gamma — the working curve layers are blended in (null = encoded values). */
	linear: LinearBlendCurve | null;
	/** The layers the scope composites at an absolute sequence frame, or null (cached). */
	itemsAt(frame: number): CompositeItem[] | null;
};

/** Set around a track that holds a GL item; null elsewhere (nothing is captured for the compositor). */
export const BlendTrackContext = createContext<BlendTrackValue | null>(null);

/** The compositor tap of a layer of the track at an absolute sequence frame, or null (not captured there). */
export function useCompositeTap(key: string, frame: number): LayerTap | null {
	const ctx = useContext(BlendTrackContext);
	if (!ctx || ctx.mode.mode === 'fallback') return null;
	const items = ctx.itemsAt(frame);
	if (!items?.some((it) => it.key === key)) return null;
	return ctx.hub.tap(key, frame);
}

/** The value of a track's context (stable per track input). */
export function makeBlendTrack(
	t: CompositeTrackInput,
	isGpuSide: (clipId: string, f: number) => boolean,
	mode: CompositeMode,
	hub: CompositeHub,
	linear: LinearBlendCurve | null = null,
): BlendTrackValue {
	const cache = new Map<number, CompositeItem[] | null>();
	return {
		hub,
		mode,
		linear,
		itemsAt: (frame) => {
			if (cache.has(frame)) return cache.get(frame)!;
			const items = compositeItemsAt(t, frame, isGpuSide, !!linear);
			if (cache.size > 512) cache.clear();
			cache.set(frame, items);
			return items;
		},
	};
}

/**
 * previews (scope nesting): the context value shared by a run of consecutive tracks holding GL blend modes in encoded
 * blending (one scope under the lowest of them). At frames where any member draws a GL item every layer of every
 * member is composited by the scope (`linearGroupItemsAt` with forced items), elsewhere it passes the backdrop through
 * and the tracks draw the CSS way. Chrome cannot nest HTML-in-Canvas scopes (fx/canvas-scope.tsx), so two GL-blend
 * tracks used to fail with CANVAS_NESTED.
 */
export function makeBlendGroup(
	members: Parameters<typeof linearGroupItemsAt>[0],
	isGpuSide: (clipId: string, f: number) => boolean,
	mode: CompositeMode,
	hub: CompositeHub,
): BlendTrackValue {
	const cache = new Map<number, CompositeItem[] | null>();
	return {
		hub,
		mode,
		linear: null,
		itemsAt: (frame) => {
			if (cache.has(frame)) return cache.get(frame)!;
			const gl = members.some((m) => compositeItemsAt(m.input, frame, isGpuSide, false) !== null);
			const items = gl ? linearGroupItemsAt(members, frame, isGpuSide) : null;
			if (cache.size > 512) cache.clear();
			cache.set(frame, items);
			return items;
		},
	};
}

/**
 * color-mgmt: the context value shared by a run of tracks blending in linear light (one scope under the lowest of
 * them, `linearGroupItemsAt`).
 */
export function makeLinearBlendGroup(
	members: Parameters<typeof linearGroupItemsAt>[0],
	isGpuSide: (clipId: string, f: number) => boolean,
	mode: CompositeMode,
	hub: CompositeHub,
	linear: LinearBlendCurve,
): BlendTrackValue {
	const cache = new Map<number, CompositeItem[] | null>();
	return {
		hub,
		mode,
		linear,
		itemsAt: (frame) => {
			if (cache.has(frame)) return cache.get(frame)!;
			const items = linearGroupItemsAt(members, frame, isGpuSide);
			if (cache.size > 512) cache.clear();
			cache.set(frame, items);
			return items;
		},
	};
}

type FxBlendParams = {
	key: string;
	items: readonly CompositeItem[];
	pictures: ReadonlyMap<string, HubPicture>;
	preview: boolean;
	linear: LinearBlendCurve | null;
};

/** Composites the track's layers onto the captured backdrop (the chain's source) on the fx GPU host. */
export const fxBlendComposite = createEffect<FxBlendParams, null>({
	type: 'jasper.fx-blend-composite',
	label: 'Blend modes (compositor)',
	documentationLink: null,
	backend: '2d',
	calculateKey: (p) => p.key,
	schema: {},
	validateParams: (p) => {
		if (!p?.items) throw new Error('fxBlendComposite needs {key, items, pictures}');
	},
	setup: () => null,
	apply({ source, target, params, width, height }) {
		const h = fxHost();
		if (!h) throw new Error('WEBGL_UNAVAILABLE: blend modes need WebGL2');
		const pics = new Map<string, CompositePicture>();
		for (const it of params.items) {
			const p = it.kind === 'matte' ? undefined : params.pictures.get(it.key);
			if (p) pics.set(it.key, p.pic);
		}
		const { plan, textures, builtins } = planComposite(
			params.items,
			pics,
			{ width, height },
			params.linear ? { linear: params.linear } : {},
		);
		const textureInputs: Record<string, FxTextureInput | null> = {};
		for (const t of textures) {
			const p = params.pictures.get(t.key)!;
			textureInputs[t.uniform] = {
				source: p.canvas,
				width: p.pic.width,
				height: p.pic.height,
				version: `${t.key}:${p.version}`,
			};
		}
		const out = (target as HTMLCanvasElement | OffscreenCanvas).getContext('2d') as CanvasRenderingContext2D;
		try {
			runShaderPlan(
				h,
				plan,
				source as TexImageSource,
				{ builtins, textures: textureInputs, samples: { sources: [], offsets: [] } },
				out,
			);
		} catch (e) {
			if (!params.preview) throw e;
			if (e instanceof FxShaderError) fxStatus.shaderFailed(e.effectId, e.message);
			else console.error('[blend]', e);
			out.globalCompositeOperation = 'copy';
			out.drawImage(source as CanvasImageSource, 0, 0, width, height);
			out.globalCompositeOperation = 'source-over';
		}
	},
	cleanup: () => {},
});

const FILL: CSSProperties = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' };

/**
 * Everything below a track that holds a GL item: captured through HTML-in-Canvas; at frames where the track draws a
 * GL item its layers are composited onto it. `offset` = the doc frame at the enclosing Sequence's frame 0.
 */
export function BlendScope({
	track,
	comp,
	offset,
	isPreview,
	children,
}: {
	track: BlendTrackValue;
	comp: { width: number; height: number };
	offset: number;
	isPreview: boolean;
	children?: ReactNode;
}) {
	const frame = useCurrentFrame() + offset;
	const rendering = getRemotionEnvironment().isRendering;
	const items = track.mode.mode === 'gpu' ? track.itemsAt(frame) : null;
	const { hub } = track;
	const version = useSyncExternalStore(hub.subscribe, hub.getVersion, () => 0);
	// The pictures of this frame (the Player shows the latest while a layer is still drawing this one).
	const pictures = new Map<string, HubPicture>();
	let complete = true;
	for (const it of items ?? []) {
		if (it.kind === 'matte') continue;
		const p = hub.pictures.get(it.key);
		if (p && (p.frame === frame || !rendering)) pictures.set(it.key, p);
		else complete = false;
	}
	const pictureKey = [...pictures.entries()].map(([k, p]) => `${k}:${p.version}`).join(',');
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the frame's items and delivered pictures
	const effects = useMemo(() => {
		if (!items || (rendering && !complete)) return [];
		const key = `${frame}|${track.linear ?? ''}|${items.map((it) => ('mode' in it ? `${it.key}:${it.mode}:${it.seed}` : it.key)).join('|')}|${pictureKey}`;
		return [fxBlendComposite({ key, items, pictures, preview: isPreview, linear: track.linear })];
	}, [frame, items, pictureKey, complete, rendering, isPreview, version]);
	// Renders: hold the frame until every layer of it delivered (the chain then draws before the release).
	const hold = useRef<number | null>(null);
	if (rendering && items && !complete && hold.current === null)
		hold.current = delayRender(`Blend modes at frame ${frame}`);
	useEffect(() => {
		if ((!items || complete) && hold.current !== null) {
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
	if (track.mode.mode === 'fallback')
		return (
			<div data-blend-scope="bypass" style={FILL}>
				{children}
			</div>
		);
	return (
		<ScopedHtmlInCanvas
			scope={track.linear ? 'Linear-light blending' : 'Blend modes'}
			width={comp.width}
			height={comp.height}
			effects={effects}
			style={{ ...FILL, display: 'block' }}
			showInTimeline={false}
		>
			<div
				data-blend-scope="canvas"
				style={{ position: 'absolute', left: 0, top: 0, width: comp.width, height: comp.height }}
			>
				{children}
			</div>
		</ScopedHtmlInCanvas>
	);
}

/**
 * The Player's fallback chip (drawn over a track whose scope cannot run, at the frames where it holds a GL item);
 * renders cancel there.
 */
export function BlendFallback({
	track,
	glModesAt,
	offset,
	isPreview,
}: {
	track: BlendTrackValue;
	glModesAt: (frame: number) => readonly string[];
	offset: number;
	isPreview: boolean;
}) {
	const frame = useCurrentFrame() + offset;
	if (track.mode.mode !== 'fallback') return null;
	const modes = glModesAt(frame);
	if (modes.length === 0) return null;
	const reason = track.mode.reason;
	if (!isPreview)
		cancelRender(
			new Error(
				reason.includes('WebGL2') || reason.includes('context lost')
					? `WEBGL_UNAVAILABLE: ${reason}`
					: `BLEND_UNSUPPORTED: ${reason}`,
			),
		);
	return (
		<CompositeChip
			text={
				modes.includes(LINEAR_MARK)
					? `${reason} — previewed with encoded blending`
					: `${reason} — previewed as Normal`
			}
		/>
	);
}

/** Status of the fx GPU host for scopes (re-exported for the composition). */
export const useBlendGpu = useFxStatus;

/** Whether HTML-in-Canvas is available (scopes need it to capture the backdrop). */
export const blendHtmlInCanvas = canUseHtmlInCanvas;

/** Chip of the Player's fallback (the modes it cannot preview here). */
export function CompositeChip({ text }: { text: string }) {
	return (
		<AbsoluteFill style={{ pointerEvents: 'none' }}>
			<div
				data-blend-chip=""
				style={{
					position: 'absolute',
					left: '2%',
					bottom: '3%',
					padding: '0.3% 0.8%',
					borderRadius: 4,
					background: 'rgba(120, 60, 0, 0.8)',
					color: 'rgba(255, 255, 255, 0.95)',
					fontFamily: '"Source Sans 3", "Source Sans Pro", Arial, sans-serif',
					fontSize: '2.2vmin',
				}}
			>
				{text}
			</div>
		</AbsoluteFill>
	);
}
