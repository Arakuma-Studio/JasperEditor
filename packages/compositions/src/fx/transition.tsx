// GPU transitions in the composition (wave-2 transition framework; docs/wp-notes/fx-transition-framework.md).
// A GPU transition (`RenderTransition` of a track) is a frame-space shader stage over its span that replaces the
// outgoing ("A") and incoming ("B") clip on the track:
// - each side's layer runs its normal pipeline through the fx chain (media layers: `FxPicture`; DOM layers and
//   cards: `FxDomPicture` via HTML-in-Canvas) with a final `tap` step that hands the finished picture (effects,
//   crop) + its placement (layer map incl. corner pin, opacity) to the transition's hub and leaves the layer's own
//   output empty;
// - `TransitionStage` (a `<Sequence>` over the span, drawn above the track's clips) places both pictures in the
//   sequence frame (`u_from`, `u_to`) and runs the transition's passes on the shared fx GPU host, into one
//   sequence-sized canvas.
// Determinism (S11 §2): every tap happens inside the side's own delayRender window and synchronously opens the
// stage's delayRender before its redraw (a microtask), so the last stage draw of a frame always uses the final
// pictures of that frame; pure functions of (document, frame) otherwise.
// Where a side cannot be captured (no WebGL2 / lost context, a DOM layer without HTML-in-Canvas, a baked layer) the
// Player falls back to a dissolve with a chip on the stage; renders fail (WEBGL_UNAVAILABLE /
// FX_TRANSITION_UNSUPPORTED) — never a silently different picture.
import {
	type EffectParams,
	evaluate,
	type MediaHandle,
	planGpuTransition,
	type RenderTransition,
	type RenderVisualClip,
	type TransitionSpec,
	type TrSide,
	transitionLinearProgress,
	transitionProgress,
} from '@jasper/project';
import { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
	AbsoluteFill,
	cancelRender,
	continueRender,
	delayRender,
	getRemotionEnvironment,
	useCurrentFrame,
} from 'remotion';
import type { TransitionTap } from '../types.ts';
import { canUseHtmlInCanvas } from './FxPicture.tsx';
import { FxShaderError, fxHost, runShaderPlan } from './host.ts';
import { type FxGpuState, fxStatus } from './status.ts';

// ---------------------------------------------------------------- hub

type HubPicture = { canvas: HTMLCanvasElement; side: TrSide; version: number };

/** The pictures of one transition's two sides, as their taps delivered them (latest wins). */
export class TransitionHub {
	readonly pictures: { out: HubPicture | null; in: HubPicture | null } = { out: null, in: null };
	private readonly listeners = new Set<() => void>();
	private readonly taps: { out?: TransitionTap; in?: TransitionTap } = {};
	private version = 0;

	tap(side: 'out' | 'in'): TransitionTap {
		const hit = this.taps[side];
		if (hit) return hit;
		const t: TransitionTap = {
			side,
			deliver: (picture, width, height, meta) => this.deliver(side, picture, width, height, meta),
		};
		this.taps[side] = t;
		return t;
	}

	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private deliver(
		side: 'out' | 'in',
		picture: CanvasImageSource,
		width: number,
		height: number,
		meta: { compToCanvas: readonly number[] | null; opacity: number },
	): void {
		const prev = this.pictures[side];
		const canvas = prev?.canvas ?? document.createElement('canvas');
		const w = Math.max(1, Math.round(width));
		const h = Math.max(1, Math.round(height));
		if (canvas.width !== w) canvas.width = w;
		if (canvas.height !== h) canvas.height = h;
		const ctx = canvas.getContext('2d')!;
		ctx.globalCompositeOperation = 'copy';
		ctx.drawImage(picture, 0, 0, w, h);
		ctx.globalCompositeOperation = 'source-over';
		this.pictures[side] = {
			canvas,
			version: ++this.version,
			// A degenerate layer map (scale 0) leaves the side out of the frame.
			side: {
				width: w,
				height: h,
				compToCanvas: meta.compToCanvas ?? [0, 0, 0, 0, 0, 0, 0, 0, 1],
				opacity: meta.compToCanvas ? meta.opacity : 0,
			},
		};
		for (const l of this.listeners) l();
	}
}

// ---------------------------------------------------------------- run mode

/** How a GPU transition runs here: on the GPU (sides captured) or as the preview's dissolve fallback. */
export type TransitionMode = { mode: 'gpu' } | { mode: 'fallback'; reason: string };

/** Kinds whose layer draws through `FxPicture` (no HTML-in-Canvas needed to capture them). */
const PICTURE_KINDS: ReadonlySet<string> = new Set([
	'video',
	'still',
	'animated-image',
	'solid',
	'composition',
]);

/** Pure: whether the sides of `t` can be captured in this environment. */
export function transitionRunMode(
	t: RenderTransition,
	spec: TransitionSpec | null,
	clips: ReadonlyMap<string, RenderVisualClip>,
	media: Readonly<Record<string, MediaHandle | null>>,
	env: { gpu: FxGpuState; htmlInCanvas: boolean },
): TransitionMode {
	if (!spec?.gpu)
		return { mode: 'fallback', reason: `Transition ${t.effectId} is not available in this version` };
	if (env.gpu !== 'ok')
		return {
			mode: 'fallback',
			reason:
				env.gpu === 'lost'
					? 'GPU transitions paused (context lost)'
					: 'GPU transitions unavailable (no WebGL2)',
		};
	for (const id of [t.outgoingClipId, t.incomingClipId]) {
		const c = id ? clips.get(id) : undefined;
		if (!c) continue;
		if (c.baked)
			return { mode: 'fallback', reason: `${spec.label}: a pre-rendered layer cannot be captured` };
		const src = c.source as { mediaId?: string };
		const picture = PICTURE_KINDS.has(c.kind) && (!src.mediaId || !!media[src.mediaId]);
		if (!picture && !env.htmlInCanvas)
			return {
				mode: 'fallback',
				reason: `${spec.label} on ${c.kind} layers needs HTML-in-Canvas here (chrome://flags/#canvas-draw-element)`,
			};
	}
	return { mode: 'gpu' };
}

/** Opacity factor of a side in the preview fallback: B dissolves in (two-sided, fade in), A fades out (fade out). */
export function transitionFallbackFactor(t: RenderTransition, side: 'out' | 'in', frame: number): number {
	const p = transitionLinearProgress(frame - t.start, t.duration, t.sides);
	if (t.sides === 'both') return side === 'in' ? p : 1;
	return t.sides === 'in' ? p : 1 - p;
}

/** The evaluated params of a transition at frame `local` of its span (keys: flicks from the span start). */
export function transitionParamsAt(t: RenderTransition, local: number, flicksPerFrame: number): EffectParams {
	const out: EffectParams = {};
	for (const [k, a] of Object.entries(t.params)) out[k] = evaluate(a, local * flicksPerFrame);
	return out;
}

/** `u_progress` of a transition at a sequence frame (what the sides' GPU effects see too). */
export function transitionProgressAt(
	t: RenderTransition,
	spec: TransitionSpec,
	frame: number,
	fpf: number,
): number {
	const local = frame - t.start;
	const params = transitionParamsAt(t, local, fpf);
	return transitionProgress(spec.gpu, params, transitionLinearProgress(local, t.duration, t.sides)).progress;
}

// ---------------------------------------------------------------- per-track context

/** One side of a transition, as a clip of the track sees it. */
export type TransitionSideEntry = {
	t: RenderTransition;
	spec: TransitionSpec;
	side: 'out' | 'in';
	mode: TransitionMode;
	hub: TransitionHub;
};

/** clipId → the GPU transitions the clip is a side of (set per track by the composition). */
export const TransitionSidesContext = createContext<ReadonlyMap<string, readonly TransitionSideEntry[]>>(
	new Map(),
);

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
 * The shader stage of one GPU transition (inside a `<Sequence from={span start}>`): a sequence-sized canvas drawn
 * above the track's clips. Redraws when its frame / params change and whenever a side delivers a picture.
 */
export function TransitionStage(props: {
	t: RenderTransition;
	spec: TransitionSpec;
	hub: TransitionHub;
	mode: TransitionMode;
	comp: { width: number; height: number; fps: number };
	flicksPerFrame: number;
	isPreview: boolean;
	blendMode?: string;
}) {
	const { t, spec, hub, mode, comp } = props;
	const local = Math.min(t.duration - 1, Math.max(0, useCurrentFrame()));
	const rendering = getRemotionEnvironment().isRendering;
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const failed = useRef<string | null>(null);
	const params = useMemo(
		() => transitionParamsAt(t, local, props.flicksPerFrame),
		[t, local, props.flicksPerFrame],
	);
	const paramsKey = JSON.stringify(params);
	const stateRef = useRef({ params, local });
	stateRef.current = { params, local };
	if (mode.mode === 'fallback' && !props.isPreview)
		cancelRender(
			new Error(
				mode.reason.includes('WebGL2') || mode.reason.includes('context lost')
					? `WEBGL_UNAVAILABLE: ${mode.reason}`
					: `FX_TRANSITION_UNSUPPORTED: ${mode.reason}`,
			),
		);

	const draw = useCallback(() => {
		const out = canvasRef.current;
		if (!out || mode.mode !== 'gpu') return;
		const h = fxHost();
		if (!h) throw new Error('WEBGL_UNAVAILABLE: GPU transitions need WebGL2');
		if (out.width !== comp.width) out.width = comp.width;
		if (out.height !== comp.height) out.height = comp.height;
		const { params: p, local: f } = stateRef.current;
		const pics = hub.pictures;
		const staged = planGpuTransition(
			spec,
			{ id: t.id, params: p, frame: f, duration: t.duration, sides: t.sides },
			comp,
			{ out: pics.out?.side ?? null, in: pics.in?.side ?? null },
		);
		const tex = (s: 'out' | 'in' | null) => {
			const pic = s ? pics[s] : null;
			return pic
				? { source: pic.canvas, width: pic.side.width, height: pic.side.height, version: String(pic.version) }
				: null;
		};
		runShaderPlan(
			h,
			staged.plan,
			blank(),
			{
				builtins: staged.builtins,
				textures: { u_trFrom: tex(staged.fromSide), u_trTo: tex(staged.toSide) },
				samples: { sources: [], offsets: [] },
			},
			out.getContext('2d')!,
		);
	}, [hub, spec, t, comp, mode.mode]);

	const pending = useRef<{ handle: number | null } | null>(null);
	const schedule = useCallback(() => {
		if (pending.current) return;
		const job = { handle: rendering ? delayRender(`Transition ${t.id}`) : null };
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
					else console.error('[transition]', e);
				}
			} finally {
				if (job.handle !== null) continueRender(job.handle);
			}
		});
	}, [draw, rendering, t.id]);

	useEffect(() => hub.subscribe(schedule), [hub, schedule]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: redraw when the frame or the param values change
	useLayoutEffect(() => {
		schedule();
	}, [schedule, local, paramsKey]);

	if (mode.mode === 'fallback') return props.isPreview ? <StageChip text={mode.reason} /> : null;
	return (
		<AbsoluteFill
			data-transition-stage={t.id}
			style={
				props.blendMode && props.blendMode !== 'normal'
					? { mixBlendMode: props.blendMode as never }
					: undefined
			}
		>
			<canvas
				ref={canvasRef}
				width={comp.width}
				height={comp.height}
				style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', display: 'block' }}
			/>
		</AbsoluteFill>
	);
}

function StageChip({ text }: { text: string }) {
	return (
		<AbsoluteFill style={{ pointerEvents: 'none' }}>
			<div
				data-transition-chip=""
				style={{
					position: 'absolute',
					left: '2%',
					top: '3%',
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

/** Whether DOM layers can be captured here (HTML-in-Canvas), for `transitionRunMode`. */
export function htmlInCanvasAvailable(): boolean {
	return canUseHtmlInCanvas();
}
