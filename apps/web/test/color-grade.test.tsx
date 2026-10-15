import type { Clip, EffectInstance } from '@jasper/project';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/commands/color.ts';
import { eyedropper } from '../src/color/grade/eyedropper.ts';
import { LumetriPanel } from '../src/panels/lumetri/LumetriPanel.tsx';
import { monitorExtras, setComparison } from '../src/panels/program/monitor-view.ts';
import { addSolids, clipOf, makeSession, renderWithSession } from './inspector-helpers.tsx';

type Anim<T = unknown> = { value: T; keyframes: unknown[] };
const effectsOf = (clip: Clip) => (clip as unknown as { effects?: EffectInstance[] }).effects ?? [];
const lumetriOf = (s: ReturnType<typeof makeSession>, id: string) =>
	effectsOf(clipOf(s, id)).filter((e) => e.effectId === 'jasper.lumetri');
const param = <T,>(fx: EffectInstance, name: string) => (fx.params[name] as unknown as Anim<T>).value;
const entries = (s: ReturnType<typeof makeSession>) => s.getState().history.entries.length;

beforeEach(() => {
	globalThis.localStorage?.clear();
	eyedropper.cancel();
	setComparison({ enabled: false, reference: null });
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

const openSection = (id: string) => {
	const t = screen.getByTestId(`section-toggle-${id}`);
	if (t.getAttribute('aria-expanded') !== 'true') act(() => fireEvent.click(t));
};

describe('Lumetri panel completion', () => {
	it('section switches write the on/off params in one step (and add the instance)', () => {
		const { session, id } = setup();
		const before = entries(session);
		act(() => fireEvent.click(screen.getByTestId('lumetri-section-creative')));
		const fx = lumetriOf(session, id)[0]!;
		expect(param(fx, 'creativeOn')).toBe(false);
		expect(entries(session)).toBe(before + 1);
		act(() => fireEvent.click(screen.getByTestId('lumetri-section-creative')));
		expect(param(lumetriOf(session, id)[0]!, 'creativeOn')).toBe(true);
	});

	it('the Looks browser applies a built-in look in one step', () => {
		const { session, id } = setup();
		act(() => fireEvent.click(screen.getByTestId('lumetri-looks-browser')));
		const tile = screen.getByTestId('lumetri-look-tile-bleach-bypass');
		const before = entries(session);
		act(() => fireEvent.click(tile));
		const fx = lumetriOf(session, id)[0]!;
		expect(param(fx, 'creativeLook')).toBe('bleach-bypass');
		expect(entries(session)).toBe(before + 1);
		expect(screen.getByTestId('lumetri-look-tile-bleach-bypass').getAttribute('aria-pressed')).toBe('true');
	});

	it('hue/saturation curve tabs and the eyedropper add three points around the picked hue', () => {
		const { session, id } = setup();
		act(() => fireEvent.click(screen.getByTestId('lumetri-hue-curve-tab-hueVsHue')));
		act(() => fireEvent.click(screen.getByTestId('lumetri-hue-curve-eyedropper')));
		expect(eyedropper.get()?.id).toBe('curve-hueVsHue');
		// A pure green pick (hue 1/3).
		act(() => eyedropper.pick([0.1, 0.9, 0.1]));
		const fx = lumetriOf(session, id)[0]!;
		const pts = param<{ curve: number[][] }>(fx, 'hueVsHue').curve;
		expect(pts.some((p) => Math.abs(p[0]! - 1 / 3) < 0.001)).toBe(true);
		expect(pts.every((p) => Math.abs(p[1]! - 0.5) < 1e-6)).toBe(true);
		expect(eyedropper.get()).toBeNull();
	});

	it('HSL Secondary Set Color keys the picked colour; Add widens it (one step each)', () => {
		const { session, id } = setup();
		openSection('lumetri.secondary');
		act(() => fireEvent.click(screen.getByTestId('lumetri-secondary-set')));
		act(() => eyedropper.pick([0.9, 0.5, 0.1]));
		let fx = lumetriOf(session, id)[0]!;
		expect(param<number>(fx, 'secHueRange')).toBe(15);
		const center = param<number>(fx, 'secHueCenter');
		expect(Math.abs(center - 30)).toBeLessThan(0.2);
		const before = entries(session);
		act(() => fireEvent.click(screen.getByTestId('lumetri-secondary-add')));
		act(() => eyedropper.pick([0.85, 0.1, 0.1]));
		fx = lumetriOf(session, id)[0]!;
		expect(param<number>(fx, 'secHueRange')).toBeGreaterThan(15);
		expect(entries(session)).toBe(before + 1);
	});

	it('Apply Match needs the Comparison View; the button opens it with a reference', () => {
		setup();
		const match = screen.getByTestId('lumetri-apply-match') as HTMLButtonElement;
		expect(match.disabled).toBe(true);
		act(() => fireEvent.click(screen.getByTestId('lumetri-comparison-view')));
		const c = monitorExtras.getState().comparison;
		expect(c.enabled).toBe(true);
		expect(c.reference).toMatchObject({ kind: 'sequence-frame', frame: 0 });
	});
});
