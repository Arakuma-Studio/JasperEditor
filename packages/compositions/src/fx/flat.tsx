// The flat compositor (workstream compositor; planning in flat-plan.ts). A stack whose canvas scopes would nest is drawn
// without any scope: every layer hands its finished picture to the compositor's hub through the tap of the GL blend
// compositor (`BlendTrackContext` with every drawn layer as an item), 3D run members to the 3D hub as always, and the
// adjustment tracks and 3D runs publish the canvas effects they would run inside their scope (`FlatRegistry`). The
// compositor then builds the frame on canvases, bottom to top, with the very effects the scopes run:
// - layers and colour fills: `fxBlendComposite` (every blend mode, linear light, Dissolve; = the native kernel);
// - an adjustment layer: its chain (stash → effects → mix) on the accumulated picture placed in the chain's padded
//   layout, exactly where the scope's HTML-in-Canvas capture would have put it, then cropped back to the frame;
// - a 3D run: `fx3dRun` with the accumulated picture as its backdrop;
// - the Program monitor's display transform (preview) and the Stencil / Silhouette background last.
// The result is a canvas in the stack's place, or (nested sequences whose nest layer runs effects) the source picture
// of the nest layer's `FxPicture`. Renders hold the frame until every layer, adjustment chain and run delivered that
// frame; the Player draws the latest pictures once per animation frame.

import type { RGBA } from '@jasper/project';
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from 'react';
import type { EffectDefinitionAndStack, EffectDescriptor } from 'remotion';
import {
	cancelRender,
	continueRender,
	delayRender,
	getRemotionEnvironment,
	Internals,
	useCurrentFrame,
} from 'remotion';
import type { LayerTap } from '../types.ts';
import { ScopedHtmlInCanvas } from './canvas-scope.tsx';
import {
	type BlendTrackValue,
	type CompositeHub,
	type CompositeMode,
	fxBlendComposite,
} from './composite.tsx';
import type { CompositeItem, LinearBlendCurve } from './composite-plan.ts';
import { fxTap } from './effects.ts';
import { type FxFeed, FxFeedContext } from './FxPicture.tsx';
import { type FlatOp, type FlatTrackInput, flatLayerItems, flatOpsAt } from './flat-plan.ts';
import type { FxLayout } from './stage.ts';

// ---------------------------------------------------------------- registry of the frame's chains

/** What an adjustment track or a 3D run publishes for a frame: the effects its scope would run on its capture. */
export type FlatChain = {
	/** Sequence frame the effects are for. */
	frame: number;
	/** The canvas effects (empty: nothing to do at this frame, or not drawable here — the Player shows a chip). */
	effects: EffectDescriptor[];
	/** The chain's canvas layout (adjustment layers: the padded layout; null = the frame). */
	layout: FxLayout | null;
	/** Everything the effects need is there (renders hold until it is). */
	ready: boolean;
	/** Identity of the effects (redraw when it changes). */
	key: string;
};

/** The chains of a flat stack's adjustment tracks (`adjust:<trackId>`) and 3D runs (`run3d:<trackIndex>`). */
export class FlatRegistry {
	private readonly chains = new Map<string, FlatChain>();
	private readonly listeners = new Set<() => void>();
	private version = 0;

	get(key: string): FlatChain | undefined {
		return this.chains.get(key);
	}

	set(key: string, chain: FlatChain): void {
		const prev = this.chains.get(key);
		if (
			prev &&
			prev.frame === chain.frame &&
			prev.key === chain.key &&
			prev.ready === chain.ready &&
			prev.effects === chain.effects
		)
			return;
		this.chains.set(key, chain);
		this.version++;
		for (const l of this.listeners) l();
	}

	subscribe = (cb: () => void): (() => void) => {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	};

	getVersion = (): number => this.version;
}

export type FlatStackValue = {
	hub: CompositeHub;
	registry: FlatRegistry;
	/** The compositor's steps at an absolute sequence frame (cached). */
	opsAt(frame: number): FlatOp[];
};

/**
 * The Program monitor's display transform (color/DisplayStage.tsx) when the sequence is drawn flat: the effects the
 * compositor of the sequence's own stack runs last (null: no display transform, or the stage captures the stack).
 */
export const FlatDisplayContext = createContext<readonly EffectDescriptor[] | null>(null);

/** Set by a flat `VideoTracks` around its adjustment chains and 3D runs. */
export const FlatStackContext = createContext<FlatStackValue | null>(null);

/**
 * The flat stack's value and the `BlendTrackContext` value every track gets: every drawn 2D layer of the frame is
 * captured for the compositor (`itemsAt`), with the stack's linear-light curve.
 */
export function makeFlatStack(
	tracks: readonly FlatTrackInput[],
	opts: Parameters<typeof flatOpsAt>[2],
	hub: CompositeHub,
	registry: FlatRegistry,
	mode: CompositeMode,
	linear: LinearBlendCurve | null,
): { stack: FlatStackValue; track: BlendTrackValue } {
	const cache = new Map<number, { ops: FlatOp[]; items: CompositeItem[] | null }>();
	const at = (frame: number) => {
		const hit = cache.get(frame);
		if (hit) return hit;
		const ops = flatOpsAt(tracks, frame, opts);
		const items = flatLayerItems(ops).filter((it) => it.kind !== 'matte');
		const v = { ops, items: items.length ? items : null };
		if (cache.size > 512) cache.clear();
		cache.set(frame, v);
		return v;
	};
	return {
		stack: { hub, registry, opsAt: (f) => at(f).ops },
		track: { hub, mode, linear, itemsAt: (f) => at(f).items },
	};
}

// ---------------------------------------------------------------- drawing

type Chains = Map<string, ReturnType<typeof Internals.createEffectChainState>>;

const canvasOf = (holder: { c: HTMLCanvasElement | null }, w: number, h: number): HTMLCanvasElement => {
	const c = holder.c ?? document.createElement('canvas');
	holder.c = c;
	if (c.width !== w) c.width = w;
	if (c.height !== h) c.height = h;
	return c;
};

/** Descriptors in the form `runEffectChain` takes (as FxPicture does). */
const memoized = (d: readonly EffectDescriptor[]) =>
	d.map((e) => ({ ...e, memoized: true }) as EffectDefinitionAndStack<unknown>);

const ctx2d = (c: HTMLCanvasElement) => {
	const ctx = c.getContext('2d');
	if (!ctx) throw new Error('flat compositor: no 2D context');
	return ctx;
};

type DrawInput = {
	ops: readonly FlatOp[];
	hub: CompositeHub;
	registry: FlatRegistry;
	width: number;
	height: number;
	frame: number;
	linear: LinearBlendCurve | null;
	preview: boolean;
	/** The display transform's effects (Program monitor), last. */
	display: readonly EffectDescriptor[];
	/** Stencil / Silhouette: the background drawn once more under the finished stack. */
	underlay: RGBA | null;
};

/** Builds the frame into `acc` (W × H). */
async function drawFlat(
	input: DrawInput,
	surfaces: {
		a: { c: HTMLCanvasElement | null };
		b: { c: HTMLCanvasElement | null };
		p: { c: HTMLCanvasElement | null };
		q: { c: HTMLCanvasElement | null };
	},
	chains: Chains,
): Promise<HTMLCanvasElement> {
	const { width: W, height: H } = input;
	const chainOf = (w: number, h: number) => {
		const k = `${w}x${h}`;
		let s = chains.get(k);
		if (!s) {
			s = Internals.createEffectChainState(w, h);
			chains.set(k, s);
		}
		return s;
	};
	let acc = canvasOf(surfaces.a, W, H);
	let spare = canvasOf(surfaces.b, W, H);
	ctx2d(acc).clearRect(0, 0, W, H);
	const run = async (effects: EffectDescriptor[]) => {
		if (effects.length === 0) return;
		await Internals.runEffectChain({
			state: chainOf(W, H),
			source: acc,
			effects: memoized(effects),
			output: spare,
			width: W,
			height: H,
		});
		[acc, spare] = [spare, acc];
	};
	for (const op of input.ops) {
		if (op.kind === 'layers') {
			const key = `flat:${input.frame}|${input.linear ?? ''}|${op.items.map((it) => ('mode' in it ? `${it.key}:${it.mode}:${it.seed}:${input.hub.pictures.get(it.key)?.version ?? '-'}` : `${it.key}:${it.color.join(',')}`)).join('|')}`;
			await run([
				fxBlendComposite({
					key,
					items: op.items,
					pictures: input.hub.pictures,
					preview: input.preview,
					linear: input.linear,
				}),
			]);
			continue;
		}
		const chain = input.registry.get(
			op.kind === 'adjust' ? `adjust:${op.trackId}` : `run3d:${op.trackIndex}`,
		);
		if (!chain || chain.effects.length === 0) continue;
		if (op.kind === 'run3d' || !chain.layout) {
			await run(chain.effects);
			continue;
		}
		// The adjustment chain's padded layout: the composite sits at the layout's box, as in the scope's capture.
		const L = chain.layout;
		const pad = canvasOf(surfaces.p, L.width, L.height);
		const out = canvasOf(surfaces.q, L.width, L.height);
		const pctx = ctx2d(pad);
		pctx.clearRect(0, 0, L.width, L.height);
		pctx.drawImage(acc, L.box.x, L.box.y, L.box.w, L.box.h);
		await Internals.runEffectChain({
			state: chainOf(L.width, L.height),
			source: pad,
			effects: memoized(chain.effects),
			output: out,
			width: L.width,
			height: L.height,
		});
		const actx = ctx2d(acc);
		actx.save();
		actx.globalCompositeOperation = 'copy';
		actx.drawImage(out, L.box.x, L.box.y, L.box.w, L.box.h, 0, 0, W, H);
		actx.restore();
	}
	if (input.display.length) await run([...input.display]);
	if (input.underlay) {
		const [r, g, b, a] = input.underlay;
		const sctx = ctx2d(spare);
		sctx.save();
		sctx.globalCompositeOperation = 'copy';
		sctx.fillStyle = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
		sctx.fillRect(0, 0, W, H);
		sctx.restore();
		sctx.drawImage(acc, 0, 0);
		[acc, spare] = [spare, acc];
	}
	return acc;
}

// ---------------------------------------------------------------- compositor

const FILL: CSSProperties = {
	position: 'absolute',
	left: 0,
	top: 0,
	width: '100%',
	height: '100%',
	display: 'block',
};

/**
 * The flat stack's picture. `output: 'canvas'` draws it in the stack's place; `'feed'` hands it to the enclosing
 * `FxPicture` as its `source` (a nest layer whose effects run on its nested sequence's picture).
 */
export function FlatCompositor({
	stack,
	comp,
	offset,
	isPreview,
	linear,
	display = NONE,
	underlay = null,
	output = 'canvas',
}: {
	stack: FlatStackValue;
	comp: { width: number; height: number };
	offset: number;
	isPreview: boolean;
	linear: LinearBlendCurve | null;
	display?: readonly EffectDescriptor[];
	underlay?: RGBA | null;
	output?: 'canvas' | 'feed';
}) {
	const frame = useCurrentFrame() + offset;
	const rendering = getRemotionEnvironment().isRendering;
	const { hub, registry } = stack;
	const hubVersion = useSyncExternalStore(hub.subscribe, hub.getVersion, () => 0);
	const regVersion = useSyncExternalStore(registry.subscribe, registry.getVersion, () => 0);
	const feed = useContext(FxFeedContext) as FxFeed | null;
	if (output === 'feed' && !feed)
		throw new Error('FlatCompositor: output "feed" needs an enclosing FxPicture');
	const ops = stack.opsAt(frame);
	// Completeness of the frame (renders draw only the frame's own pictures).
	let complete = true;
	const parts: string[] = [];
	for (const op of ops) {
		if (op.kind === 'layers') {
			for (const it of op.items) {
				if (it.kind === 'matte') continue;
				const p = hub.pictures.get(it.key);
				if (!p || (rendering && p.frame !== frame)) complete = false;
				parts.push(`${it.key}:${p?.version ?? '-'}`);
			}
			continue;
		}
		const key = op.kind === 'adjust' ? `adjust:${op.trackId}` : `run3d:${op.trackIndex}`;
		const c = registry.get(key);
		if (!c || (rendering && (c.frame !== frame || !c.ready))) complete = false;
		parts.push(`${key}:${c?.frame ?? '-'}:${c?.key ?? '-'}`);
	}
	const drawKey = `${frame}|${parts.join(',')}|${display.map((d) => d.effectKey).join(',')}|${underlay?.join(',') ?? ''}`;
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const surfaces = useRef({ a: { c: null }, b: { c: null }, p: { c: null }, q: { c: null } } as {
		a: { c: HTMLCanvasElement | null };
		b: { c: HTMLCanvasElement | null };
		p: { c: HTMLCanvasElement | null };
		q: { c: HTMLCanvasElement | null };
	}).current;
	const chains = useRef<Chains>(new Map()).current;
	useEffect(
		() => () => {
			for (const s of chains.values()) Internals.cleanupEffectChainState(s);
			chains.clear();
		},
		[chains],
	);
	// Renders: hold the frame until it is complete and drawn.
	const hold = useRef<number | null>(null);
	if (rendering && !complete && hold.current === null)
		hold.current = delayRender(`Flat compositor at frame ${frame}`);
	const latest = useRef<DrawInput | null>(null);
	latest.current = {
		ops,
		hub,
		registry,
		width: comp.width,
		height: comp.height,
		frame,
		linear,
		preview: isPreview,
		display,
		underlay,
	};
	const drawing = useRef<{ busy: boolean; again: boolean }>({ busy: false, again: false }).current;
	const raf = useRef<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refs only
	const draw = useMemo(() => {
		const once = async () => {
			const input = latest.current;
			if (!input) return;
			const handle = rendering ? delayRender('Flat compositor draw') : null;
			try {
				const pic = await drawFlat(input, surfaces, chains);
				if (output === 'feed') feed?.feed('source', pic);
				else {
					const out = canvasRef.current;
					if (out) {
						if (out.width !== input.width) out.width = input.width;
						if (out.height !== input.height) out.height = input.height;
						const ctx = ctx2d(out);
						ctx.save();
						ctx.globalCompositeOperation = 'copy';
						ctx.drawImage(pic, 0, 0);
						ctx.restore();
					}
				}
			} catch (e) {
				if (rendering) cancelRender(e as Error);
				else console.error('[flat]', e);
			} finally {
				if (handle !== null) continueRender(handle);
			}
		};
		const loop = async () => {
			if (drawing.busy) {
				drawing.again = true;
				return;
			}
			drawing.busy = true;
			try {
				do {
					drawing.again = false;
					await once();
				} while (drawing.again);
			} finally {
				drawing.busy = false;
			}
		};
		return loop;
	}, []);
	// Renders: a nested picture is invalid as soon as the frame changes (never another frame's picture).
	// biome-ignore lint/correctness/useExhaustiveDependencies: the frame changes the picture
	useLayoutEffect(() => {
		if (rendering && output === 'feed') feed?.invalidate('source');
	}, [frame]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the frame's parts
	useLayoutEffect(() => {
		if (rendering) {
			if (!complete) return;
			void draw().then(() => {
				if (hold.current !== null) {
					continueRender(hold.current);
					hold.current = null;
				}
			});
			return;
		}
		if (typeof requestAnimationFrame === 'undefined') {
			void draw();
			return;
		}
		if (raf.current !== null) return;
		raf.current = requestAnimationFrame(() => {
			raf.current = null;
			void draw();
		});
	}, [drawKey, complete, hubVersion, regVersion]);
	useEffect(
		() => () => {
			if (raf.current !== null) cancelAnimationFrame(raf.current);
			if (hold.current !== null) continueRender(hold.current);
		},
		[],
	);
	if (output === 'feed') return null;
	return (
		<canvas
			ref={canvasRef}
			width={comp.width}
			height={comp.height}
			data-flat-compositor=""
			style={{ ...FILL, pointerEvents: 'none' }}
		/>
	);
}

const NONE: readonly EffectDescriptor[] = [];

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

/**
 * A DOM layer of a flat stack captured in composition space: its transformed element (drawn opaque and Normal) inside
 * a frame-sized HTML-in-Canvas whose only effect hands the capture to the compositor (identity placement, the layer's
 * opacity), so its pixels are exactly the ones Chrome draws for it in the nested structure. The key changes every
 * frame: a static layer delivers each frame too (renders wait for the frame's picture).
 */
export function FlatDomCapture({
	tap,
	frame,
	opacity,
	width,
	height,
	children,
}: {
	tap: LayerTap;
	frame: number;
	opacity: number;
	width: number;
	height: number;
	children?: ReactNode;
}) {
	const o = Math.min(1, Math.max(0, opacity));
	const effects = useMemo(
		() => [
			fxTap({ key: `flat-dom:${tap.side}:${frame}:${o}`, tap, meta: { compToCanvas: IDENTITY, opacity: o } }),
		],
		[tap, frame, o],
	);
	return (
		<ScopedHtmlInCanvas
			scope="A layer of the flat compositor"
			width={width}
			height={height}
			effects={effects}
			style={{ ...FILL, width, height, pointerEvents: 'none' }}
			showInTimeline={false}
		>
			<div data-flat-dom-capture="" style={{ position: 'absolute', left: 0, top: 0, width, height }}>
				{children}
			</div>
		</ScopedHtmlInCanvas>
	);
}

/** Publishes a chain into the flat stack's registry (adjustment tracks and 3D runs of a flat stack). */
export function usePublishFlatChain(key: string, chain: FlatChain): void {
	const ctx = useContext(FlatStackContext);
	useLayoutEffect(() => {
		ctx?.registry.set(key, chain);
	});
}

export type { ReactNode };
