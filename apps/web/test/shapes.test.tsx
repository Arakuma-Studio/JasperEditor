// Shapes in the web app (wp-m2-shapes): Graphics ▸ New Layer ▸ Rectangle / Ellipse (S11:SHP-006, FIX-007), the
// Program monitor shape tools (S03:XF-061: drag box, Shift, Alt, Escape, one undo step), Properties ▸ Shape and
// Effect Controls ▸ Shape (SHP-005), "Resize shapes by size" handles (SHP-007) and geometry hit-testing (XF-001).
import {
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type LegacyShapeClip,
	resolveSceneAt,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCommand, registerAllCommands } from '../src/commands/index.ts';
import type { CommandCtx } from '../src/commands/types.ts';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { TransformOverlay } from '../src/panels/program/TransformOverlay.tsx';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { hitsLayerGeometry } from '../src/shapes/geometry.ts';
import { shapePrefs } from '../src/shapes/prefs.ts';
import { ShapeToolOverlay } from '../src/shapes/ShapeToolOverlay.tsx';

function makeSession() {
	const ids = createCounterIdSource(1);
	const document = createEmptyProject({ ids, name: 'Shapes', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: document.projectId,
		document,
		ctx: { ids, now: () => 't', registries: defaultRegistries() },
		coalesceWindowMs: 0,
	});
	const seqId = session.getState().activeSequenceId!;
	return { session, seqId };
}
const seqOf = (session: EditorSession, seqId: string) => session.getCommitted().sequences[seqId]!;
const shapes = (session: EditorSession, seqId: string) =>
	Object.values(seqOf(session, seqId).clips).filter(
		(c): c is LegacyShapeClip => c.kind === 'shape' && c.shape.type !== 'vector',
	);
const snapshot = (session: EditorSession, seqId: string) =>
	buildRenderSnapshot(session.getDrawn(), seqId, { resolveMedia: () => null, resolveFont: () => null });
function addShape(
	session: EditorSession,
	shape: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) {
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [{ type: 'clip.addShape', at: 0, track: 'V1', shape, ref: '$s', ...extra }] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.refs.$s!;
}
const cmdCtx = (session: EditorSession | null) =>
	({ session, ui: { toast: () => {}, openDialog: () => {} } }) as unknown as CommandCtx;

beforeEach(() => shapePrefs.set({ resizeBySize: false, linkSize: false }));
afterEach(() => cleanup());

describe('shape geometry (pure)', () => {
	it('hit-tests shapes by their geometry (ellipse corners miss)', () => {
		const { session, seqId } = makeSession();
		const id = addShape(session, { type: 'ellipse', size: [400, 400] });
		const layer = resolveSceneAt(snapshot(session, seqId), 0).find((l) => l.clip.clipId === id)!;
		expect(hitsLayerGeometry(layer, [960, 540])).toBe(true);
		expect(hitsLayerGeometry(layer, [770, 350])).toBe(false); // inside the quad, outside the circle
		expect(hitsLayerGeometry(layer, [760, 540])).toBe(true);
	});
});

describe('Graphics ▸ New Layer ▸ Rectangle / Ellipse (FIX-007)', () => {
	it('are registered, enabled with a sequence and add a selected 400×400 shape at the playhead', () => {
		registerAllCommands();
		const { session, seqId } = makeSession();
		const rect = getCommand('graphics.newRectangle')!;
		const ell = getCommand('graphics.newEllipse')!;
		expect(rect.when?.(cmdCtx(null))).toBe(false);
		expect(rect.when?.(cmdCtx(session))).toBe(true);
		session.transport.seek(45);
		const before = session.getState().history.entries.length;
		rect.run(cmdCtx(session));
		const [r] = shapes(session, seqId);
		expect(r).toMatchObject({ kind: 'shape', start: 45, duration: 150 });
		expect(r!.shape.size.value).toEqual([400, 400]);
		expect(r!.transform.position.value).toEqual([960, 540]);
		expect(session.getState().selection.timeline.clips).toEqual([r!.id]);
		expect(session.getState().history.entries.length).toBe(before + 1);
		// The targeted V1 is busy now: the ellipse goes to the next free track.
		ell.run(cmdCtx(session));
		const e = shapes(session, seqId).find((c) => c.shape.type === 'ellipse')!;
		expect(e.trackId).not.toBe(r!.trackId);
		expect(e.start).toBe(45);
	});
});

describe('Program monitor shape tools (XF-061)', () => {
	const view = { scale: 0.5, x: 0, y: 0 };
	function mount(session: EditorSession, seqId: string) {
		return render(
			<ShapeToolOverlay
				session={session}
				doc={snapshot(session, seqId)}
				view={view}
				viewport={{ width: 960, height: 540 }}
				transport={session.transport}
				monitor={monitorStores.program.getState()}
			/>,
		);
	}
	const drag = (
		el: Element,
		from: [number, number],
		to: [number, number],
		mods: { shiftKey?: boolean; altKey?: boolean } = {},
	) => {
		fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1, ...mods });
		fireEvent.pointerMove(el, {
			clientX: (from[0] + to[0]) / 2,
			clientY: (from[1] + to[1]) / 2,
			pointerId: 1,
			...mods,
		});
		fireEvent.pointerMove(el, { clientX: to[0], clientY: to[1], pointerId: 1, ...mods });
		fireEvent.pointerUp(el, { clientX: to[0], clientY: to[1], pointerId: 1, ...mods });
	};

	it('a drag creates the shape with that box in one undo step, selects it and returns to Selection', () => {
		const { session, seqId } = makeSession();
		session.setToggles({ activeTool: 'rectangle' });
		session.transport.seek(10);
		const r = mount(session, seqId);
		const before = session.getState().history.entries.length;
		drag(r.getByTestId('shape-tool-overlay'), [100, 50], [300, 150]);
		const [s] = shapes(session, seqId);
		expect(s!.shape).toMatchObject({ type: 'rect', size: { value: [400, 200] } });
		expect(s!.transform.position.value).toEqual([400, 200]);
		expect(s!.start).toBe(10);
		expect(session.getState().history.entries.length).toBe(before + 1);
		expect(session.getState().selection.timeline.clips).toEqual([s!.id]);
		expect(session.getState().toggles.activeTool).toBe('selection');
		session.undo();
		expect(shapes(session, seqId)).toHaveLength(0);
	});

	it('Shift draws a circle, Alt draws from the centre; Escape cancels; a click adds nothing', () => {
		const { session, seqId } = makeSession();
		session.setToggles({ activeTool: 'ellipse' });
		const r = mount(session, seqId);
		const el = r.getByTestId('shape-tool-overlay');
		drag(el, [100, 100], [200, 130], { shiftKey: true });
		expect(shapes(session, seqId)[0]!.shape.size.value).toEqual([200, 200]);
		act(() => session.setToggles({ activeTool: 'ellipse' }));
		drag(r.getByTestId('shape-tool-overlay'), [480, 270], [530, 290], { altKey: true });
		const alt = shapes(session, seqId).find(
			(c) => c.shape.size.value[0] === 200 && c.shape.size.value[1] === 80,
		)!;
		expect(alt.transform.position.value).toEqual([960, 540]);
		act(() => session.setToggles({ activeTool: 'ellipse' }));
		const count = shapes(session, seqId).length;
		const surface = r.getByTestId('shape-tool-overlay');
		fireEvent.pointerDown(surface, { clientX: 10, clientY: 10, button: 0, pointerId: 3 });
		fireEvent.pointerMove(surface, { clientX: 90, clientY: 90, pointerId: 3 });
		expect(r.getByTestId('shape-tool-preview')).toBeTruthy();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(r.queryByTestId('shape-tool-preview')).toBeNull();
		fireEvent.pointerUp(surface, { clientX: 90, clientY: 90, pointerId: 3 });
		fireEvent.pointerDown(surface, { clientX: 50, clientY: 50, button: 0, pointerId: 4 });
		fireEvent.pointerUp(surface, { clientX: 51, clientY: 50, pointerId: 4 });
		expect(shapes(session, seqId)).toHaveLength(count);
		expect(session.getState().toggles.activeTool).toBe('ellipse');
	});
});

describe('"Resize shapes by size" (SHP-007)', () => {
	function overlay(session: EditorSession, seqId: string) {
		return (
			<TransformOverlay
				session={session}
				doc={snapshot(session, seqId)}
				view={{ scale: 0.5, x: 0, y: 0 }}
				viewport={{ width: 960, height: 540 }}
				transport={session.transport}
				monitor={monitorStores.program.getState()}
				onPan={() => {}}
			/>
		);
	}
	const dragEastHandle = (session: EditorSession, seqId: string, alt = false) => {
		const r = render(overlay(session, seqId));
		const svg = r.getByTestId('program-overlay');
		// 400×200 at the centre, scale 100: the east handle is at sequence (1160, 540) = screen (580, 270).
		fireEvent.pointerDown(svg, { clientX: 580, clientY: 270, button: 0, pointerId: 1, altKey: alt });
		fireEvent.pointerMove(svg, { clientX: 600, clientY: 270, pointerId: 1, altKey: alt });
		fireEvent.pointerMove(svg, { clientX: 630, clientY: 270, pointerId: 1, altKey: alt });
		fireEvent.pointerUp(svg, { clientX: 630, clientY: 270, pointerId: 1, altKey: alt });
		r.unmount();
	};

	it('off (default): handles change Motion scale', () => {
		const { session, seqId } = makeSession();
		const id = addShape(session, { type: 'rect', size: [400, 200] });
		session.select('timeline', [id]);
		dragEastHandle(session, seqId);
		const c = shapes(session, seqId)[0]!;
		expect(c.shape.size.value).toEqual([400, 200]);
		expect(c.transform.scale.value).not.toBe(100);
	});

	it('on: handles change shape.size (stroke width unchanged), one undo step; Alt keeps the west side', () => {
		shapePrefs.set({ resizeBySize: true });
		const { session, seqId } = makeSession();
		const id = addShape(session, {
			type: 'rect',
			size: [400, 200],
			stroke: { color: [0, 0, 0, 1], width: 6, position: 'inside' },
		});
		session.select('timeline', [id]);
		dragEastHandle(session, seqId);
		let c = shapes(session, seqId)[0]!;
		expect(c.shape.size.value).toEqual([600, 200]);
		expect(c.transform.scale.value).toBe(100);
		expect(c.shape.stroke!.width.value).toBe(6);
		expect(c.transform.position.value).toEqual([960, 540]);
		session.undo();
		dragEastHandle(session, seqId, true);
		c = shapes(session, seqId)[0]!;
		expect(c.shape.size.value).toEqual([500, 200]);
		// The west edge stays at x = 760: centre 1010 = 760 + 500 / 2.
		expect(c.transform.position.value).toEqual([1010, 540]);
	});
});

describe('Properties ▸ Shape and Effect Controls ▸ Shape (SHP-005)', () => {
	function mountProperties(session: EditorSession) {
		registerAllCommands();
		return render(
			<SessionProvider session={session}>
				<PropertiesPanel instanceId="props" visible />
			</SessionProvider>,
		);
	}

	it('shows type, size, fill and radius; None toggles remove/restore fill and add/remove the stroke', () => {
		const { session, seqId } = makeSession();
		const id = addShape(session, { type: 'rect', size: [300, 120] });
		session.select('timeline', [id]);
		mountProperties(session);
		fireEvent.click(screen.getByLabelText('No fill'));
		expect(shapes(session, seqId)[0]!.shape.fill).toBeNull();
		fireEvent.click(screen.getByLabelText('No fill'));
		expect(shapes(session, seqId)[0]!.shape.fill?.value).toEqual([1, 1, 1, 1]);
		fireEvent.click(screen.getByLabelText('No stroke'));
		expect(shapes(session, seqId)[0]!.shape.stroke).toMatchObject({
			width: { value: 8 },
			position: 'center',
		});
		fireEvent.click(screen.getByLabelText('No stroke'));
		expect(shapes(session, seqId)[0]!.shape.stroke).toBeNull();
	});

	it('the size link keeps the aspect ratio when one side is typed', () => {
		const { session, seqId } = makeSession();
		const id = addShape(session, { type: 'ellipse', size: [300, 100] });
		session.select('timeline', [id]);
		const r = mountProperties(session);
		fireEvent.click(r.getByTestId('shape-size-link'));
		const w = r.getByTestId('prop-shape.size-0');
		act(() => {
			fireEvent.pointerDown(w, { clientX: 10, button: 0 });
			fireEvent.pointerUp(window, { clientX: 10 });
		});
		const input = r.getByTestId('prop-shape.size-0-input') as HTMLInputElement;
		act(() => {
			fireEvent.change(input, { target: { value: '600' } });
			fireEvent.keyDown(input, { key: 'Enter' });
		});
		expect(shapes(session, seqId)[0]!.shape.size.value).toEqual([600, 200]);
	});
});
