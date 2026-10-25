// spatial-points: the Program monitor's motion path of an effect point param (Transform's Position) and the Effect
// Controls ▸ Spatial Interpolation menu on its keys (docs/wp-notes/spatial-points.md).
import {
	buildRenderSnapshot,
	contentTimeAt,
	type EffectInstance,
	evaluate,
	type Keyframe,
	type Rational,
	type Vec2,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { TransformOverlay } from '../src/panels/program/TransformOverlay.tsx';
import { inspectorFocus } from '../src/panels/properties/lib/focus.ts';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

beforeEach(() => {
	globalThis.localStorage?.clear();
	inspectorFocus.set({ source: null, clipIds: [], rowId: null, effectInstanceId: null });
});
afterEach(() => cleanup());

const fxOf = (s: EditorSession, id: string) =>
	(clipOf(s, id) as unknown as { effects: EffectInstance[] }).effects.find((e) => e.effectId === 'jasper.transform')!;
const keysOf = (s: EditorSession, id: string) => fxOf(s, id).params.position!.keyframes as Keyframe<Vec2>[];

/** A 90-frame 1920×1080 solid with a Transform effect whose Position has Auto Bezier keys at frames 0, 30, 60. */
function setup() {
	const session = makeSession();
	const [id] = addSolids(session, [0], 90);
	const r0 = session.apply({
		label: 'fx',
		origin: 'user',
		commands: [{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.transform' }] as never,
	});
	if (!r0.ok) throw new Error(JSON.stringify(r0.errors));
	const fxId = fxOf(session, id!).id;
	const pos = ['effect', fxId, 'position'];
	const r = session.apply({
		label: 'keys',
		origin: 'user',
		commands: [
			{ type: 'keyframe.add', target: pos, value: [0.25, 0.25], at: { sequenceFrame: 0 } },
			{ type: 'keyframe.add', target: pos, value: [0.5, 0.75], at: { sequenceFrame: 30 } },
			{ type: 'keyframe.add', target: pos, value: [0.75, 0.25], at: { sequenceFrame: 60 } },
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	act(() => session.select('timeline', [id!]));
	return { session, id: id!, fxId };
}

function overlay(session: EditorSession, view = { scale: 0.5, x: 0, y: 0 }) {
	const seqId = session.getState().activeSequenceId!;
	const ui = () => (
		<TransformOverlay
			session={session}
			doc={buildRenderSnapshot(session.getDrawn(), seqId, { resolveMedia: () => null, resolveFont: () => null })}
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

const drag = (svg: HTMLElement, from: Vec2, to: Vec2, opts: { altKey?: boolean } = {}) => {
	fireEvent.pointerDown(svg, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1 });
	fireEvent.pointerMove(svg, { clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2, pointerId: 1, ...opts });
	fireEvent.pointerMove(svg, { clientX: to[0], clientY: to[1], pointerId: 1, ...opts });
	fireEvent.pointerUp(svg, { clientX: to[0], clientY: to[1], pointerId: 1, ...opts });
};

describe('Program monitor ▸ effect point motion path', () => {
	it('is drawn for the effect focused in Effect Controls, through the layer, evaluated like the renderer', () => {
		const { session, id, fxId } = setup();
		const first = overlay(session);
		expect(first.queryByTestId('overlay-effect-path')).toBeNull();
		cleanup();
		act(() => inspectorFocus.set({ effectInstanceId: fxId }));
		const { container: c2 } = overlay(session);
		const g = c2.querySelector('[data-testid="overlay-effect-path"]')!;
		expect(g.getAttribute('data-effect-param')).toBe('position');
		const dots = g.querySelector('[data-testid="effect-path-dots"]')!;
		expect(dots.getAttribute('data-count')).toBe('90');
		// Key squares: normalised value × the 1920×1080 box (the solid's layer map is the identity) × view scale 0.5.
		const mid = keysOf(session, id)[1]!;
		const sq = c2.querySelector(`[data-path-key="${mid.id}"]`)!;
		expect(Number(sq.getAttribute('x')) + 3.5).toBeCloseTo(480, 6);
		expect(Number(sq.getAttribute('y')) + 3.5).toBeCloseTo(405, 6);
		// The dot of frame 15 is the metric-evaluated value (the renderers' value), not the metric-free one.
		const clip = clipOf(session, id);
		const rate = Object.values(session.getCommitted().sequences)[0]!.settings.frameRate as Rational;
		const t = contentTimeAt(clip as never, 15, rate);
		const want = evaluate(fxOf(session, id).params.position!, t, { metric: [1920, 1080] }) as Vec2;
		const d = dots.getAttribute('d')!;
		const pts = [...d.matchAll(/M([\d.]+) ([\d.]+)h0/g)].map((m) => [Number(m[1]), Number(m[2])]);
		expect(pts[15]![0]).toBeCloseTo(want[0] * 960, 0);
		expect(pts[15]![1]).toBeCloseTo(want[1] * 540, 0);
	});

	it('the param row focus also shows it; dragging a key edits the normalised value in one undo entry', () => {
		const { session, id, fxId } = setup();
		act(() => inspectorFocus.set({ rowId: `effects.${fxId}.position` }));
		const { svg } = overlay(session);
		const before = session.getState().history.entries.length;
		const key = keysOf(session, id)[1]!;
		// (0.5, 0.75) → sequence (960, 810) → screen (480, 405); +20 screen px = +40 sequence px.
		act(() => drag(svg, [480, 405], [500, 425]));
		const v = keysOf(session, id)[1]!.value;
		expect(v[0]).toBeCloseTo(0.5 + 40 / 1920, 6);
		expect(v[1]).toBeCloseTo(0.75 + 40 / 1080, 6);
		expect(keysOf(session, id)[1]!.id).toBe(key.id);
		expect(session.getState().history.entries.length).toBe(before + 1);
		act(() => session.undo());
		expect(keysOf(session, id)[1]!.value).toEqual([0.5, 0.75]);
	});

	it('dragging a tangent handle stores normalised tangents (continuous, lengths kept in pixels)', () => {
		const { session, id, fxId } = setup();
		act(() => inspectorFocus.set({ effectInstanceId: fxId }));
		const { svg, container } = overlay(session);
		const mid = keysOf(session, id)[1]!;
		const handle = container.querySelector(`[data-tangent="${mid.id}:out"] circle`)!;
		const hx = Number(handle.getAttribute('cx'));
		const hy = Number(handle.getAttribute('cy'));
		act(() => drag(svg, [hx, hy], [hx, hy - 30]));
		const s = keysOf(session, id)[1]!.spatial!;
		expect(s.mode).toBe('continuous-bezier');
		// The out tangent moved up by 60 sequence px = 60 / 1080 in y; the in side stays opposite.
		const t0 = (mid.spatial as { outTangent: Vec2 }).outTangent;
		expect(s.outTangent[0]).toBeCloseTo(t0[0], 4);
		expect(s.outTangent[1]).toBeCloseTo(t0[1] - 60 / 1080, 4);
		const cross = s.inTangent[0] * 1920 * s.outTangent[1] * 1080 - s.inTangent[1] * 1080 * s.outTangent[0] * 1920;
		expect(Math.abs(cross)).toBeLessThan(1e-3);
		act(() => session.undo());
		expect(keysOf(session, id)[1]!.spatial!.mode).toBe('auto-bezier');
	});
});

describe('Effect Controls ▸ Spatial Interpolation on effect points', () => {
	it('is offered on Transform Position keys and sets their mode', () => {
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
	});
});
