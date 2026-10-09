// gaps (Preferences ▸ Memory ▸ Optimize rendering for): the default number of parallel render pages / tabs of the
// Remotion and layer-bake paths. `performance` = half the cores (the long-standing default), `memory` = a quarter
// (each headless page holds decoded frames and GPU textures: fewer pages, less memory, slower renders).
import { availableParallelism } from 'node:os';

let mode: 'performance' | 'memory' = 'performance';

export function setRenderOptimization(m: 'performance' | 'memory'): void {
	mode = m;
}

export function renderOptimization(): 'performance' | 'memory' {
	return mode;
}

/** Default parallelism of headless render pages. */
export function renderParallelism(cpus = availableParallelism()): number {
	return Math.max(1, Math.floor(cpus / (mode === 'memory' ? 4 : 2)));
}
