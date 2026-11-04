// Spec 19 TL-092: every handle a look layer declares sits on what it edits and drags back to its own value; the Program
// overlay draws them for the selected layer, a drag is one undo step, and an animated param gets a key at the playhead.
import {
	type Appearance,
	appearanceFromRecipe,
	buildRenderSnapshot,
	lookOrientation,
	resolveAppearance,
	TITLE_LAYER_TYPES,
	titleLayerType,
	titleLookUniforms,
	withDefaults,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { lookFocus } from '../src/title-looks/focus.ts';
import { growthAbove, handlesOf, LookLayerOverlay } from '../src/title-looks/LayerOverlay.tsx';
import { type Handle, handlePoint, handleValues, lookFrame } from '../src/title-looks/overlay-geometry.ts';
import { lookedClip } from '../src/title-looks/selection.ts';
import { clipOf, makeSession } from './inspector-helpers.tsx';

afterEach(() => {
	cleanup();
	lookFocus.set(null);
});

// happy-dom's PointerEvent carries no coordinates through fireEvent: a MouseEvent with a pointer id does.
class TestPointerEvent extends MouseEvent {
	readonly pointerId: number;
	constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? 1;
	}
}
(globalThis as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;

const f = lookFrame(
	[
		[0, 0],
		[400, 0],
		[400, 200],
		[0, 200],
	],
	{ width: 400, height: 200 },
	100,
);

/** Every state a `when` of the type names, so each declared handle is seen once. */
function statesOf(type: string): Record<string, unknown>[] {
	const def = titleLayerType(type)!;
	const out: Record<string, unknown>[] = [{}];
	for (const h of def.handles ?? []) if (h.when) out.push({ [h.when.param]: h.when.value });
	return out;
}

describe('every declared handle (TL-092)', () => {
	it('is drawn somewhere finite and drags back to its own value', () => {
		let count = 0;
		for (const def of TITLE_LAYER_TYPES) {
			for (const state of statesOf(def.type)) {
				const params = withDefaults(def, state as never) as Record<string, unknown>;
				for (const h of handlesOf(f, { id: 'x', type: def.type, params }, 4, { angle: 210 })) {
					const at = handlePoint(f, h);
					expect(Number.isFinite(at[0]) && Number.isFinite(at[1]), `${def.type}`).toBe(true);
					const back = handleValues(f, h, at);
					const own: Record<string, number> =
						h.kind === 'offset'
							? { [h.angleParam]: h.angle, [h.distanceParam]: h.distance }
							: { [h.param]: h.value };
					for (const [k, v] of Object.entries(own)) {
						const got = back[k]!;
						// Angles may come back a turn apart.
						const d =
							h.kind === 'angle' || k === (h.kind === 'offset' ? h.angleParam : '')
								? ((got - v + 540) % 360) - 180
								: got - v;
						expect(Math.abs(d), `${def.type}.${k}`).toBeLessThan(0.11);
					}
					count++;
				}
			}
		}
		// Each kind is exercised: distances, offsets, axes, angles and positions.
		expect(count).toBeGreaterThan(30);
	});

	it('chains an inline: Inset from the edge inwards, then Width from there', () => {
		const h = handlesOf(f, { id: 'x', type: 'inline', params: { inset: 3, width: 2 } }, 7, { angle: 0 });
		const [inset, width] = h.filter((x) => x.kind === 'distance') as Extract<
			(typeof h)[number],
			{ kind: 'distance' }
		>[];
		expect(inset).toMatchObject({ param: 'inset', start: 0, dir: [-1, 0] });
		expect(width).toMatchObject({ param: 'width', start: 3, anchor: inset!.anchor });
		// Inside the box: the edge is x = 400, inwards is towards the centre.
		expect(handlePoint(f, width!)[0]).toBeCloseTo(400 - 5 * f.perPercent, 6);
	});

	it('puts a reflection’s gap below the bottom edge, and lets it go above it as its range does', () => {
		const [gap] = handlesOf(f, { id: 'x', type: 'reflection', params: { gap: 4 } }, 0, { angle: 0 });
		expect(gap).toMatchObject({ kind: 'distance', param: 'gap', anchor: [200, 200], dir: [0, 1], min: -100 });
		expect(handleValues(f, gap!, [200, 190]).gap).toBeCloseTo(-10 / f.perPercent, 6);
	});

	it('measures a sheen’s width across its band, from the band’s centre', () => {
		const h = handlesOf(f, { id: 'x', type: 'sheen', params: { angle: 0, position: 75, width: 10 } }, 0, {
			angle: 0,
		});
		const width = h.find((x) => x.kind === 'distance')!;
		// Position 75 % along +x: half way from the centre to the right side.
		expect(width).toMatchObject({ anchor: [300, 100], dir: [1, 0] });
		const pos = h.find((x) => x.kind === 'position')!;
		expect(handlePoint(f, pos)).toEqual([300, 100]);
	});

	it('runs a gloss cap down from its angle, whose zero points up at the cap', () => {
		const h = handlesOf(f, { id: 'x', type: 'gloss', params: { angle: 0, height: 25 } }, 0, { angle: 0 });
		const height = h.find((x) => x.kind === 'position')!;
		const p = handlePoint(f, height);
		expect(p[0]).toBeCloseTo(200, 6);
		expect(p[1]).toBeCloseTo(50, 6);
		const angle = h.find((x) => x.kind === 'angle')!;
		expect(handlePoint(f, angle)[1]).toBeLessThan(100);
	});

	it('anchors a plate’s corner on the grown box, and its skew leans from upright', () => {
		const h = handlesOf(
			f,
			{ id: 'x', type: 'plate', params: { kind: 'slant', grow: 10, corner: 6, skew: 0 } },
			0,
			{ angle: 0 },
		);
		const corner = h.find((x) => x.kind === 'distance' && x.param === 'corner')!;
		expect(corner).toMatchObject({ anchor: [-10 * f.perPercent, -10 * f.perPercent], dir: [1, 0] });
		const skew = h.find((x) => x.kind === 'angle' && x.param === 'skew')!;
		const up = handlePoint(f, skew);
		expect(up[0]).toBeCloseTo(200, 6);
		expect(up[1]).toBeLessThan(100);
		// Leaning the handle to the right is a positive skew, and the range stops it at 60°.
		expect(handleValues(f, skew, [400, 0]).skew).toBeGreaterThan(0);
		expect(handleValues(f, skew, [400, 100]).skew).toBe(60);
	});

	it('moves a gradient overlay band from fully before the title to fully past it', () => {
		const paint = {
			kind: 'gradient',
			gradient: { type: 'linear', span: 'block', angle: 0, stops: [] },
		};
		const h = handlesOf(
			f,
			{ id: 'x', type: 'gradientOverlay', params: { style: 'band', paint, bandLength: 100, position: 100 } },
			0,
			{ angle: 0 },
		);
		const pos = h.find((x) => x.kind === 'position')!;
		// The centre (200) plus half the box (200) plus half the band (100 % of a 100 px unit = 100 px, half of it 50).
		expect(handlePoint(f, pos)[0]).toBeCloseTo(200 + 200 + 50, 6);
		expect(
			handlesOf(f, { id: 'x', type: 'gradientOverlay', params: { paint } }, 0, { angle: 0 }).map(
				(x) => x.kind,
			),
		).toEqual(['angle']);
	});

	it('puts the light’s handle on a ring outside the box, clear of the clip’s own handles', () => {
		const h = handlesOf(f, { id: 'x', type: 'shadow', params: { useLight: true } }, 0, { angle: 0 });
		const light = h.find((x) => x.kind === 'angle' && x.light)!;
		const at = handlePoint(f, light);
		// Light from the right (0°): past the right edge of the 400 × 200 box.
		expect(at[0]).toBeGreaterThan(400);
		expect(
			handlesOf(f, { id: 'x', type: 'shadow', params: { useLight: true } }, 0, { angle: 0 }, 300),
		).toContainEqual(expect.objectContaining({ light: true, radius: 300 }));
	});

	describe('on a turned title, the light and screen-fixed directions do not turn with it', () => {
		// The 400 × 200 box turned 90° clockwise about its centre (200, 100): the layer's +x points down the screen.
		const turn = { a: 0, b: 1, c: -1, d: 0 };
		const at = (x: number, y: number): [number, number] => [
			200 + turn.a * (x - 200) + turn.c * (y - 100),
			100 + turn.b * (x - 200) + turn.d * (y - 100),
		];
		const g = lookFrame([at(0, 0), at(400, 0), at(400, 200), at(0, 200)], { width: 400, height: 200 }, 100);
		const toward = (h: Handle) => {
			const p = handlePoint(g, h);
			return (Math.atan2(p[1] - g.center[1], p[0] - g.center[0]) * 180) / Math.PI;
		};
		const same = (a: number, b: number) => expect(Math.abs(((a - b + 540) % 360) - 180)).toBeLessThan(0.01);

		it('the light handle sits where the preview lights from, and a drag writes that screen angle', () => {
			const light = handlesOf(g, { id: 'x', type: 'shadow', params: { useLight: true } }, 0, {
				angle: 30,
			}).find((x) => x.kind === 'angle' && x.light)!;
			// The planner turns the light back into the layer by the layer map's rotation; on screen it is where it was set.
			let n = 0;
			const a = appearanceFromRecipe(
				{ light: { angle: 30, altitude: 30 }, layers: [{ type: 'face', params: {} }] },
				() => `apl_${String(++n).padStart(16, '0')}`,
			);
			const u = titleLookUniforms({
				width: 400,
				height: 400,
				pxScale: 1,
				fps: 30,
				frame: 0,
				duration: 30,
				seed: 0,
				progress: 0,
				structures: {
					titleLook: {
						appearance: resolveAppearance(a, 0),
						source: a,
						unitPx: 100,
						contentSeconds: 0,
						orient: lookOrientation(turn),
					},
				},
			} as never);
			const [lx, ly] = u.u_tlLightDir as readonly [number, number];
			const [xx, xy, yx, yy] = u.u_tlStage as readonly [number, number, number, number];
			const shown = (Math.atan2(xy * lx + yy * ly, xx * lx + yx * ly) * 180) / Math.PI;
			same(shown, 30);
			same(toward(light), shown);
			// Dragging it to a point straight below the centre on screen sets the light to 90°.
			const to: [number, number] = [g.center[0], g.center[1] + 300];
			expect(handleValues(g, light, to).angle).toBeCloseTo(90, 1);
		});

		it('a drop shadow’s offset points down-right on screen at 45°; a perspective shadow’s turns with its floor', () => {
			const drop = handlesOf(
				g,
				{ id: 'x', type: 'shadow', params: { angle: 45, kind: 'drop', useLight: false } },
				0,
				{ angle: 0 },
			)[0]!;
			same(toward(drop), 45);
			const back = handleValues(g, drop, handlePoint(g, drop));
			expect(back.angle).toBeCloseTo(45, 1);
			const floor = handlesOf(
				g,
				{ id: 'x', type: 'shadow', params: { angle: 45, kind: 'perspective', useLight: false } },
				0,
				{
					angle: 0,
				},
			)[0]!;
			same(toward(floor), 45 + 90);
		});

		it('Shaded Extrude’s depth and own light, and an inner shadow, are on screen too', () => {
			const ex = handlesOf(
				g,
				{ id: 'x', type: 'extrude', params: { angle: 45, lightAngle: 200, useLight: false } },
				0,
				{
					angle: 0,
				},
			);
			same(toward(ex.find((h) => h.kind === 'offset')!), 45);
			same(toward(ex.find((h) => h.kind === 'angle' && h.param === 'lightAngle')!), 200);
			const inner = handlesOf(
				g,
				{ id: 'x', type: 'innerShadow', params: { angle: 120, useLight: false } },
				0,
				{ angle: 0 },
			)[0]!;
			same(toward(inner), 120);
		});
	});

	it('a layer that starts from the whole silhouette counts every rim, wherever it sits', () => {
		const layers = [
			{ id: 'r', type: 'reflection', params: {} },
			{ id: 'a', type: 'rim', params: { width: 5 } },
			{ id: 's', type: 'shadow', params: {} },
			{ id: 'b', type: 'rim', params: { width: 3 } },
		];
		expect(growthAbove(layers, 2)).toBe(3);
		expect(growthAbove(layers, 0)).toBe(8);
	});
});

/** A selected title with a look of a shadow, a rim and a face; the shadow is the layer in focus. */
function setup(shadow: Record<string, unknown> = { angle: 0, distance: 10 }) {
	const session = makeSession();
	const seqId = Object.keys(session.getCommitted().sequences)[0]!;
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{ type: 'clip.addText', at: 0, duration: 60, track: 'V1', content: { text: 'HANDLES' }, ref: '$t' },
			{
				type: 'look.apply',
				clipIds: ['$t'],
				look: {
					name: 'Shadowed',
					recipe: {
						palette: { face: [1, 1, 1, 1] },
						layers: [
							{ type: 'shadow', params: shadow },
							{ type: 'rim', params: { width: 4 } },
							{ type: 'face' },
						],
					},
				},
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const clipId = r.refs.$t!;
	act(() => session.select('timeline', [clipId]));
	const looked = lookedClip(clipOf(session, clipId))!;
	const layer = (looked.appearance as Appearance).layers[0]!;
	act(() => lookFocus.set({ clipId, fxId: looked.fx.id, target: layer.id }));
	return { session, seqId, clipId, fxId: looked.fx.id, layerId: layer.id };
}

function overlay(session: EditorSession, seqId: string) {
	const doc = buildRenderSnapshot(session.getDrawn(), seqId, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
	return render(
		<SessionProvider session={session}>
			<LookLayerOverlay
				session={session}
				doc={doc}
				view={{ scale: 0.5, x: 0, y: 0 }}
				viewport={{ width: 960, height: 540 }}
				transport={session.transport}
				monitor={monitorStores.program.getState()}
			/>
		</SessionProvider>,
	);
}

/** Drags a handle by (dx, dy) screen px, as the pointer does. */
function drag(testId: string, dx: number, dy: number) {
	const g = screen.getByTestId(testId);
	const x = Number(g.getAttribute('data-x'));
	const y = Number(g.getAttribute('data-y'));
	const hit = g.querySelectorAll('circle')[1]!;
	fireEvent.pointerDown(hit, { button: 0, clientX: x, clientY: y, pointerId: 1 });
	fireEvent.pointerMove(window, { clientX: x + dx / 2, clientY: y + dy / 2, pointerId: 1 });
	fireEvent.pointerMove(window, { clientX: x + dx, clientY: y + dy, pointerId: 1 });
	fireEvent.pointerUp(window, { clientX: x + dx, clientY: y + dy, pointerId: 1 });
}

const history = (s: EditorSession) => s.getState().history.entries.length;
const shadowOf = (s: EditorSession, clipId: string) =>
	(lookedClip(clipOf(s, clipId))!.appearance as Appearance).layers[0]!;

describe('the Program overlay (TL-092)', () => {
	it('a shadow offset drag sets angle and distance together in one undo step', () => {
		const { session, seqId, clipId } = setup();
		overlay(session, seqId);
		const n = history(session);
		// Straight down from a handle to the right: the angle turns towards 90°, the distance grows.
		drag('look-handle-distance', 0, 80);
		expect(history(session)).toBe(n + 1);
		const p = shadowOf(session, clipId).params;
		expect(p.angle!.value as number).toBeGreaterThan(5);
		expect(p.distance!.value as number).toBeGreaterThan(10);
		act(() => void session.undo());
		expect(shadowOf(session, clipId).params.distance!.value).toBe(10);
	});

	it('keys an animated param at the playhead instead of moving its animation', () => {
		const { session, seqId, clipId, fxId, layerId } = setup();
		session.apply({
			label: 'animate',
			origin: 'user',
			commands: [
				{
					type: 'param.setAnimated',
					target: ['appearance', fxId, layerId, 'distance'],
					animated: true,
					at: { sequenceFrame: 0 },
				},
				{
					type: 'param.setAnimated',
					target: ['appearance', fxId, layerId, 'angle'],
					animated: true,
					at: { sequenceFrame: 0 },
				},
			] as never,
		});
		act(() => session.transport.seek(20));
		overlay(session, seqId);
		drag('look-handle-distance', 40, 0);
		const d = shadowOf(session, clipId).params.distance!;
		expect(d.keyframes).toHaveLength(2);
		expect(d.keyframes[0]!.value).toBe(10);
		expect(d.keyframes[1]!.value as number).toBeGreaterThan(10);
	});

	it('a shadow following the light drags the look’s light angle', () => {
		const { session, seqId, clipId } = setup({ useLight: true, distance: 10 });
		overlay(session, seqId);
		const n = history(session);
		const before = (lookedClip(clipOf(session, clipId))!.appearance as Appearance).light.angle.value;
		drag('look-handle-light-angle', 0, -60);
		expect(history(session)).toBe(n + 1);
		const after = (lookedClip(clipOf(session, clipId))!.appearance as Appearance).light.angle.value;
		expect(after).not.toBe(before);
		expect(screen.queryByTestId('look-handle-angle')).toBeNull();
	});

	it('Escape cancels a drag: nothing changes and History is untouched', () => {
		const { session, seqId, clipId } = setup();
		overlay(session, seqId);
		const n = history(session);
		const g = screen.getByTestId('look-handle-distance');
		const x = Number(g.getAttribute('data-x'));
		const y = Number(g.getAttribute('data-y'));
		fireEvent.pointerDown(g.querySelectorAll('circle')[1]!, {
			button: 0,
			clientX: x,
			clientY: y,
			pointerId: 1,
		});
		fireEvent.pointerMove(window, { clientX: x + 50, clientY: y, pointerId: 1 });
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(history(session)).toBe(n);
		expect(shadowOf(session, clipId).params.distance!.value).toBe(10);
	});
});
