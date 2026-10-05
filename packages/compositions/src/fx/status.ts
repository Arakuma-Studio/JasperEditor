// Availability of the fx GPU host (wave-1 fx framework; mirrors the colour stage's status store, S06:CG-045): a tiny
// external store the layers subscribe to. Preview: while WebGL2 is missing or the shared context is lost, shader
// effects are bypassed with a chip on the layer; an effect whose shader failed to compile is bypassed alone (its
// error is logged once). Renders never draw a bypassed effect: they fail (WEBGL_UNAVAILABLE / FX_SHADER_ERROR).
import { useSyncExternalStore } from 'react';
import { canUseWebGl2 } from '../color/gl.ts';

export type FxGpuState = 'ok' | 'lost' | 'unavailable';

let lost = false;
let version = 0;
/** Effect ids whose shaders failed (preview), with the first error message. */
const failed = new Map<string, string>();
const listeners = new Set<() => void>();
const emit = () => {
	version++;
	for (const l of listeners) l();
};

export const fxStatus = {
	gpu(): FxGpuState {
		if (!canUseWebGl2()) return 'unavailable';
		return lost ? 'lost' : 'ok';
	},
	/** Changes whenever availability or the failure set changes (store snapshot). */
	version(): number {
		return version;
	},
	subscribe(cb: () => void): () => void {
		listeners.add(cb);
		return () => listeners.delete(cb);
	},
	contextLost(): void {
		lost = true;
		emit();
	},
	contextRestored(): void {
		lost = false;
		emit();
	},
	/** An effect's shader failed to compile/link (preview): bypass it from now on. */
	shaderFailed(effectId: string, message: string): void {
		if (failed.has(effectId)) return;
		failed.set(effectId, message);
		console.error(`[fx] ${message}`);
		emit();
	},
	failure(effectId: string): string | undefined {
		return failed.get(effectId);
	},
	/** Test hook. */
	reset(): void {
		lost = false;
		failed.clear();
		emit();
	},
};

/** Re-renders the caller when GPU availability or shader failures change; returns the GPU state. */
export function useFxStatus(): FxGpuState {
	useSyncExternalStore(fxStatus.subscribe, fxStatus.version, fxStatus.version);
	return fxStatus.gpu();
}
