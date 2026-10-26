import type { Fixture, FixtureContext } from './types.ts';

export const FPSMAP_SIZE: { width: number; height: number };
export const FPSMAP_BITS: number;
export const FPSMAP_SECONDS: number;
export function fpsmapBitCentre(b: number): { x: number; y: number };
export const FPSMAP_PATCHES: ReadonlyArray<readonly [number, number, number]>;
export function fpsmapPatchRect(i: number): { x: number; y: number; w: number; h: number };
export const FPSMAP_RATES: ReadonlyArray<{ id: string; rate: string }>;
export function fixtures(ctx: FixtureContext): Fixture[];
