import { describe, expect, it } from 'vitest';
import { setupTimeline, solid } from './timeline-helpers.ts';

function pointerTimeline() {
	const t = setupTimeline({ pxPerFrame: 2 });
	t.apply([solid(0, 400, 'V1'), solid(100, 100, 'V2')]);
	t.session.setToggles({ activeTool: 'razor', snapping: true });
	t.session.transport.seek(50);
	const hover = (frame: number) => {
		t.controller.hover(t.pt(t.x(frame), t.rowY('V1')));
		return t.ui.getState().razor?.frame;
	};
	return { ...t, hover };
}

describe('timeline pointer snapping', () => {
	it('uses the current playhead and snapping toggle on consecutive razor hovers', () => {
		const t = pointerTimeline();
		expect(t.hover(52)).toBe(50);
		expect(t.hover(53)).toBe(50);
		t.session.transport.seek(60);
		expect(t.hover(58)).toBe(60);
		expect(t.hover(52)).toBe(52);
		expect(t.hover(102)).toBe(100);
		t.session.setToggles({ snapping: false });
		expect(t.hover(102)).toBe(102);
		// TL-620 still snaps the razor to the playhead when ordinary snapping is off.
		expect(t.hover(58)).toBe(60);
		t.session.setToggles({ snapping: true });
		expect(t.hover(102)).toBe(100);
	});

	it('updates razor snap edges after an edit, undo and redo, and cuts at the displayed frame', () => {
		const t = pointerTimeline();
		const clip = t.clipsOn('V2')[0]!;
		expect(t.hover(102)).toBe(100);
		t.apply([{ type: 'clip.move', clipIds: [clip.id], deltaFrames: 10 }]);
		expect(t.hover(102)).toBe(102);
		expect(t.hover(108)).toBe(110);
		t.session.undo();
		expect(t.hover(102)).toBe(100);
		t.session.redo();
		expect(t.hover(102)).toBe(102);
		expect(t.hover(108)).toBe(110);
		t.controller.pointerDown(t.pt(t.x(108), t.rowY('V1')));
		t.controller.pointerUp(t.pt(t.x(108), t.rowY('V1')));
		expect(t.spans('V1')).toEqual([
			[0, 110],
			[110, 400],
		]);
	});

	it('keeps ruler snap targets independent of the changing playhead and updates them after edits', () => {
		const t = pointerTimeline();
		const scrub = (frame: number) => t.controller.scrubTo(t.x(frame), true);
		const clip = t.clipsOn('V2')[0]!;
		t.session.transport.seek(104);
		expect(scrub(102)).toBe(100);
		expect(scrub(104)).toBe(100);
		t.apply([{ type: 'clip.move', clipIds: [clip.id], deltaFrames: 10 }]);
		expect(scrub(102)).toBe(102);
		expect(scrub(108)).toBe(110);
		t.session.undo();
		expect(scrub(102)).toBe(100);
		t.session.redo();
		expect(scrub(102)).toBe(102);
		t.apply([{ type: 'marker.add', frame: 153 }]);
		expect(scrub(150)).toBe(153);
		expect(t.controller.scrubTo(t.x(150), false)).toBe(150);
	});

	it('preserves marker priority on ties when switching between ruler and razor snapping', () => {
		const t = pointerTimeline();
		t.apply([{ type: 'marker.add', frame: 104 }]);
		expect(t.controller.scrubTo(t.x(102), true)).toBe(104);
		t.session.transport.seek(100);
		// Playhead priority beats the equally distant marker for the razor.
		expect(t.hover(102)).toBe(100);
		expect(t.controller.scrubTo(t.x(102), true)).toBe(104);
	});
});
