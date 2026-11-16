// The Pitch Shifter's optional Rubber Band engine: the separate GPL WebAssembly module of @jasper/audio-fx
// (scripts/rubberband-wasm), served by Vite as an asset, compiled on the main thread and passed into the AudioWorklet.
// layers-allow: Vite's ?url query on the exported ./rubberband.wasm subpath
import rubberBandUrl from '@jasper/audio-fx/rubberband.wasm?url';

export const RUBBERBAND_WASM_URL: string = rubberBandUrl;
