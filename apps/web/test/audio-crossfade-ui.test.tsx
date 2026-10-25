// Premiere port: audio crossfade UI — Effect Controls' fade curve and Custom Fade controls, the Custom Start
// alignment and actual timeline edge gestures of off-centre transitions.
import type { Sequence, Transition } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { makeSession, setupTimeline, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

/** Two A/V clips cut at frame 120 (2 s of media handle on each side) and an audio crossfade of `effectId` on A1. */
function scene(
	effectId = 'jasper.constant-power',
	extra: Record<string, unknown> = {},
	timeline?: ReturnType<typeof setupTimeline>,
) {
	const { session, seqId } = timeline ?? makeSession();
	const apply = (commands: unknown[]) => {
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: commands as never[],
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const reg = () =>
		(apply([{ type: 'media.register', asset: videoAsset(20, true) }]).results[0] as { mediaId: string })
			.mediaId;
	const a = reg();
	const b = reg();
	apply([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 120,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
		},
	]);
	const r = apply([
		{ type: 'transition.add', trackId: 'A1', at: 120, effectId, duration: 20, ref: '$x', ...extra },
	]);
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const id = r.refs.$x!;
	const t = () => seq().transitions[id] as Transition;
	return { session, id, t };
}

function mount(s: ReturnType<typeof scene>) {
	act(() => s.session.select('transitions', [s.id], 'replace'));
	render(
		<SessionProvider session={s.session}>
			<EffectControlsPanel instanceId="ec-xf" visible />
		</SessionProvider>,
	);
}

describe('Effect Controls: audio transition curve and Custom Fade controls', () => {
	it('picking Custom Fade preserves the Constant Gain curve as Linear @ 0', () => {
		const s = scene('jasper.constant-gain');
		mount(s);
		expect(screen.queryByTestId('custom-fade-shape')).toBeNull();
		act(() => {
			fireEvent.change(screen.getByTestId('transition-type'), { target: { value: 'jasper.custom-fade' } });
		});
		expect(s.t()).toMatchObject({
			effectId: 'jasper.custom-fade',
			params: { fadeShape: { value: 'linear' }, fadeValue: { value: 0 } },
		});
		expect((screen.getByTestId('custom-fade-shape') as HTMLSelectElement).value).toBe('linear');
	});

	it('edits shape, value and symmetry (asymmetrical seeds the fade out); each edit is one undo step', () => {
		const s = scene('jasper.custom-fade');
		mount(s);
		const n = s.session.getState().history.entries.length;
		act(() => {
			fireEvent.change(screen.getByTestId('custom-fade-shape'), { target: { value: 'linear' } });
		});
		act(() => {
			fireEvent.change(screen.getByTestId('custom-fade-value-slider'), { target: { value: '30' } });
		});
		expect(s.t().params).toMatchObject({ fadeShape: { value: 'linear' }, fadeValue: { value: 30 } });
		expect(screen.queryByTestId('custom-fade-out-shape')).toBeNull();
		act(() => {
			fireEvent.change(screen.getByTestId('custom-fade-symmetry'), { target: { value: 'asymmetric' } });
		});
		expect(s.t().params).toMatchObject({
			symmetry: { value: 'asymmetric' },
			outFadeShape: { value: 'linear' },
			outFadeValue: { value: 30 },
		});
		expect(screen.getByTestId('custom-fade-out-shape')).toBeTruthy();
		expect(s.session.getState().history.entries.length).toBe(n + 3);
		act(() => {
			s.session.undo();
		});
		expect(s.t().params.symmetry).toBeUndefined();
		act(() => {
			s.session.redo();
		});
		expect(s.t().params.symmetry?.value).toBe('asymmetric');
	});

	it('dragging the curve up makes a Constant Power a Custom Fade above Cosine @ 19, in one history entry', () => {
		const s = scene('jasper.constant-power');
		mount(s);
		const n = s.session.getState().history.entries.length;
		const g = screen.getByTestId('audio-fade-curve-graph');
		act(() => {
			fireEvent.pointerDown(g, { button: 0, clientX: 50, clientY: 100 });
			window.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 90 }));
			window.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 89 }));
			window.dispatchEvent(new MouseEvent('pointerup', {}));
		});
		expect(s.t()).toMatchObject({
			effectId: 'jasper.custom-fade',
			params: { fadeShape: { value: 'cosine' } },
		});
		expect(s.t().params.fadeValue?.value).toBeGreaterThan(19);
		expect(s.session.getState().history.entries.length).toBe(n + 1);
	});

	it('an off-centre crossfade shows Custom Start; picking an alignment drops it', () => {
		const s = scene('jasper.constant-power', { cutOffset: 5 });
		mount(s);
		const sel = screen.getByTestId('transition-alignment') as HTMLSelectElement;
		expect(sel.value).toBe('custom');
		act(() => {
			fireEvent.change(sel, { target: { value: 'center' } });
		});
		expect(s.t().cutPosition).toBeUndefined();
	});
});

describe('timeline: Custom Start edge gestures', () => {
	it('resizes either edge without moving the opposite edge and becomes at-cut when dragged past the cut', () => {
		const timeline = setupTimeline({ pxPerFrame: 4 });
		timeline.session.setToggles({ snapping: false });
		const s = scene('jasper.constant-power', { cutOffset: 5 }, timeline);
		const y = timeline.rowY('A1');
		timeline.drag(timeline.x(135) - 1, y, timeline.x(140), y);
		expect(s.t()).toMatchObject({ duration: 25, cutPosition: 0.2 }); // span 115…140
		timeline.session.undo();
		timeline.drag(timeline.x(115) + 1, y, timeline.x(110), y);
		expect(s.t()).toMatchObject({ duration: 25, cutPosition: 0.4 }); // span 110…135
		timeline.session.undo();
		timeline.drag(timeline.x(115) + 1, y, timeline.x(125), y);
		expect(s.t()).toMatchObject({ duration: 15, alignment: 'start-at-cut' });
		expect(s.t().cutPosition).toBeUndefined();
	});
});
