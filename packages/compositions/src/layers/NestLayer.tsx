// Nested sequence layer (edit-structure, S01:KND-011): the nested sequence's tracks drawn inside the nest clip's layer
// box (the nested frame), then the clip's effects, Motion, opacity and blend like any layer. The nested snapshot is
// conformed to the parent rate (render snapshot); the frame shown is the clip's picture time on that grid. At 100 %
// forward speed the nested tracks play through a shifted `<Sequence>` (smooth playback, no per-frame seeks); speed
// changes, reverse and frame holds show the nested frame through `<Freeze>`. Recursion goes through
// `NestTracksContext` (the composition's own `VideoTracks`); the snapshot builder already refuses cycles.
// compositor: a nest layer whose picture is captured (its effects, masks, a blend compositor or transition tap: LayerBox
// draws it through HTML-in-Canvas) cannot capture a nested sequence that draws through HTML-in-Canvas itself (Chrome
// never paints a canvas nested in another). Such a nest takes its nested sequence's picture as a CANVAS SOURCE: the
// nested tracks are drawn flat and their compositor hands the frame to the layer's `FxPicture`, like a video frame.
import {
	activeRemap,
	defaultEffectRegistry,
	flicksPerFrame,
	remapSourceAt,
	type SequenceColorInfo,
} from '@jasper/project';
import { type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { ColorDocContext } from '../color/chain.ts';
import { CanvasOwnerContext } from '../fx/canvas-scope.tsx';
import { canUseHtmlInCanvas, FxPicture } from '../fx/FxPicture.tsx';
import { docUsesCanvas } from '../fx/flat-plan.ts';
import { useLayerFx } from '../fx/stage.ts';
import { useFxStatus } from '../fx/status.ts';
import { ShowFrame } from '../show-frame.tsx';
import type { LayerProps } from '../types.ts';
import { cssExactAdjustment } from './AdjustmentScope.tsx';
import { GradeChip, LayerBox } from './LayerBox.tsx';
import { NestCompSizeContext, NestTracksContext } from './nest-context.ts';
import { UnsupportedLayer } from './UnsupportedLayer.tsx';

export function NestLayer(layer: LayerProps) {
	const Tracks = useContext(NestTracksContext);
	const { clip } = layer;
	const src = clip.source;
	if (!('nest' in src) || !Tracks) return <UnsupportedLayer {...layer} />;
	return <NestPicture layer={layer} Tracks={Tracks} />;
}

function NestPicture({
	layer,
	Tracks,
}: {
	layer: LayerProps;
	Tracks: NonNullable<React.ContextType<typeof NestTracksContext>>;
}) {
	const { clip } = layer;
	const src = clip.source as Extract<LayerProps['clip']['source'], { nest: unknown }>;
	const sub = src.nest.snapshot;
	// compositor: the canvas-source decision (see the file comment). The layer's own fx stage, as LayerBox plans it
	// (colour effects of nests run in the chain).
	const chain = layer.props.effects.some(
		(fx) => fx.enabled && !!defaultEffectRegistry.get(fx.effectId, fx.effectVersion)?.color,
	);
	const gpu = useFxStatus();
	const htmlInCanvas = canUseHtmlInCanvas();
	const fx = useLayerFx(layer, { chain, enabled: gpu === 'ok' && htmlInCanvas });
	const usesCanvas = useMemo(() => docUsesCanvas(sub, cssExactAdjustment), [sub]);
	const [reported, setReported] = useState(false);
	const report = useCallback(() => setReported(true), []);
	const canvasSource = fx.mode === 'active' && (usesCanvas || reported);
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
			<Tracks
				doc={sub}
				options={layer.options}
				offset={sub.range.start}
				{...(canvasSource ? { flat: 'feed' as const } : {})}
			/>
		</NestedColorScope>
	);
	// Inside the clip's Sequence the frame is `localFrame + headHandle`; the nested axis needs `inner`.
	const shift = inner - (layer.localFrame + (clip.headHandle ?? 0));
	const nested = (
		<NestCompSizeContext.Provider value={{ width: sub.settings.width, height: sub.settings.height }}>
			<AbsoluteFill
				data-nest={src.nest.sequenceId}
				data-nest-frame={nestedFrame}
				data-nest-source={canvasSource ? 'canvas' : undefined}
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
	);
	if (canvasSource && fx.mode === 'active')
		return (
			<LayerBox
				layer={layer}
				effects={fx.cssEffects}
				masksInChain
				overlay={fx.chip ? <GradeChip layer={layer} text={fx.chip} /> : null}
			>
				<FxPicture stage={fx.stage}>{nested}</FxPicture>
			</LayerBox>
		);
	return (
		<CanvasOwnerContext.Provider value={fx.mode === 'active' ? report : null}>
			<LayerBox layer={layer}>{nested}</LayerBox>
		</CanvasOwnerContext.Provider>
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
