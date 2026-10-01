// Review fixes of the anime templates (docs/wp-notes/wp-m2-anime-templates.md "Review fixes"):
// - every template clips its drawing to the canvas (preview = hybrid export crop) and its own design stays inside
//   the canvas at default params on every design canvas;
// - callout@1: the pulse ring is invisible before it starts (first frames, head handles) and at rest;
// - counter@1: large ranges count in steps of the frame, not of the 1e-6 value rounding.
import {
	ANIME_CATALOG,
	type AnyAnimeMgTemplate,
	animeTemplateTiming,
	CANVASES,
	estimateTextWidth,
	formatCounterValue,
} from '@jasper/mg-templates';
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { frameToMs, hash32, roundValue, seekCanonical } from '../src/runtime/index.ts';
import {
	ANIME_TEMPLATE_IMPLS,
	type AnimeTemplateProps,
	buildCallout,
	buildCounterCount,
	counterProgressAt,
	counterValue,
} from '../src/templates/index.ts';

const FPS = 30;

function propsAt(
	def: AnyAnimeMgTemplate,
	frame: number,
	durationFrames: number,
	canvas: { width: number; height: number },
	params: Record<string, unknown> = def.defaults,
): AnimeTemplateProps {
	const t = animeTemplateTiming(def, { fps: FPS, localFrame: frame, durationFrames });
	return {
		params,
		timeMs: t.timeMs,
		totalMs: t.totalMs,
		introMs: t.introMs,
		outroMs: t.outroMs,
		canvas,
		seed: hash32('clp_TEST', 'template'),
	};
}

const def = (id: string) => ANIME_CATALOG.find((d) => d.id === id)!;
const num = (v: string) => Number.parseFloat(v);

/** Absolute boxes (design px) of the parts that carry explicit left/top/width/height styles. */
function partRects(root: Element): { part: string; x0: number; y0: number; x1: number; y1: number }[] {
	return [...root.querySelectorAll<HTMLElement>('[data-part]')]
		.filter((el) => el.style.left && el.style.top && el.style.width && el.style.height)
		.map((el) => {
			const x0 = num(el.style.left);
			const y0 = num(el.style.top);
			return { part: el.dataset.part!, x0, y0, x1: x0 + num(el.style.width), y1: y0 + num(el.style.height) };
		});
}

describe('anime templates clip to their canvas (preview = hybrid export)', () => {
	for (const d of ANIME_CATALOG) {
		it(`${d.id}@${d.version}: the content root clips (overflow hidden)`, () => {
			const Impl = ANIME_TEMPLATE_IMPLS[`${d.id}@${d.version}`]!;
			const r = render(<Impl {...propsAt(d, 75, 150, { width: 1280, height: 720 })} />);
			const root = r.container.querySelector<HTMLElement>('[data-anime-template]')!;
			expect(root.style.overflow).toBe('hidden');
			expect(root.style.inset).toMatch(/^0(px)?$/);
			r.unmount();
		});
	}

	// The designs themselves stay inside every design canvas at default params (hold and mid-intro frames).
	for (const canvas of CANVASES) {
		const W = canvas.width;
		const H = canvas.height;
		const tag = `${W}x${H}`;
		it(`callout and lower-third-anim parts stay inside ${tag}`, () => {
			for (const id of ['callout', 'lower-third-anim']) {
				const d = def(id);
				const Impl = ANIME_TEMPLATE_IMPLS[`${d.id}@${d.version}`]!;
				for (const params of [d.defaults, ...(id === 'callout' ? [{ ...d.defaults, motionPath: true }] : [])])
					for (const frame of [10, 25, 75]) {
						const r = render(<Impl {...propsAt(d, frame, 150, canvas, params)} />);
						const rects = partRects(r.container);
						expect(rects.length, `${id} parts`).toBeGreaterThan(0);
						for (const b of rects) {
							expect(b.x0, `${id} ${b.part} left @${frame}`).toBeGreaterThanOrEqual(0);
							expect(b.y0, `${id} ${b.part} top @${frame}`).toBeGreaterThanOrEqual(0);
							expect(b.x1, `${id} ${b.part} right @${frame}`).toBeLessThanOrEqual(W);
							expect(b.y1, `${id} ${b.part} bottom @${frame}`).toBeLessThanOrEqual(H);
						}
						r.unmount();
					}
			}
			// callout: the grown pulse ring around the target
			const c = def('callout').defaults as { targetX: number; targetY: number; dotSize: number };
			const ringR = (c.dotSize / 2) * 2.6 + c.dotSize / 6;
			expect(c.targetX * W - ringR).toBeGreaterThan(0);
			expect(c.targetX * W + ringR).toBeLessThan(W);
			expect(c.targetY * H + ringR).toBeLessThan(H);
		});
		it(`title-reveal and counter text fits ${tag} (estimated)`, () => {
			const t = def('title-reveal').defaults as {
				title: string;
				subtitle: string;
				titleSize: number;
				y: number;
			};
			const margin = W * 0.08;
			expect(estimateTextWidth(t.title, t.titleSize, 700)).toBeLessThanOrEqual(W - 2 * margin);
			expect(estimateTextWidth(t.subtitle, t.titleSize * 0.4, 400)).toBeLessThanOrEqual(W - 2 * margin);
			// title + underline + subtitle, centred on y (translateY(-50%)), plus the 0.6 em rise of the subtitle
			const blockH = t.titleSize * 1.1 + t.titleSize * 0.24 + 12 + t.titleSize * 0.4 * 1.25;
			expect(t.y * H - blockH / 2).toBeGreaterThan(0);
			expect(t.y * H + blockH / 2 + t.titleSize * 0.4 * 0.6).toBeLessThan(H);
			const k = def('counter');
			const c = k.defaults as { size: number; to: number };
			const shown = formatCounterValue(c.to, k.defaults as never);
			expect(estimateTextWidth(shown, c.size, 700)).toBeLessThanOrEqual(W);
			const counterH = c.size * 1.05 + c.size * 0.3 * 1.3;
			expect(H / 2 + counterH / 2 + c.size * 0.4).toBeLessThan(H);
		});
	}
});

describe('callout@1 pulse ring', () => {
	const timing = (() => {
		const t = animeTemplateTiming(def('callout'), { fps: FPS, localFrame: 0, durationFrames: 150 });
		return { totalMs: t.totalMs, introMs: t.introMs, outroMs: t.outroMs };
	})();
	const ringAt = (ms: number) => {
		const b = buildCallout({ ...timing, ease: 'inOut', motionPath: false });
		seekCanonical(b.timeline, ms);
		const [dot, ring, label] = b.targets.map((x) => ({ s: roundValue(x.s), o: roundValue(x.o), m: x.m }));
		return { dot: dot!, ring: ring!, label: label! };
	};
	it('is invisible before it starts (first frame, head handles), visible during the pulse, gone at rest', () => {
		// initial state: nothing of the callout shows (dot at scale 0, ring and label transparent)
		for (const ms of [-1000, frameToMs(-3, FPS), 0]) {
			const v = ringAt(ms);
			expect(v.ring.o, `ring @${ms}`).toBe(0);
			expect(v.dot.s, `dot @${ms}`).toBe(0);
			expect(v.label.o, `label @${ms}`).toBe(0);
		}
		// fades in with the dot's pop, peaks at 0.8 when the pulse starts, then fades while growing
		const start = 0.08 * timing.introMs;
		expect(ringAt(start / 2).ring.o).toBeGreaterThan(0);
		expect(ringAt(start / 2).ring.o).toBeLessThan(0.8);
		expect(ringAt(start).ring.o).toBeCloseTo(0.8, 6);
		expect(ringAt(start + 0.2 * timing.introMs).ring.s).toBeGreaterThan(1);
		// rest (hold): dot at full size, ring faded out, label shown
		const hold = ringAt(timing.totalMs / 2);
		expect(hold).toMatchObject({ dot: { s: 1 }, ring: { o: 0 }, label: { o: 1, s: 1 } });
		// end of the outro: everything gone again
		const end = ringAt(timing.totalMs);
		expect(end.ring.o).toBe(0);
		expect(end.dot.s).toBe(0);
		expect(end.label.o).toBe(0);
	});
	it('renders no ring in the first frames of the clip', () => {
		const d = def('callout');
		const Impl = ANIME_TEMPLATE_IMPLS['callout@1']!;
		const r = render(<Impl {...propsAt(d, 0, 150, { width: 1920, height: 1080 })} />);
		const opacity = () => r.container.querySelector('[data-part="ring"]')!.getAttribute('opacity');
		expect(opacity()).toBe('0');
		act(() => r.rerender(<Impl {...propsAt(d, -2, 150, { width: 1920, height: 1080 })} />));
		expect(opacity()).toBe('0');
		act(() => r.rerender(<Impl {...propsAt(d, 75, 150, { width: 1920, height: 1080 })} />));
		expect(opacity()).toBe('0');
		r.unmount();
	});
});

describe('counter@1 precision', () => {
	it('a 0 → 25,000,000 count is not quantised by the 1e-6 value rounding', () => {
		const d = def('counter');
		const params = { ...d.defaults, from: 0, to: 25_000_000 };
		const Impl = ANIME_TEMPLATE_IMPLS['counter@1']!;
		const canvas = { width: 1920, height: 1080 };
		const r = render(<Impl {...propsAt(d, 0, 150, canvas, params)} />);
		const shown: string[] = [];
		for (let f = 0; f <= 75; f++) {
			act(() => r.rerender(<Impl {...propsAt(d, f, 150, canvas, params)} />));
			shown.push(r.container.querySelector('[data-part="number"]')!.textContent!);
		}
		r.unmount();
		const values = shown.map((s) => Number(s.replace(/,/g, '')));
		expect(values[0]).toBe(0);
		expect(values.at(-1)).toBe(25_000_000);
		// counting frames: the last two digits are not limited to 00/25/50/75
		const counting = values.filter((v) => v > 0 && v < 25_000_000);
		expect(counting.length).toBeGreaterThan(20);
		expect(counting.some((v) => v % 25 !== 0)).toBe(true);
	});
	it('the progress is exact at the ends and un-rounded in between; the value is exactly from / to at rest', () => {
		const count = buildCounterCount({ countMs: 2000, ease: 'outExpo' });
		expect(counterProgressAt(count, -100)).toBe(0);
		expect(counterProgressAt(count, 0)).toBe(0);
		expect(counterProgressAt(count, 2000)).toBe(1);
		expect(counterProgressAt(count, 4000)).toBe(1);
		const mid = counterProgressAt(count, 1234);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);
		// pure function of the time (canonical seek): revisits agree
		expect(counterProgressAt(count, 1777)).toBe(counterProgressAt(count, 1777));
		expect(counterProgressAt(count, 1234)).toBe(mid);
		const p = { from: 0.1, to: 0.3 };
		expect(counterValue(p, 0)).toBe(0.1);
		expect(counterValue(p, 1)).toBe(0.3);
		expect(counterValue({ from: -1e12, to: 1e12 }, 0.5)).toBe(0);
	});
});
