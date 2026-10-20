// WP6.5a item 7 (Phase 3 verification limit): after an In Context audition (or a listen window) the Timeline stayed
// scrolled where playback had taken it while the playhead returned. The audition now tells the Timeline when a
// session's windows start and end (`onInContextView`), and the view it had comes back (`scrollAfterAudition`).
import type { EditorSession } from '@jasper/session';
import { afterEach, describe, expect, it } from 'vitest';
import { scrollAfterAudition, type Viewport } from '../src/panels/timeline/model/viewport.ts';
import { onInContextView, playTimelineWindow, stopInContext } from '../src/sound/in-context.ts';
import { makeSession } from './timeline-helpers.ts';

afterEach(() => stopInContext({ returnToAnchor: false }));

const view = (scrollFrame: number): Viewport => ({ scrollFrame, pxPerFrame: 2, width: 200 }) as Viewport;

describe('scrollAfterAudition', () => {
	it('goes back to the view before playback when the returned playhead is in it, else reveals it', () => {
		// playback scrolled the view to frame 300; the audition started at view 0 (frames 0–100 visible)
		expect(scrollAfterAudition(view(300), 0, 40)).toBe(0);
		// the playhead returned outside the old view: reveal it with minimum movement (25 % from the left)
		expect(scrollAfterAudition(view(300), 0, 150)).toBe(150 - 100 * 0.25);
		// no saved view: reveal; already visible: stay
		expect(scrollAfterAudition(view(300), null, 40)).toBe(40 - 100 * 0.25);
		expect(scrollAfterAudition(view(0), null, 40)).toBeNull();
		expect(scrollAfterAudition(view(0), 0, 40)).toBeNull();
		expect(scrollAfterAudition(view(300), Number.NaN, 320)).toBeNull();
	});
});

describe('onInContextView', () => {
	function record() {
		const events: string[] = [];
		const off = onInContextView({
			start: () => events.push('start'),
			end: (_s, f) => events.push(`end ${f}`),
		});
		return { events, off };
	}
	const seqOf = (session: EditorSession) =>
		session.getCommitted().sequences[session.getState().activeSequenceId!]!;

	it('one start and one end with the frame the playhead returned to, also when a window replaces another', () => {
		const { session } = makeSession();
		const r = record();
		playTimelineWindow(session, seqOf(session), { center: 60, returnTo: 12, title: 'A' });
		playTimelineWindow(session, seqOf(session), { center: 90, returnTo: 30, title: 'B' });
		expect(r.events).toEqual(['start']);
		stopInContext();
		// the replacing window returns where the first would have
		expect(r.events).toEqual(['start', 'end 12']);
		expect(session.transport.getState().frame).toBe(12);
		r.off();
	});

	it('an audition ended without returning the playhead (the session closed, another sequence) says null', () => {
		const { session } = makeSession();
		const r = record();
		playTimelineWindow(session, seqOf(session), { center: 60, returnTo: 12, title: 'A' });
		stopInContext({ returnToAnchor: false });
		expect(r.events).toEqual(['start', 'end null']);
		r.off();
	});
});
