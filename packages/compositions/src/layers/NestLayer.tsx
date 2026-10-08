// Nested sequence layer (edit-structure, S01:KND-011): the nested sequence's tracks drawn inside the nest clip's layer
// box (the nested frame), then the clip's effects, Motion, opacity and blend like any layer. The nested snapshot is
// conformed to the parent rate (render snapshot); the frame shown is the clip's picture time on that grid. At 100 %
// forward speed the nested tracks play through a shifted `<Sequence>` (smooth playback, no per-frame seeks); speed
// changes, reverse and frame holds show the nested frame through `<Freeze>`. Recursion goes through
// `NestTracksContext` (the composition's own `VideoTracks`); the snapshot builder already refuses cycles.
import { activeRemap, flicksPerFrame, remapSourceAt, type SequenceColorInfo } from '@jasper/project';
import { type ReactNode, useContext, useMemo } from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { ColorDocContext } from '../color/chain.ts';
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
	// Workstream `time`: a time-remapped nest (multi-camera clips too) shows the nested frame at the remapped time.
	const remap = activeRemap(clip);
	const pt = layer.pictureTime ?? layer.contentTime;
	const t = remap ? Math.max(0, remapSourceAt(remap, pt)) : pt;
	const nestedFrame = Math.floor(t / F + 1e-6);
	const inner = nestedFrame - sub.range.start;
	const sourceFrames = clip.sourceIn / F;
	const linear =
		clip.speed.rate === 1 &&
		!clip.speed.reverse &&
		!clip.frameHold &&
		!remap &&
		Math.abs(sourceFrames - Math.round(sourceFrames)) < 1e-6;
	// color-mgmt: the nested sequence's layers work in its own working space.
	const tracks = (
		<NestedColorScope working={sub.settings.color}>
			<Tracks doc={sub} options={layer.options} offset={sub.range.start} />
		</NestedColorScope>
	);
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

/** color-mgmt: the colour document of a nested sequence: the parent's media and bypass, the nested working space. */
function NestedColorScope({
	working,
	children,
}: {
	working: SequenceColorInfo | undefined;
	children: ReactNode;
}) {
	const parent = useContext(ColorDocContext);
	const value = useMemo(() => {
		const { working: _w, ...rest } = parent;
		return working ? { ...rest, working } : rest;
	}, [parent, working]);
	return <ColorDocContext.Provider value={value}>{children}</ColorDocContext.Provider>;
}
