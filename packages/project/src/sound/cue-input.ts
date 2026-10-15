// A derived cue (`deriveCues`, spec 12 §2.2) as `soundCue.add` input: the stored cue fields only (no key, merged
// anchors, pattern group, score or derivation source), within the cue limits. The engine route, MCP and the Suggest
// Cues… dialog store suggestions with it. Pure.
import { SOUND_DESIGN_LIMITS } from '../schema/sound.ts';
import type { DerivedCue } from './cues/types.ts';

/** The `soundCue.add` cue of a derived cue (`ref` optional, e.g. `$cue3`, for a placement in the same transaction). */
export function cueInputFromDerived(c: DerivedCue, ref?: string): Record<string, unknown> {
	const out: Record<string, unknown> = {
		frame: Math.max(0, Math.min(SOUND_DESIGN_LIMITS.maxFrame, Math.round(c.frame))),
		kind: c.kind,
		weight: c.weight,
		types: c.types.slice(0, SOUND_DESIGN_LIMITS.types),
		align: c.align,
		anchor: c.anchor,
		confidence: Math.min(1, Math.max(0, c.confidence)),
		reason: c.reason.slice(0, SOUND_DESIGN_LIMITS.reason),
		source: c.source,
	};
	if (c.pan !== undefined) out.pan = c.pan;
	if (c.panSweep) out.panSweep = { from: c.panSweep.from, to: c.panSweep.to };
	if (c.window && c.window.end >= c.window.start) out.window = { start: c.window.start, end: c.window.end };
	if (ref) out.ref = ref;
	return out;
}
