// The picture of a layer with GPU shader effects (wave-1 fx framework; docs/wp-notes/fx-shader-framework.md).
// `FxPicture` owns the layer's output canvas — the layer box grown by the effects' padding (S03:FX-041), placed at
// (−left, −top) in the box so glows/shadows/rays draw outside it — and runs the canvas effect chain (Remotion
// `Internals.runEffectChain`, as the colour stage's ColorCanvas) on the source picture. Feeders (children) deliver
// pictures into slots: the layer source (`source`), time samples (`sample@<source frame>`) and media inputs
// (`media:<mediaId>`); every delivery and every stage change redraws.
// Renders: each draw holds a delayRender while it runs (the chain is synchronous: 2D effects on the shared GPU
// host); a video feeder invalidates its slot when the frame it shows changes, so a frame is never drawn from another
// frame's picture (parallel/random-order renders stay deterministic); its own delayRender lasts until it delivered.
// Player: draws on delivery and coalesces stage-driven redraws to one per animation frame (smooth paused scrubbing).
// `FxDomPicture` is the DOM-layer variant: the layer's DOM content inside Remotion's `<HtmlInCanvas>`.

import { fxOffsetBuiltins, type Lut } from '@jasper/project';
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	cancelRender,
	continueRender,
	delayRender,
	type EffectDescriptor,
	getRemotionEnvironment,
	HtmlInCanvas,
	Internals,
} from 'remotion';
import { colorLutCpu, cssFilter } from '../color/effects.ts';
import { colorStageBackend, sourceSize } from '../color/gl.ts';
import { loadedLutAsset, ocioConversionLut } from '../color/luts.ts';
import { memoizeEffects } from '../effect-chain.ts';
import { ScopedHtmlInCanvas } from './canvas-scope.tsx';
import { fxAdjustmentMix, fxCrop, fxFlip, fxLut, fxShader, fxStash, fxTap } from './effects.ts';
import type { FxTextureInput } from './host.ts';
import { fxImageFailed, loadedFxImage, loadFxImage, useFxImages } from './images.ts';
import { fxLowered } from './lowered.ts';
import { fxMaskApply, fxMasked } from './mask.ts';
import { fxMatteTap, useTrackMattes } from './matte.ts';
import type { FxMediaInput, FxStage } from './stage.ts';
import { fxStatus } from './status.ts';

export type FxFeed = {
	/** Copies a picture into a slot (`source`, `sample@<frame>`, `media:<mediaId>`) and redraws. */
	feed(slot: string, image: CanvasImageSource): void;
	/** Renders: the slot has no picture for the frame being rendered (until its next delivery). */
	invalidate(slot: string): void;
};

export const FxFeedContext = createContext<FxFeed | null>(null);

export function useFxFeed(): FxFeed {
	const f = useContext(FxFeedContext);
	if (!f) throw new Error('fx feeders must be rendered inside <FxPicture>');
	return f;
}

type Slot = { raw: HTMLCanvasElement; has: boolean; version: number; width: number; height: number };

const canvasEl = (w: number, h: number) => {
	const c = document.createElement('canvas');
	c.width = Math.max(1, w);
	c.height = Math.max(1, h);
	return c;
};

type DescriptorInputs = {
	/** Placed time samples by source frame (canvas-sized). */
	samples: ReadonlyMap<number, HTMLCanvasElement>;
	/** Identity of each placed sample picture (slot version), for the host's once-per-frame upload. */
	sampleKeys?: ReadonlyMap<number, string>;
	/** A transparent canvas-sized picture (samples outside the clip, `sampleEdge: 'transparent'`). */
	blank?: HTMLCanvasElement;
	/** Media pictures (or LUTs of `lut` params) by media id. */
	media: ReadonlyMap<string, FxTextureInput>;
	preview: boolean;
};

/** The canvas effect chain of a stage (shared by FxPicture and FxDomPicture). */
export function fxDescriptors(stage: FxStage, inputs: DescriptorInputs): EffectDescriptor[] {
	const out: EffectDescriptor[] = [];
	const cpu = colorStageBackend() === 'cpu';
	const box = stage.layout.box;
	// color-grade: a `maskJoin` step waits for the next step; both run inside one mask mix.
	let joined: { at: number } | null = null;
	for (const s of stage.steps) {
		// wp masks: a masked step's effect applies inside its masks only (mix with its input by coverage).
		const at = out.length;
		switch (s.kind) {
			case 'gpu': {
				const textures: Record<string, FxTextureInput | null> = {};
				const versions: string[] = [];
				for (const t of s.plan.textures) {
					const m = t.mediaId ? inputs.media.get(t.mediaId) : undefined;
					textures[t.uniform] = m ?? null;
					versions.push(m?.version ?? '-');
				}
				// Every sample picture, or none while one is not delivered yet (u_sampleCount 0).
				const sources = s.sampleFrames
					.map((f) => (f === null ? inputs.blank : inputs.samples.get(f)))
					.filter((c): c is HTMLCanvasElement => !!c);
				const complete = sources.length === s.sampleFrames.length && sources.length > 0;
				const sampleKey =
					complete && inputs.sampleKeys
						? s.sampleFrames.map((f) => (f === null ? 'blank' : inputs.sampleKeys!.get(f))).join(',')
						: undefined;
				out.push(
					fxShader({
						key: `${s.key}|${versions.join(',')}|${sampleKey ?? (complete ? 'samples' : 'none')}`,
						plan: s.plan,
						preview: inputs.preview,
						...(s.inputKey ? { inputKey: s.inputKey } : {}),
						inputs: {
							builtins: [
								...fxOffsetBuiltins(stage.builtins, s.frameOffset),
								{ name: 'u_seed', type: 'float', value: [s.seed] },
							],
							textures,
							samples: {
								sources: complete ? sources : [],
								offsets: s.sampleOffsets,
								valid: complete ? s.sampleValid : 0,
								...(sampleKey !== undefined ? { key: sampleKey } : {}),
							},
						},
					}),
				);
				break;
			}
			case 'lut':
				if (s.lut)
					out.push(cpu ? colorLutCpu({ key: s.key, lut: s.lut }) : fxLut({ key: s.key, lut: s.lut }));
				break;
			case 'css':
				out.push(cssFilter({ key: s.key, filter: s.filter }));
				break;
			case 'crop':
				out.push(fxCrop({ key: s.key, box, insets: s.insets }));
				break;
			case 'flip':
				out.push(fxFlip({ key: s.key, box, horizontal: s.horizontal }));
				break;
			case 'tap':
				out.push(fxTap({ key: s.key, tap: s.tap, meta: s.meta }));
				break;
			case 'stash':
				out.push(fxStash({ key: s.key, holder: s.holder }));
				break;
			case 'mix':
				out.push(
					fxAdjustmentMix({
						key: s.key,
						holder: s.holder,
						opacity: s.opacity,
						blend: s.blend,
						seed: s.seed,
						// Dissolve hashes sequence pixels: canvas px → sequence px.
						noise: { x: box.x, y: box.y, scale: stage.layout.pxScale },
						region: s.insets
							? {
									x: box.x + s.insets[0] * box.w,
									y: box.y + s.insets[1] * box.h,
									w: Math.max(0, box.w * (1 - s.insets[0] - s.insets[2])),
									h: Math.max(0, box.h * (1 - s.insets[1] - s.insets[3])),
								}
							: null,
						feather: s.feather?.length
							? s.feather.map((c) => ({
									x0: box.x + c.insets[0] * box.w,
									y0: box.y + c.insets[1] * box.h,
									x1: box.x + (1 - c.insets[2]) * box.w,
									y1: box.y + (1 - c.insets[3]) * box.h,
									f: c.feather * stage.layout.pxScale,
								}))
							: null,
						masks: s.opacityMasks?.length
							? { masks: s.opacityMasks, box, pxScale: stage.layout.pxScale }
							: null,
					}),
				);
				break;
			case 'mask':
				out.push(fxMaskApply({ key: s.key, geometry: s.geometry }));
				break;
			case 'matteTap':
				out.push(fxMatteTap({ key: s.key, tap: s.tap, meta: s.meta, hide: s.hide }));
				break;
		}
		if (
			s.kind !== 'mask' &&
			s.kind !== 'tap' &&
			s.kind !== 'matteTap' &&
			s.kind !== 'stash' &&
			s.kind !== 'mix' &&
			s.masks &&
			out.length === at + 1
		) {
			if (joined && joined.at === at - 1) {
				const first = out[joined.at]!;
				out.splice(
					joined.at,
					2,
					fxMasked({ key: s.key, geometry: s.masks, inner: first, followedBy: [out[at]!] }),
				);
				joined = null;
			} else if ('maskJoin' in s && s.maskJoin) joined = { at };
			else out[at] = fxMasked({ key: s.key, geometry: s.masks, inner: out[at]! });
		} else if (joined) {
			// The partner did not produce a masked descriptor: mask the waiting step alone.
			const prev = stage.steps[stage.steps.indexOf(s) - 1];
			if (prev && 'masks' in prev && prev.masks)
				out[joined.at] = fxMasked({ key: prev.key, geometry: prev.masks, inner: out[joined.at]! });
			joined = null;
		}
	}
	if (joined) {
		const last = stage.steps[stage.steps.length - 1];
		if (last && 'masks' in last && last.masks)
			out[joined.at] = fxMasked({ key: last.key, geometry: last.masks, inner: out[joined.at]! });
	}
	return out;
}

/** Style of the output canvas inside the layer box: the padded canvas at (−left, −top), in layer pixels. */
function canvasStyle(stage: FxStage): CSSProperties {
	const L = stage.layout;
	return {
		position: 'absolute',
		left: -L.padding.left,
		top: -L.padding.top,
		width: L.cssWidth,
		height: L.cssHeight,
		display: 'block',
	};
}

let pictureSerial = 0;

export function FxPicture({ stage, children }: { stage: FxStage; children?: ReactNode }) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const chain = Internals.useEffectChainState();
	const rendering = getRemotionEnvironment().isRendering;
	const stageRef = useRef(stage);
	stageRef.current = stage;
	const slots = useRef(new Map<string, Slot>());
	const placed = useRef(new Map<string, HTMLCanvasElement>());
	// Distinguishes this picture's sample uploads from other layers' in the shared GPU host.
	const [pictureId] = useState(() => `p${++pictureSerial}`);
	const raf = useRef<number | null>(null);
	const imageUrls = stage.media.filter((m) => m.kind === 'image').map((m) => m.url);
	const matteUrls = useMemo(
		() => new Set(stage.media.filter((m) => m.matte).map((m) => m.url)),
		[stage.media],
	);
	const images = useFxImages(imageUrls, rendering, matteUrls);
	const imagesRef = useRef(images);
	imagesRef.current = images;
	/** parity (roto): last drawn frame of each matte store (preview: shown while the next frame loads). */
	const lastMatte = useRef(new Map<string, HTMLImageElement>());
	// Preview: load the next frames of playing mattes ahead.
	useEffect(() => {
		if (rendering) return;
		for (const m of stage.media)
			for (const u of m.matte?.prefetch ?? []) void loadFxImage(u, { transient: true });
	}, [stage.media, rendering]);
	// wp masks: composites of the tracks the stack's Track Matte Keys read.
	const mattes = useTrackMattes(stage.trackMattes, stage.seqFrame);
	const mattesRef = useRef(mattes.media);
	mattesRef.current = mattes.media;

	const placeSlot = useCallback((name: string, w: number, h: number) => {
		let c = placed.current.get(name);
		if (!c) {
			c = canvasEl(w, h);
			placed.current.set(name, c);
		}
		if (c.width !== w) c.width = w;
		if (c.height !== h) c.height = h;
		const ctx = c.getContext('2d')!;
		ctx.clearRect(0, 0, w, h);
		const slot = slots.current.get(name);
		const b = stageRef.current.layout.box;
		if (slot?.has) ctx.drawImage(slot.raw, 0, 0, slot.width, slot.height, b.x, b.y, b.w, b.h);
		return c;
	}, []);

	const draw = useCallback(async () => {
		const out = canvasRef.current;
		if (!out) return;
		const s = stageRef.current;
		const { width: W, height: H } = s.layout;
		if (out.width !== W) out.width = W;
		if (out.height !== H) out.height = H;
		const handle = rendering ? delayRender('fx stage') : null;
		try {
			const source = placeSlot('source', W, H);
			const samples = new Map<number, HTMLCanvasElement>();
			const sampleKeys = new Map<number, string>();
			const b = s.layout.box;
			for (const f of s.samples) {
				const name = `sample@${f}`;
				samples.set(f, placeSlot(name, W, H));
				const slot = slots.current.get(name);
				if (slot?.has)
					sampleKeys.set(f, `${pictureId}:${f}:${slot.version}:${W}x${H}:${b.x},${b.y},${b.w},${b.h}`);
			}
			const blank = s.steps.some((st) => st.kind === 'gpu' && st.sampleFrames.includes(null))
				? placeSlot('sample@blank', W, H)
				: undefined;
			const media = new Map<string, FxTextureInput>(mattesRef.current);
			for (const m of s.media) {
				if (m.kind === 'lut') {
					const lut = colorLutOf(m, rendering);
					if (lut) media.set(m.mediaId, { lut, version: m.mediaId });
					continue;
				}
				if (m.kind === 'image') {
					let img = imagesRef.current.get(m.url) ?? (m.matte ? loadedFxImage(m.url) : null);
					if (m.matte) {
						if (img) lastMatte.current.set(m.matte.group, img);
						else if (rendering && fxImageFailed(m.url))
							throw new Error(`ROTO_MATTE_MISSING: the object matte frame ${m.url} could not be loaded`);
						else if (!rendering) img = lastMatte.current.get(m.matte.group) ?? null;
					}
					if (img)
						media.set(m.mediaId, {
							source: img,
							width: img.naturalWidth,
							height: img.naturalHeight,
							version: img.src,
						});
					continue;
				}
				const slot = slots.current.get(`media:${m.mediaId}`);
				if (slot?.has)
					media.set(m.mediaId, {
						source: slot.raw,
						width: slot.width,
						height: slot.height,
						version: String(slot.version),
					});
			}
			const effects = memoizeEffects(
				fxDescriptors(s, { samples, sampleKeys, blank, media, preview: !rendering }),
			);
			const state = chain.get(W, H);
			if (!state) return;
			await Internals.runEffectChain({ state, source, effects, output: out, width: W, height: H });
		} catch (e) {
			if (rendering) cancelRender(e as Error);
			else console.error('[fx]', e);
		} finally {
			if (handle !== null) continueRender(handle);
		}
	}, [chain, rendering, placeSlot, pictureId]);

	const feed = useMemo<FxFeed>(
		() => ({
			feed(name, image) {
				const { width, height } = sourceSize(image);
				if (!width || !height) return;
				let slot = slots.current.get(name);
				if (!slot) {
					slot = { raw: canvasEl(width, height), has: false, version: 0, width, height };
					slots.current.set(name, slot);
				}
				if (slot.raw.width !== width) slot.raw.width = width;
				if (slot.raw.height !== height) slot.raw.height = height;
				const ctx = slot.raw.getContext('2d')!;
				ctx.clearRect(0, 0, width, height);
				ctx.drawImage(image, 0, 0, width, height);
				slot.has = true;
				slot.version++;
				slot.width = width;
				slot.height = height;
				if (raf.current !== null) {
					cancelAnimationFrame(raf.current);
					raf.current = null;
				}
				void draw();
			},
			invalidate(name) {
				const slot = slots.current.get(name);
				if (!slot?.has) return;
				slot.has = false;
				if (rendering) void draw();
			},
		}),
		[draw, rendering],
	);

	// Stage changes (params, frame, layout, media arrival): redraw from the current pictures.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the stage identity and the loaded images
	useLayoutEffect(() => {
		if (rendering || typeof requestAnimationFrame === 'undefined') {
			void draw();
			return;
		}
		if (raf.current !== null) return;
		raf.current = requestAnimationFrame(() => {
			raf.current = null;
			void draw();
		});
	}, [stage.key, images.size, mattes.key, draw]);
	// Cleared as well as cancelled: React may run this cleanup and keep the component (Strict Mode, `<Activity>`), and a
	// stale id would keep the layout effect above from asking for a draw again (fx/flat.tsx has the same rule).
	useEffect(
		() => () => {
			if (raf.current !== null) cancelAnimationFrame(raf.current);
			raf.current = null;
		},
		[],
	);

	return (
		<FxFeedContext.Provider value={feed}>
			{children}
			<canvas
				ref={canvasRef}
				width={stage.layout.width}
				height={stage.layout.height}
				style={canvasStyle(stage)}
				data-fx-output=""
			/>
		</FxFeedContext.Provider>
	);
}

/**
 * A DOM layer's content through the fx chain: Remotion's `<HtmlInCanvas>` (Chrome's HTML-in-Canvas: always enabled
 * in Remotion's render browser; behind chrome://flags/#canvas-draw-element in a normal Chrome) captures the content
 * and runs the same descriptors. No time samples here (the DOM exists at one time only): `u_sampleCount` is 0.
 */
export function FxDomPicture({ stage, children }: { stage: FxStage; children?: ReactNode }) {
	const effects = useDomFxDescriptors(stage);
	const L = stage.layout;
	return (
		<ScopedHtmlInCanvas
			scope="A layer's effects"
			width={L.cssWidth}
			height={L.cssHeight}
			pixelDensity={L.pxScale}
			effects={effects}
			style={canvasStyle(stage)}
			showInTimeline={false}
		>
			<div
				data-fx-dom-source=""
				style={{
					position: 'absolute',
					left: L.padding.left,
					top: L.padding.top,
					width: L.box.w / L.pxScale,
					height: L.box.h / L.pxScale,
				}}
			>
				{children}
			</div>
		</ScopedHtmlInCanvas>
	);
}

/**
 * The canvas effect chain of a DOM picture's stage (`HtmlInCanvas effects`): loads the stage's image inputs (renders
 * wait), LUT assets as loaded. No time samples (the DOM exists at one time only). `null` stage → no effects.
 */
const NO_TRACKS: readonly string[] = [];

export function useDomFxDescriptors(stage: FxStage | null): EffectDescriptor[] {
	const rendering = getRemotionEnvironment().isRendering;
	const imageUrls = stage ? stage.media.filter((m) => m.kind === 'image').map((m) => m.url) : [];
	const images = useFxImages(imageUrls, rendering);
	// wp masks: composites of the tracks the stack's Track Matte Keys read.
	const mattes = useTrackMattes(stage?.trackMattes ?? NO_TRACKS, stage?.seqFrame ?? 0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the stage, the loaded images and the mattes
	return useMemo(() => {
		if (!stage) return [];
		// spec 13 AS-075: a lowered layer's effects are one Canvas 2D pass (fx/lowered.ts).
		if (stage.lowered) return [fxLowered(stage.lowered)];
		const media = new Map<string, FxTextureInput>(mattes.media);
		for (const m of stage.media) {
			if (m.kind === 'lut') {
				const lut = colorLutOf(m, rendering);
				if (lut) media.set(m.mediaId, { lut, version: m.mediaId });
				continue;
			}
			const img = m.kind === 'image' ? images.get(m.url) : undefined;
			if (img)
				media.set(m.mediaId, {
					source: img,
					width: img.naturalWidth,
					height: img.naturalHeight,
					version: m.url,
				});
		}
		return fxDescriptors(stage, { samples: new Map(), media, preview: !rendering });
	}, [stage?.key, images.size, rendering, mattes.key]);
}

/** HTML-in-Canvas is available here (Chrome ≥ 148 with the feature; always in Remotion renders). */
/**
 * A `lut` media input: a LUT asset, or (color-mgmt) the conversion LUT of a custom OCIO config. A conversion the config
 * cannot apply fails renders and shows its message in the preview (never drawn as the identity silently).
 */
function colorLutOf(m: FxMediaInput, rendering: boolean): Lut | null {
	if (!m.ocio) return loadedLutAsset(m.url) ?? null;
	const r = ocioConversionLut(m.url, m.ocio.from, m.ocio.to);
	if (!r) return null;
	if ('error' in r) {
		const msg = `S_OCIOTransform: ${r.error}`;
		if (rendering) throw new Error(`OCIO_UNSUPPORTED: ${msg}`);
		fxStatus.shaderFailed('jasper.s.ocio-transform', msg);
		return null;
	}
	return r;
}

export function canUseHtmlInCanvas(): boolean {
	try {
		return HtmlInCanvas.isSupported();
	} catch {
		return false;
	}
}

export type { FxMediaInput };
