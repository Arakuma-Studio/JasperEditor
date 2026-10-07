// Nested sequence layer (edit-structure, S01:KND-011): the nested sequence's tracks drawn inside the nest clip's layer
// box (the nested frame), then the clip's effects, Motion, opacity and blend like any layer. The nested snapshot is
// conformed to the parent rate (render snapshot); the frame shown is the clip's picture time on that grid. At 100 %
// forward speed the nested tracks play through a shifted `<Sequence>` (smooth playback, no per-frame seeks); speed
// changes, reverse and frame holds show the nested frame through `<Freeze>`. Recursion goes through
// `NestTracksContext` (the composition's own `VideoTracks`); the snapshot builder already refuses cycles.
import { flicksPerFrame } from '@jasper/project';
import { useContext } from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { ShowFrame } from '../show-frame.tsx';
import type { LayerProps } from '../types.ts';
import { LayerBox } from './LayerBox.tsx';
import { NestCompSizeContext, NestTracksContext } from './nest-context.ts';
import { UnsupportedLayer } from './UnsupportedLayer.tsx';

export function NestLayer(layer: LayerProps) {
	const Tracks = useContext(NestTracksContext);
	const { clip } = layer;
	const src = clip.source;
	if (!('nest' in src) || !Tracks) return <UnsupportedLayer {...layer} />;
	const sub = src.nest.snapshot;
	const F = flicksPerFrame(sub.settings.fps);
	const t = layer.pictureTime ?? layer.contentTime;
	const nestedFrame = Math.floor(t / F + 1e-6);
	const inner = nestedFrame - sub.range.start;
	const sourceFrames = clip.sourceIn / F;
	const linear =
		clip.speed.rate === 1 &&
		!clip.speed.reverse &&
		!clip.frameHold &&
		Math.abs(sourceFrames - Math.round(sourceFrames)) < 1e-6;
	const tracks = <Tracks doc={sub} options={layer.options} offset={sub.range.start} />;
	// Inside the clip's Sequence the frame is `localFrame + headHandle`; the nested axis needs `inner`.
	const shift = inner - (layer.localFrame + (clip.headHandle ?? 0));
	return (
		<LayerBox layer={layer}>
			<NestCompSizeContext.Provider value={{ width: sub.settings.width, height: sub.settings.height }}>
				<AbsoluteFill
					data-nest={src.nest.sequenceId}
					data-nest-frame={nestedFrame}
					style={{ overflow: 'hidden' }}
				>
					{linear ? (
						<Sequence from={-shift} layout="none" name="Nested sequence">
							{tracks}
						</Sequence>
					) : (
						<ShowFrame frame={Math.max(0, inner)}>{tracks}</ShowFrame>
					)}
				</AbsoluteFill>
			</NestCompSizeContext.Provider>
		</LayerBox>
	);
}
