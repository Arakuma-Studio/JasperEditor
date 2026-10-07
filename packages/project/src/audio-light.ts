// `@jasper/project/audio` (audio-fx): the light part of the model the audio DSP needs — the audio effect catalogue,
// the keyframe evaluator, flick/frame time and audio fades — without zod/immer or the rest of the model, so the
// AudioWorklet bundle stays small. Everything here is also exported from the package root.

export * from './audio/processors.ts';
export * from './audio-fade.ts';
export { evaluate, isAnimated } from './keyframes.ts';
export * from './registry/audio/index.ts';
export type { AudioEffectEditor, AudioEffectInfo, EffectSpec, ParamSpec } from './registry/effects.ts';
export type { Animatable, Keyframe, ParamValue } from './schema/common.ts';
export type { EffectInstance } from './schema/sequence.ts';
export * from './time.ts';
