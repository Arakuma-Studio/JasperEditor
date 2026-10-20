// @jasper/compositions — SequenceComposition + layers for the Player and @remotion/renderer (ARCHITECTURE §8).
export * from './AssetComposition.tsx';
// audio-fx: preview slots of the audio effects and their live meters.
export { audioFxMeters, installAudioFxPreview } from './audio/fx-inserts.ts';
// audio-mix: the preview mix graph (meters, live mixer controls, effect slots).
export {
	activeMixGraph,
	type LoudnessReading,
	type MeterReading,
	type MixGraph,
	onActiveMixGraph,
	type PreviewInsert,
	type PreviewInsertFactory,
	panStageMatrix,
	registerPreviewInsert,
	setMixWorkletUrl,
	type TransportLogEntry,
	VISIBLE_START_WAIT,
} from './audio/graph.ts';
export * from './color/index.ts';
export * from './fonts.ts';
// Wave 1: GPU shader-effect framework runtime.
export * from './fx/index.ts';
export * from './layers/index.ts';
export * from './metadata.ts';
export * from './mg-host/protocol.ts';
export * from './mg-host/remote.ts';
export * from './mg-host/runtime.ts';
export * from './pipeline.ts';
// previews: render preview playback in the Program monitor.
export { applyPreviews, type PreviewFiles, type PreviewSpan, usableAudioSpans } from './previews.tsx';
export { RemotionRoot } from './Root.tsx';
export { renderPagesInOwnWindows } from './render-host.ts';
export { FrameRepaint } from './repaint.tsx';
export { SequenceComposition } from './SequenceComposition.tsx';
export * from './stabilize.ts';
// M2 (wp-m2-text-anim, S11:TXA-020)
export * from './text-animation-preview.tsx';
export * from './types.ts';
