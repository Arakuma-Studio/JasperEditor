// The single composition for Player preview, engine renders and stills (ARCHITECTURE §8, S03:ARC-002).
// A pure function of its props: it never reads editor stores (S03:ARC-003).
//
// Structure: background → video tracks V1 (bottom) → top (S01:RND-005), each clip in a
// `<Sequence from durationInFrames premountFor>` (S03:RND-020) → audio clips.
// Transitions (S01 §13): a clip's Sequence also covers its handles (content before the in-point and after the
// out-point), its opacity is multiplied by the transition ramps, and a track's mattes (the black of a dip to
// black) are drawn under its clips.
// Paint parity (S11:ANM-014): the last child of the root, `FrameRepaint`, has Chrome paint every rendered frame
// (and every paused Player frame) from scratch, so the pixels never depend on the frames painted before.
// Re-render budget (S03:ARC-011, NFR-003): `ClipLayer` reads the frame and resolves the clip's values
// (static clips resolve to the same cached object), then hands them to a memoized `LayerView` that
// skips rendering when nothing it draws changed. Layers that draw per-frame content (motion graphics, animated
// text, keyframed shapes) are `isFrameDependent` and re-render every frame.
// fx framework: layers with time-dependent GPU shader effects are frame dependent too, and a time effect's
// source-frame remap (`gpu.time.remap`) is applied here: `<Freeze>` + remapped localFrame/contentTime, `realFrame`.
// Transition framework (wave 2): a track's GPU transitions (`transitions`) are shader stages drawn above its clips
// over their spans (fx/transition.tsx); the clips that are their sides get `transition` (progress, side and the tap
// that captures their picture), or the preview's dissolve fallback ramp when the GPU cannot run them.
// edit-structure: frame holds and freeze-frame handles show one picture frame (`<Freeze>` at `pictureLocalFrame`);
// nest clips draw their nested sequence with `VideoTracks` (recursive, through `NestTracksContext`); adjustment
// clips wrap the tracks below them in an `AdjustmentScope` (layers/AdjustmentScope.tsx); the background is drawn
// inside the stack so adjustment layers process it like Premiere's composite.
// keyframes-blend: a track holding a layer whose blend mode CSS cannot draw exactly wraps everything below it in a
// `BlendScope` (fx/composite.tsx): the composite below is captured and the track's layers are composited onto it on
// the GPU at the frames where such a layer is drawn (its clips and GPU transition stages hand over their pictures).
import {
	clipContentTime,
	clipPictureTime,
	colorSpace,
	fadeFactor,
	flicksPerFrame,
	hasActiveExpression,
	isAnimated,
	isCssBlend,
	isStencilBlend,
	lookAtCamera,
	matteTrackIds,
	type RenderVisualClip,
	resolveCachedLayerProps,
	type SequenceColorInfo,
	textSourceFrameDependent,
	transitionSpec,
	vectorShapeIsTimeDependent,
} from '@jasper/project';
import {
	type ComponentType,
	type CSSProperties,
	Fragment,
	memo,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { AbsoluteFill, Freeze, Internals, Sequence, useBufferState, useCurrentFrame } from 'remotion';
import { MixGraphContext } from './audio/context.ts';
import { type MixGraph, mixGraphFor } from './audio/graph.ts';
import { installSerialAudioContext } from './audio/serial-audio-context.ts';
import { ColorDocContext, type ColorDocValue } from './color/chain.ts';
import { DisplayStage } from './color/DisplayStage.tsx';
import { useExpressionSnapshot, useTextExpressionHosts } from './expressions.ts';
import { EmojiTableContext, FontsReadyContext, useFontsReadyState, useLayerFontsReady } from './fonts.ts';
import { type FrameSpan, FrameWindow } from './frame-window.tsx';
import { CanvasOwnerContext } from './fx/canvas-scope.tsx';
import { installCaptureSafeCanvases } from './fx/capture-safe-canvas.ts';
import {
	BlendFallback,
	BlendScope,
	BlendTrackContext,
	type BlendTrackValue,
	CompositeHub,
	compositeRunMode,
	LINEAR_MARK,
	makeBlendGroup,
	makeBlendTrack,
	makeLinearBlendGroup,
	useCompositeTap,
} from './fx/composite.tsx';
import { type CompositeTrackInput, type LinearBlendCurve, trackHasGlBlend } from './fx/composite-plan.ts';
import { canUseHtmlInCanvas } from './fx/FxPicture.tsx';
import {
	FlatCompositor,
	FlatDisplayContext,
	FlatDomCapture,
	FlatRegistry,
	FlatStackContext,
	makeFlatStack,
} from './fx/flat.tsx';
import {
	clipDrawsThroughCanvas,
	docUsesCanvas,
	type FlatTrackInput,
	flatStackReason,
	isDomPictureClip,
	type StackScope,
} from './fx/flat-plan.ts';
import { TrackMatteContext, TrackMatteHub } from './fx/matte.ts';
import { useFxStatus } from './fx/status.ts';
import { fxRemapFrame, hasTimeDependentFx } from './fx/time.ts';
import {
	TransitionHub,
	type TransitionSideEntry,
	TransitionSidesContext,
	TransitionStage,
	transitionFallbackFactor,
	transitionProgressAt,
	transitionRunMode,
} from './fx/transition.tsx';
import { AdjustmentScope, cssExactAdjustment, FlatAdjustment } from './layers/AdjustmentScope.tsx';
import { AudioLayer, layerComponentFor, useGraphEpoch, useGraphLatency } from './layers/index.ts';
import { NestCompSizeContext, NestTracksContext } from './layers/nest-context.ts';
import { TextExpressionContext } from './layers/text/expression-context.ts';
import { rgbaCss } from './metadata.ts';
import { blendModeCss, premountFrames } from './pipeline.ts';
import { applyPreviews, PreviewLayers } from './previews.tsx';
import { FrameRepaint } from './repaint.tsx';
import { ShowFrame } from './show-frame.tsx';
import {
	FlatRun3D,
	fallbackProjective,
	makeScene3D,
	runBottomTracks,
	Scene3DContext,
	Scene3DFallback,
	Scene3DHub,
	Scene3DScope,
	scene3dRunMode,
	useScene3DTap,
} from './three-d/scope.tsx';
import type { LayerProps, RenderDoc, RenderOptions, SequenceCompositionProps } from './types.ts';

// Video canvases must stay capturable by HTML-in-Canvas scopes (fx/capture-safe-canvas.ts), and the Player's audio
// clock must never freeze between a resume and a suspend (audio/serial-audio-context.ts: the stall after seeks).
installCaptureSafeCanvases();
installSerialAudioContext();

/** compositor: whether a nested snapshot draws through HTML-in-Canvas (cached per snapshot). */
const nestCanvas = new WeakMap<object, boolean>();
function nestUsesCanvas(sub: RenderDoc): boolean {
	let v = nestCanvas.get(sub);
	if (v === undefined) {
		v = docUsesCanvas(sub, cssExactAdjustment);
		nestCanvas.set(sub, v);
	}
	return v;
}

/** Kinds whose layer output depends on the frame beyond what `ResolvedLayerProps` captures. */
const FRAME_DEPENDENT_KINDS: ReadonlySet<string> = new Set([
	'motion-graphic',
	'animated-image',
	'composition',
	// edit-structure: a nested sequence plays its own content.
	'nest-video',
	// wp captions: pages and the active-word highlight change with the frame
	'captions',
]);

/**
 * Layers whose output depends on the frame beyond `ResolvedLayerProps` (ARCHITECTURE §20.4): the
 * FRAME_DEPENDENT_KINDS, text clips with animators in their source (S11:TXA-009) and shapes whose geometry or
 * paint is keyframed (evaluated by the layer, S11:SHP-003).
 */
function isFrameDependent(
	clip: Pick<RenderVisualClip, 'kind' | 'source' | 'effects' | 'retime'>,
	media?: RenderDoc['media'],
): boolean {
	if (FRAME_DEPENDENT_KINDS.has(clip.kind)) return true;
	if (clip.retime) return true;
	// A shader effect that changes over time (incl. a media param bound to a video that plays).
	if (hasTimeDependentFx(clip, undefined, media ? (id) => media[id]?.kind : undefined)) return true;
	const src = clip.source;
	if ('generator' in src) return src.generator.kind === 'counting-leader';
	// A Source Text expression (wave expressions) changes the text per frame.
	if ('text' in src)
		return (
			(!!src.animation && !!(src.animation.in || src.animation.out)) ||
			hasActiveExpression(src.text) ||
			// text-animators: animators, Source Text keys and text paths are evaluated per frame by the layer.
			textSourceFrameDependent(src)
		);
	if ('shape' in src) {
		const s = src.shape;
		// wp shapes: keyframes / expressions anywhere in the contents, or a self-animating Wiggle Paths.
		if (s.type === 'vector') return vectorShapeIsTimeDependent(s.contents);
		return (
			isAnimated(s.size) ||
			isAnimated(s.fill) ||
			isAnimated(s.cornerRadius) ||
			isAnimated(s.stroke?.color) ||
			isAnimated(s.stroke?.width)
		);
	}
	return false;
}

/**
 * Audio clips' Sequences: Remotion premounts only Sequences with a layout (an empty AbsoluteFill here, which must
 * never take the pointer).
 */
const AUDIO_SEQUENCE_STYLE: CSSProperties = { pointerEvents: 'none' };

/** Media kinds get a 2 s premount so decoders warm up before the cut (S03:RND-020). */
const PREMOUNT_KINDS: ReadonlySet<string> = new Set(['video', 'still', 'animated-image']);

type ViewProps = LayerProps & { Component: ComponentType<LayerProps>; frameDependent: boolean };

/** Equality for LayerView: frame-independent layers ignore localFrame/contentTime. */
function layerViewEqual(a: ViewProps, b: ViewProps): boolean {
	if (
		a.Component !== b.Component ||
		a.clip !== b.clip ||
		a.props !== b.props ||
		a.media !== b.media ||
		a.options !== b.options ||
		a.fps !== b.fps ||
		a.fonts !== b.fonts ||
		a.transition !== b.transition ||
		a.matte !== b.matte ||
		a.composite !== b.composite
	)
		return false;
	if (a.frameDependent || b.frameDependent)
		return a.localFrame === b.localFrame && a.realFrame === b.realFrame && a.pictureTime === b.pictureTime;
	return true;
}

/** Frame dependence of a clip in a document (cached per clip object and media table). */
const frameDependence = new WeakMap<RenderVisualClip, { media: RenderDoc['media']; value: boolean }>();
function frameDependentIn(clip: RenderVisualClip, media: RenderDoc['media']): boolean {
	const hit = frameDependence.get(clip);
	if (hit && hit.media === media) return hit.value;
	const value = isFrameDependent(clip, media);
	frameDependence.set(clip, { media, value });
	return value;
}

const LayerView = memo(function LayerView({ Component, frameDependent: _fd, ...layer }: ViewProps) {
	return <Component {...layer} />;
}, layerViewEqual);

const ClipLayer = memo(function ClipLayer({
	clip,
	doc,
	options,
	matteHub,
	matteOnly,
}: {
	clip: RenderVisualClip;
	doc: RenderDoc;
	options: RenderOptions;
	/** wp masks: the hub of this clip's track when a Track Matte Key reads it. */
	matteHub?: TrackMatteHub;
	matteOnly?: boolean;
}) {
	// Inside the Sequence the current frame counts from its start, also when `from` is negative (a render
	// range starting mid-clip): Remotion subtracts the absolute `from`. The Sequence starts `headHandle`
	// frames before the clip, so the clip-local frame is negative inside the handle.
	const localFrame = useCurrentFrame() - (clip.headHandle ?? 0);
	const frame = clip.start + localFrame;
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const contentTime = clipContentTime(clip, frame, doc.settings.fps);
	// edit-structure: the frame whose picture is shown (frame holds, freeze-frame handles).
	const pictureLocal = pictureLocalFrame(clip, localFrame, doc.settings.fps);
	const pictureTime = clipPictureTime(clip, clip.start + pictureLocal, doc.settings.fps);
	// A held clip is drawn as a clip whose first frame is the held content (its axis starts at the hold).
	const heldClip = useMemo(
		() =>
			clip.frameHold
				? {
						...clip,
						sourceIn: clip.frameHold.flicks,
						speed: { ...clip.speed, reverse: false },
						// Its axis starts at the held content (frame 0), handles included.
						headHandle: 0,
						tailHandle: 0,
					}
				: null,
		[clip],
	);
	const resolved = resolveCachedLayerProps(clip, contentTime);
	// Transition framework: the GPU transition this clip is a side of at this frame (if any).
	const sides = useContext(TransitionSidesContext).get(clip.clipId);
	const entry = sides?.find((e) => frame >= e.t.start && frame < e.t.start + e.t.duration);
	const gpuSide = entry?.mode.mode === 'gpu' ? entry : null;
	const progress = gpuSide
		? transitionProgressAt(gpuSide.t, gpuSide.spec, frame, flicksPerFrame(doc.settings.fps))
		: 0;
	const tap = gpuSide ? gpuSide.hub.tap(gpuSide.side) : null;
	const transition = useMemo(() => (tap ? { progress, side: tap.side, tap } : undefined), [tap, progress]);
	// keyframes-blend: a layer its track's blend scope composites at this frame hands its picture to the scope.
	const compositeTap = useCompositeTap(clip.clipId, frame);
	// three-d: a 3D layer of a run hands its layer-space picture to the run's 3D scope.
	const scene3d = useContext(Scene3DContext);
	const tap3d = useScene3DTap(clip.clipId, frame);
	const media0 = 'mediaId' in clip.source ? (doc.media[clip.source.mediaId] ?? null) : null;
	// compositor: in a flat stack a DOM layer that needs no canvas chain of its own (no effects run on its pixels, not
	// read as a matte) is captured in composition space as Chrome draws it (FlatDomCapture), not in layer space and
	// resampled: text and shapes keep the exact edges they have in the nested structure.
	const flatStack = useContext(FlatStackContext);
	const compSpace =
		!!flatStack &&
		!!compositeTap &&
		!gpuSide &&
		!matteOnly &&
		!tap3d &&
		!matteHub?.tap(clip.clipId) &&
		isDomPictureClip(clip, media0) &&
		!clipDrawsThroughCanvas(clip, media0, false) &&
		// A nested sequence that draws through HTML-in-Canvas itself is a canvas source (NestLayer), never captured.
		!('nest' in clip.source && nestUsesCanvas(clip.source.nest.snapshot));
	const composite = useMemo(
		() =>
			tap3d && !matteOnly
				? { tap: tap3d }
				: compositeTap && !gpuSide && !matteOnly && !compSpace
					? { tap: compositeTap }
					: undefined,
		[tap3d, compositeTap, gpuSide, matteOnly, compSpace],
	);
	const matteTap = matteHub?.tap(clip.clipId);
	const matte = useMemo(
		() => (matteTap ? { tap: matteTap, hide: !!matteOnly, seqFrame: frame } : undefined),
		[matteTap, matteOnly, frame],
	);
	// Transition ramps multiply the opacity; outside a ramp the (cached) props object is passed through.
	const fade =
		fadeFactor(clip.fades, frame) *
		(entry && !gpuSide ? transitionFallbackFactor(entry.t, entry.side, frame) : 1);
	// three-d: without the GPU scope (Player fallback) a 3D layer is drawn through its 3D homography (no depth sort).
	const fallback3d = !!clip.threeD && !!scene3d && scene3d.mode.mode === 'fallback';
	const projective3d = fallback3d
		? fallbackProjective(clip, resolved, frame, scene3d!.doc, scene3d!.cameraAt(frame))
		: null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the projective map is compared by value (a new array per render)
	const shown = useMemo(() => {
		const base = fade === 1 ? resolved : { ...resolved, opacity: resolved.opacity * fade };
		if (!fallback3d) return base;
		return projective3d ? { ...base, projective: projective3d } : { ...base, opacity: 0 };
	}, [resolved, fade, fallback3d, projective3d?.join(',')]);
	// compositor: a composition-space capture draws the layer opaque and Normal; the compositor applies both.
	const props = useMemo(() => (compSpace ? { ...shown, opacity: 100 } : shown), [compSpace, shown]);
	const drawnClip = useMemo(
		() => (compSpace ? { ...clip, blendMode: 'normal' as const } : clip),
		[compSpace, clip],
	);
	const media = media0;
	const Component = layerComponentFor({ clip, media });
	// S11:FIX-003: font-dependent layers mount once their faces are loaded (no fallback-font paint/measure).
	const fontsReady = useLayerFontsReady(clip, doc.fonts);
	// fx framework: a time effect shows the source at another frame (Motion/opacity/params stay at the real time).
	const remapped = fxRemapFrame(clip, props.effects, pictureLocal, fps);
	const frameDependent = frameDependentIn(clip, doc.media);
	if (!fontsReady) return null;
	let view: ReactNode;
	if (remapped === null && pictureLocal !== localFrame)
		view = (
			<ShowFrame frame={heldClip ? 0 : Math.max(0, pictureLocal + (clip.headHandle ?? 0))}>
				<LayerView
					Component={Component}
					frameDependent={frameDependent}
					clip={heldClip ? (compSpace ? { ...heldClip, blendMode: 'normal' as const } : heldClip) : drawnClip}
					props={props}
					localFrame={heldClip ? 0 : pictureLocal}
					realFrame={localFrame}
					contentTime={contentTime}
					pictureTime={pictureTime}
					fps={fps}
					media={media}
					options={options}
					fonts={doc.fonts}
					transition={transition}
					matte={matte}
					composite={composite}
				/>
			</ShowFrame>
		);
	else if (remapped !== null)
		view = (
			<Freeze frame={remapped + (clip.headHandle ?? 0)}>
				<LayerView
					Component={Component}
					frameDependent={frameDependent}
					clip={drawnClip}
					props={props}
					localFrame={remapped}
					realFrame={localFrame}
					contentTime={clipContentTime(clip, clip.start + remapped, doc.settings.fps)}
					pictureTime={clipPictureTime(clip, clip.start + remapped, doc.settings.fps)}
					fps={fps}
					media={media}
					options={options}
					fonts={doc.fonts}
					transition={transition}
					matte={matte}
					composite={composite}
				/>
			</Freeze>
		);
	else
		view = (
			<LayerView
				Component={Component}
				frameDependent={frameDependent}
				clip={drawnClip}
				props={props}
				localFrame={localFrame}
				contentTime={contentTime}
				pictureTime={pictureTime}
				fps={fps}
				media={media}
				options={options}
				fonts={doc.fonts}
				transition={transition}
				matte={matte}
				composite={composite}
			/>
		);
	if (compSpace && compositeTap)
		return (
			<FlatDomCapture
				tap={compositeTap}
				frame={frame}
				opacity={shown.opacity / 100}
				width={doc.settings.width}
				height={doc.settings.height}
			>
				{view}
			</FlatDomCapture>
		);
	return view;
});

/**
 * edit-structure: the clip-local frame whose picture a clip shows at `localFrame` — the held frame of a frame hold
 * (rounded to the frame grid), or the edge frame inside freeze-frame transition handles; else `localFrame`.
 */
function pictureLocalFrame(
	clip: Pick<
		RenderVisualClip,
		| 'start'
		| 'duration'
		| 'sourceIn'
		| 'speed'
		| 'frameHold'
		| 'headHandle'
		| 'tailHandle'
		| 'freezeHead'
		| 'freezeTail'
	>,
	localFrame: number,
	fps: { num: number; den: number },
): number {
	if (clip.frameHold) {
		const step = flicksPerFrame(fps) * clip.speed.rate;
		const i = Math.round((clip.frameHold.flicks - clip.sourceIn) / step);
		return clip.speed.reverse ? clip.duration - 1 - i : i;
	}
	const firstReal = -(clip.headHandle ?? 0) + (clip.freezeHead ?? 0);
	if (clip.freezeHead && localFrame < firstReal) return firstReal;
	const lastReal = clip.duration + (clip.tailHandle ?? 0) - (clip.freezeTail ?? 0) - 1;
	if (clip.freezeTail && localFrame > lastReal) return lastReal;
	return localFrame;
}

/**
 * The video tracks of a render doc, bottom → top, with their background (S01:RND-005): used for the sequence and,
 * recursively, for nested sequences (`NestLayer` through `NestTracksContext`). `offset` = the doc frame shown at the
 * enclosing Sequence's frame 0 (`doc.range.start` for the root).
 */
export function VideoTracks({
	doc,
	options,
	offset,
	flat: flatOutput,
}: {
	doc: SequenceCompositionProps['doc'];
	options: SequenceCompositionProps['options'];
	offset: number;
	/**
	 * compositor: draw flat and hand the picture to the enclosing `FxPicture` (a nest layer whose effects run on its
	 * nested sequence's picture, NestLayer).
	 */
	flat?: 'feed';
}) {
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const premount = premountFrames(fps);
	// ui-perf: the frames a clip's Sequence draws or premounts in (FrameWindow mounts only the clips near the frame).
	const clipSpan = useCallback(
		(clip: RenderVisualClip): FrameSpan => {
			const from = clip.start - (clip.headHandle ?? 0) - offset;
			return [
				from - (PREMOUNT_KINDS.has(clip.kind) ? premount : 0),
				from + clip.duration + (clip.headHandle ?? 0) + (clip.tailHandle ?? 0),
			];
		},
		[offset, premount],
	);
	const gpu = useFxStatus();
	const htmlInCanvas = canUseHtmlInCanvas();
	// One hub per transition id for the life of the composition (the sides' taps and the stage meet there).
	const hubs = useRef(new Map<string, TransitionHub>());
	const hubOf = (id: string) => {
		let h = hubs.current.get(id);
		if (!h) {
			h = new TransitionHub();
			hubs.current.set(id, h);
		}
		return h;
	};
	// wp masks: one matte hub per track a Track Matte Key reads (keyed by the frame size of the document).
	const matteHubs = useRef(new Map<string, TrackMatteHub>());
	const matteHubOf = (trackId: string) => {
		const key = `${trackId}@${doc.settings.width}x${doc.settings.height}`;
		let h = matteHubs.current.get(key);
		if (!h) {
			h = new TrackMatteHub(trackId, { width: doc.settings.width, height: doc.settings.height });
			matteHubs.current.set(key, h);
		}
		return h;
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: matteHubOf reads a ref
	const matteContext = useMemo(() => {
		const ids = matteTrackIds({ videoTracks: [...doc.videoTracks, ...(doc.matteTracks ?? [])] });
		const out = new Map<string, TrackMatteHub>();
		for (const id of ids) out.set(id, matteHubOf(id));
		return out;
	}, [doc.videoTracks, doc.matteTracks, doc.settings.width, doc.settings.height]);
	// Hidden tracks read as mattes: their clips feed the hub only (no transitions, no visible output).
	const hiddenMattes = useMemo(
		() =>
			(doc.matteTracks ?? []).map((t) => {
				const hub = matteContext.get(t.trackId);
				hub?.setClips(t.clips, doc.media);
				return { trackId: t.trackId, clips: t.clips, hub };
			}),
		[doc.matteTracks, doc.media, matteContext],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: hubOf reads a ref
	const tracks = useMemo(
		() =>
			doc.videoTracks.map((t) => {
				const all = options.layerFilter
					? t.clips.filter((c) => options.layerFilter!.includes(c.clipId))
					: t.clips;
				// edit-structure: adjustment clips wrap the tracks below (AdjustmentScope), they are not layers.
				const adjustments = all.filter((c) => c.kind === 'adjustment');
				const clips = all.filter((c) => c.kind !== 'adjustment');
				// Layer renders (bakes of single clips) draw no stages, as no mattes.
				const byId = new Map(clips.map((c) => [c.clipId, c]));
				const sides = new Map<string, TransitionSideEntry[]>();
				const stages: (TransitionSideEntry & { blendMode?: string; blendModeId: string })[] = [];
				for (const tr of options.layerFilter ? [] : (t.transitions ?? [])) {
					const spec = transitionSpec(tr.effectId);
					if (!spec) continue;
					const mode = transitionRunMode(tr, spec, byId, doc.media, { gpu, htmlInCanvas });
					const hub = hubOf(tr.id);
					const sideClips = (['out', 'in'] as const)
						.map((side) => ({
							side,
							clip: byId.get((side === 'out' ? tr.outgoingClipId : tr.incomingClipId) ?? ''),
						}))
						.filter((x): x is { side: 'out' | 'in'; clip: RenderVisualClip } => !!x.clip);
					for (const { side, clip } of sideClips) {
						const list = sides.get(clip.clipId) ?? [];
						list.push({ t: tr, spec, side, mode, hub });
						sides.set(clip.clipId, list);
					}
					const modes = new Set(sideClips.map((x) => x.clip.blendMode));
					// The stage composites with the sides' common blend mode (GPU fallback: the sides draw themselves).
					const blendModeId = modes.size === 1 && mode.mode === 'gpu' ? [...modes][0]! : 'normal';
					const blend = blendModeCss(blendModeId);
					stages.push({
						t: tr,
						spec,
						side: 'in',
						mode,
						hub,
						blendModeId,
						...(blend ? { blendMode: blend } : {}),
					});
				}
				const matteHub = matteContext.get(t.trackId);
				matteHub?.setClips(clips, doc.media);
				return {
					trackId: t.trackId,
					clips,
					adjustments,
					mattes: options.layerFilter ? [] : (t.mattes ?? []),
					sides,
					stages,
					matteHub,
				};
			}),
		[doc.videoTracks, doc.media, options.layerFilter, gpu, htmlInCanvas, matteContext],
	);
	const comp = useMemo(
		() => ({ width: doc.settings.width, height: doc.settings.height, fps }),
		[doc.settings.width, doc.settings.height, fps],
	);
	const fpf = flicksPerFrame(doc.settings.fps);
	// keyframes-blend: the blend scope of each track holding a GL item (layer renders composite nothing: a baked
	// layer's blend mode is applied where the bake is composited).
	const compositeHubs = useRef(new Map<string, CompositeHub>());
	// color-mgmt: Blend using 1.0 gamma / Linearize Working Space (the working curve layers blend in).
	const linearCurve = linearBlendCurveOf(doc.settings.color);
	const blendTracks = useMemo(() => {
		const out = new Map<
			string,
			{
				value: BlendTrackValue;
				glModesAt: (f: number) => string[];
				/** False for the upper tracks of a linear-light run (they composite in the lowest track's scope). */
				scope: boolean;
			}
		>();
		if (options.layerFilter) return out;
		const isGpuSide = (clipId: string, f: number) => {
			for (const t of tracks) {
				const e = t.sides.get(clipId);
				if (e?.some((x) => x.mode.mode === 'gpu' && f >= x.t.start && f < x.t.start + x.t.duration))
					return true;
			}
			return false;
		};
		type Run = { members: Parameters<typeof makeLinearBlendGroup>[0][number][]; first: string };
		const runs: Run[] = [];
		let run: Run | null = null;
		// previews (scope nesting): consecutive GL-blend tracks share one scope; an adjustment layer or the bottom of a
		// 3D run (scopes of their own over the stack) ends a run.
		const glRuns: Run[] = [];
		let glRun: Run | null = null;
		const bottoms3d: ReadonlySet<number> = doc.videoTracks.some((t) => t.clips.some((c) => c.threeD))
			? runBottomTracks(
					doc.videoTracks,
					doc.range.end > doc.range.start ? doc.range : { start: 0, end: Number.MAX_SAFE_INTEGER },
					{},
				)
			: new Set<number>();
		for (const [ti, t] of tracks.entries()) {
			const input: CompositeTrackInput = {
				trackId: t.trackId,
				// three-d: 3D layers are composited by their run's 3D scope (blend modes included), never here.
				clips: t.clips
					.filter((c) => !c.threeD)
					.map((c) => ({
						clipId: c.clipId,
						start: c.start,
						duration: c.duration,
						headHandle: c.headHandle ?? 0,
						tailHandle: c.tailHandle ?? 0,
						blendMode: c.blendMode,
					})),
				stages: t.stages.map((st) => ({
					id: st.t.id,
					start: st.t.start,
					duration: st.t.duration,
					blendMode: st.blendModeId,
				})),
			};
			if (linearCurve) {
				// color-mgmt: a run of tracks blending in linear light shares one scope (Chrome cannot nest
				// HTML-in-Canvas scopes); an adjustment layer starts a new run (it applies to the composite below it).
				if (t.adjustments.length > 0) run = null;
				if (!trackHasGlBlend(input, true)) continue;
				if (!run) {
					run = { members: [], first: t.trackId };
					runs.push(run);
				}
				run.members.push({ input, mattes: t.mattes });
				continue;
			}
			if (t.adjustments.length > 0 || bottoms3d.has(ti)) glRun = null;
			if (!glRun) {
				if (!trackHasGlBlend(input, false)) continue;
				glRun = { members: [], first: t.trackId };
				glRuns.push(glRun);
			}
			glRun.members.push({ input, mattes: t.mattes });
		}
		for (const r of glRuns) {
			if (r.members.length > 1) {
				const key = `group:${r.first}`;
				let hub = compositeHubs.current.get(key);
				if (!hub) {
					hub = new CompositeHub();
					compositeHubs.current.set(key, hub);
				}
				const all = r.members.flatMap((m) => [
					...m.input.clips.map((c) => ({ ...c, kind: 'clip' as const })),
					...m.input.stages.map((st) => ({ ...st, kind: 'stage' as const })),
				]);
				const mode = compositeRunMode(
					{ gpu, htmlInCanvas },
					all.map((x) => x.blendMode).filter((m) => !isCssBlend(m)),
				);
				const value = makeBlendGroup(r.members, isGpuSide, mode, hub);
				const glModesAt = (f: number) =>
					all
						.filter((x) =>
							x.kind === 'clip'
								? f >= x.start - (x.headHandle ?? 0) && f < x.start + x.duration + (x.tailHandle ?? 0)
								: f >= x.start && f < x.start + x.duration,
						)
						.map((x) => x.blendMode)
						.filter((m) => !isCssBlend(m));
				r.members.forEach((m, i) => {
					out.set(m.input.trackId, { value, glModesAt: i === 0 ? glModesAt : () => [], scope: i === 0 });
				});
				continue;
			}
			const input = r.members[0]!.input;
			const t = { trackId: input.trackId };
			let hub = compositeHubs.current.get(t.trackId);
			if (!hub) {
				hub = new CompositeHub();
				compositeHubs.current.set(t.trackId, hub);
			}
			const glModes = [
				...input.clips.map((c) => c.blendMode),
				...input.stages.map((st) => st.blendMode),
			].filter((m) => !isCssBlend(m));
			// color-mgmt: with Blend using 1.0 gamma every layer is composited by the scope.
			if (linearCurve) glModes.push(LINEAR_MARK);
			const mode = compositeRunMode({ gpu, htmlInCanvas }, glModes);
			const value = makeBlendTrack(input, isGpuSide, mode, hub, linearCurve);
			const glModesAt = (f: number) =>
				[
					...input.clips.filter(
						(c) => f >= c.start - (c.headHandle ?? 0) && f < c.start + c.duration + (c.tailHandle ?? 0),
					),
					...input.stages.filter((st) => f >= st.start && f < st.start + st.duration),
				]
					.flatMap((x) => (linearCurve ? [x.blendMode, LINEAR_MARK] : [x.blendMode]))
					.filter((m) => m === LINEAR_MARK || !isCssBlend(m));
			out.set(t.trackId, { value, glModesAt, scope: true });
		}
		for (const r of runs) {
			const key = `linear:${r.first}`;
			let hub = compositeHubs.current.get(key);
			if (!hub) {
				hub = new CompositeHub();
				compositeHubs.current.set(key, hub);
			}
			const mode = compositeRunMode({ gpu, htmlInCanvas }, [LINEAR_MARK]);
			const value = makeLinearBlendGroup(r.members, isGpuSide, mode, hub, linearCurve!);
			const glModesAt = (f: number) => (value.itemsAt(f) ? [LINEAR_MARK] : []);
			r.members.forEach((m, i) => {
				out.set(m.input.trackId, { value, glModesAt: i === 0 ? glModesAt : () => [], scope: i === 0 });
			});
		}
		return out;
	}, [tracks, options.layerFilter, gpu, htmlInCanvas, linearCurve, doc.videoTracks, doc.range]);
	// three-d: a 3D scope (and its hub) per track that holds a 3D clip; the runs of every frame.
	// One hub for every scope: a member's tap stays the same when the run it belongs to moves to another bottom track
	// (a layer only delivers when it repaints, so a new hub would never get its picture).
	const scene3dHub = useRef<Scene3DHub | null>(null);
	const nested = useContext(NestCompSizeContext) !== null;
	const scene3d = useMemo(() => {
		const hubs = new Map<number, Scene3DHub>();
		if (!doc.videoTracks.some((t) => t.clips.some((c) => c.threeD))) return null;
		// Only the tracks where a run starts get a scope (it captures exactly the composite below the run).
		const bottoms = runBottomTracks(
			doc.videoTracks,
			doc.range.end > doc.range.start ? doc.range : { start: 0, end: Number.MAX_SAFE_INTEGER },
			options.layerFilter ? { layerFilter: options.layerFilter } : {},
		);
		scene3dHub.current ??= new Scene3DHub();
		for (const i of bottoms) hubs.set(i, scene3dHub.current);
		// The Program monitor's 3D view (preview only, the top-level sequence only).
		const v = options.isPreview && !nested ? options.view3d : undefined;
		return makeScene3D(
			doc,
			scene3dRunMode({ gpu, htmlInCanvas }),
			hubs,
			options.layerFilter,
			v ? lookAtCamera(v.eye, v.poi, v.zoom, v.ortho, v.down) : null,
		);
	}, [doc, gpu, htmlInCanvas, options.layerFilter, options.view3d, options.isPreview, nested]);
	const gpu3d = scene3d?.mode.mode === 'gpu';
	// compositor: a stack whose canvas scopes would nest is drawn flat (fx/flat.tsx, fx/flat-plan.ts). Decided
	// statically from the stack; a scope that still finds itself inside another asks for it at run time
	// (CanvasOwnerContext). The Program monitor's display transform makes the sequence's own stack flat whenever
	// anything in it draws through HTML-in-Canvas (FlatDisplayContext).
	const flatDisplay = useContext(FlatDisplayContext);
	const [flatRequested, setFlatRequested] = useState(false);
	const requestFlat = useCallback(() => setFlatRequested(true), []);
	// Layer renders (bakes of single clips) composite nothing; a nest's canvas source always draws its picture.
	const canFlat = gpu === 'ok' && htmlInCanvas && (!options.layerFilter || !!flatOutput);
	const flatReason = useMemo(() => {
		if (!canFlat) return null;
		const scopes: StackScope[] = [];
		const canvasTracks: number[] = [];
		tracks.forEach((t, i) => {
			if (t.adjustments.length > 0 && !t.adjustments.every(cssExactAdjustment))
				scopes.push({ track: i, kind: 'adjustment' });
			const b = blendTracks.get(t.trackId);
			if (b?.scope && b.value.mode.mode === 'gpu')
				scopes.push({ track: i, kind: b.value.linear ? 'linear' : 'blend' });
			if (gpu3d && scene3d?.hubOf(i)) scopes.push({ track: i, kind: '3d' });
			const readAsMatte = matteContext.has(t.trackId);
			const canvas = t.clips.some((c) => {
				// 3D members draw outside every scope.
				if (gpu3d && c.threeD) return false;
				const media = 'mediaId' in c.source ? doc.media[c.source.mediaId] : null;
				const side = t.sides.get(c.clipId)?.some((e) => e.mode.mode === 'gpu') ?? false;
				if (clipDrawsThroughCanvas(c, media, side || readAsMatte)) return true;
				return 'nest' in c.source && docUsesCanvas(c.source.nest.snapshot, cssExactAdjustment);
			});
			if (canvas) canvasTracks.push(i);
		});
		return flatStackReason(scopes, canvasTracks);
	}, [canFlat, tracks, blendTracks, gpu3d, scene3d, matteContext, doc.media]);
	const flat =
		canFlat && (!!flatOutput || flatRequested || (!nested && !!flatDisplay) || flatReason !== null);
	const flatHub = useRef<CompositeHub | null>(null);
	const flatRegistry = useRef<FlatRegistry | null>(null);
	const background0 = options.transparentBackground ? null : doc.settings.backgroundColor;
	const flatStack = useMemo(() => {
		if (!flat) return null;
		flatHub.current ??= new CompositeHub();
		flatRegistry.current ??= new FlatRegistry();
		const inputs: FlatTrackInput[] = tracks.map((t, index) => ({
			trackId: t.trackId,
			index,
			layers: {
				trackId: t.trackId,
				// three-d: 3D layers are drawn by their run (FlatRun3D), never as items.
				clips: t.clips
					.filter((c) => !(gpu3d && c.threeD))
					.map((c) => ({
						clipId: c.clipId,
						start: c.start,
						duration: c.duration,
						headHandle: c.headHandle ?? 0,
						tailHandle: c.tailHandle ?? 0,
						blendMode: c.blendMode,
					})),
				stages: t.stages.map((st) => ({
					id: st.t.id,
					start: st.t.start,
					duration: st.t.duration,
					blendMode: st.blendModeId,
				})),
			},
			mattes: t.mattes,
			adjustments: t.adjustments,
		}));
		const isGpuSide = (clipId: string, f: number) => {
			for (const t of tracks) {
				const e = t.sides.get(clipId);
				if (e?.some((x) => x.mode.mode === 'gpu' && f >= x.t.start && f < x.t.start + x.t.duration))
					return true;
			}
			return false;
		};
		return makeFlatStack(
			inputs,
			{
				background: background0 && background0[3] > 0 ? background0 : null,
				isGpuSide,
				run3dAt: (i, f) =>
					!!gpu3d && !!scene3d?.hubOf(i) && scene3d.runsAt(f).some((r) => r.bottomTrack === i),
			},
			flatHub.current,
			flatRegistry.current,
			{ mode: 'gpu' },
			linearCurve,
		);
	}, [flat, tracks, gpu3d, scene3d, background0, linearCurve]);
	const stencilledIn = (bg: typeof background0) =>
		!!bg &&
		bg[3] > 0 &&
		tracks.some(
			(t) =>
				t.clips.some((c) => isStencilBlend(c.blendMode)) ||
				t.stages.some((st) => isStencilBlend(st.blendModeId)),
		);
	const hiddenMatteLayers = hiddenMattes.map((track) => (
		<AbsoluteFill key={`matte-${track.trackId}`} data-matte-track-id={track.trackId}>
			<FrameWindow
				items={track.clips}
				span={clipSpan}
				render={(clip) => {
					const head = clip.headHandle ?? 0;
					return (
						<Sequence
							key={clip.clipId}
							from={clip.start - head - offset}
							durationInFrames={clip.duration + head + (clip.tailHandle ?? 0)}
							name={`${clip.name} (matte)`}
							premountFor={PREMOUNT_KINDS.has(clip.kind) ? premount : undefined}
						>
							<ClipLayer clip={clip} doc={doc} options={options} matteHub={track.hub} matteOnly />
						</Sequence>
					);
				}}
			/>
		</AbsoluteFill>
	));
	const members3d = gpu3d ? (
		<AbsoluteFill data-scene3d-members="" style={{ pointerEvents: 'none' }}>
			{tracks.flatMap((track) =>
				track.clips
					.filter((clip) => clip.threeD)
					.map((clip) => (
						<Sequence
							key={clip.clipId}
							from={clip.start - offset}
							durationInFrames={clip.duration}
							name={`${clip.name} (3D)`}
							premountFor={PREMOUNT_KINDS.has(clip.kind) ? premount : undefined}
						>
							<ClipLayer clip={clip} doc={doc} options={options} matteHub={track.matteHub} />
						</Sequence>
					)),
			)}
		</AbsoluteFill>
	) : null;
	if (flat && flatStack)
		return (
			<Scene3DContext.Provider value={scene3d}>
				<TrackMatteContext.Provider value={matteContext}>
					<FlatStackContext.Provider value={flatStack.stack}>
						<BlendTrackContext.Provider value={flatStack.track}>
							<FlatCompositor
								stack={flatStack.stack}
								comp={comp}
								offset={offset}
								isPreview={options.isPreview}
								linear={linearCurve}
								display={!nested && flatDisplay ? flatDisplay : undefined}
								underlay={stencilledIn(background0) ? background0 : null}
								output={flatOutput === 'feed' ? 'feed' : 'canvas'}
							/>
							{hiddenMatteLayers}
							{tracks.map((track) => (
								<TransitionSidesContext.Provider key={track.trackId} value={track.sides}>
									<AbsoluteFill data-track-id={track.trackId} data-flat-track="">
										<FrameWindow
											items={track.clips}
											span={clipSpan}
											render={(clip) => {
												if (gpu3d && clip.threeD) return null;
												const head = clip.headHandle ?? 0;
												return (
													<Sequence
														key={clip.clipId}
														from={clip.start - head - offset}
														durationInFrames={clip.duration + head + (clip.tailHandle ?? 0)}
														name={clip.name}
														premountFor={PREMOUNT_KINDS.has(clip.kind) ? premount : undefined}
													>
														<ClipLayer clip={clip} doc={doc} options={options} matteHub={track.matteHub} />
													</Sequence>
												);
											}}
										/>
										{track.stages.map((st) => (
											<Sequence
												key={`transition-${st.t.id}`}
												from={st.t.start - offset}
												durationInFrames={st.t.duration}
												name={st.spec.label}
											>
												<TransitionStage
													t={st.t}
													spec={st.spec}
													hub={st.hub}
													mode={st.mode}
													comp={comp}
													flicksPerFrame={fpf}
													isPreview={options.isPreview}
													blendMode={st.blendMode}
													media={doc.media}
												/>
											</Sequence>
										))}
									</AbsoluteFill>
								</TransitionSidesContext.Provider>
							))}
							{tracks.map((track) =>
								track.adjustments.length > 0 ? (
									<FlatAdjustment
										key={`adj-${track.trackId}`}
										trackId={track.trackId}
										clips={track.adjustments}
										doc={doc}
										options={options}
										offset={offset}
									/>
								) : null,
							)}
							{gpu3d && scene3d
								? tracks.map((track, i) =>
										scene3d.hubOf(i) ? (
											<FlatRun3D
												key={`scene3d-${track.trackId}`}
												scene={scene3d}
												trackIndex={i}
												comp={comp}
												offset={offset}
												isPreview={options.isPreview}
											/>
										) : null,
									)
								: null}
							{members3d}
						</BlendTrackContext.Provider>
					</FlatStackContext.Provider>
				</TrackMatteContext.Provider>
			</Scene3DContext.Provider>
		);
	const background = options.transparentBackground ? null : doc.settings.backgroundColor;
	let stack: ReactNode =
		background && background[3] > 0 ? (
			<AbsoluteFill data-sequence-background="" style={{ backgroundColor: rgbaCss(background) }} />
		) : null;
	for (const [trackIndex, track] of tracks.entries()) {
		const blend = blendTracks.get(track.trackId);
		if (track.adjustments.length > 0)
			stack = (
				<AdjustmentScope
					key={`adj-${track.trackId}`}
					clips={track.adjustments}
					doc={doc}
					options={options}
					offset={offset}
				>
					{stack}
				</AdjustmentScope>
			);
		const mattes = track.mattes.map((m) => (
			<Sequence
				key={`matte-${m.id}`}
				from={m.start - offset}
				durationInFrames={m.duration}
				name="Transition matte"
			>
				<AbsoluteFill data-transition-matte={m.id} style={{ backgroundColor: rgbaCss(m.color) }} />
			</Sequence>
		));
		// keyframes-blend: the track's mattes lie under its clips, so a blend scope takes them in with the stack below.
		if (blend?.scope)
			stack = (
				<BlendScope
					key={`blend-${track.trackId}`}
					track={blend.value}
					comp={comp}
					offset={offset}
					isPreview={options.isPreview}
				>
					{stack}
					{mattes}
				</BlendScope>
			);
		// three-d: at frames where a 3D run tops out on this track, it is drawn over everything below.
		if (scene3d?.hubOf(trackIndex))
			stack = (
				<Scene3DScope
					key={`scene3d-${track.trackId}`}
					scene={scene3d}
					trackIndex={trackIndex}
					comp={comp}
					offset={offset}
					isPreview={options.isPreview}
				>
					{stack}
				</Scene3DScope>
			);
		const content = (
			<TransitionSidesContext.Provider value={track.sides}>
				<AbsoluteFill data-track-id={track.trackId}>
					{/* color-mgmt: the upper tracks of a linear-light run composite their mattes in the run's scope */}
					{!blend || (!blend.scope && blend.value.mode.mode === 'fallback') ? mattes : null}
					<FrameWindow
						items={track.clips}
						span={clipSpan}
						render={(clip) => {
							// three-d: on the GPU the 3D layers are drawn by their run's scope; their own (captured, empty)
							// elements live outside every scope (below), never inside another HTML-in-Canvas capture.
							if (gpu3d && clip.threeD) return null;
							const head = clip.headHandle ?? 0;
							const from = clip.start - head - offset;
							return (
								<Sequence
									key={clip.clipId}
									from={from}
									durationInFrames={clip.duration + head + (clip.tailHandle ?? 0)}
									name={clip.name}
									premountFor={PREMOUNT_KINDS.has(clip.kind) ? premount : undefined}
								>
									<ClipLayer clip={clip} doc={doc} options={options} matteHub={track.matteHub} />
								</Sequence>
							);
						}}
					/>
					{track.stages.map((st) => (
						<Sequence
							key={`transition-${st.t.id}`}
							from={st.t.start - offset}
							durationInFrames={st.t.duration}
							name={st.spec.label}
						>
							<TransitionStage
								t={st.t}
								spec={st.spec}
								hub={st.hub}
								mode={st.mode}
								comp={comp}
								flicksPerFrame={fpf}
								isPreview={options.isPreview}
								blendMode={st.blendMode}
								media={doc.media}
							/>
						</Sequence>
					))}
					{blend ? (
						<BlendFallback
							track={blend.value}
							glModesAt={blend.glModesAt}
							offset={offset}
							isPreview={options.isPreview}
						/>
					) : null}
				</AbsoluteFill>
			</TransitionSidesContext.Provider>
		);
		stack = (
			<Fragment key={track.trackId}>
				{stack}
				{blend ? (
					<BlendTrackContext.Provider value={blend.value}>{content}</BlendTrackContext.Provider>
				) : (
					content
				)}
			</Fragment>
		);
	}
	// keyframes-blend: Stencil / Silhouette cut the stack below them, background included; what they reveal is the
	// background (After Effects: the comp background), drawn once more under the whole stack (= the native export).
	const stencilled =
		!!background &&
		background[3] > 0 &&
		tracks.some(
			(t) =>
				t.clips.some((c) => isStencilBlend(c.blendMode)) ||
				t.stages.some((st) => isStencilBlend(st.blendModeId)),
		);
	return (
		<CanvasOwnerContext.Provider value={canFlat ? requestFlat : null}>
			<Scene3DContext.Provider value={scene3d}>
				<TrackMatteContext.Provider value={matteContext}>
					{stencilled ? (
						<AbsoluteFill data-stencil-background="" style={{ backgroundColor: rgbaCss(background) }} />
					) : null}
					{hiddenMatteLayers}
					{stack}
					{members3d}
					{scene3d ? <Scene3DFallback scene={scene3d} offset={offset} isPreview={options.isPreview} /> : null}
				</TrackMatteContext.Provider>
			</Scene3DContext.Provider>
		</CanvasOwnerContext.Provider>
	);
}

/**
 * audio-mix: drives the preview mix graph at the composition's frame (lane values, live overrides) — every rendered
 * frame during playback, and on every document change while paused.
 */
function MixGraphDriver({
	graph,
	doc,
	offset,
}: {
	graph: MixGraph;
	doc: SequenceCompositionProps['doc'];
	offset: number;
}) {
	const frame = useCurrentFrame();
	// sound-design Phase 0 close-out: the graph follows the transport (seeks flush it, a Play after a paused seek is
	// primed, the read-ahead is held while playing).
	const sharedAudio = useContext(Internals.SharedAudioContext);
	const [playing] = Internals.Timeline.usePlayingState();
	useEffect(() => {
		if (!sharedAudio) return;
		const emitter = sharedAudio.audioSyncAnchorEmitter;
		graph.attachSync({
			anchor: sharedAudio.audioSyncAnchor,
			subscribe: (cb) => {
				const s = emitter.subscribe(cb);
				return () => s.remove();
			},
			emitter,
		});
	}, [graph, sharedAudio]);
	// sound-design Phase 6: playback is held while the sources start again after a schedule epoch
	const buffer = useBufferState();
	const buffering = useContext(Internals.BufferingContextReact);
	useEffect(() => {
		graph.setBufferGate(() => buffer.delayPlayback(), buffering?.buffering);
		return () => graph.setBufferGate(null);
	}, [graph, buffer, buffering]);
	// A picture that fell behind the audio catches up (the anchor guard): Remotion's frame state, as its playback loop
	// advances it.
	const setTimelineFrame = Internals.Timeline.useTimelineSetFrame();
	const config = Internals.useUnsafeVideoConfig();
	const compositionId = config?.id ?? null;
	const compositionFps = config?.fps ?? 30;
	const lastFrame = (config?.durationInFrames ?? 1) - 1;
	useEffect(() => {
		if (!compositionId) return;
		graph.setPictureAdvance((n) => {
			setTimelineFrame((c) => {
				const cur = c[compositionId] ?? 0;
				return { ...c, [compositionId]: Math.min(lastFrame, cur + n) };
			});
			return true;
		}, compositionFps);
		return () => graph.setPictureAdvance(null, compositionFps);
	}, [graph, setTimelineFrame, compositionId, compositionFps, lastFrame]);
	// The playback rate (J / L shuttle): with Remotion's sync anchor the graph reads the audio clock's time from it.
	const playbackRate = useContext(Internals.PlaybackRateContext)?.playbackRate ?? 1;
	// (before the playing state below: a Play that comes with a seek is checked against the new picture position)
	useEffect(() => {
		if (!doc.audioMix) return;
		const F = flicksPerFrame(doc.settings.fps);
		const t = (frame + offset) * F;
		graph.update(doc.audioMix, doc.audioClips, t, doc.settings.fps, {
			compositionFlicks: frame * F,
			rate: playbackRate,
		});
	}, [graph, doc, frame, offset, playbackRate]);
	useEffect(() => {
		graph.setPlaying(playing);
	}, [graph, playing]);
	return null;
}

/** color-mgmt: the curve layers blend in with Blend using 1.0 gamma / Linearize (null = encoded blending). */
function linearBlendCurveOf(c: SequenceColorInfo | undefined): LinearBlendCurve | null {
	if (!c?.blendLinear) return null;
	const curve = colorSpace(c.space)?.curve;
	if (curve === 'srgb') return 'srgb';
	if (curve === 'pq') return 'pq';
	if (curve === 'hlg') return 'hlg';
	return 'bt1886';
}

/**
 * Wave expressions: binds the snapshot's expressions (`doc.expressions`) once the QuickJS engine is loaded; renders
 * wait for it (`delayRender`), so every rendered frame shows post-expression values.
 */
export function SequenceComposition({ doc: raw, options }: SequenceCompositionProps) {
	const doc = useExpressionSnapshot(raw);
	// text-animators: text Expression Selectors evaluate in the snapshot's expression world.
	const textExpressions = useTextExpressionHosts(doc);
	// audio-mix: the Program preview routes audio through our mix graph (renders take the export mixer's audio).
	const sharedAudio = useContext(Internals.SharedAudioContext);
	const audioCtx = sharedAudio?.audioContext ?? null;
	const audioOut = sharedAudio?.gainNode ?? null;
	const hasMix = !!doc.audioMix;
	const graph = useMemo(
		() =>
			options.isPreview && hasMix && audioCtx && audioOut && typeof AudioWorkletNode !== 'undefined'
				? mixGraphFor(audioCtx, audioOut)
				: null,
		[options.isPreview, hasMix, audioCtx, audioOut],
	);
	const root = useRef<HTMLDivElement>(null);
	const fontsReady = useFontsReadyState(doc.fonts);
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const offset = doc.range.start;
	// previews: rendered segments play from their files; covered live layers are not mounted.
	const previewed = useMemo(
		() => applyPreviews(doc, options.isPreview ? options.previews : undefined),
		[doc, options.isPreview, options.previews],
	);
	const live = previewed.doc;
	// Audio clips are premounted like media (decoder warm-up) and at least by their lead: the graph's read-ahead plus
	// their own effect latency (`MixGraph.clipLead`). The source of a clip mounted only when the picture reaches it
	// cannot start early, so it lost its first `lead` seconds at every cut; premounted, its first buffers are
	// scheduled ahead of the cut (S03:RND-020, spec 12 Phase 0).
	const graphLatency = useGraphLatency(graph);
	const graphEpoch = useGraphEpoch(graph);
	const audioPremount = useCallback(
		(clip: RenderDoc['audioClips'][number]): number =>
			Math.max(premountFrames(fps), Math.ceil(Math.max(graphLatency, graph?.clipLead(clip) ?? 0) * fps) + 1),
		[graph, graphLatency, fps],
	);
	// ui-perf: audio clips are windowed like the video layers (FrameWindow), premount included.
	const audioSpan = useCallback(
		(clip: RenderDoc['audioClips'][number]): FrameSpan => {
			const from = clip.start - (clip.headHandle ?? 0) - offset;
			return [
				from - audioPremount(clip),
				from + clip.duration + (clip.headHandle ?? 0) + (clip.tailHandle ?? 0),
			];
		},
		[offset, audioPremount],
	);
	// compositor: the display transform cannot capture a stack that draws through HTML-in-Canvas (DisplayStage).
	const displayFlat = useMemo(
		() => options.isPreview && !!doc.settings.color && docUsesCanvas(live, cssExactAdjustment),
		[options.isPreview, doc.settings.color, live],
	);
	// M2 colour stage (S06): LUT assets referenced by effect params and the preview before/after bypass.
	const color = useMemo<ColorDocValue>(
		() => ({
			media: doc.media,
			bypass: new Set(options.colorBypassClipIds ?? []),
			isPreview: options.isPreview,
			...(doc.settings.color ? { working: doc.settings.color } : {}),
		}),
		[doc.media, options.colorBypassClipIds, options.isPreview, doc.settings.color],
	);
	return (
		<TextExpressionContext.Provider value={textExpressions}>
			<MixGraphContext.Provider value={graph}>
				<FontsReadyContext.Provider value={fontsReady}>
					<EmojiTableContext.Provider value={doc.emoji}>
						<ColorDocContext.Provider value={color}>
							<NestTracksContext.Provider value={VideoTracks}>
								<AbsoluteFill ref={root} style={{ overflow: 'hidden', isolation: 'isolate' }}>
									{/* color-mgmt: the monitor shows the working signal through the display transform. */}
									<DisplayStage
										working={doc.settings.color}
										enabled={options.isPreview && options.displayColor !== false}
										width={doc.settings.width}
										height={doc.settings.height}
										flat={displayFlat}
									>
										<VideoTracks doc={live} options={options} offset={offset} />
										{/* previews: rendered segments (the export's picture of the working signal) */}
										<PreviewLayers
											video={previewed.video}
											audio={previewed.audio}
											offset={offset}
											premount={premountFrames(fps)}
											options={options}
											epoch={graphEpoch}
										/>
									</DisplayStage>
									{graph ? <MixGraphDriver graph={graph} doc={live} offset={offset} /> : null}
									{/* Renders take their audio from the export mixer (every path muxes it): they play no audio. */}
									{options.isPreview ? (
										<FrameWindow
											items={live.audioClips}
											span={audioSpan}
											render={(clip) => {
												// An audio crossfade plays the clip's handles (S10:TUI-052).
												const head = clip.headHandle ?? 0;
												const from = clip.start - head - offset;
												return (
													<Sequence
														key={clip.clipId}
														from={from}
														durationInFrames={clip.duration + head + (clip.tailHandle ?? 0)}
														premountFor={audioPremount(clip)}
														name={clip.clipId}
														style={AUDIO_SEQUENCE_STYLE}
													>
														<AudioLayer
															clip={clip}
															media={doc.media[clip.mediaId] ?? null}
															fps={fps}
															fpsRational={doc.settings.fps}
															options={options}
															master={doc.master}
															sequenceFrom={from}
														/>
													</Sequence>
												);
											}}
										/>
									) : null}
									{/* Last child: every frame is captured as a fresh paint of the settled DOM (repaint.tsx). */}
									<FrameRepaint target={root} deps={[doc, options]} />
								</AbsoluteFill>
							</NestTracksContext.Provider>
						</ColorDocContext.Provider>
					</EmojiTableContext.Provider>
				</FontsReadyContext.Provider>
			</MixGraphContext.Provider>
		</TextExpressionContext.Provider>
	);
}
