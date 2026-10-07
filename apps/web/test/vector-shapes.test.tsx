// Vector shapes in the web app (wp shapes): Properties ▸ Shape Contents (add with After Effects' placement, presets,
// group, move, rename, enable, delete, stroke options, gradient editor), the Polygon / Star tools and drawing into a
// selected shape, the Pen tool (draw, close) and vertex editing on the monitor, Convert to Vector Shape, Effect
// Controls ▸ Contents sections, SVG paste helpers and the monitor framing.
import {
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	findItem,
	resolveSceneAt,
	type ShapeClip,
	type ShapeItem,
	type VectorShapeData,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { looksLikeSvgPathData } from '../src/clipboard/external.ts';
import { getCommand, registerAllCommands } from '../src/commands/index.ts';
import type { CommandCtx } from '../src/commands/types.ts';
import { buildGroups } from '../src/panels/effectControls/items.ts';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { dragStar, polystarPreview } from '../src/shapes/draw.ts';
import { addStop, removeStop } from '../src/shapes/GradientEditor.tsx';
import { hitsLayerGeometry, layerEditQuad, layerEditRect } from '../src/shapes/geometry.ts';
import { ShapeToolOverlay } from '../src/shapes/ShapeToolOverlay.tsx';
import { VectorPathOverlay } from '../src/shapes/VectorPathOverlay.tsx';
import { insertionPoint } from '../src/shapes/VectorShapeSection.tsx';
import { vectorUi } from '../src/shapes/vector.ts';

function makeSession() {
	const ids = createCounterIdSource(1);
	const document = createEmptyProject({ ids, name: 'Vector', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: document.projectId,
		document,
		ctx: { ids, now: () => 't', registries: defaultRegistries() },
		coalesceWindowMs: 0,
	});
	return { session, seqId: session.getState().activeSequenceId! };
}
const clipOf = (session: EditorSession, seqId: string, id: string) =>
	session.getCommitted().sequences[seqId]!.clips[id] as ShapeClip & { shape: VectorShapeData };
const vectorClips = (session: EditorSession, seqId: string) =>
	Object.values(session.getCommitted().sequences[seqId]!.clips).filter(
		(c): c is ShapeClip & { shape: VectorShapeData } => c.kind === 'shape' && c.shape.type === 'vector',
	);
function addVector(session: EditorSession, contents: unknown[]) {
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{ type: 'clip.addShape', at: 0, track: 'V1', shape: { type: 'vector', contents }, ref: '$s' },
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.refs.$s!;
}
const snapshot = (session: EditorSession, seqId: string) =>
	buildRenderSnapshot(session.getDrawn(), seqId, { resolveMedia: () => null, resolveFont: () => null });
const cmdCtx = (session: EditorSession | null) =>
	({ session, ui: { toast: () => {}, openDialog: () => {} } }) as unknown as CommandCtx;

afterEach(() => {
	cleanup();
	vectorUi.set({ selected: null, vertices: [], collapsed: {} });
});

describe('pure helpers', () => {
	it('insertion point: paths above the paints, others at the end, into a selected group', () => {
		const items = [
			{ id: 'a', type: 'rect', name: 'R' },
			{ id: 'b', type: 'fill', name: 'F' },
			{
				id: 'g',
				type: 'group',
				name: 'G',
				contents: [
					{ id: 'c', type: 'ellipse', name: 'E' },
					{ id: 'd', type: 'stroke', name: 'S' },
				],
			},
		] as unknown as ShapeItem[];
		expect(insertionPoint(items, null, 'ellipse')).toEqual({ parentId: null, index: 1 });
		expect(insertionPoint(items, null, 'trim')).toEqual({ parentId: null, index: 3 });
		expect(insertionPoint(items, 'g', 'rect')).toEqual({ parentId: 'g', index: 1 });
		expect(insertionPoint(items, 'g', 'fill')).toEqual({ parentId: 'g', index: 2 });
		expect(insertionPoint(items, 'a', 'fill')).toEqual({ parentId: null, index: 1 });
	});
	it('polystar drags and gradient stop edits', () => {
		const s = dragStar([100, 100], [100, 0], false);
		expect(s).toEqual({ center: [100, 100], radius: 100, rotation: 0 });
		expect(dragStar([0, 0], [100, 0], false).rotation).toBe(90);
		expect(dragStar([0, 0], [100, 0], true).rotation).toBe(0);
		expect(polystarPreview('star', s)).toHaveLength(10);
		const g = {
			colors: [
				{ position: 0, color: [0, 0, 0] as [number, number, number] },
				{ position: 1, color: [1, 1, 1] as [number, number, number] },
			],
			opacities: [],
		};
		const r = addStop(g, 'color', 0.5);
		expect(r.g.colors[r.index]!.color[0]).toBeCloseTo(0.5, 6);
		expect(removeStop(r.g, { kind: 'color', index: r.index }).colors).toHaveLength(2);
		expect(removeStop({ ...g, colors: [g.colors[0]!] }, { kind: 'color', index: 0 }).colors).toHaveLength(1);
	});
	it('recognises SVG path data', () => {
		expect(looksLikeSvgPathData('M0 0 L10 10 Z')).toBe(true);
		expect(looksLikeSvgPathData('Meeting at 10')).toBe(false);
		expect(looksLikeSvgPathData('hello')).toBe(false);
	});
});

describe('Properties ▸ Shape Contents', () => {
	const mount = (session: EditorSession) => {
		registerAllCommands();
		return render(
			<SessionProvider session={session}>
				<PropertiesPanel instanceId="props" visible />
			</SessionProvider>,
		);
	};

	it('lists the tree; adds, groups, moves, renames, toggles and deletes items (one undo step each)', () => {
		const { session, seqId } = makeSession();
		const id = addVector(session, [
			{ type: 'rect', size: [200, 100] },
			{ type: 'fill', color: '#ff0000' },
		]);
		session.select('timeline', [id]);
		mount(session);
		const tree = screen.getByTestId('vector-tree');
		expect(
			within(tree)
				.getAllByRole('treeitem')
				.map((r) => r.getAttribute('data-item-type')),
		).toEqual(['rect', 'fill']);
		const [rect, fill] = clipOf(session, seqId, id).shape.contents;
		// Select the rectangle, add an Ellipse Path: it lands right after it (above the fill).
		fireEvent.click(screen.getByTestId(`vector-item-${rect!.id}`));
		const before = session.getState().history.entries.length;
		fireEvent.change(screen.getByTestId('vector-add'), { target: { value: 'ellipse' } });
		expect(session.getState().history.entries.length).toBe(before + 1);
		expect(clipOf(session, seqId, id).shape.contents.map((i) => i.type)).toEqual(['rect', 'ellipse', 'fill']);
		// The new item is selected; its properties show.
		expect(screen.getByTestId('vector-item-properties')).toBeTruthy();
		// Add Trim Paths: after the selected ellipse.
		fireEvent.change(screen.getByTestId('vector-add'), { target: { value: 'trim' } });
		expect(clipOf(session, seqId, id).shape.contents.map((i) => i.type)).toEqual([
			'rect',
			'ellipse',
			'trim',
			'fill',
		]);
		// Group the trim, then move it down.
		fireEvent.click(screen.getByTestId('vector-group'));
		expect(clipOf(session, seqId, id).shape.contents.map((i) => i.type)).toEqual([
			'rect',
			'ellipse',
			'group',
			'fill',
		]);
		fireEvent.click(screen.getByTestId('vector-down'));
		expect(clipOf(session, seqId, id).shape.contents.map((i) => i.type)).toEqual([
			'rect',
			'ellipse',
			'fill',
			'group',
		]);
		// Eye and delete.
		fireEvent.click(screen.getByTestId(`vector-eye-${fill!.id}`));
		expect(findItem(clipOf(session, seqId, id).shape.contents, fill!.id)!.item.enabled).toBe(false);
		fireEvent.click(screen.getByTestId(`vector-item-${fill!.id}`));
		fireEvent.click(screen.getByTestId('vector-delete'));
		expect(findItem(clipOf(session, seqId, id).shape.contents, fill!.id)).toBeNull();
		// Rename by double-click.
		fireEvent.doubleClick(
			within(screen.getByTestId(`vector-item-${rect!.id}`)).getByText('Rectangle Path 1'),
		);
		const input = within(screen.getByTestId(`vector-item-${rect!.id}`)).getByLabelText('Name');
		fireEvent.change(input, { target: { value: 'Box' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(findItem(clipOf(session, seqId, id).shape.contents, rect!.id)!.item.name).toBe('Box');
		session.undo();
		expect(findItem(clipOf(session, seqId, id).shape.contents, rect!.id)!.item.name).toBe('Rectangle Path 1');
	});

	it('adds presets as groups; stroke options toggle dashes / taper / wave; the gradient editor writes stops', () => {
		const { session, seqId } = makeSession();
		const id = addVector(session, [
			{ type: 'path', path: 'M0 0 L100 0' },
			{ type: 'stroke' },
			{ type: 'rect' },
			{ type: 'gradientFill' },
		]);
		session.select('timeline', [id]);
		mount(session);
		fireEvent.change(screen.getByTestId('vector-add'), { target: { value: 'preset:star' } });
		const top = clipOf(session, seqId, id).shape.contents;
		expect(top.some((i) => i.type === 'group' && i.name === 'Star')).toBe(true);
		const stroke = top.find((i) => i.type === 'stroke')!;
		fireEvent.click(screen.getByTestId(`vector-item-${stroke.id}`));
		fireEvent.click(screen.getByTestId('vector-dashes'));
		fireEvent.click(screen.getByTestId('vector-taper'));
		fireEvent.click(screen.getByTestId('vector-wave'));
		const st = findItem(clipOf(session, seqId, id).shape.contents, stroke.id)!.item as Extract<
			ShapeItem,
			{ type: 'stroke' }
		>;
		expect(st.dashes?.segments).toHaveLength(1);
		expect(st.taper?.startLength.value).toBe(25);
		expect(st.wave?.amount.value).toBe(50);
		fireEvent.click(screen.getByTestId('vector-dash-add'));
		expect(
			(findItem(clipOf(session, seqId, id).shape.contents, stroke.id)!.item as typeof st).dashes?.segments,
		).toHaveLength(2);
		const gf = top.find((i) => i.type === 'gradientFill')!;
		fireEvent.click(screen.getByTestId(`vector-item-${gf.id}`));
		const editor = screen.getByTestId('gradient-editor');
		const lane = within(editor).getByTestId('gradient-color-lane');
		fireEvent.pointerDown(lane, { clientX: 0, button: 0 });
		const colors = (
			findItem(clipOf(session, seqId, id).shape.contents, gf.id)!.item as Extract<
				ShapeItem,
				{ type: 'gradientFill' }
			>
		).colors;
		expect(colors.value.colors).toHaveLength(3);
	});

	it('Convert to Vector Shape keeps the clip and turns it into items', () => {
		registerAllCommands();
		const { session, seqId } = makeSession();
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addShape',
					at: 0,
					track: 'V1',
					shape: { type: 'ellipse', size: [200, 200] },
					ref: '$e',
				},
			] as never,
		});
		const id = r.ok ? r.refs.$e! : '';
		session.select('timeline', [id]);
		const cmd = getCommand('graphics.convertToVector')!;
		expect(cmd.when?.(cmdCtx(session))).toBe(true);
		cmd.run(cmdCtx(session), undefined as never);
		expect(clipOf(session, seqId, id).shape.contents.map((i) => i.type)).toEqual(['ellipse', 'fill']);
		expect(cmd.when?.(cmdCtx(session))).toBe(false);
	});
});

describe('Effect Controls ▸ Contents', () => {
	it('one section per item with its keyframable rows', () => {
		const { session, seqId } = makeSession();
		const id = addVector(session, [
			{ type: 'group', name: 'G', contents: [{ type: 'rect' }, { type: 'fill' }] },
			{ type: 'trim' },
		]);
		const doc = session.getCommitted();
		const seq = doc.sequences[seqId]!;
		const groups = buildGroups(doc, seq, [seq.clips[id]!], 0, {
			effects: defaultRegistries().effects,
			mgTemplates: defaultRegistries().mgTemplates,
		});
		const titles = groups[0]!.sections.map((s) => s.title);
		expect(titles).toEqual(
			expect.arrayContaining([
				'Contents › G',
				'Contents › G › Rectangle Path 1',
				'Contents › G › Fill 1',
				'Contents › Trim Paths 1',
			]),
		);
		const trim = groups[0]!.sections.find((s) => s.title === 'Contents › Trim Paths 1')!;
		expect(trim.rows.map((r) => r.label)).toEqual(['Start', 'End', 'Offset', 'Trim Multiple Shapes']);
	});
});

describe('Program monitor', () => {
	const view = { scale: 0.5, x: 0, y: 0 };
	const host = (session: EditorSession, seqId: string) => ({
		session,
		doc: snapshot(session, seqId),
		view,
		viewport: { width: 960, height: 540 },
		transport: session.transport,
		monitor: monitorStores.program.getState(),
	});
	const drag = (
		el: Element,
		from: [number, number],
		to: [number, number],
		mods: { shiftKey?: boolean } = {},
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

	it('Star tool: a new vector shape centred on the press; with a vector shape selected, a group in it', () => {
		const { session, seqId } = makeSession();
		session.setToggles({ activeTool: 'star' });
		render(<ShapeToolOverlay {...host(session, seqId)} />);
		const surface = screen.getByTestId('shape-tool-overlay');
		drag(surface, [480, 270], [480, 220]);
		const [c] = vectorClips(session, seqId);
		expect(c!.transform.position.value).toEqual([960, 540]);
		const star = c!.shape.contents[0] as Extract<ShapeItem, { type: 'polystar' }>;
		expect(star.starType).toBe('star');
		expect(star.outerRadius.value).toBe(100);
		expect(session.getState().toggles.activeTool).toBe('selection');
		cleanup();
		// With the shape selected, a Rectangle drag adds a group into it.
		session.select('timeline', [c!.id]);
		session.setToggles({ activeTool: 'rectangle' });
		render(<ShapeToolOverlay {...host(session, seqId)} />);
		drag(screen.getByTestId('shape-tool-overlay'), [100, 100], [150, 140]);
		expect(vectorClips(session, seqId)).toHaveLength(1);
		const g = clipOf(session, seqId, c!.id).shape.contents[0] as Extract<ShapeItem, { type: 'group' }>;
		expect(g.contents.map((i) => i.type)).toEqual(['rect', 'fill']);
		const rect = g.contents[0] as Extract<ShapeItem, { type: 'rect' }>;
		expect(rect.size.value).toEqual([100, 80]);
		// Content (0,0) = sequence (960,540); the box centre (250,240) at half scale = sequence (250, 240)·2.
		expect(rect.position.value).toEqual([250 - 960, 240 - 540]);
	});

	it('Pen tool: clicks draw a path in a new shape, a click on the first vertex closes it; vertices drag', () => {
		const { session, seqId } = makeSession();
		session.setToggles({ activeTool: 'pen' });
		const { rerender } = render(<VectorPathOverlay {...host(session, seqId)} />);
		const surface = () => screen.getByTestId('vector-pen-surface');
		const click = (x: number, y: number) => {
			fireEvent.pointerDown(surface(), { clientX: x, clientY: y, button: 0, pointerId: 1 });
			fireEvent.pointerUp(window, { clientX: x, clientY: y, pointerId: 1 });
			rerender(<VectorPathOverlay {...host(session, seqId)} />);
		};
		click(100, 100);
		const [c] = vectorClips(session, seqId);
		expect(c).toBeTruthy();
		click(300, 100);
		click(300, 300);
		const path = () => {
			const g = clipOf(session, seqId, c!.id).shape.contents[0] as Extract<ShapeItem, { type: 'group' }>;
			return (g.contents[0] as Extract<ShapeItem, { type: 'path' }>).path.value;
		};
		expect(path().vertices.map((v) => v.p)).toEqual([
			[200 - 960, 200 - 540],
			[600 - 960, 200 - 540],
			[600 - 960, 600 - 540],
		]);
		// Close on the first vertex (now drawn as a handle by the overlay).
		fireEvent.pointerDown(screen.getByTestId('vector-vertex-0'), {
			clientX: 100,
			clientY: 100,
			button: 0,
			pointerId: 1,
		});
		expect(path().closed).toBe(true);
		// Selection tool: drag vertex 1 by (10, 20) screen px = (20, 40) sequence px.
		act(() => session.setToggles({ activeTool: 'selection' }));
		rerender(<VectorPathOverlay {...host(session, seqId)} />);
		const v1 = screen.getByTestId('vector-vertex-1');
		fireEvent.pointerDown(v1, { clientX: 300, clientY: 100, button: 0, pointerId: 1 });
		fireEvent.pointerMove(window, { clientX: 305, clientY: 110, pointerId: 1 });
		fireEvent.pointerMove(window, { clientX: 310, clientY: 120, pointerId: 1 });
		fireEvent.pointerUp(window, { clientX: 310, clientY: 120, pointerId: 1 });
		expect(path().vertices[1]!.p).toEqual([620 - 960, 240 - 540]);
	});

	it('frames a vector shape by its contents and hit-tests its paint', () => {
		const { session, seqId } = makeSession();
		const id = addVector(session, [{ type: 'rect', size: [200, 100], position: [100, 0] }, { type: 'fill' }]);
		const layer = resolveSceneAt(snapshot(session, seqId), 0).find((l) => l.clip.clipId === id)!;
		// The painted bounds (1 px of anti-aliasing around the fill).
		expect(layerEditRect(layer)).toEqual({ x: 959, y: 489, width: 202, height: 102 });
		expect(layerEditQuad(layer)[0]).toEqual([959, 489]);
		expect(hitsLayerGeometry(layer, [1060, 540])).toBe(true);
		expect(hitsLayerGeometry(layer, [900, 540])).toBe(false);
	});
});
