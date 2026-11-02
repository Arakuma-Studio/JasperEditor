// Spec 19 TL-078, TL-079: the 3D Title section, the Environment section, the cost shown before enabling, and the
// rotation gizmo sized to its target, in the app's own components.
import { buildRenderSnapshot, COST_CLASSES } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { Cost3DContent, cost3dAcknowledged } from '../src/three-d/Cost3DDialog.tsx';
import {
	arcDelta,
	FREE_RING,
	freeDelta,
	GIZMO_MAX_PX,
	GIZMO_MIN_PX,
	gizmoRadius,
	polylinePath,
	tangentAt,
	worldCircle,
} from '../src/three-d/gizmo.ts';
import { Scene3DOverlay } from '../src/three-d/Scene3DOverlay.tsx';
import { Environment3DSection, Title3DSection } from '../src/three-d/Title3DSection.tsx';
import { makeSession } from './timeline-helpers.ts';

afterEach(cleanup);

// jsdom has no PointerEvent: React's pointer handlers need one that carries coordinates.
class TestPointerEvent extends MouseEvent {
	readonly pointerId: number;
	constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? 1;
	}
}
(globalThis as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;

type Session = ReturnType<typeof makeSession>['session'];

function title3d(renderer: 'classic' | 'advanced' = 'advanced') {
	const { session, seqId } = makeSession();
	const add = session.apply({
		label: 'Text',
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'clip.addText', at: 0, duration: 60, track: 'V1', content: { text: 'GOLD' } } as never],
	});
	expect(add.ok).toBe(true);
	const clipId = (add as { results: { clipId: string }[] }).results[0]!.clipId;
	const on = session.apply({
		label: '3D',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.set3d', clipIds: [clipId], enabled: true },
			{ type: 'sequence.set3dRenderer', renderer },
		],
	});
	expect(on.ok).toBe(true);
	return { session, seqId, clipId };
}

const clipOf = (session: Session, seqId: string, id: string) => session.getDrawn().sequences[seqId]!.clips[id]!;

function section(session: Session, seqId: string, id: string) {
	return render(
		<SessionProvider session={session}>
			<Title3DSection session={session} clips={[clipOf(session, seqId, id)]} frame={0} sequenceId={seqId} />
		</SessionProvider>,
	);
}

describe('gizmo maths (TL-079)', () => {
	it('sizes to the target, within limits', () => {
		const box = (w: number, h: number) =>
			[
				[0, 0],
				[w, 0],
				[w, h],
				[0, h],
			] as [number, number][];
		expect(gizmoRadius(box(200, 100))).toBeCloseTo(120);
		expect(gizmoRadius(box(10, 10))).toBe(GIZMO_MIN_PX);
		expect(gizmoRadius(box(4000, 100))).toBe(GIZMO_MAX_PX);
		expect(gizmoRadius(box(Number.NaN, 2))).toBe(GIZMO_MIN_PX);
	});

	it('a world circle stays at its radius, in the plane of its axis', () => {
		const pts = worldCircle([10, 20, 30], 2, 5, 16);
		expect(pts).toHaveLength(17);
		for (const p of pts) {
			expect(p[2]).toBe(30);
			expect(Math.hypot(p[0] - 10, p[1] - 20)).toBeCloseTo(5);
		}
	});

	it('a drag along the arc is its angle; across it, nothing', () => {
		const pts = worldCircle([0, 0, 0], 2, 100, 64).map((p) => [p[0], p[1]] as [number, number]);
		const t = tangentAt(pts, [100, 0])!;
		expect(t.radius).toBeCloseTo(100, 0);
		const quarter = (Math.PI / 2) * 100;
		expect(Math.abs(arcDelta([100, 0], [100 + t.tangent[0] * quarter, t.tangent[1] * quarter], t.tangent, t.radius))).toBeCloseTo(90, 0);
		expect(arcDelta([100, 0], [100 - t.tangent[1] * 50, t.tangent[0] * 50], t.tangent, t.radius)).toBeCloseTo(0);
	});

	it('free rotation turns about Y across and X along the screen', () => {
		expect(freeDelta([0, 0], [10, 0])).toEqual({ x: -0, y: 5 });
		expect(freeDelta([0, 0], [0, 10]).x).toBe(-5);
	});

	it('breaks a path at points behind the camera', () => {
		expect(polylinePath([[0, 0], [1, 1], null, [2, 2]])).toBe('M0.00,0.00L1.00,1.00M2.00,2.00');
	});
});

describe('rotation gizmo in the overlay', () => {
	const overlay = (session: Session, seqId: string) => {
		const doc = buildRenderSnapshot(session.getDrawn(), seqId, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		return render(
			<SessionProvider session={session}>
				<Scene3DOverlay
					session={session}
					doc={doc}
					view={{ scale: 0.5, x: 0, y: 0 }}
					viewport={{ width: 960, height: 540 }}
					transport={session.transport}
					monitor={monitorStores.program.getState()}
				/>
			</SessionProvider>,
		);
	};

	it('draws an arc per axis and a ring outside them; a ring drag turns the layer in one undo step', () => {
		const { session, seqId, clipId } = title3d();
		session.store.setState((s) => ({
			...s,
			selection: { ...s.selection, timeline: { ...s.selection.timeline, clips: [clipId] } },
		}));
		overlay(session, seqId);
		for (const a of ['X', 'Y', 'Z']) expect(screen.getByTestId(`scene3d-arc-${a}`)).toBeTruthy();
		const ring = screen.getByTestId('scene3d-free-ring');
		const r = Number(ring.getAttribute('r'));
		expect(r).toBeGreaterThanOrEqual(GIZMO_MIN_PX * FREE_RING);
		const svg = screen.getByTestId('scene3d-overlay');
		svg.setPointerCapture = () => {};
		fireEvent.pointerDown(ring, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
		fireEvent.pointerMove(svg, { clientX: 140, clientY: 100, pointerId: 1 });
		fireEvent.pointerUp(svg, { pointerId: 1 });
		const td = (clipOf(session, seqId, clipId) as unknown as { threeD: { rotationY: { value: number } } }).threeD;
		expect(td.rotationY.value).toBeCloseTo(20);
	});
});

describe('Properties ▸ 3D Title', () => {
	it('says what the title costs and offers Advanced 3D under Classic', () => {
		const { session, seqId, clipId } = title3d('classic');
		section(session, seqId, clipId);
		expect(screen.getByTestId('title3d-cost').textContent).toContain(COST_CLASSES['3d'].label);
		fireEvent.click(screen.getByTestId('title3d-advanced'));
		expect(session.getDrawn().sequences[seqId]!.threeD?.renderer).toBe('advanced');
	});

	it('applies a material preset, adds bands up to the limit and disables the button there', () => {
		const { session, seqId, clipId } = title3d();
		const { rerender } = section(session, seqId, clipId);
		fireEvent.change(screen.getByTestId('title3d-preset'), { target: { value: 'gold' } });
		const again = () =>
			rerender(
				<SessionProvider session={session}>
					<Title3DSection session={session} clips={[clipOf(session, seqId, clipId)]} frame={0} sequenceId={seqId} />
				</SessionProvider>,
			);
		again();
		const td = (clipOf(session, seqId, clipId) as unknown as { threeD: { material: { pbr?: unknown }; geometry: { bands?: unknown[] } } }).threeD;
		expect(td.material.pbr).toBeDefined();
		for (let i = 0; i < 6; i++) {
			fireEvent.click(screen.getByTestId('title3d-add-band'));
			again();
		}
		const after = (clipOf(session, seqId, clipId) as unknown as { threeD: { geometry: { bands: unknown[] } } }).threeD;
		expect(after.geometry.bands).toHaveLength(6);
		const add = screen.getByTestId('title3d-add-band') as HTMLButtonElement;
		expect(add.disabled || add.getAttribute('aria-disabled') === 'true').toBe(true);
	});

	it('tone mapping is a sequence setting, one undoable edit', () => {
		const { session, seqId, clipId } = title3d();
		section(session, seqId, clipId);
		fireEvent.change(screen.getByTestId('title3d-tone'), { target: { value: 'agx' } });
		expect(session.getDrawn().sequences[seqId]!.threeD?.toneMapping).toBe('agx');
	});
});

describe('Properties ▸ Environment', () => {
	it('chooses a procedural preset for an environment light', () => {
		const { session, seqId } = makeSession();
		const r = session.apply({
			label: 'Light',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'clip.addLight', at: 0, duration: 30, lightType: 'environment' }],
		});
		const id = (r as { results: { clipId: string }[] }).results[0]!.clipId;
		render(
			<SessionProvider session={session}>
				<Environment3DSection session={session} clips={[clipOf(session, seqId, id)]} frame={0} sequenceId={seqId} />
			</SessionProvider>,
		);
		fireEvent.change(screen.getByTestId('environment3d-preset'), { target: { value: 'neon' } });
		expect((clipOf(session, seqId, id) as unknown as { light: { environmentPreset: string } }).light.environmentPreset).toBe('neon');
	});
});

describe('the cost before enabling (TL-078)', () => {
	it('names the Remotion path and what makes a title heavy', () => {
		render(<Cost3DContent dontAsk={false} onDontAsk={() => {}} />);
		expect(document.body.textContent).toContain('Remotion path');
		expect(document.body.textContent).toContain('transmission');
		expect(cost3dAcknowledged()).toBe(false);
	});
});
