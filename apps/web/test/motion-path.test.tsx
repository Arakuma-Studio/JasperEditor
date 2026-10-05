// Program Monitor motion path (S03:OVL-020) and the Effect Controls Spatial Interpolation menu (S03:KF-021):
// drawing under monitor zoom/pan, key square and tangent drags (one undo entry each, Alt breaks continuity),
// key selection, locked tracks.
import { buildRenderSnapshot, type Keyframe, type Vec2 } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { TransformOverlay } from '../src/panels/program/TransformOverlay.tsx';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

const keysOf = (s: EditorSession, id: string) =>
	(clipOf(s, id) as unknown as { transform: { position: { keyframes: Keyframe<Vec2>[] } } }).transform
		.position.keyframes;

/** A 90-frame solid with Auto Bezier position keys at frames 0, 30 and 60 (made like the monitor does). */
function setup() {
	const session = makeSession();
	const [id] = addSolids(session, [0], 90);
	const pos = ['clip', id!, 'transform', 'position'];
	const r = session.apply({
		label: 'keys',
		origin: 'user',
		commands: [
			{ type: 'param.setAnimated', target: pos, animated: true, at: { sequenceFrame: 0 } },
			{ type: 'param.set', target: pos, value: [400, 300], at: { sequenceFrame: 0 } },
			{ type: 'param.set', target: pos, value: [960, 800], at: { sequenceFrame: 30 } },
			{ type: 'param.set', target: pos, value: [1500, 300], at: { sequenceFrame: 60 } },
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	act(() => session.select('timeline', [id!]));
	return { session, id: id! };
}

function overlay(session: EditorSession, view = { scale: 0.5, x: 0, y: 0 }) {
	const seqId = session.getState().activeSequenceId!;
	const ui = () => (
		<TransformOverlay
			session={session}
			doc={buildRenderSnapshot(session.getDrawn(), seqId, {
				resolveMedia: () => null,
				resolveFont: () => null,
			})}
			view={view}
			viewport={{ width: 960, height: 540 }}
			transport={session.transport}
			monitor={{ ...monitorStores.program.getState(), snapInMonitor: false }}
			onPan={() => {}}
		/>
	);
	const r = render(ui());
	return { ...r, svg: r.getByTestId('program-overlay'), refresh: () => r.rerender(ui()) };
}

const drag = (svg: HTMLElement, from: Vec2, to: Vec2, opts: { altKey?: boolean; id?: number } = {}) => {
	const pointerId = opts.id ?? 1;
	fireEvent.pointerDown(svg, { clientX: from[0], clientY: from[1], button: 0, pointerId });
	fireEvent.pointerMove(svg, {
		clientX: (from[0] + to[0]) / 2,
		clientY: (from[1] + to[1]) / 2,
		pointerId,
		...opts,
	});
	fireEvent.pointerMove(svg, { clientX: to[0], clientY: to[1], pointerId, ...opts });
	fireEvent.pointerUp(svg, { clientX: to[0], clientY: to[1], pointerId, ...opts });
};

describe('Program Monitor motion path (S03:OVL-020)', () => {
	it('draws one dot per clip frame, key squares and the Auto Bezier tangent handles, under zoom and pan', () => {
		const { session, id } = setup();
		const { getByTestId, container } = overlay(session, { scale: 0.25, x: 100, y: 50 });
		const layer = getByTestId('overlay-motion-path');
		expect(layer.getAttribute('data-clip-id')).toBe(id);
		expect(getByTestId('motion-path-dots').getAttribute('data-count')).toBe('90');
		const squares = container.querySelectorAll('[data-path-key]');
		expect(squares).toHaveLength(3);
		// Key 2 at (960, 800) sequence px → screen (100 + 240, 50 + 200); the square is 7 px.
		const mid = squares[1] as SVGRectElement;
		expect([Number(mid.getAttribute('x')), Number(mid.getAttribute('y'))]).toEqual([336.5, 246.5]);
		expect(mid.getAttribute('width')).toBe('7');
		// First key: out handle only; middle: both; last: in only.
		expect(container.querySelectorAll('[data-tangent]')).toHaveLength(4);
	});

	it('is not drawn below two position keys', () => {
		const { session, id } = setup();
		act(
			() =>
				void session.apply({
					label: 'rm',
					origin: 'user',
					commands: [
						{
							type: 'keyframe.remove',
							keyframeIds: keysOf(session, id)
								.slice(1)
								.map((k) => k.id),
						},
					] as never,
				}),
		);
		const { queryByTestId } = overlay(session);
		expect(queryByTestId('overlay-motion-path')).toBeNull();
	});

	it('dragging a key square edits that key (one undo entry) and selects it', () => {
		const { session, id } = setup();
		const { svg, refresh, container } = overlay(session);
		const before = session.getState().history.entries.length;
		const key = keysOf(session, id)[1]!;
		// (960, 800) at scale 0.5 → screen (480, 400); +20 screen px = +40 sequence px.
		act(() => drag(svg, [480, 400], [500, 420]));
		expect(keysOf(session, id)[1]!.value).toEqual([1000, 840]);
		expect(keysOf(session, id)[1]!.id).toBe(key.id);
		expect(session.getState().history.entries.length).toBe(before + 1);
		expect(session.getState().selection.keyframes).toEqual({ clipOrTrackId: id, keyframeIds: [key.id] });
		refresh();
		expect(container.querySelector(`[data-path-key="${key.id}"]`)!.getAttribute('data-selected')).toBe(
			'true',
		);
		act(() => session.undo());
		expect(keysOf(session, id)[1]!.value).toEqual([960, 800]);
	});

	it('dragging a tangent keeps it continuous; Alt-drag breaks continuity; one undo entry per drag', () => {
		const { session, id } = setup();
		const { svg, refresh } = overlay(session);
		const before = session.getState().history.entries.length;
		// Auto tangent of the middle key = (next − prev) / 6 = (183.33, 0): out handle at screen (571.67, 400).
		const out: Vec2 = [(960 + 1100 / 6) / 2, 400];
		act(() => drag(svg, out, [out[0], 450]));
		let s = keysOf(session, id)[1]!.spatial!;
		expect(s.mode).toBe('continuous-bezier');
		expect(s.outTangent[0]).toBeCloseTo(1100 / 6, 6);
		expect(s.outTangent[1]).toBeCloseTo(100, 6);
		const len = Math.hypot(...s.outTangent);
		// The in tangent turned opposite and kept its length (1100 / 6).
		expect(s.inTangent[0] / (1100 / 6)).toBeCloseTo(-s.outTangent[0] / len, 6);
		expect(Math.hypot(...s.inTangent)).toBeCloseTo(1100 / 6, 6);
		expect(session.getState().history.entries.length).toBe(before + 1);
		refresh();
		// Alt-drag the in handle: Bezier, the out tangent stays.
		const inH: Vec2 = [(960 + s.inTangent[0]) / 2, (800 + s.inTangent[1]) / 2];
		const outBefore = [...s.outTangent];
		act(() => drag(svg, inH, [inH[0] - 10, inH[1]], { altKey: true, id: 2 }));
		s = keysOf(session, id)[1]!.spatial!;
		expect(s.mode).toBe('bezier');
		expect(s.outTangent).toEqual(outBefore);
		expect(session.getState().history.entries.length).toBe(before + 2);
		act(() => session.undo());
		expect(keysOf(session, id)[1]!.spatial!.mode).toBe('continuous-bezier');
		act(() => session.undo());
		expect(keysOf(session, id)[1]!.spatial!.mode).toBe('auto-bezier');
	});

	it('keys on a locked track are drawn but not draggable', () => {
		const { session, id } = setup();
		const trackId = clipOf(session, id).trackId;
		act(
			() =>
				void session.apply({
					label: 'lock',
					origin: 'user',
					commands: [{ type: 'track.update', trackId, patch: { locked: true } }] as never,
				}),
		);
		const { svg, getByTestId } = overlay(session);
		expect(getByTestId('overlay-motion-path')).toBeTruthy();
		act(() => drag(svg, [480, 400], [500, 420]));
		expect(keysOf(session, id)[1]!.value).toEqual([960, 800]);
	});
});

describe('Effect Controls ▸ Spatial Interpolation (S03:KF-021)', () => {
	it('sets the spatial interpolation of position keys from the key context menu', () => {
		const { session, id } = setup();
		renderWithSession(session, <EffectControlsPanel instanceId="ec1" visible />);
		const key = keysOf(session, id)[1]!;
		const glyph = document.querySelector(`[data-kf-id="${key.id}"]`) as HTMLElement;
		act(() => {
			fireEvent.contextMenu(glyph, { clientX: 10, clientY: 10 });
		});
		act(() => {
			fireEvent.click(within(screen.getByTestId('ec-kf-menu')).getByTestId('ec-kf-spatial'));
		});
		const sub = screen.getByTestId('ec-kf-spatial-menu');
		expect(sub.querySelector('[data-spatial="auto-bezier"]')!.getAttribute('aria-checked')).toBe('true');
		act(() => {
			fireEvent.click(sub.querySelector('[data-spatial="linear"]')!);
		});
		expect(keysOf(session, id)[1]!.spatial!.mode).toBe('linear');
		expect(screen.queryByTestId('ec-kf-menu')).toBeNull();
		expect(session.getState().history.entries.at(-1)?.label).toBe('Spatial Interpolation: Linear');
	});

	it('is not offered for keys of non-point properties', () => {
		const { session, id } = setup();
		act(
			() =>
				void session.apply({
					label: 'k',
					origin: 'user',
					commands: [
						{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 0 }, value: 50 },
					] as never,
				}),
		);
		renderWithSession(session, <EffectControlsPanel instanceId="ec1" visible />);
		const k = (clipOf(session, id) as unknown as { opacity: { keyframes: { id: string }[] } }).opacity
			.keyframes[0]!;
		act(() => {
			fireEvent.contextMenu(document.querySelector(`[data-kf-id="${k.id}"]`) as HTMLElement, {
				clientX: 10,
				clientY: 10,
			});
		});
		expect(within(screen.getByTestId('ec-kf-menu')).queryByTestId('ec-kf-spatial')).toBeNull();
	});
});
