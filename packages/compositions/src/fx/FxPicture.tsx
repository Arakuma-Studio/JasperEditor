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
	type EffectDefinitionAndStack,
	type EffectDescriptor,
	getRemotionEnvironment,
	HtmlInCanvas,
	Internals,
} from 'remotion';
import { colorLutCpu, cssFilter } from '../color/effects.ts';
import { colorStageBackend } from '../color/gl.ts';
import { loadedLutAsset } from '../color/luts.ts';
import { fxAdjustmentMix, fxCrop, fxFlip, fxLut, fxShader, fxStash, fxTap } from './effects.ts';
import type { FxRunInputs, FxTextureInput } from './host.ts';
import { fxMaskApply, fxMasked } from './mask.ts';
import { fxMatteTap, useTrackMattes } from './matte.ts';
import type { FxMediaInput, FxStage } from './stage.ts';

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

function imageSize(src: CanvasImageSource): { width: number; height: number } {
	const s = src as {
		videoWidth?: number;
		videoHeight?: number;
		naturalWidth?: number;
		naturalHeight?: number;
		width?: unknown;
		height?: unknown;
		displayWidth?: number;
		displayHeight?: number;
	};
	if (s.videoWidth) return { width: s.videoWidth, height: s.videoHeight ?? 0 };
	if (s.naturalWidth) return { width: s.naturalWidth, height: s.naturalHeight ?? 0 };
	if (s.displayWidth) return { width: s.displayWidth, height: s.displayHeight ?? 0 };
	return {
		width: typeof s.width === 'number' ? s.width : 0,
		height: typeof s.height === 'number' ? s.height : 0,
	};
}

const canvasEl = (w: number, h: number) => {
	const c = document.createElement('canvas');
	c.width = Math.max(1, w);
	c.height = Math.max(1, h);
	return c;
};

// ---------------------------------------------------------------- media images

type LoadedImage = {
	img: HTMLImageElement | null;
	failed: boolean;
	promise: Promise<HTMLImageElement | null>;
};
const imageCache = new Map<string, LoadedImage>();
/**
 * parity (roto): per-frame pictures (object-matte frames) are transient: at most this many are kept (least recently
 * used first out), so long mattes do not hold every decoded frame. Effect media (textures, maps) stay cached.
 */
const TRANSIENT_IMAGES = 96;
const transient = new Set<string>();
/** URLs whose last load failed (renders turn a failed object-matte frame into an error). */
const failedImages = new Set<string>();

/** parity (roto): the matte frame at `url` failed to load. */
export function fxImageFailed(url: string): boolean {
	return failedImages.has(url) && !imageCache.get(url)?.img;
}

function touch(url: string, entry: LoadedImage): void {
	if (!transient.has(url)) return;
	imageCache.delete(url);
	imageCache.set(url, entry);
}

/** Loads an image for WebGL (`crossOrigin = anonymous`: render pages read the engine's signed URLs cross-origin). */
export function loadFxImage(
	url: string,
	opts: { transient?: boolean } = {},
): Promise<HTMLImageElement | null> {
	const hit = imageCache.get(url);
	if (hit) {
		touch(url, hit);
		return hit.promise;
	}
	const entry: LoadedImage = {
		img: null,
		failed: false,
		promise: new Promise((resolve) => {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => {
				void (img.decode?.() ?? Promise.resolve())
					.catch(() => undefined)
					.then(() => {
						entry.img = img;
						resolve(img);
					});
			};
			img.onerror = () => {
				entry.failed = true;
				failedImages.add(url);
				if (failedImages.size > 1024) failedImages.delete(failedImages.values().next().value!);
				// A failed transient frame may be computed later (a running propagation): do not cache the failure.
				if (transient.has(url)) {
					imageCache.delete(url);
					transient.delete(url);
				}
				resolve(null);
			};
			img.src = url;
		}),
	};
	imageCache.set(url, entry);
	if (opts.transient) {
		transient.add(url);
		if (transient.size > TRANSIENT_IMAGES)
			for (const u of imageCache.keys()) {
				if (transient.size <= TRANSIENT_IMAGES) break;
				if (!transient.has(u) || u === url) continue;
				imageCache.delete(u);
				transient.delete(u);
			}
	}
	return entry.promise;
}

/** The loaded image of `url` (null while loading or after a failure). */
function loadedFxImage(url: string): HTMLImageElement | null {
	return imageCache.get(url)?.img ?? null;
}

/** The loaded images of `urls` (renders wait for them with a delayRender); re-renders on arrival. Also used by the
 * transition stage for image params. */
export function useFxImages(
	urls: readonly string[],
	rendering: boolean,
	transientUrls?: ReadonlySet<string>,
): Map<string, HTMLImageElement> {
	const key = urls.join('\n');
	const missing = urls.filter((u) => !imageCache.get(u)?.img);
	const [initial] = useState(() =>
		rendering && missing.length > 0 ? delayRender(`Loading fx image ${missing[0]}`) : null,
	);
	const [, setVersion] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the URL list
	useEffect(() => {
		const need = key ? key.split('\n').filter((u) => !imageCache.get(u)?.img) : [];
		if (need.length === 0) {
			if (initial !== null) continueRender(initial);
			return;
		}
		let alive = true;
		const handle = rendering && initial === null ? delayRender(`Loading fx image ${need[0]}`) : initial;
		Promise.all(need.map((u) => loadFxImage(u, { transient: transientUrls?.has(u) }))).then(() => {
			if (alive) setVersion((v) => v + 1);
			if (handle !== null) continueRender(handle);
		});
		return () => {
			alive = false;
		};
	}, [key]);
	const out = new Map<string, HTMLImageElement>();
	for (const u of urls) {
		const img = imageCache.get(u)?.img;
		if (img) out.set(u, img);
	}
	return out;
}

// ---------------------------------------------------------------- descriptors

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
				const textures: FxRunInputs['textures'] = {};
				const versions: string[] = [];
				for (const t of s.plan.textures) {
					const m = t.mediaId ? inputs.media.get(t.mediaId) : undefined;
					(textures as Record<string, unknown>)[t.uniform] = m ?? null;
					versions.push(m?.version ?? '-');
				}
				// Every sample picture, or none while one is not delivered yet (u_sampleCount 0, as in wave 1).
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
						inputs: {
							builtins: [...stage.builtins, { name: 'u_seed', type: 'float', value: [s.seed] }],
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
				out.splice(joined.at, 2, fxMasked({ key: s.key, geometry: s.masks, inner: first, then: [out[at]!] }));
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

const memoized = (d: readonly EffectDescriptor[]) =>
	d.map((e) => ({ ...e, memoized: true }) as EffectDefinitionAndStack<unknown>);

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

// ---------------------------------------------------------------- FxPicture (media layers)

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
					const lut = loadedLutAsset(m.url);
					if (lut) media.set(m.mediaId, { lut, version: m.url });
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
			const effects = memoized(fxDescriptors(s, { samples, sampleKeys, blank, media, preview: !rendering }));
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
				const { width, height } = imageSize(image);
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
	useEffect(
		() => () => {
			if (raf.current !== null) cancelAnimationFrame(raf.current);
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

// ---------------------------------------------------------------- FxDomPicture (DOM layers)

/**
 * A DOM layer's content through the fx chain: Remotion's `<HtmlInCanvas>` (Chrome's HTML-in-Canvas: always enabled
 * in Remotion's render browser; behind chrome://flags/#canvas-draw-element in a normal Chrome) captures the content
 * and runs the same descriptors. No time samples here (the DOM exists at one time only): `u_sampleCount` is 0.
 */
export function FxDomPicture({ stage, children }: { stage: FxStage; children?: ReactNode }) {
	const effects = useDomFxDescriptors(stage);
	const L = stage.layout;
	return (
		<HtmlInCanvas
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
		</HtmlInCanvas>
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
		const media = new Map<string, FxTextureInput>(mattes.media);
		for (const m of stage.media) {
			if (m.kind === 'lut') {
				const lut = loadedLutAsset(m.url);
				if (lut) media.set(m.mediaId, { lut, version: m.url });
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
export function canUseHtmlInCanvas(): boolean {
	try {
		return HtmlInCanvas.isSupported();
	} catch {
		return false;
	}
}

export type { FxMediaInput };
