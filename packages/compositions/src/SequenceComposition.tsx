// The single composition for Player preview, engine renders and stills (ARCHITECTURE §8, S03:ARC-002).
// A pure function of its props: it never reads editor stores (S03:ARC-003).
import {
	clipContentTime,
	type RenderVisualClip,
	type ResolvedLayerProps,
	resolveLayerProps,
} from '@jasper/project';
import { memo, useMemo } from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import { AudioLayer, layerComponentFor } from './layers/index.ts';
import { rgbaCss } from './metadata.ts';
import type { LayerProps, RenderDoc, RenderOptions, SequenceCompositionProps } from './types.ts';

const staticProps = new WeakMap<RenderVisualClip, ResolvedLayerProps>();

function isStatic(c: RenderVisualClip): boolean {
	const t = c.transform;
	return (
		c.opacity.keyframes.length === 0 &&
		(!t ||
			[t.position, t.anchor, t.scale, t.scaleWidth, t.rotation].every((a) => a.keyframes.length === 0)) &&
		c.effects.every((fx) => Object.values(fx.params).every((p) => p.keyframes.length === 0))
	);
}

const ClipLayer = memo(function ClipLayer({
	clip,
	doc,
	options,
}: {
	clip: RenderVisualClip;
	doc: RenderDoc;
	options: RenderOptions;
}) {
	const local = useCurrentFrame();
	const frame = clip.start + local;
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const contentTime = clipContentTime(clip, frame, doc.settings.fps);
	let props: ResolvedLayerProps;
	if (isStatic(clip)) {
		props = staticProps.get(clip) ?? resolveLayerProps(clip, contentTime);
		staticProps.set(clip, props);
	} else props = resolveLayerProps(clip, contentTime);
	const media = 'mediaId' in clip.source ? (doc.media[clip.source.mediaId] ?? null) : null;
	const layer: LayerProps = { clip, props, localFrame: local, contentTime, fps, media, options };
	const Component = layerComponentFor(layer);
	return <Component {...layer} />;
});

export function SequenceComposition({ doc, options }: SequenceCompositionProps) {
	const fps = doc.settings.fps.num / doc.settings.fps.den;
	const offset = doc.range.start;
	const background = options.transparentBackground ? 'transparent' : rgbaCss(doc.settings.backgroundColor);
	const tracks = useMemo(
		() =>
			doc.videoTracks.map((t) => ({
				trackId: t.trackId,
				clips: options.layerFilter ? t.clips.filter((c) => options.layerFilter!.includes(c.clipId)) : t.clips,
			})),
		[doc.videoTracks, options.layerFilter],
	);
	return (
		<AbsoluteFill style={{ backgroundColor: background, overflow: 'hidden' }}>
			{tracks.map((track) => (
				<AbsoluteFill key={track.trackId} data-track-id={track.trackId}>
					{track.clips.map((clip) => (
						<Sequence
							key={clip.clipId}
							from={clip.start - offset}
							durationInFrames={clip.duration}
							name={clip.name}
							layout="none"
						>
							<ClipLayer clip={clip} doc={doc} options={options} />
						</Sequence>
					))}
				</AbsoluteFill>
			))}
			{doc.audioClips.map((clip) => (
				<Sequence
					key={clip.clipId}
					from={clip.start - offset}
					durationInFrames={clip.duration}
					name={clip.clipId}
					layout="none"
				>
					<AudioLayer clip={clip} media={doc.media[clip.mediaId] ?? null} fps={fps} options={options} />
				</Sequence>
			))}
		</AbsoluteFill>
	);
}
