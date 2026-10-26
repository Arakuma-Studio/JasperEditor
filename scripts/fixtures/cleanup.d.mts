import type { Fixture, FixtureContext } from './types.ts';

export const CLEANUP_VOICE_EVENTS: ReadonlyArray<{ say: string; keep: boolean } | { pauseS: number }>;
export function cleanupVoiceWords(): Array<{ text: string; s: number; e: number; keep: boolean }>;
export function fixtures(ctx: FixtureContext): Fixture[];
