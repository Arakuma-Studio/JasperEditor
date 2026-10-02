// Live host budget of composition clips (S08:MGC-024) with on-canvas text editing (wp-m3-mgtext, S08:MGU-005):
// first-come 4 hosts; a clip edited on canvas without a slot takes the one of the holder farthest from the
// playhead for the duration of the edit; the edited clip never shows its cached preview.
import { describe, expect, it } from 'vitest';
import { MgRuntime } from '../src/mg-bundles/runtime.ts';
import { addSolids, makeSession } from './inspector-helpers.tsx';

function runtime() {
	const session = makeSession();
	const ids = addSolids(session, [0, 100, 200, 300, 400], 50);
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
		session.transport.seek(420); // inside the 5th clip
		rt.setTextEditing(ids[4]!);
		// The 5th clip is edited: it gets a host; the clip at 0 (farthest from 420) gives its slot up.
		expect(ids.map((id) => rt.hostAllowed(id))).toEqual([false, true, true, true, true]);
		rt.setTextEditing(null);
		expect(ids.map((id) => rt.hostAllowed(id))).toEqual([true, true, true, true, false]);
		// A holder that leaves frees its slot for the next mounted clip.
		releases[1]?.();
		expect(rt.hostAllowed(ids[4]!)).toBe(true);
		rt.dispose();
	});

	it('an edited clip that already holds a slot evicts nobody and never shows the cached preview', () => {
		const { ids, rt } = runtime();
		for (const id of ids) rt.acquireHost(id);
		rt.setTextEditing(ids[1]!);
		expect(ids.map((id) => rt.hostAllowed(id))).toEqual([true, true, true, true, false]);
		const src = {
			bundle: { key: 'k' },
			compositionId: 'C',
			props: {},
			canvas: { width: 1, height: 1 },
		} as never;
		expect(rt.previewFor({ clipId: ids[1]! } as never, src, 30)).toBeNull();
		rt.dispose();
	});
});
