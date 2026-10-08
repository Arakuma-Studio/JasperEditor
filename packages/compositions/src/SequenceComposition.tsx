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
// fx framework (wave 1): layers with time-dependent GPU shader effects are frame dependent too, and a time effect's
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
	Fragment,
	memo,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from 'react';
import { AbsoluteFill, Freeze, Internals, Sequence, useCurrentFrame } from 'remotion';
import { MixGraphContext } from './audio/context.ts';
import { type MixGraph, mixGraphFor } from './audio/graph.ts';
import { ColorDocContext, type ColorDocValue } from './color/chain.ts';
import { DisplayStage } from './color/DisplayStage.tsx';
import { useExpressionSnapshot, useTextExpressionHosts } from './expressions.ts';
import { FontsReadyContext, useFontsReadyState, useLayerFontsReady } from './fonts.ts';
import {
	BlendFallback,
	BlendScope,
	BlendTrackContext,
	type BlendTrackValue,
	CompositeHub,
	compositeRunMode,
	LINEAR_MARK,
	makeBlendTrack,
	makeLinearBlendGroup,
	useCompositeTap,
} from './fx/composite.tsx';
import { type CompositeTrackInput, type LinearBlendCurve, trackHasGlBlend } from './fx/composite-plan.ts';
import { TrackMatteContext, TrackMatteHub } from './fx/matte.ts';
import { useFxStatus } from './fx/status.ts';
import { fxRemapFrame, hasTimeDependentFx } from './fx/time.ts';
import {
	htmlInCanvasAvailable,
	TransitionHub,
	type TransitionSideEntry,
	TransitionSidesContext,
	TransitionStage,
	transitionFallbackFactor,
	transitionProgressAt,
	transitionRunMode,
} from './fx/transition.tsx';
import { AdjustmentScope } from './layers/AdjustmentScope.tsx';
import { AudioLayer, layerComponentFor } from './layers/index.ts';
import { NestCompSizeContext, NestTracksContext } from './layers/nest-context.ts';
import { TextExpressionContext } from './layers/text/expression-context.ts';
import { rgbaCss } from './metadata.ts';
import { blendModeCss, premountFrames } from './pipeline.ts';
import { FrameRepaint } from './repaint.tsx';
import { ShowFrame } from './show-frame.tsx';
import {
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

/** Keyframed or driven by an active expression (wave expressions). */
const hasKeyframes = (
	v: { keyframes: unknown[]; expression?: { text: string; enabled: boolean } } | null | undefined,
): boolean => isAnimated(v);

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
	// Workstream `time`: a retimed video draws the frame of its media time (retime/RetimedVideo.tsx).
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
			hasKeyframes(s.size) ||
			hasKeyframes(s.fill) ||
			hasKeyframes(s.cornerRadius) ||
			hasKeyframes(s.stroke?.color) ||
			hasKeyframes(s.stroke?.width)
		);
	}
	return false;
}

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
	const composite = useMemo(
		() =>
			tap3d && !matteOnly
				? { tap: tap3d }
				: compositeTap && !gpuSide && !matteOnly
					? { tap: compositeTap }
					: undefined,
		[tap3d, compositeTap, gpuSide, matteOnly],
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
	const props = useMemo(() => {
		const base = fade === 1 ? resolved : { ...resolved, opacity: resolved.opacity * fade };
		if (!fallback3d) return base;
		return projective3d ? { ...base, projective: projective3d } : { ...base, opacity: 0 };
	}, [resolved, fade, fallback3d, projective3d?.join(',')]);
	const media = 'mediaId' in clip.source ? (doc.media[clip.source.mediaId] ?? null) : null;
	const Component = layerComponentFor({ clip, media });
	// S11:FIX-003: font-dependent layers mount once their faces are loaded (no fallback-font paint/measure).
	const fontsReady = useLayerFontsReady(clip, doc.fonts);
	// fx framework: a time effect shows the source at another frame (Motion/opacity/params stay at the real time).
	const remapped = fxRemapFrame(clip, props.effects, pictureLocal, fps);
	const frameDependent = frameDependentIn(clip, doc.media);
	if (!fontsReady) return null;
	if (remapped === null && pictureLocal !== localFrame)
		return (
			<ShowFrame frame={heldClip ? 0 : Math.max(0, pictureLocal + (clip.headHandle ?? 0))}>
				<LayerView
					Component={Component}
					frameDependent={frameDependent}
					clip={heldClip ?? clip}
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
	if (remapped !== null)
		return (
			<Freeze frame={remapped + (clip.headHandle ?? 0)}>
				<LayerView
					Component={Component}
					frameDependent={frameDependent}
					clip={clip}
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
	return (
		<LayerView
			Component={Component}
			frameDependent={frameDependent}
			clip={clip}
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
});

/**
 * edit-structure: the clip-local frame whose picture a clip shows at `localFrame` — the held frame of a frame hold
 * (rounded to the frame grid), or the edge frame inside freeze-frame transition handles; else `localFrame`.
 */
export function pictureLocalFrame(
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
}: {
	doc: SequenceCompositionProps['doc'];
	options: SequenceCompositionProps['options'];
	offset: number;
}) {
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const premount = premountFrames(fps);
	const gpu = useFxStatus();
	const htmlInCanvas = htmlInCanvasAvailable();
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
		for (const t of tracks) {
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
			if (!trackHasGlBlend(input, false)) continue;
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
	}, [tracks, options.layerFilter, gpu, htmlInCanvas, linearCurve]);
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
					{track.clips.map((clip) => {
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
					})}
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
		<Scene3DContext.Provider value={scene3d}>
			<TrackMatteContext.Provider value={matteContext}>
				{stencilled ? (
					<AbsoluteFill data-stencil-background="" style={{ backgroundColor: rgbaCss(background) }} />
				) : null}
				{hiddenMattes.map((track) => (
					<AbsoluteFill key={`matte-${track.trackId}`} data-matte-track-id={track.trackId}>
						{track.clips.map((clip) => {
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
						})}
					</AbsoluteFill>
				))}
				{stack}
				{gpu3d ? (
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
				) : null}
				{scene3d ? <Scene3DFallback scene={scene3d} offset={offset} isPreview={options.isPreview} /> : null}
			</TrackMatteContext.Provider>
		</Scene3DContext.Provider>
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
	useEffect(() => {
		if (!doc.audioMix) return;
		const t = (frame + offset) * flicksPerFrame(doc.settings.fps);
		graph.update(doc.audioMix, doc.audioClips, t, doc.settings.fps);
	}, [graph, doc, frame, offset]);
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
					<ColorDocContext.Provider value={color}>
						<NestTracksContext.Provider value={VideoTracks}>
							<AbsoluteFill ref={root} style={{ overflow: 'hidden', isolation: 'isolate' }}>
								{/* color-mgmt: the monitor shows the working signal through the display transform. */}
								<DisplayStage
									working={doc.settings.color}
									enabled={options.isPreview && options.displayColor !== false}
									width={doc.settings.width}
									height={doc.settings.height}
								>
									<VideoTracks doc={doc} options={options} offset={offset} />
								</DisplayStage>
								{graph ? <MixGraphDriver graph={graph} doc={doc} offset={offset} /> : null}
								{/* Renders take their audio from the export mixer (every path muxes it): they play no audio. */}
								{(options.isPreview ? doc.audioClips : []).map((clip) => {
									// An audio crossfade plays the clip's handles (S10:TUI-052).
									const head = clip.headHandle ?? 0;
									const from = clip.start - head - offset;
									return (
										<Sequence
											key={clip.clipId}
											from={from}
											durationInFrames={clip.duration + head + (clip.tailHandle ?? 0)}
											name={clip.clipId}
											layout="none"
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
								})}
								{/* Last child: every frame is captured as a fresh paint of the settled DOM (repaint.tsx). */}
								<FrameRepaint target={root} deps={[doc, options]} />
							</AbsoluteFill>
						</NestTracksContext.Provider>
					</ColorDocContext.Provider>
				</FontsReadyContext.Provider>
			</MixGraphContext.Provider>
		</TextExpressionContext.Provider>
	);
}
