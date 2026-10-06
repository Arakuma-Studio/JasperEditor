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
import {
	clipContentTime,
	fadeFactor,
	flicksPerFrame,
	isCssBlend,
	type RenderVisualClip,
	resolveCachedLayerProps,
	transitionSpec,
} from '@jasper/project';
import { type ComponentType, memo, useContext, useMemo, useRef } from 'react';
import { AbsoluteFill, cancelRender, Freeze, Sequence, useCurrentFrame } from 'remotion';
import { ColorDocContext, type ColorDocValue } from './color/chain.ts';
import { FontsReadyContext, useFontsReadyState, useLayerFontsReady } from './fonts.ts';
import {
	CompositeChip,
	CompositeContext,
	type CompositeContextValue,
	CompositeHub,
	CompositeStage,
	compositeRunMode,
	makeGroupCache,
	useCompositeTap,
} from './fx/composite.tsx';
import { type CompositeTrackInput, hasGlBlend } from './fx/composite-plan.ts';
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
import { AudioLayer, layerComponentFor } from './layers/index.ts';
import { rgbaCss } from './metadata.ts';
import { blendModeCss, premountFrames } from './pipeline.ts';
import { FrameRepaint } from './repaint.tsx';
import type { LayerProps, RenderDoc, RenderOptions, SequenceCompositionProps } from './types.ts';

/** Kinds whose layer output depends on the frame beyond what `ResolvedLayerProps` captures. */
const FRAME_DEPENDENT_KINDS: ReadonlySet<string> = new Set([
	'motion-graphic',
	'animated-image',
	'composition',
]);

const hasKeyframes = (v: { keyframes: unknown[] } | null | undefined): boolean =>
	(v?.keyframes.length ?? 0) > 0;

/**
 * Layers whose output depends on the frame beyond `ResolvedLayerProps` (ARCHITECTURE §20.4): the
 * FRAME_DEPENDENT_KINDS, text clips with animators in their source (S11:TXA-009) and shapes whose geometry or
 * paint is keyframed (evaluated by the layer, S11:SHP-003).
 */
function isFrameDependent(
	clip: Pick<RenderVisualClip, 'kind' | 'source' | 'effects'>,
	media?: RenderDoc['media'],
): boolean {
	if (FRAME_DEPENDENT_KINDS.has(clip.kind)) return true;
	// A shader effect that changes over time (incl. a media param bound to a video that plays).
	if (hasTimeDependentFx(clip, undefined, media ? (id) => media[id]?.kind : undefined)) return true;
	const src = clip.source;
	if ('text' in src) return !!src.animation && !!(src.animation.in || src.animation.out);
	if ('shape' in src) {
		const s = src.shape;
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
		a.composite !== b.composite
	)
		return false;
	if (a.frameDependent || b.frameDependent)
		return a.localFrame === b.localFrame && a.realFrame === b.realFrame;
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
}: {
	clip: RenderVisualClip;
	doc: RenderDoc;
	options: RenderOptions;
}) {
	// Inside the Sequence the current frame counts from its start, also when `from` is negative (a render
	// range starting mid-clip): Remotion subtracts the absolute `from`. The Sequence starts `headHandle`
	// frames before the clip, so the clip-local frame is negative inside the handle.
	const localFrame = useCurrentFrame() - (clip.headHandle ?? 0);
	const frame = clip.start + localFrame;
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const contentTime = clipContentTime(clip, frame, doc.settings.fps);
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
	// keyframes-blend: a member of the GL compositor's group at this frame hands its picture to the compositor.
	const compositeTap = useCompositeTap(clip.clipId, frame);
	const composite = useMemo(
		() => (compositeTap && !gpuSide ? { tap: compositeTap } : undefined),
		[compositeTap, gpuSide],
	);
	// Transition ramps multiply the opacity; outside a ramp the (cached) props object is passed through.
	const fade =
		fadeFactor(clip.fades, frame) *
		(entry && !gpuSide ? transitionFallbackFactor(entry.t, entry.side, frame) : 1);
	const props = useMemo(
		() => (fade === 1 ? resolved : { ...resolved, opacity: resolved.opacity * fade }),
		[resolved, fade],
	);
	const media = 'mediaId' in clip.source ? (doc.media[clip.source.mediaId] ?? null) : null;
	const Component = layerComponentFor({ clip, media });
	// S11:FIX-003: font-dependent layers mount once their faces are loaded (no fallback-font paint/measure).
	const fontsReady = useLayerFontsReady(clip, doc.fonts);
	// fx framework: a time effect shows the source at another frame (Motion/opacity/params stay at the real time).
	const remapped = fxRemapFrame(clip, props.effects, localFrame, fps);
	const frameDependent = frameDependentIn(clip, doc.media);
	if (!fontsReady) return null;
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
					fps={fps}
					media={media}
					options={options}
					fonts={doc.fonts}
					transition={transition}
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
			fps={fps}
			media={media}
			options={options}
			fonts={doc.fonts}
			transition={transition}
			composite={composite}
		/>
	);
});

/** A track's transition matte (the black of a dip to black); captured by the compositor inside its group. */
function MatteLayer({ id, color, start }: { id: string; color: string; start: number }) {
	const frame = start + useCurrentFrame();
	const captured = useCompositeTap(`matte:${id}`, frame);
	return (
		<AbsoluteFill data-transition-matte={id} style={captured ? undefined : { backgroundColor: color }} />
	);
}

/**
 * The compositor's slot in a track: draws the stage at the frames where this track is the group's top (or, in the
 * Player's fallback, the chip; renders cancel there).
 */
function CompositeSlot({
	trackIndex,
	offset,
	comp,
	isPreview,
}: {
	trackIndex: number;
	offset: number;
	comp: { width: number; height: number };
	isPreview: boolean;
}) {
	const ctx = useContext(CompositeContext);
	const frame = useCurrentFrame() + offset;
	const group = ctx?.groupAt(frame) ?? null;
	if (!ctx || !group || group.trackIndex !== trackIndex) return null;
	if (ctx.mode.mode === 'fallback') {
		if (!isPreview)
			cancelRender(
				new Error(
					ctx.mode.reason.includes('WebGL2') || ctx.mode.reason.includes('context lost')
						? `WEBGL_UNAVAILABLE: ${ctx.mode.reason}`
						: `BLEND_UNSUPPORTED: ${ctx.mode.reason}`,
				),
			);
		return <CompositeChip text={`${ctx.mode.reason} — previewed as Normal`} />;
	}
	return <CompositeStage group={group} frame={frame} comp={comp} />;
}

export function SequenceComposition({ doc, options }: SequenceCompositionProps) {
	const root = useRef<HTMLDivElement>(null);
	const fontsReady = useFontsReadyState(doc.fonts);
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const offset = doc.range.start;
	const background = options.transparentBackground ? 'transparent' : rgbaCss(doc.settings.backgroundColor);
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: hubOf reads a ref
	const tracks = useMemo(
		() =>
			doc.videoTracks.map((t) => {
				const clips = options.layerFilter
					? t.clips.filter((c) => options.layerFilter!.includes(c.clipId))
					: t.clips;
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
					const blendModeId = modes.size === 1 ? [...modes][0]! : 'normal';
					const blend = blendModeCss(blendModeId);
					stages.push({
						t: tr,
						spec,
						side: 'in',
						mode,
						hub,
						blendModeId: mode.mode === 'gpu' ? blendModeId : 'normal',
						...(blend ? { blendMode: blend } : {}),
					});
				}
				return {
					trackId: t.trackId,
					clips,
					mattes: options.layerFilter ? [] : (t.mattes ?? []),
					sides,
					stages,
				};
			}),
		[doc.videoTracks, doc.media, options.layerFilter, gpu, htmlInCanvas],
	);
	const comp = useMemo(
		() => ({ width: doc.settings.width, height: doc.settings.height, fps }),
		[doc.settings.width, doc.settings.height, fps],
	);
	const fpf = flicksPerFrame(doc.settings.fps);
	// keyframes-blend: the GL compositor for the blend modes CSS cannot draw exactly (fx/composite.tsx). Layer renders
	// (bakes of single clips) composite nothing: their blend mode is applied where the bake is composited.
	const compositeHub = useRef<CompositeHub | null>(null);
	const composite = useMemo((): CompositeContextValue | null => {
		if (options.layerFilter) return null;
		const inputs: CompositeTrackInput[] = tracks.map((t) => ({
			trackId: t.trackId,
			mattes: t.mattes.map((m) => ({ id: m.id, start: m.start, duration: m.duration, color: m.color })),
			clips: t.clips.map((c) => ({
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
		}));
		if (!hasGlBlend(inputs)) return null;
		compositeHub.current ??= new CompositeHub();
		const isGpuSide = (clipId: string, f: number) => {
			for (const t of tracks) {
				const e = t.sides.get(clipId);
				if (e?.some((x) => x.mode.mode === 'gpu' && f >= x.t.start && f < x.t.start + x.t.duration))
					return true;
			}
			return false;
		};
		const glModes = inputs.flatMap((t) => [
			...t.clips.map((c) => c.blendMode),
			...t.stages.map((st) => st.blendMode),
		]);
		const mode = compositeRunMode(
			tracks.flatMap((t) => t.clips),
			doc.media,
			{ gpu, htmlInCanvas, isPreview: options.isPreview },
			glModes.filter((m) => !blendModeCss(m) && m !== 'normal'),
		);
		const groupTops = new Set(
			inputs.flatMap((t, i) =>
				t.clips.some((c) => !isCssBlend(c.blendMode)) || t.stages.some((st) => !isCssBlend(st.blendMode))
					? [i]
					: [],
			),
		);
		return {
			hub: compositeHub.current,
			mode,
			tracks: inputs,
			groupTops,
			groupAt: makeGroupCache(inputs, isGpuSide),
		};
	}, [tracks, doc.media, gpu, htmlInCanvas, options.isPreview, options.layerFilter]);
	// M2 colour stage (S06): LUT assets referenced by effect params and the preview before/after bypass.
	const color = useMemo<ColorDocValue>(
		() => ({
			media: doc.media,
			bypass: new Set(options.colorBypassClipIds ?? []),
			isPreview: options.isPreview,
		}),
		[doc.media, options.colorBypassClipIds, options.isPreview],
	);
	return (
		<FontsReadyContext.Provider value={fontsReady}>
			<ColorDocContext.Provider value={color}>
				<CompositeContext.Provider value={composite}>
					<AbsoluteFill ref={root} style={{ backgroundColor: background, overflow: 'hidden' }}>
						{/* keyframes-blend: layers blend in their own group, onto transparency (a blend mode over nothing shows the
					    layer as it is, as in Premiere / After Effects); the background colour is drawn behind the group. */}
						<AbsoluteFill data-layer-stack="" style={{ isolation: 'isolate' }}>
							{tracks.map((track, trackIndex) => (
								<TransitionSidesContext.Provider key={track.trackId} value={track.sides}>
									<AbsoluteFill data-track-id={track.trackId}>
										{track.mattes.map((m) => (
											<Sequence
												key={`matte-${m.id}`}
												from={m.start - offset}
												durationInFrames={m.duration}
												name="Transition matte"
											>
												<MatteLayer id={m.id} color={rgbaCss(m.color)} start={m.start} />
											</Sequence>
										))}
										{track.clips.map((clip) => {
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
													<ClipLayer clip={clip} doc={doc} options={options} />
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
										{composite?.groupTops.has(trackIndex) ? (
											<CompositeSlot
												trackIndex={trackIndex}
												offset={offset}
												comp={comp}
												isPreview={options.isPreview}
											/>
										) : null}
									</AbsoluteFill>
								</TransitionSidesContext.Provider>
							))}
						</AbsoluteFill>
						{doc.audioClips.map((clip) => {
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
				</CompositeContext.Provider>
			</ColorDocContext.Provider>
		</FontsReadyContext.Provider>
	);
}
