// Layer dispatch: clip kind → layer component. The only registration point for layer renderers.
import type { ComponentType } from 'react';
import type { LayerProps } from '../types.ts';
import { MotionGraphicLayer } from './MotionGraphicLayer.tsx';
import { OfflineCard } from './OfflineCard.tsx';
import { SolidLayer } from './SolidLayer.tsx';
import { StillLayer } from './StillLayer.tsx';
import { TextLayer } from './TextLayer.tsx';
import { UnsupportedLayer } from './UnsupportedLayer.tsx';
import { ProxyPendingCard, VideoLayer } from './VideoLayer.tsx';

export { AudioLayer, type AudioLayerProps } from './AudioLayer.tsx';
export { LayerBox, StubLabel } from './LayerBox.tsx';
export { type MgRenderState, MgRenderStateContext } from './MotionGraphicLayer.tsx';
export { OFFLINE_CARD_COLORS } from './OfflineCard.tsx';
export { textBlockStyle, textFontFamily } from './TextLayer.tsx';
export {
	MotionGraphicLayer,
	OfflineCard,
	ProxyPendingCard,
	SolidLayer,
	StillLayer,
	TextLayer,
	UnsupportedLayer,
	VideoLayer,
};

export const LAYER_COMPONENTS: Partial<Record<string, ComponentType<LayerProps>>> = {
	video: VideoLayer,
	still: StillLayer,
	'animated-image': StillLayer,
	text: TextLayer,
	solid: SolidLayer,
	'motion-graphic': MotionGraphicLayer,
};

const MEDIA_KINDS = new Set(['video', 'still', 'animated-image']);

/** Picks the component for a layer: offline media → OfflineCard, unknown kinds → UnsupportedLayer. */
export function layerComponentFor(layer: Pick<LayerProps, 'clip' | 'media'>): ComponentType<LayerProps> {
	if (MEDIA_KINDS.has(layer.clip.kind) && !layer.media) return OfflineCard;
	return LAYER_COMPONENTS[layer.clip.kind] ?? UnsupportedLayer;
}
