import { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { JASPER_EFFECT_MIME } from '../src/panels/effects/drag.ts';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

type Anim = {
	value: number;
	keyframes: { id: string; time: number; value: number; interpolation: string }[];
};
const F = 705_600_000 / 30;
const opacityOf = (s: ReturnType<typeof makeSession>, id: string) =>
	(clipOf(s, id) as unknown as { opacity: Anim }).opacity;

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => cleanup());

function setup() {
	const session = makeSession();
	const [id] = addSolids(session, [30], 60);
	act(() => {
		session.select('timeline', [id!]);
		session.transport.seek(40);
	});
	renderWithSession(session, <EffectControlsPanel instanceId="ec1" visible />);
	return { session, id: id! };
}

describe('Effect Controls (S03 §13, S05:ECP)', () => {
	it('shows an empty state without a selected clip', () => {
		const session = makeSession();
		renderWithSession(session, <EffectControlsPanel instanceId="ec1" visible />);
		expect(screen.getByTestId('ec-empty').textContent).toMatch(/Select a clip/);
	});

	it('the stopwatch creates a key at the playhead content time; a later value makes a ramp resolved at the playhead', async () => {
		const { session, id } = setup();
		act(() => {
			fireEvent.click(screen.getByTestId('stopwatch-opacity'));
		});
		expect(opacityOf(session, id).keyframes.map((k) => [k.time, k.value])).toEqual([[10 * F, 100]]);
		act(() => session.transport.seek(60));
		const field = screen.getByTestId('prop-opacity');
		act(() => {
			fireEvent.pointerDown(field, { clientX: 5, button: 0 });
			fireEvent.pointerUp(window, { clientX: 5 });
		});
		const input = screen.getByTestId('prop-opacity-input');
		act(() => {
			fireEvent.change(input, { target: { value: '40' } });
			fireEvent.keyDown(input, { key: 'Enter' });
		});
		expect(opacityOf(session, id).keyframes.map((k) => [k.time / F, k.value])).toEqual([
			[10, 100],
			[30, 40],
		]);
		// EC-006: the row shows the value resolved at the playhead (frame 50 = halfway).
		act(() => session.transport.seek(50));
		await waitFor(() => expect(screen.getByTestId('prop-opacity').textContent).toBe('70.0%'));
		// Keyframe glyphs in the mini-timeline; navigator jumps between keys.
		expect(document.querySelectorAll('[data-kf-id]')).toHaveLength(2);
		act(() => {
			fireEvent.click(screen.getByTestId('kf-next-opacity'));
		});
		expect(session.transport.getState().frame).toBe(60);
		act(() => {
			fireEvent.click(screen.getByTestId('kf-prev-opacity'));
		});
		expect(session.transport.getState().frame).toBe(40);
	});

	it('turning the stopwatch off asks first and keeps the value at the playhead', () => {
		const { session, id } = setup();
		act(
			() =>
				void session.apply({
					label: 'keys',
					origin: 'user',
					commands: [
						{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 0 }, value: 0 },
						{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 20 }, value: 100 },
					] as never,
				}),
		);
		act(() => {
			fireEvent.click(screen.getByTestId('stopwatch-opacity'));
		});
		const dialog = screen.getByTestId('inspector-confirm');
		expect(opacityOf(session, id).keyframes).toHaveLength(2);
		act(() => {
			fireEvent.click(within(dialog).getByText('OK'));
		});
		expect(opacityOf(session, id)).toEqual({ value: 50, keyframes: [] });
	});

	it('right-click interpolation menu eases a key and changes its glyph; drag moves keys by whole frames', () => {
		const { session, id } = setup();
		act(
			() =>
				void session.apply({
					label: 'keys',
					origin: 'user',
					commands: [
						{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 0 }, value: 0 },
						{ type: 'keyframe.add', target: ['clip', id, 'opacity'], at: { frames: 20 }, value: 100 },
					] as never,
				}),
		);
		const [first] = opacityOf(session, id).keyframes;
		const glyph = () => document.querySelector(`[data-kf-id="${first!.id}"]`) as HTMLElement;
		act(() => {
			fireEvent.contextMenu(glyph(), { clientX: 10, clientY: 10 });
		});
		act(() => {
			fireEvent.click(within(screen.getByTestId('ec-kf-menu')).getByText('Ease Out'));
		});
		expect(opacityOf(session, id).keyframes[0]!.interpolation).toBe('bezier');
		const originalTime = opacityOf(session, id).keyframes[0]!.time;
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.pointerDown(glyph(), { clientX: 100, button: 0 });
			fireEvent.pointerMove(window, { clientX: 120, shiftKey: true });
			fireEvent.pointerMove(window, { clientX: 144, shiftKey: true });
			fireEvent.pointerUp(window, { clientX: 144 });
		});
		expect(opacityOf(session, id).keyframes[0]!.time).toBeGreaterThan(originalTime);
		expect(session.getState().history.entries.length).toBe(entries + 1);
		// Delete removes the selected key.
		act(() => {
			fireEvent.keyDown(screen.getByTestId('ec-content'), { key: 'Delete' });
		});
		expect(opacityOf(session, id).keyframes).toHaveLength(1);
	});

	it('shows applied effects with bypass/remove and accepts drops from the Effects panel', () => {
		const { session, id } = setup();
		act(
			() =>
				void session.apply({
					label: 'fx',
					origin: 'user',
					commands: [
						{ type: 'effect.add', target: { clipId: id }, effectId: 'jasper.gaussian-blur', ref: '$b' },
					] as never,
				}),
		);
		const fx = (
			clipOf(session, id) as unknown as { effects: { id: string; enabled: boolean; effectId: string }[] }
		).effects;
		expect(screen.getByText('Gaussian Blur')).toBeTruthy();
		act(() => {
			fireEvent.click(screen.getByTestId(`fx-toggle-${fx[0]!.id}`));
		});
		expect((clipOf(session, id) as unknown as { effects: { enabled: boolean }[] }).effects[0]!.enabled).toBe(
			false,
		);
		const dt = {
			types: [JASPER_EFFECT_MIME],
			getData: (t: string) =>
				t === JASPER_EFFECT_MIME
					? JSON.stringify({ type: 'jasper/effect', effectId: 'jasper.black-white' })
					: '',
			dropEffect: 'none',
		};
		act(() => {
			fireEvent.dragOver(screen.getByTestId('ec-drop-end'), { dataTransfer: dt });
			fireEvent.drop(screen.getByTestId('ec-drop-end'), { dataTransfer: dt });
		});
		const after = (clipOf(session, id) as unknown as { effects: { effectId: string }[] }).effects.map(
			(e) => e.effectId,
		);
		expect(after).toEqual(['jasper.gaussian-blur', 'jasper.black-white']);
		act(() => {
			fireEvent.click(screen.getByTestId(`fx-remove-${fx[0]!.id}`));
		});
		expect((clipOf(session, id) as unknown as { effects: unknown[] }).effects).toHaveLength(1);
	});
});

describe('Effect Controls with unknown effects (S01:FX-022)', () => {
	it('shows "Missing effect: <id>" and still allows removing it', () => {
		const base = makeSession();
		const [id] = addSolids(base, [0], 30);
		const doc = JSON.parse(JSON.stringify(base.getCommitted()));
		const seq = Object.values(doc.sequences)[0] as { clips: Record<string, { effects: unknown[] }> };
		seq.clips[id!]!.effects.push({
			id: 'fx_000000000000FUTR',
			effectId: 'jasper.hologram',
			effectVersion: 3,
			enabled: true,
			params: { glow: { value: 0.7, keyframes: [] } },
		});
		const session = new EditorSession({ projectId: doc.projectId, document: doc, ctx: base.ctx });
		act(() => session.select('timeline', [id!]));
		renderWithSession(session, <EffectControlsPanel instanceId="ec2" visible />);
		expect(screen.getByText('Missing effect: jasper.hologram')).toBeTruthy();
		act(() => {
			fireEvent.click(screen.getByTestId('fx-remove-fx_000000000000FUTR'));
		});
		expect((clipOf(session, id!) as unknown as { effects: unknown[] }).effects).toEqual([]);
	});
});

describe('Effect Controls helpers', () => {
	it('the footer Loop button reflects the transport loop state', () => {
		const { session } = setup();
		const btn = screen.getByRole('button', { name: 'Loop' });
		const pressed = () => btn.getAttribute('aria-pressed');
		const before = pressed();
		act(() => fireEvent.click(btn));
		expect(session.transport.getState().loop).toBe(true);
		expect(pressed()).not.toBe(before);
		act(() => session.transport.setLoop(false));
		expect(pressed()).toBe(before);
	});
});
