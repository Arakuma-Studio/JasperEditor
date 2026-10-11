import type { Clip, EffectInstance } from '@jasper/project';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/commands/color.ts';
import { eyedropper } from '../src/color/grade/eyedropper.ts';
import { computeScopes } from '../src/color/scopes/compute.ts';
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

	it('the Looks browser applies a built-in look and clears a look LUT, one step', () => {
		const { session, id } = setup();
		act(() => fireEvent.click(screen.getByTestId('lumetri-looks-browser')));
		const tile = screen.getByTestId('lumetri-look-tile-bleach-bypass');
		const before = entries(session);
		act(() => fireEvent.click(tile));
		const fx = lumetriOf(session, id)[0]!;
		expect(param(fx, 'creativeLook')).toBe('bleach-bypass');
		expect(param(fx, 'look')).toEqual({ mediaId: '' });
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

	it('the vignette sliders and the 3-way correction wheels are in the panel', () => {
		setup();
		openSection('lumetri.vignette');
		expect(screen.getByTestId('lumetri-vignetteAmount')).toBeTruthy();
		openSection('lumetri.secondary');
		expect(screen.getByTestId('lumetri-secWheel')).toBeTruthy();
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

describe('Lumetri Scopes compute (worker)', () => {
	const frame = () => {
		const w = 64;
		const h = 32;
		const data = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < w * h; i++) {
			data[i * 4] = (i * 7) % 256;
			data[i * 4 + 1] = (i * 3) % 256;
			data[i * 4 + 2] = 128;
			data[i * 4 + 3] = 255;
		}
		return { data, width: w, height: h };
	};
	const colors = {
		trace: [100, 255, 100],
		luma: [230, 230, 230],
		chroma: [220, 160, 255],
		red: [255, 80, 80],
		green: [80, 255, 100],
		blue: [80, 140, 255],
	} as const;
	it('computes every scope of a four-up layout in one pass', () => {
		const r = computeScopes({
			id: 1,
			...frame(),
			kinds: ['vectorscopeYuv', 'histogram', 'parade', 'waveform'],
			settings: {
				waveformType: 'yc',
				paradeType: 'rgbWhite',
				matrix: 'bt2020',
				clamp: true,
				brightness: 'bright',
			},
			colors,
		});
		expect(r.samples).toBe(64 * 32);
		expect(r.histogram?.samples).toBe(64 * 32);
		const parade = r.images.find((i) => i.kind === 'parade')!;
		expect(parade.blocks).toBe(4);
		expect(parade.names).toEqual(['R', 'G', 'B', 'Y']);
		expect(parade.width).toBe(64 * 4);
		const wf = r.images.find((i) => i.kind === 'waveform')!;
		expect(wf.names).toEqual(['Y', 'C']);
		expect(r.images.find((i) => i.kind === 'vectorscopeYuv')!.width).toBe(255);
		expect(wf.image.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
	});
	it('unclamped waveforms span −10 … 110 %', () => {
		const r = computeScopes({
			id: 2,
			...frame(),
			kinds: ['waveform'],
			settings: {
				waveformType: 'luma',
				paradeType: 'rgb',
				matrix: 'bt601',
				clamp: false,
				brightness: 'dimmed',
			},
			colors,
		});
		expect([r.images[0]!.lo, r.images[0]!.hi]).toEqual([-0.1, 1.1]);
	});
});
