// The GL layer compositor (keyframes-blend): draws the blend modes CSS cannot draw exactly (see composite-plan.ts).
// - `CompositeHub`: the members' captured pictures (latest delivery wins), keyed by clip id / `transition:<id>`;
// - `CompositeStage`: one sequence-sized canvas in the group's top track, redrawn on every delivery and frame change
//   on the shared fx GPU host (`runShaderPlan`), like the transition stage;
// - `CompositeContext`: what clips, mattes and transition stages ask per frame ("am I captured?").
// Determinism (S11 §2) as for transitions: each member taps inside its own delayRender window and the stage opens its
// delayRender synchronously before redrawing (a microtask), so the last draw of a frame uses that frame's pictures.
// Where the group cannot be captured (no WebGL2 / lost context, a DOM layer without HTML-in-Canvas, a pre-rendered
// layer in the Player) the Player draws the layers the CSS way with a chip naming the mode it cannot preview (GL
// modes draw as Normal there); renders fail with BLEND_UNSUPPORTED / WEBGL_UNAVAILABLE — never a silently different
// picture.
import type { MediaHandle, RenderVisualClip } from '@jasper/project';
import { blendModeInfo } from '@jasper/project';
import { createContext, useCallback, useContext, useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, cancelRender, continueRender, delayRender, getRemotionEnvironment } from 'remotion';
import type { LayerTap } from '../types.ts';
import {
	type CompositeGroup,
	type CompositePicture,
	type CompositeTrackInput,
	compositeGroupAt,
	planComposite,
} from './composite-plan.ts';
import { FxShaderError, type FxTextureInput, fxHost, runShaderPlan } from './host.ts';
import { type FxGpuState, fxStatus } from './status.ts';

type HubPicture = { canvas: HTMLCanvasElement; version: number; pic: CompositePicture };

/** The members' pictures, as their taps delivered them. */
export class CompositeHub {
	readonly pictures = new Map<string, HubPicture>();
	private readonly listeners = new Set<() => void>();
	private readonly taps = new Map<string, LayerTap>();
	private version = 0;

	tap(key: string): LayerTap {
		const hit = this.taps.get(key);
		if (hit) return hit;
		const t: LayerTap = { side: key, deliver: (p, w, h, meta) => this.deliver(key, p, w, h, meta) };
		this.taps.set(key, t);
		return t;
	}

	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	/** Forgets a member's picture (it left the group: a later visit must not show another frame's picture). */
	forget(key: string): void {
		this.pictures.delete(key);
	}

	deliver(
		key: string,
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
			version: ++this.version,
			// A degenerate layer map (scale 0) leaves the member out of the frame.
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

/** How the compositor runs here: on the GPU (members captured) or as the Player's CSS fallback. */
export type CompositeMode = { mode: 'gpu' } | { mode: 'fallback'; reason: string };

/** Kinds whose layer draws through `FxPicture` (no HTML-in-Canvas needed to capture them). */
const PICTURE_KINDS: ReadonlySet<string> = new Set([
	'video',
	'still',
	'animated-image',
	'solid',
	'composition',
]);

/** Pure: whether the members of a document's groups can be captured in this environment. */
export function compositeRunMode(
	clips: readonly RenderVisualClip[],
	media: Readonly<Record<string, MediaHandle | null>>,
	env: { gpu: FxGpuState; htmlInCanvas: boolean; isPreview: boolean },
	glModes: readonly string[],
): CompositeMode {
	const names = [...new Set(glModes.map((m) => blendModeInfo(m)?.label ?? m))].join(', ');
	if (env.gpu !== 'ok')
		return {
			mode: 'fallback',
			reason:
				env.gpu === 'lost'
					? `Blend mode ${names} paused (GPU context lost)`
					: `Blend mode ${names} needs WebGL2 (no WebGL2 here)`,
		};
	for (const c of clips) {
		// Renders capture the injected graded master; the Player's graded preview is a plain video element.
		if (c.baked && env.isPreview)
			return { mode: 'fallback', reason: `Blend mode ${names}: a pre-rendered layer cannot be captured` };
		const src = c.source as { mediaId?: string };
		const picture = (PICTURE_KINDS.has(c.kind) && (!src.mediaId || !!media[src.mediaId])) || !!c.baked;
		if (!picture && !env.htmlInCanvas)
			return {
				mode: 'fallback',
				reason: `Blend mode ${names} with ${c.kind} layers needs HTML-in-Canvas here (chrome://flags/#canvas-draw-element)`,
			};
	}
	return { mode: 'gpu' };
}

// ---------------------------------------------------------------- context

export type CompositeContextValue = {
	hub: CompositeHub;
	mode: CompositeMode;
	tracks: readonly CompositeTrackInput[];
	/** Tracks holding a GL item (the only ones that can be a group's top). */
	groupTops: ReadonlySet<number>;
	/** The group at an absolute sequence frame (cached), or null. */
	groupAt(frame: number): CompositeGroup | null;
};

/** Null when the document has no GL blend item (nothing is ever captured for the compositor). */
export const CompositeContext = createContext<CompositeContextValue | null>(null);

/** The compositor tap of a member at an absolute sequence frame, or null (not a member, or the CSS fallback). */
export function useCompositeTap(key: string, frame: number): LayerTap | null {
	const ctx = useContext(CompositeContext);
	if (!ctx || ctx.mode.mode === 'fallback') return null;
	const g = ctx.groupAt(frame);
	if (!g?.items.some((it) => it.key === key)) return null;
	return ctx.hub.tap(key);
}

/** A group cache for one composition: groups depend only on the frame. */
export function makeGroupCache(
	tracks: readonly CompositeTrackInput[],
	isGpuSide: (clipId: string, f: number) => boolean,
): (frame: number) => CompositeGroup | null {
	const cache = new Map<number, CompositeGroup | null>();
	return (frame) => {
		if (cache.has(frame)) return cache.get(frame)!;
		const g = compositeGroupAt(tracks, frame, isGpuSide);
		if (cache.size > 512) cache.clear();
		cache.set(frame, g);
		return g;
	};
}

// ---------------------------------------------------------------- stage

const blank = (() => {
	let c: HTMLCanvasElement | null = null;
	return () => {
		c ??= document.createElement('canvas');
		c.width = 1;
		c.height = 1;
		return c;
	};
})();

/**
 * The compositor stage of the group whose top track this is, at absolute sequence frame `frame`: a sequence-sized
 * canvas redrawn whenever a member delivers.
 */
export function CompositeStage(props: {
	group: CompositeGroup;
	frame: number;
	comp: { width: number; height: number };
}) {
	const ctx = useContext(CompositeContext)!;
	const { hub } = ctx;
	const rendering = getRemotionEnvironment().isRendering;
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const failed = useRef<string | null>(null);
	const groupRef = useRef(props.group);
	groupRef.current = props.group;
	const { comp } = props;

	const draw = useCallback(() => {
		const out = canvasRef.current;
		if (!out) return;
		const h = fxHost();
		if (!h) throw new Error('WEBGL_UNAVAILABLE: blend modes need WebGL2');
		if (out.width !== comp.width) out.width = comp.width;
		if (out.height !== comp.height) out.height = comp.height;
		const items = groupRef.current.items;
		const pics = new Map<string, CompositePicture>();
		for (const it of items) {
			const p = it.kind === 'matte' ? undefined : hub.pictures.get(it.key);
			if (p) pics.set(it.key, p.pic);
		}
		const { plan, textures, builtins } = planComposite(items, pics, comp);
		const inputs: Record<string, FxTextureInput | null> = {};
		for (const t of textures) {
			const p = hub.pictures.get(t.key)!;
			inputs[t.uniform] = {
				source: p.canvas,
				width: p.pic.width,
				height: p.pic.height,
				version: `${t.key}:${p.version}`,
			};
		}
		runShaderPlan(
			h,
			plan,
			blank(),
			{ builtins, textures: inputs, samples: { sources: [], offsets: [] } },
			out.getContext('2d')!,
		);
	}, [hub, comp]);

	const pending = useRef<{ handle: number | null } | null>(null);
	const schedule = useCallback(() => {
		if (pending.current) return;
		const job = { handle: rendering ? delayRender('Blend compositor') : null };
		pending.current = job;
		queueMicrotask(() => {
			pending.current = null;
			try {
				draw();
			} catch (e) {
				if (rendering) cancelRender(e as Error);
				else if (failed.current === null) {
					failed.current = (e as Error).message;
					if (e instanceof FxShaderError) fxStatus.shaderFailed(e.effectId, e.message);
					else console.error('[composite]', e);
				}
			} finally {
				if (job.handle !== null) continueRender(job.handle);
			}
		});
	}, [draw, rendering]);

	// Subscribed in the layout phase so a delivery in the next animation frame is not missed (as transitions).
	useLayoutEffect(() => hub.subscribe(schedule), [hub, schedule]);
	const itemsKey = props.group.items
		.map((it) => `${it.key}:${'mode' in it ? `${it.mode}:${it.seed}` : ''}`)
		.join('|');
	// biome-ignore lint/correctness/useExhaustiveDependencies: redraw when the frame or the group changes
	useLayoutEffect(() => {
		schedule();
	}, [schedule, props.frame, itemsKey]);

	return (
		<AbsoluteFill data-blend-compositor="" style={{ pointerEvents: 'none' }}>
			<canvas
				ref={canvasRef}
				width={comp.width}
				height={comp.height}
				style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block' }}
			/>
		</AbsoluteFill>
	);
}

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
