// Live host budget of composition clips (S08:MGC-024) with on-canvas text editing (wp-m3-mgtext, S08:MGU-005):
// first-come 4 hosts; a clip edited on canvas without a slot takes the one of the holder farthest from the
// playhead for the duration of the edit.
import { describe, expect, it } from 'vitest';
import { MgRuntime } from '../src/mg-bundles/runtime.ts';
import { addSolids, makeSession } from './inspector-helpers.tsx';

function runtime() {
	const session = makeSession();
	const ids = addSolids(session, [200, 0, 300, 100, 400], 50);
	const rt = new MgRuntime(session, {
		client: { call: async () => ({}) } as never,
		subscribe: () => () => undefined,
	});
	return { session, ids, rt };
}

describe('live host budget (S08:MGC-024) and on-canvas editing', () => {
	it('gives 4 slots first-come; an edited clip takes the farthest holder’s slot until the edit ends', () => {
		const { session, ids, rt } = runtime();
		const releases = ids.map((id) => rt.acquireHost(id));
		expect(ids.map((id) => rt.hostAllowed(id))).toEqual([true, true, true, true, false]);
		// Editing a holder uses its existing slot.
		rt.setTextEditing(ids[2]!);
		expect(ids.map((id) => rt.hostAllowed(id))).toEqual([true, true, true, true, false]);
		session.transport.seek(420); // inside the 5th clip
		rt.setTextEditing(ids[4]!);
		// Distance, not mount order: the second holder at 0 gives its slot to the edited clip.
		expect(ids.map((id) => rt.hostAllowed(id))).toEqual([true, false, true, true, true]);
		rt.setTextEditing(null);
		expect(ids.map((id) => rt.hostAllowed(id))).toEqual([true, true, true, true, false]);
		// A holder that leaves frees its slot for the next mounted clip.
		releases[1]?.();
		expect(rt.hostAllowed(ids[4]!)).toBe(true);
		rt.dispose();
	});
});
