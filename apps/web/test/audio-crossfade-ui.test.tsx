// Premiere port: audio crossfade UI — Effect Controls' fade curve and Custom Fade controls, the Custom Start
// alignment, the timeline geometry / edge drags of off-centre transitions and the curves the timeline draws.
import type { Sequence, Transition } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { transitionViewProps } from '../src/panels/timeline/components/TransitionView.tsx';
import {
	edgeDrag,
	edgeDragCommand,
	resizableEdges,
	transitionGeom,
} from '../src/panels/timeline/model/transitions.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

/** Two A/V clips cut at frame 120 (2 s of media handle on each side) and an audio crossfade of `effectId` on A1. */
function scene(effectId = 'jasper.constant-power', extra: Record<string, unknown> = {}) {
	const { session, seqId } = makeSession();
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
	return { session, seq, id, t };
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
	it('draws both sides of a fixed crossfade; picking Custom Fade starts from its own curve (Constant Gain → Linear @ 0)', () => {
		const s = scene('jasper.constant-gain');
		mount(s);
		expect(screen.getByTestId('audio-fade-curve-in')).toBeTruthy();
		expect(screen.getByTestId('audio-fade-curve-out')).toBeTruthy();
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
			params: { fadeShape: { value: 'cosine' }, fadeValue: { value: 30 } },
		});
		expect(s.session.getState().history.entries.length).toBe(n + 1);
	});

	it('an off-centre crossfade shows Custom Start; picking an alignment drops it', () => {
		const s = scene('jasper.constant-power', { cutOffset: 5 });
		mount(s);
		const sel = screen.getByTestId('transition-alignment') as HTMLSelectElement;
		expect(sel.value).toBe('custom');
		expect([...sel.options].map((o) => o.textContent)).toContain('Custom Start');
		act(() => {
			fireEvent.change(sel, { target: { value: 'center' } });
		});
		expect(s.t().cutPosition).toBeUndefined();
	});
});

describe('timeline: Custom Start geometry, edge drags and curves', () => {
	it('draws the span off-centre, resizes from either edge keeping the other one', () => {
		const s = scene('jasper.constant-power', { cutOffset: 5 });
		const g = transitionGeom(s.seq(), s.session.getCommitted().media, s.t())!;
		expect(g).toMatchObject({ cut: 120, start: 115, end: 135, cutOffset: 5 });
		expect(resizableEdges(g)).toEqual({ start: true, end: true });
		expect(edgeDrag(g, 'end', 140, false)).toEqual({ duration: 25, alignment: 'center', cutOffset: 5 });
		expect(edgeDrag(g, 'start', 110, false)).toEqual({ duration: 25, alignment: 'center', cutOffset: 10 });
		expect(edgeDrag(g, 'start', 125, false)).toEqual({ duration: 15, alignment: 'start-at-cut' });
		expect(edgeDragCommand('t', { duration: 25, alignment: 'center', cutOffset: 10 })).toEqual({
			type: 'transition.update',
			transitionId: 't',
			duration: 25,
			cutOffset: 10,
		});
		// Alt on a centred transition keeps the other edge too
		const c = scene('jasper.constant-power');
		const gc = transitionGeom(c.seq(), c.session.getCommitted().media, c.t())!;
		expect(edgeDrag(gc, 'end', 136, true)).toEqual({ duration: 26, alignment: 'center', cutOffset: 10 });
		expect(edgeDrag(gc, 'end', 136, false)).toEqual({ duration: 32, alignment: 'center' });
	});

	it('the timeline draws each side’s curve (Custom Fade asymmetrical, one-sided fades)', () => {
		const s = scene('jasper.custom-fade', {
			params: {
				fadeShape: 'linear',
				fadeValue: 12,
				symmetry: 'asymmetric',
				outFadeShape: 'cosine',
				outFadeValue: 30,
			},
		});
		const g = transitionGeom(s.seq(), s.session.getCommitted().media, s.t())!;
		const p = transitionViewProps(
			g,
			{ scrollFrame: 0, pxPerFrame: 2 } as never,
			60,
			false,
			{ num: 30, den: 1 },
			false,
		);
		expect(p.inCurve).toBe('shape:linear:12');
		expect(p.outCurve).toBe('shape:cosine:30');
		expect(p.title).toContain('Center at Cut');
		const o = scene('jasper.constant-power', { cutOffset: 5 });
		const go = transitionGeom(o.seq(), o.session.getCommitted().media, o.t())!;
		const po = transitionViewProps(
			go,
			{ scrollFrame: 0, pxPerFrame: 2 } as never,
			60,
			false,
			{ num: 30, den: 1 },
			false,
		);
		expect(po.inCurve).toBe('equal-power');
		expect(po.title).toContain('Custom Start (5 frames before the cut)');
	});
});
