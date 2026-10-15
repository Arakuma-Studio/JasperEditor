import { buildRenderSnapshot, type Keyframe, type Vec2 } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { TransformOverlay } from '../src/panels/program/TransformOverlay.tsx';
import { addSolids, clipOf, makeSession } from './inspector-helpers.tsx';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

type K = Keyframe<Vec2>;
const transform = (s: EditorSession, id: string) =>
	(
		clipOf(s, id) as unknown as {
			transform: { position: { keyframes: K[] }; anchor: { keyframes: K[]; value: Vec2 } };
		}
	).transform;

function setup(prop: 'position' | 'anchor' = 'position') {
	const session = makeSession();
	const [id] = addSolids(session, [0], 90);
	const path = ['clip', id!, 'transform', prop];
	const values: Vec2[] =
		prop === 'position'
			? [
					[400, 300],
					[960, 800],
					[1500, 300],
				]
			: [
					[100, 100],
					[500, 400],
					[900, 100],
				];
	const r = session.apply({
		label: 'keys',
		origin: 'user',
		commands: [
			{ type: 'param.setAnimated', target: path, animated: true, at: { sequenceFrame: 0 } },
			...values.map((value, i) => ({
				type: 'param.set',
				target: path,
				value,
				at: { sequenceFrame: i * 30 },
			})),
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	act(() => session.select('timeline', [id!]));
	return { session, id: id! };
}

function overlay(session: EditorSession, opts: { snap?: boolean; tool?: string } = {}) {
	const seqId = session.getState().activeSequenceId!;
	if (opts.tool) act(() => session.setToggles({ activeTool: opts.tool as never }));
	const ui = () => (
		<TransformOverlay
			session={session}
			doc={buildRenderSnapshot(session.getDrawn(), seqId, {
				resolveMedia: () => null,
				resolveFont: () => null,
			})}
			view={{ scale: 0.5, x: 0, y: 0 }}
			viewport={{ width: 960, height: 540 }}
			transport={session.transport}
			monitor={{ ...monitorStores.program.getState(), snapInMonitor: !!opts.snap }}
			onPan={() => {}}
		/>
	);
	const r = render(ui());
	return { ...r, svg: r.getByTestId('program-overlay'), refresh: () => r.rerender(ui()) };
}

function drag(
	svg: HTMLElement,
	from: Vec2,
	to: Vec2,
	mods: { ctrlKey?: boolean; down?: { ctrlKey?: boolean } } = {},
) {
	act(() => {
		fireEvent.pointerDown(svg, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1, ...mods.down });
		fireEvent.pointerMove(svg, {
			clientX: (from[0] + to[0]) / 2,
			clientY: (from[1] + to[1]) / 2,
			pointerId: 1,
			ctrlKey: mods.ctrlKey,
		});
		fireEvent.pointerMove(svg, { clientX: to[0], clientY: to[1], pointerId: 1, ctrlKey: mods.ctrlKey });
		fireEvent.pointerUp(svg, { clientX: to[0], clientY: to[1], pointerId: 1 });
	});
}

describe('motion path (keyframes-blend)', () => {
	it('draws the Anchor Point path through the layer map and edits its keys in layer space', () => {
		const { session, id } = setup('anchor');
		const { getByTestId, svg } = overlay(session);
		const before = session.getState().history.entries.length;
		// Middle key: anchor (500, 400) drawn where the layer map puts it at the playhead (frame 0).
		const square = getByTestId('overlay-anchor-path').querySelector(
			`[data-path-key="${transform(session, id).anchor.keyframes[1]!.id}"]`,
		)!;
		const at: Vec2 = [Number(square.getAttribute('x')) + 3.5, Number(square.getAttribute('y')) + 3.5];
		drag(svg, at, [at[0] + 10, at[1]]);
		const k = transform(session, id).anchor.keyframes[1]!;
		// +10 screen px = +20 sequence px; the solid's scale is 100 %, so +20 layer px.
		expect(k.value[0]).toBeCloseTo(520, 6);
		expect(k.value[1]).toBeCloseTo(400, 6);
		expect(session.getState().history.entries.length).toBe(before + 1);
	});

	it('snaps a dragged key to the frame centre (snapping on)', () => {
		const { session, id } = setup();
		const { svg } = overlay(session, { snap: true });
		// Key (960, 800) at screen (480, 400); dragged 3 screen px off the vertical centre line x = 960.
		drag(svg, [480, 400], [483, 380]);
		const k = transform(session, id).position.keyframes[1]!;
		expect(k.value[0]).toBe(960);
		expect(k.value[1]).toBeCloseTo(760, 6);
	});

	it('drags every selected key of the path by the same offset (one undo entry)', () => {
		const { session, id } = setup();
		const keys = transform(session, id).position.keyframes;
		act(() => session.selectKeyframes({ clipOrTrackId: id, keyframeIds: [keys[0]!.id, keys[1]!.id] }));
		const { svg } = overlay(session);
		const before = session.getState().history.entries.length;
		drag(svg, [480, 400], [490, 410]);
		const after = transform(session, id).position.keyframes;
		expect(after[0]!.value).toEqual([420, 320]);
		expect(after[1]!.value).toEqual([980, 820]);
		expect(after[2]!.value).toEqual([1500, 300]);
		expect(session.getState().history.entries.length).toBe(before + 1);
	});

	it('Ctrl-click converts a vertex (smooth ↔ corner); the Pen tool drags handles out of a corner', () => {
		const { session, id } = setup();
		const { svg, refresh } = overlay(session);
		const click = (at: Vec2, ctrlKey: boolean) =>
			act(() => {
				fireEvent.pointerDown(svg, { clientX: at[0], clientY: at[1], button: 0, pointerId: 1, ctrlKey });
				fireEvent.pointerUp(svg, { clientX: at[0], clientY: at[1], pointerId: 1 });
			});
		click([480, 400], true);
		expect(transform(session, id).position.keyframes[1]!.spatial?.mode).toBe('linear');
		refresh();
		click([480, 400], true);
		expect(transform(session, id).position.keyframes[1]!.spatial?.mode).toBe('auto-bezier');
		click([480, 400], true);
		cleanup();
		const pen = overlay(session, { tool: 'pen' });
		drag(pen.svg, [480, 400], [530, 400]);
		const s = transform(session, id).position.keyframes[1]!.spatial!;
		expect(s.mode).toBe('continuous-bezier');
		expect(s.outTangent[0]).toBeCloseTo(100, 6);
		expect(s.inTangent[0]).toBeCloseTo(-100, 6);
	});
});
