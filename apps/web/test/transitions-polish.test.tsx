import { buildRenderSnapshot, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import type { ProgramOverlayHostProps } from '../src/extensions/index.ts';
import {
	framePointToSequence,
	sequenceToFramePoint,
	TransitionPointOverlay,
} from '../src/fx/TransitionPointOverlay.tsx';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { monitorStores } from '../src/panels/program/monitor-store.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

/** Two clips cut at 120 with a centred 20-frame transition (span 110…129). */
function scene(effectId = 'jasper.iris-round') {
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
	const reg = (asset = videoAsset(20, false)) =>
		(apply([{ type: 'media.register', asset }]).results[0] as { mediaId: string }).mediaId;
	const a = reg();
	const b = reg();
	const image = reg({ ...videoAsset(20, false), kind: 'image', originalName: 'gradient.png' });
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
	const r = apply([{ type: 'transition.add', trackId: 'V1', at: 120, effectId, duration: 20, ref: '$x' }]);
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const id = r.refs.$x!;
	act(() => session.select('transitions', [id], 'replace'));
	return { session, id, seq, image };
}

const panel = (session: ReturnType<typeof scene>['session']) =>
	render(
		<SessionProvider session={session}>
			<EffectControlsPanel instanceId="ec-polish" visible />
		</SessionProvider>,
	);

describe('Transition section (wave 4)', () => {
	it('marks expensive transitions with the expensive-effect dot', () => {
		const heavy = scene('jasper.s.swish-3d');
		panel(heavy.session);
		expect(screen.getByTestId('transition-expensive').getAttribute('title')).toBe('Expensive in preview');
		cleanup();
		panel(scene('jasper.iris-round').session);
		expect(screen.queryByTestId('transition-expensive')).toBeNull();
	});

	it('picks a Custom Gradient image for Gradient Wipe (None = the built-in gradient)', () => {
		const { session, id, seq, image } = scene('jasper.gradient-wipe');
		panel(session);
		const picker = screen.getByTestId('transition-param-gradientImage') as HTMLSelectElement;
		expect([...picker.options].map((o) => o.textContent)).toEqual(['None', 'gradient.png']);
		act(() => {
			fireEvent.change(picker, { target: { value: image } });
		});
		expect(seq().transitions[id]!.params.gradientImage!.value).toEqual({ mediaId: image });
	});

	it('turning Custom Completion on seeds a 0 → 100 % curve over the span (one history entry)', () => {
		const { session, id, seq } = scene('jasper.push');
		panel(session);
		const n = session.getState().history.entries.length;
		const box = document.querySelector('[data-transition-param="useCompletion"] input') as HTMLInputElement;
		act(() => {
			fireEvent.click(box);
		});
		const t = seq().transitions[id]!;
		expect(t.params.useCompletion!.value).toBe(true);
		const F = 705_600_000 / 30;
		expect(t.params.completion!.keyframes.map((k) => [k.time / F, k.value])).toEqual([
			[0, 0],
			[19, 100],
		]);
		expect(session.getState().history.entries).toHaveLength(n + 1);
	});
});

describe('on-canvas point handles of the selected transition', () => {
	const hostProps = (
		session: EditorSession,
		view: ProgramOverlayHostProps['view'],
	): ProgramOverlayHostProps => ({
		session,
		view,
		doc: buildRenderSnapshot(session.getDrawn(), session.getState().activeSequenceId!, {
			resolveMedia: () => null,
			resolveFont: () => null,
		}),
		transport: session.transport,
		viewport: { width: 960, height: 540 },
		monitor: monitorStores.program.getState(),
	});
	it('maps frame-normalised points to sequence px and back', () => {
		const seq = { settings: { width: 1920, height: 1080 } } as Sequence;
		expect(framePointToSequence(seq, [0.25, 0.5])).toEqual([480, 540]);
		expect(sequenceToFramePoint(seq, [480, 540])).toEqual([0.25, 0.5]);
	});

	it('draws a crosshair for Center and drags it in one gesture', async () => {
		const { session, id, seq } = scene('jasper.iris-round');
		const view = { scale: 0.5, x: 10, y: 20 };
		render(
			<SessionProvider session={session}>
				<TransitionPointOverlay {...hostProps(session, view)} />
			</SessionProvider>,
		);
		const g = screen.getByTestId('transition-point-center');
		expect([Number(g.getAttribute('data-x')), Number(g.getAttribute('data-y'))]).toEqual([
			10 + 480,
			20 + 270,
		]);
		const n = session.getState().history.entries.length;
		const hit = g.querySelectorAll('circle')[2]!;
		act(() => {
			fireEvent.pointerDown(hit, { button: 0, clientX: 490, clientY: 290 });
		});
		await act(async () => {
			window.dispatchEvent(new MouseEvent('pointermove', { clientX: 590, clientY: 290 }));
			await new Promise((r) => setTimeout(r, 40));
			window.dispatchEvent(new MouseEvent('pointerup', { clientX: 590, clientY: 290 }));
		});
		// +100 screen px at scale 0.5 = +200 sequence px → x = (960 + 200) / 1920.
		const c = seq().transitions[id]!.params.center!.value as number[];
		expect(c[0]).toBeCloseTo(1160 / 1920, 5);
		expect(c[1]).toBeCloseTo(0.5, 5);
		expect(session.getState().history.entries).toHaveLength(n + 1);
	});

	it('shows nothing without a selected transition, or for a type without point params', () => {
		const { session } = scene('jasper.push');
		render(
			<SessionProvider session={session}>
				<TransitionPointOverlay {...hostProps(session, { scale: 1, x: 0, y: 0 })} />
			</SessionProvider>,
		);
		expect(screen.queryByTestId('transition-point-overlay')).toBeNull();
	});
});
