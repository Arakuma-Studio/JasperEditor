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
import {
	clipContentTime,
	fadeFactor,
	type RenderVisualClip,
	type ResolvedLayerProps,
	resolveLayerProps,
} from '@jasper/project';
import { type ComponentType, memo, useMemo, useRef } from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import { ColorDocContext, type ColorDocValue } from './color/chain.ts';
import { FontsReadyContext, useFontsReadyState, useLayerFontsReady } from './fonts.ts';
import { AudioLayer, layerComponentFor } from './layers/index.ts';
import { rgbaCss } from './metadata.ts';
import { premountFrames } from './pipeline.ts';
import { FrameRepaint } from './repaint.tsx';
import type { LayerProps, RenderDoc, RenderOptions, SequenceCompositionProps } from './types.ts';

/** Kinds whose layer output depends on the frame beyond what `ResolvedLayerProps` captures. */
export const FRAME_DEPENDENT_KINDS: ReadonlySet<string> = new Set([
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
export function isFrameDependent(clip: Pick<RenderVisualClip, 'kind' | 'source'>): boolean {
	if (FRAME_DEPENDENT_KINDS.has(clip.kind)) return true;
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

const staticProps = new WeakMap<RenderVisualClip, ResolvedLayerProps>();

export function isStaticClip(c: RenderVisualClip): boolean {
	const t = c.transform;
	return (
		c.opacity.keyframes.length === 0 &&
		(!t ||
			[t.position, t.anchor, t.scale, t.scaleWidth, t.rotation].every((a) => a.keyframes.length === 0)) &&
		c.effects.every((fx) => Object.values(fx.params).every((p) => p.keyframes.length === 0))
	);
}

/**
 * Evaluated props of a clip at a sequence frame. Static clips return the same object for every frame
 * (S03:ARC-011) so memoized layers do not re-render.
 */
export function layerPropsAt(clip: RenderVisualClip, frame: number, doc: Pick<RenderDoc, 'settings'>) {
	const contentTime = clipContentTime(clip, frame, doc.settings.fps);
	if (!isStaticClip(clip)) return { props: resolveLayerProps(clip, contentTime), contentTime };
	let props = staticProps.get(clip);
	if (!props) {
		props = resolveLayerProps(clip, contentTime);
		staticProps.set(clip, props);
	}
	return { props, contentTime };
}

type ViewProps = LayerProps & { Component: ComponentType<LayerProps> };

/** Equality for LayerView: frame-independent layers ignore localFrame/contentTime. */
export function layerViewEqual(a: ViewProps, b: ViewProps): boolean {
	if (
		a.Component !== b.Component ||
		a.clip !== b.clip ||
		a.props !== b.props ||
		a.media !== b.media ||
		a.options !== b.options ||
		a.fps !== b.fps ||
		a.fonts !== b.fonts
	)
		return false;
	if (isFrameDependent(a.clip)) return a.localFrame === b.localFrame;
	return true;
}

const LayerView = memo(function LayerView({ Component, ...layer }: ViewProps) {
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
	const resolved = layerPropsAt(clip, frame, doc);
	const { contentTime } = resolved;
	// Transition ramps multiply the opacity; outside a ramp the (cached) props object is passed through.
	const fade = fadeFactor(clip.fades, frame);
	const props = useMemo(
		() => (fade === 1 ? resolved.props : { ...resolved.props, opacity: resolved.props.opacity * fade }),
		[resolved.props, fade],
	);
	const media = 'mediaId' in clip.source ? (doc.media[clip.source.mediaId] ?? null) : null;
	const Component = layerComponentFor({ clip, media });
	// S11:FIX-003: font-dependent layers mount once their faces are loaded (no fallback-font paint/measure).
	const fontsReady = useLayerFontsReady(clip, doc.fonts);
	if (!fontsReady) return null;
	return (
		<LayerView
			Component={Component}
			clip={clip}
			props={props}
			localFrame={localFrame}
			contentTime={contentTime}
			fps={fps}
			media={media}
			options={options}
			fonts={doc.fonts}
		/>
	);
});

export function SequenceComposition({ doc, options }: SequenceCompositionProps) {
	const root = useRef<HTMLDivElement>(null);
	const fontsReady = useFontsReadyState(doc.fonts);
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const offset = doc.range.start;
	const background = options.transparentBackground ? 'transparent' : rgbaCss(doc.settings.backgroundColor);
	const premount = premountFrames(fps);
	const tracks = useMemo(
		() =>
			doc.videoTracks.map((t) => ({
				trackId: t.trackId,
				clips: options.layerFilter ? t.clips.filter((c) => options.layerFilter!.includes(c.clipId)) : t.clips,
				mattes: options.layerFilter ? [] : (t.mattes ?? []),
			})),
		[doc.videoTracks, options.layerFilter],
	);
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
				<AbsoluteFill
					ref={root}
					style={{ backgroundColor: background, overflow: 'hidden', isolation: 'isolate' }}
				>
					{tracks.map((track) => (
						<AbsoluteFill key={track.trackId} data-track-id={track.trackId}>
							{track.mattes.map((m) => (
								<Sequence
									key={`matte-${m.id}`}
									from={m.start - offset}
									durationInFrames={m.duration}
									name="Transition matte"
								>
									<AbsoluteFill data-transition-matte={m.id} style={{ backgroundColor: rgbaCss(m.color) }} />
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
						</AbsoluteFill>
					))}
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
			</ColorDocContext.Provider>
		</FontsReadyContext.Provider>
	);
}
