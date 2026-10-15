// Layer dispatch: clip kind → layer component. The only registration point for layer renderers.
import type { ComponentType } from 'react';
import type { LayerProps } from '../types.ts';
import { needsBakedPicture, withBakedLayer } from './BakedLayer.tsx';
import { CaptionsLayer } from './CaptionsLayer.tsx';
import { CompositionLayer } from './CompositionLayer.tsx';
import { GeneratorLayer } from './GeneratorLayer.tsx';
import { LottieLayer } from './LottieLayer.tsx';
import { ModelLayer } from './ModelLayer.tsx';
import { MotionGraphicLayer } from './MotionGraphicLayer.tsx';
import { NestLayer } from './NestLayer.tsx';
import { OfflineCard } from './OfflineCard.tsx';
import { ShapeLayer } from './ShapeLayer.tsx';
import { SolidLayer } from './SolidLayer.tsx';
import { StillLayer } from './StillLayer.tsx';
import { TextLayer } from './TextLayer.tsx';
import { UnsupportedLayer } from './UnsupportedLayer.tsx';
import { VectorLayer } from './VectorLayer.tsx';
import { ProxyPendingCard, VideoLayer } from './VideoLayer.tsx';

export { AudioLayer, type AudioLayerProps } from './AudioLayer.tsx';
export {
	type BakedLayerPreview,
	type BakedLayerRuntime,
	bakedFrameUrl,
	hasDomColorEffects,
	isDomLayerClip,
	needsBakedPicture,
	setBakedLayerRuntime,
	withBakedLayer,
} from './BakedLayer.tsx';
export { compositionFrameOf, compositionFramesAt, hasPixelEffects } from './CompositionLayer.tsx';
export { LayerBox } from './LayerBox.tsx';
export { lottieFrameForLayer } from './LottieLayer.tsx';
export { lottieDocument } from './lottie.ts';
export {
	type MgRenderState,
	MgRenderStateContext,
	MgTemplatePreview,
	type MgTemplatePreviewProps,
} from './MotionGraphicLayer.tsx';
export { OFFLINE_CARD_COLORS } from './OfflineCard.tsx';
export { lottieThumbnail, pdfThumbnail } from './thumbnails.ts';
export { drawPdfPage, pdfPagePicture } from './VectorLayer.tsx';
export {
	CaptionsLayer,
	CompositionLayer,
	GeneratorLayer,
	LottieLayer,
	MotionGraphicLayer,
	NestLayer,
	OfflineCard,
	ProxyPendingCard,
	ShapeLayer,
	SolidLayer,
	StillLayer,
	TextLayer,
	UnsupportedLayer,
	VectorLayer,
	VideoLayer,
};

const LAYER_COMPONENTS: Partial<Record<string, ComponentType<LayerProps>>> = {
	video: VideoLayer,
	still: StillLayer,
	'animated-image': StillLayer,
	text: TextLayer,
	solid: SolidLayer,
	'motion-graphic': MotionGraphicLayer,
	composition: CompositionLayer,
	// M2 (S11:SHP-004, wp-m2-shapes)
	shape: ShapeLayer,
	// edit-structure: nested sequences (adjustment clips are drawn by VideoTracks' AdjustmentScope).
	'nest-video': NestLayer,
	// wp captions
	captions: CaptionsLayer,
	// three-d: 3D model layers (drawn by their run's Advanced 3D renderer).
	model: ModelLayer,
};

const MEDIA_KINDS = new Set(['video', 'still', 'animated-image', 'model']);

/** Picks the component for a layer: offline media → OfflineCard, unknown kinds → UnsupportedLayer. */
export function layerComponentFor(layer: Pick<LayerProps, 'clip' | 'media'>): ComponentType<LayerProps> {
	if (MEDIA_KINDS.has(layer.clip.kind) && !layer.media) return OfflineCard;
	// edit-structure: Bars and Tone / counting leader pictures (solid clips of generator sources).
	if ('generator' in layer.clip.source) return GeneratorLayer;
	// imports: Lottie animations and vector stills (SVG, PDF) are drawn by the composition from their documents.
	const imported = layer.media?.lottie ? LottieLayer : layer.media?.vector ? VectorLayer : null;
	const component = imported ?? LAYER_COMPONENTS[layer.clip.kind] ?? UnsupportedLayer;
	// M2 (S11:LBK-010, wp-m2-layer-bake): a DOM layer with a baked (graded) picture or colour effects is wrapped.
	return needsBakedPicture(layer.clip) ? withBakedLayer(component) : component;
}
