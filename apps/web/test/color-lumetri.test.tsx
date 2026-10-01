// Lumetri UI (S06 §9 test 7, CGU-001/002/004, LUT-002): the panel creates the instance on first edit (one history
// entry), a scrub is one entry, the curves editor adds/moves/removes points and writes a sorted curve, the wheels
// write the unit disc, Effect Controls hosts the custom editor and hides the curve/wheel rows, Copy/Paste Grade and
// "Apply as Look" are one undo step.
import {
	type Clip,
	type EffectInstance,
	LUMETRI_EDITOR_PARAMS,
	LUMETRI_EFFECT,
	MAX_CURVE_POINTS,
} from '@jasper/project';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/commands/color.ts';
import { colorBypass, copyGradeFrom, gradeClipboard, pasteGradeTo } from '../src/color/actions.ts';
import {
	addCurvePoint,
	curvePoints,
	hitCurvePoint,
	moveCurvePoint,
	planApplyLook,
	removeCurvePoint,
	wheelFromOffset,
} from '../src/color/model.ts';
import { effectEditorFor } from '../src/extensions/index.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { LumetriPanel } from '../src/panels/lumetri/LumetriPanel.tsx';
import { BUILTIN_WORKSPACES, panelsIn } from '../src/shell/workspaces/definitions.ts';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

type Anim<T = unknown> = { value: T; keyframes: unknown[] };
const effectsOf = (clip: Clip) => (clip as unknown as { effects?: EffectInstance[] }).effects ?? [];
const lumetriOf = (s: ReturnType<typeof makeSession>, id: string) =>
	effectsOf(clipOf(s, id)).filter((e) => e.effectId === 'jasper.lumetri');
const param = <T,>(fx: EffectInstance, name: string) => (fx.params[name] as unknown as Anim<T>).value;
const entries = (s: ReturnType<typeof makeSession>) => s.getState().history.entries.length;

/** Registers a `.cube` LUT asset (header only, as the engine prober stores it) with a project item. */
function addLut(session: ReturnType<typeof makeSession>, name = 'Film Look.cube'): string {
	const r = session.apply({
		label: 'import lut',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				ref: '$lut',
				itemRef: '$item',
				asset: {
					kind: 'lut',
					fingerprint: `q1:${'a'.repeat(64)}`,
					originalName: name,
					sizeBytes: 100,
					container: 'cube',
					probe: {
						durationFlicks: null,
						startTimecode: null,
						streams: [],
						rotationDegrees: 0,
						hasAlpha: false,
						variableFrameRate: false,
					},
					locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_lut' }],
					derivation: null,
					importedAt: '2026-10-01T00:00:00.000Z',
					lut: {
						format: 'cube',
						dimensions: 3,
						size: 33,
						title: 'Film',
						domainMin: [0, 0, 0],
						domainMax: [1, 1, 1],
					},
				},
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.created.find((id) => id.startsWith('med_'))!;
}

beforeEach(() => {
	globalThis.localStorage?.clear();
	gradeClipboard.clear();
	colorBypass.clear();
});
afterEach(() => cleanup());

function setup() {
	const session = makeSession();
	const [id] = addSolids(session, [0], 60);
	act(() => {
		session.select('timeline', [id!]);
		session.transport.seek(10);
	});
	renderWithSession(session, <LumetriPanel instanceId="lumetri-1" visible />);
	return { session, id: id! };
}

const drag = (el: Element, from: number, moves: number[]) => {
	act(() => {
		fireEvent.pointerDown(el, { clientX: from, clientY: 0, button: 0 });
		for (const x of moves) fireEvent.pointerMove(window, { clientX: x, clientY: 0 });
		fireEvent.pointerUp(window, { clientX: moves.at(-1) ?? from, clientY: 0 });
	});
};

describe('Lumetri Color panel (S06:CGU-001)', () => {
	it('shows an empty state without a selected clip', () => {
		const session = makeSession();
		addSolids(session, [0]);
		renderWithSession(session, <LumetriPanel instanceId="lumetri-1" visible />);
		expect(screen.getByTestId('lumetri-empty').textContent).toMatch(/Select a clip/);
	});

	it('the first edit adds jasper.lumetri in one history entry; a slider drag is one entry', () => {
		const { session, id } = setup();
		expect(lumetriOf(session, id)).toHaveLength(0);
		for (const s of ['Basic Correction', 'Creative', 'Curves', 'Color Wheels'])
			expect(screen.getByText(s)).toBeTruthy();
		const before = entries(session);
		// Track width falls back to 100 px in happy-dom: x = 75 → 75 % of −5…5 = +2.5 stops.
		drag(screen.getByTestId('lumetri-exposure'), 75, []);
		expect(entries(session)).toBe(before + 1);
		const [fx] = lumetriOf(session, id);
		expect(fx).toBeTruthy();
		expect(param(fx!, 'exposure')).toBe(2.5);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Exposure');
		// A drag with many moves on another slider is still exactly one entry and edits the same instance.
		drag(screen.getByTestId('lumetri-contrast'), 50, [55, 60, 70, 80]);
		expect(entries(session)).toBe(before + 2);
		expect(lumetriOf(session, id)).toHaveLength(1);
		expect(param(lumetriOf(session, id)[0]!, 'contrast')).toBe(60);
		// Undo removes the contrast change only; undo again removes the instance.
		act(() => void session.undo());
		expect(param(lumetriOf(session, id)[0]!, 'contrast')).toBe(0);
		act(() => void session.undo());
		expect(lumetriOf(session, id)).toHaveLength(0);
	});

	it('scrubbing the exposure value (hot text) is one undo step', () => {
		const { session, id } = setup();
		const before = entries(session);
		const value = screen.getByTestId('lumetri-exposure-value');
		act(() => {
			fireEvent.pointerDown(value, { clientX: 100, button: 0 });
			for (const x of [110, 130, 150]) fireEvent.pointerMove(window, { clientX: x });
			fireEvent.pointerUp(window, { clientX: 150 });
		});
		expect(entries(session)).toBe(before + 1);
		// step 0.01 per px: +50 px = +0.5 stops.
		expect(param(lumetriOf(session, id)[0]!, 'exposure')).toBeCloseTo(0.5, 6);
	});

	it('double-click on a slider resets it (one entry)', () => {
		const { session, id } = setup();
		drag(screen.getByTestId('lumetri-saturation'), 25, []);
		expect(param(lumetriOf(session, id)[0]!, 'saturation')).toBe(50);
		const before = entries(session);
		act(() => {
			fireEvent.doubleClick(screen.getByTestId('lumetri-saturation'));
		});
		expect(param(lumetriOf(session, id)[0]!, 'saturation')).toBe(100);
		expect(entries(session)).toBe(before + 1);
	});

	it('the curves editor adds, moves and removes points and writes a sorted curve', () => {
		const { session, id } = setup();
		const svg = () => screen.getByTestId('lumetri-curve');
		const curve = () => param<{ curve: number[][] }>(lumetriOf(session, id)[0]!, 'curveMaster').curve;
		const before = entries(session);
		// Click (no move) at the centre column, 3/4 up: the editor falls back to 200 px.
		act(() => {
			fireEvent.pointerDown(svg(), { clientX: 100, clientY: 50, button: 0 });
			fireEvent.pointerUp(window, { clientX: 100, clientY: 50 });
		});
		expect(curve()).toEqual([
			[0, 0],
			[0.5, 0.75],
			[1, 1],
		]);
		expect(entries(session)).toBe(before + 1);
		// Drag the new point to the right and up: one entry, still sorted.
		act(() => {
			fireEvent.pointerDown(svg(), { clientX: 100, clientY: 50, button: 0 });
			for (const x of [110, 120]) fireEvent.pointerMove(window, { clientX: x, clientY: 40 });
			fireEvent.pointerUp(window, { clientX: 120, clientY: 40 });
		});
		expect(curve()).toEqual([
			[0, 0],
			[0.6, 0.8],
			[1, 1],
		]);
		expect(entries(session)).toBe(before + 2);
		// A point dragged past its neighbour stops before it (x stays strictly increasing).
		act(() => {
			fireEvent.pointerDown(svg(), { clientX: 30, clientY: 150, button: 0 });
			fireEvent.pointerMove(window, { clientX: 190, clientY: 150 });
			fireEvent.pointerUp(window, { clientX: 190, clientY: 150 });
		});
		const pts = curve();
		expect(pts).toHaveLength(4);
		expect(pts.map((p) => p[0])).toEqual([...pts.map((p) => p[0])].sort((a, b) => a - b));
		expect(pts[1]![0]).toBeCloseTo(0.59, 6);
		expect(entries(session)).toBe(before + 3);
		// Dragging out of the box removes the point.
		act(() => {
			fireEvent.pointerDown(svg(), { clientX: 120, clientY: 40, button: 0 });
			fireEvent.pointerMove(window, { clientX: 500, clientY: 50 });
			fireEvent.pointerUp(window, { clientX: 500, clientY: 50 });
		});
		expect(curve()).toHaveLength(3);
		expect(entries(session)).toBe(before + 4);
		// Double-click removes a point; clicking a point without moving adds no entry.
		const n = entries(session);
		act(() => {
			fireEvent.pointerDown(svg(), { clientX: 118, clientY: 150, button: 0 });
			fireEvent.pointerUp(window, { clientX: 118, clientY: 150 });
		});
		expect(entries(session)).toBe(n);
		act(() => {
			fireEvent.doubleClick(svg(), { clientX: 118, clientY: 150 });
		});
		expect(curve()).toEqual([
			[0, 0],
			[1, 1],
		]);
		expect(entries(session)).toBe(n + 1);
		// The end points cannot be removed below two points.
		act(() => {
			fireEvent.doubleClick(svg(), { clientX: 0, clientY: 200 });
		});
		expect(curve()).toHaveLength(2);
	});

	it('curve tabs edit the per-channel curves', () => {
		const { session, id } = setup();
		act(() => {
			fireEvent.click(screen.getByTestId('lumetri-curve-tab-red'));
		});
		act(() => {
			fireEvent.pointerDown(screen.getByTestId('lumetri-curve'), { clientX: 100, clientY: 100, button: 0 });
			fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
		});
		const fx = lumetriOf(session, id)[0]!;
		expect(param<{ curve: number[][] }>(fx, 'curveRed').curve).toHaveLength(3);
		expect(param<{ curve: number[][] }>(fx, 'curveMaster').curve).toHaveLength(2);
	});

	it('a wheel drag writes the unit disc in one entry; double-click resets', () => {
		const { session, id } = setup();
		const disc = screen.getByTestId('lumetri-shadowsWheel-disc');
		const before = entries(session);
		// Fallback wheel: 120 px, centre (60, 60). Right edge = +x (red).
		act(() => {
			fireEvent.pointerDown(disc, { clientX: 90, clientY: 60, button: 0 });
			fireEvent.pointerMove(window, { clientX: 200, clientY: 60 });
			fireEvent.pointerUp(window, { clientX: 200, clientY: 60 });
		});
		expect(param(lumetriOf(session, id)[0]!, 'shadowsWheel')).toEqual([1, 0]);
		expect(entries(session)).toBe(before + 1);
		act(() => {
			fireEvent.doubleClick(disc);
		});
		expect(param(lumetriOf(session, id)[0]!, 'shadowsWheel')).toEqual([0, 0]);
		// The level slider under the wheel.
		drag(screen.getByTestId('lumetri-midtonesWheel-level'), 100, []);
		expect(param(lumetriOf(session, id)[0]!, 'midtonesLevel')).toBe(100);
	});

	it('the LUT pickers list the project LUTs with their size, plus None and Browse… (LUT-005)', () => {
		const session = makeSession();
		const [id] = addSolids(session, [0], 60);
		const lut = addLut(session);
		act(() => session.select('timeline', [id!]));
		renderWithSession(session, <LumetriPanel instanceId="lumetri-1" visible />);
		const look = screen.getByTestId('lumetri-look') as HTMLSelectElement;
		expect([...look.options].map((o) => o.textContent)).toEqual(['None', 'Film Look.cube (33³)', 'Browse…']);
		const before = entries(session);
		act(() => {
			fireEvent.change(look, { target: { value: lut } });
		});
		expect(entries(session)).toBe(before + 1);
		expect(param(lumetriOf(session, id!)[0]!, 'look')).toEqual({ mediaId: lut });
		act(() => {
			fireEvent.change(screen.getByTestId('lumetri-look'), { target: { value: '' } });
		});
		expect(param(lumetriOf(session, id!)[0]!, 'look')).toEqual({ mediaId: '' });
	});

	it('the before/after toggle marks the clip bypassed (preview only; the document is unchanged)', () => {
		const { session, id } = setup();
		const rev = session.getState().revision;
		act(() => {
			fireEvent.click(screen.getByTestId('lumetri-before-after'));
		});
		expect(colorBypass.get()).toEqual([id]);
		expect(screen.getByTestId('lumetri-bypass-note')).toBeTruthy();
		expect(session.getState().revision).toBe(rev);
	});
});

describe('Effect Controls hosts the Lumetri editor (S06:CGU-002)', () => {
	it('shows curves and wheels and hides their generic rows; scalar rows keep their rows', () => {
		const session = makeSession();
		const [id] = addSolids(session, [0], 60);
		act(() => {
			session.apply({
				label: 'add',
				origin: 'user',
				commands: [{ type: 'effect.add', target: { clipId: id! }, effectId: 'jasper.lumetri' }] as never,
			});
			session.select('timeline', [id!]);
		});
		expect(effectEditorFor('jasper.lumetri')?.hideParams).toEqual(LUMETRI_EDITOR_PARAMS);
		renderWithSession(session, <EffectControlsPanel instanceId="ec1" visible />);
		const fx = lumetriOf(session, id!)[0]!;
		const editor = screen.getByTestId(`fx-editor-${fx.id}`);
		expect(within(editor).getByTestId('lumetri-editor-effectControls')).toBeTruthy();
		expect(within(editor).getByTestId('lumetri-curve')).toBeTruthy();
		expect(within(editor).getByTestId('lumetri-highlightsWheel-disc')).toBeTruthy();
		// The EC editor does not duplicate the scalar rows.
		expect(within(editor).queryByTestId('lumetri-exposure')).toBeNull();
		for (const p of LUMETRI_EDITOR_PARAMS)
			expect(document.querySelector(`[data-row="effects.${fx.id}.${p}"]`), p).toBeNull();
		for (const p of ['exposure', 'shadowsLevel', 'look', 'inputLut', 'saturation'])
			expect(document.querySelector(`[data-row="effects.${fx.id}.${p}"]`), p).not.toBeNull();
		// The generic `slider` control shows a track next to the value.
		expect(screen.getByTestId(`slider-effects.${fx.id}.exposure`)).toBeTruthy();
		// A curve edit from Effect Controls writes the instance in one entry.
		const before = entries(session);
		act(() => {
			fireEvent.pointerDown(within(editor).getByTestId('lumetri-curve'), {
				clientX: 50,
				clientY: 100,
				button: 0,
			});
			fireEvent.pointerUp(window, { clientX: 50, clientY: 100 });
		});
		expect(entries(session)).toBe(before + 1);
		expect(param<{ curve: number[][] }>(lumetriOf(session, id!)[0]!, 'curveMaster').curve).toEqual([
			[0, 0],
			[0.25, 0.5],
			[1, 1],
		]);
	});
});

describe('grade clipboard and looks (S06:CGU-004, LUT-002)', () => {
	it('Copy Grade / Paste Grade replace the colour effects of the targets in one undo step', () => {
		const session = makeSession();
		const [a, b, c] = addSolids(session, [0, 100, 200], 50);
		act(
			() =>
				void session.apply({
					label: 'grade',
					origin: 'user',
					commands: [
						{
							type: 'effect.add',
							target: { clipId: a! },
							effectId: 'jasper.lumetri',
							params: { exposure: 1 },
						},
						{ type: 'effect.add', target: { clipId: a! }, effectId: 'jasper.gaussian-blur' },
						{ type: 'effect.add', target: { clipId: a! }, effectId: 'jasper.black-white' },
						{ type: 'effect.add', target: { clipId: b! }, effectId: 'jasper.lumetri', params: { tint: 50 } },
						{ type: 'effect.add', target: { clipId: b! }, effectId: 'jasper.gaussian-blur' },
					] as never,
				}),
		);
		expect(copyGradeFrom(session, clipOf(session, a!))).toBe(true);
		expect(gradeClipboard.get()!.effects.map((e) => e.effectId)).toEqual([
			'jasper.lumetri',
			'jasper.black-white',
		]);
		const before = entries(session);
		const r = pasteGradeTo(session, [b!, c!]);
		expect(r?.ok).toBe(true);
		expect(entries(session)).toBe(before + 1);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Paste Grade (2 clips)');
		const ids = (id: string) => effectsOf(clipOf(session, id)).map((e) => e.effectId);
		expect(ids(b!)).toEqual(['jasper.lumetri', 'jasper.black-white', 'jasper.gaussian-blur']);
		expect(ids(c!)).toEqual(['jasper.lumetri', 'jasper.black-white']);
		const pasted = lumetriOf(session, b!)[0]!;
		expect(param(pasted, 'exposure')).toBe(1);
		expect(param(pasted, 'tint')).toBe(0);
	});

	it('Apply as Look sets `look` on the first Lumetri or adds one (one transaction)', () => {
		const session = makeSession();
		const [a, b] = addSolids(session, [0, 100], 50);
		act(
			() =>
				void session.apply({
					label: 'grade',
					origin: 'user',
					commands: [
						{
							type: 'effect.add',
							target: { clipId: a! },
							effectId: 'jasper.lumetri',
							params: { exposure: 1 },
						},
					] as never,
				}),
		);
		const lut = addLut(session);
		const cmds = planApplyLook(session.getCommitted(), lut, [a!, b!]);
		expect(cmds.map((c) => c.type)).toEqual(['param.set', 'effect.add']);
		const r = session.apply({ label: 'Apply Look', origin: 'user', commands: cmds });
		expect(r.ok ? [] : r.errors).toEqual([]);
		expect(param(lumetriOf(session, a!)[0]!, 'look')).toEqual({ mediaId: lut });
		expect(param(lumetriOf(session, a!)[0]!, 'exposure')).toBe(1);
		expect(param(lumetriOf(session, b!)[0]!, 'look')).toEqual({ mediaId: lut });
	});
});

describe('colour UI model', () => {
	it('curve point edits keep the curve sorted and bounded', () => {
		const id = curvePoints(undefined);
		expect(id).toEqual([
			[0, 0],
			[1, 1],
		]);
		expect(
			curvePoints({
				curve: [
					[1, 1],
					[0.3, 0.9],
					[0, 0],
				],
			}),
		).toEqual([
			[0, 0],
			[0.3, 0.9],
			[1, 1],
		]);
		const added = addCurvePoint(id, 0.5, 0.6)!;
		expect(added.index).toBe(1);
		expect(addCurvePoint(added.points, 0.505, 0.1)).toBeNull();
		expect(moveCurvePoint(added.points, 1, 2, -1)[1]).toEqual([0.99, 0]);
		expect(removeCurvePoint(id, 0)).toBeNull();
		expect(hitCurvePoint(added.points, 0.51, 0.61, 0.03)).toBe(1);
		let pts = id;
		for (let i = 1; i < 80; i++) pts = addCurvePoint(pts, i / 80, 0.5)?.points ?? pts;
		expect(pts).toHaveLength(MAX_CURVE_POINTS);
	});

	it('wheel offsets map to the unit disc with y up', () => {
		expect(wheelFromOffset(50, 0, 50)).toEqual([1, 0]);
		expect(wheelFromOffset(0, -25, 50)).toEqual([0, 0.5]);
		const [x, y] = wheelFromOffset(100, 100, 50);
		expect(Math.hypot(x, y)).toBeCloseTo(1, 2);
	});

	it('the Color workspace has Lumetri, Scopes, Program and Timeline (S06:CGU-003)', () => {
		const ws = BUILTIN_WORKSPACES.find((w) => w.id === 'color');
		expect(ws?.name).toBe('Color');
		const kinds = panelsIn(ws!.layout);
		for (const k of ['lumetri', 'scopes', 'program', 'timeline']) expect(kinds).toContain(k);
		expect(LUMETRI_EFFECT.params.every((p) => p.group)).toBe(true);
	});
});
