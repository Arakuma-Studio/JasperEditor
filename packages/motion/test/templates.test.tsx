// Anime template implementations (S11:ATP-001/003/004, ANM-013 for the templates): the implementation list
// matches the catalogue, every template is a pure function of the frame (values and markup identical whether frames
// are visited in order, reversed, shuffled or built fresh per frame) and responsive time keeps the intro and outro
// frame-exact when the clip is stretched. Own harness (wp-m2-anime-core builds the generic suite in parallel).
import {
	ANIME_CATALOG,
	ANIME_TEMPLATE_EASES,
	type AnyAnimeMgTemplate,
	animeTemplateTiming,
	formatCounterValue,
	mgRegistry,
} from '@jasper/mg-templates';
import { act, render } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EASE_NAMES, frameToMs, hash32, seekCanonical, type Timeline } from '../src/runtime/index.ts';
import {
	ANIME_TEMPLATE_IMPLS,
	type AnimeTemplateProps,
	buildCallout,
	buildCounter,
	buildLowerThirdAnim,
	buildTitleReveal,
	calloutGeometry,
	staggerRanks,
} from '../src/templates/index.ts';

const FPS = 30;
const CANVAS = { width: 1280, height: 720 };

function propsAt(
	def: AnyAnimeMgTemplate,
	frame: number,
	durationFrames: number,
	params = def.defaults,
): AnimeTemplateProps {
	const t = animeTemplateTiming(def, { fps: FPS, localFrame: frame, durationFrames });
	return {
		params,
		timeMs: t.timeMs,
		totalMs: t.totalMs,
		introMs: t.introMs,
		outroMs: t.outroMs,
		canvas: CANVAS,
		seed: hash32('clp_TEST', 'template'),
	};
}

/** Value builds of each template with its default params (the inputs the components derive). */
const BUILDS: Record<
	string,
	(t: { totalMs: number; introMs: number; outroMs: number }) => { timeline: Timeline; targets: object[] }
> = {
	'title-reveal@1': (t) =>
		buildTitleReveal({ ...t, units: 12, order: 'random', stagger: 0.6, ease: 'outExpo', seed: 7 }),
	'lower-third-anim@1': (t) => buildLowerThirdAnim({ ...t, nameWords: 2, roleWords: 3, ease: 'outExpo' }),
	'callout@1': (t) => buildCallout({ ...t, ease: 'inOut', motionPath: true }),
	'counter@1': (t) => buildCounter({ ...t, countMs: 2000, ease: 'outExpo' }),
};

describe('implementations (S11:ATP-001)', () => {
	it('every anime catalogue entry has an implementation and vice versa', () => {
		expect(Object.keys(ANIME_TEMPLATE_IMPLS).sort()).toEqual(
			ANIME_CATALOG.map((d) => `${d.id}@${d.version}`).sort(),
		);
		expect(
			mgRegistry
				.definitions()
				.filter((d) => d.renderer === 'anime')
				.map((d) => `${d.id}@${d.version}`)
				.sort(),
		).toEqual(Object.keys(ANIME_TEMPLATE_IMPLS).sort());
	});
	it('template eases are a subset of the runtime eases', () => {
		for (const e of ANIME_TEMPLATE_EASES) expect(EASE_NAMES).toContain(e);
	});
});

describe('value determinism (S11:ANM-013): in order = reversed = shuffled = fresh', () => {
	for (const def of ANIME_CATALOG) {
		const key = `${def.id}@${def.version}`;
		it(key, () => {
			const duration = Math.round(def.defaultDurationSeconds * FPS);
			const t = animeTemplateTiming(def, { fps: FPS, localFrame: 0, durationFrames: duration });
			const timing = { totalMs: t.totalMs, introMs: t.introMs, outroMs: t.outroMs };
			const build = BUILDS[key]!;
			// a few frames outside the clip too (transition handles clamp to the start/end state)
			const frames = Array.from({ length: duration + 6 }, (_, i) => i - 3);
			const snap = (b: ReturnType<typeof build>) => b.targets.map((x) => ({ ...x }));
			const fresh = new Map(
				frames.map((f) => {
					const b = build(timing);
					seekCanonical(b.timeline, frameToMs(f, FPS));
					return [f, snap(b)] as const;
				}),
			);
			const visit = (order: number[]) => {
				const b = build(timing);
				for (const f of order) {
					seekCanonical(b.timeline, frameToMs(f, FPS));
					expect(snap(b), `${key} frame ${f}`).toEqual(fresh.get(f));
				}
			};
			visit(frames);
			visit([...frames].reverse());
			fc.assert(
				fc.property(fc.shuffledSubarray(frames, { minLength: frames.length }), (order) => visit(order)),
				{ seed: hash32(key) | 0, numRuns: 12 },
			);
			// hold = the intro's end state; before the clip = the intro's start state
			const hold = fresh.get(Math.floor(duration / 2))!;
			expect(fresh.get(-3)).toEqual(fresh.get(0));
			expect(hold.length).toBeGreaterThan(0);
		});
	}
});

/** Renders a template at `frame` (one mount reused for `frames`, or fresh per frame) and returns the markup. */
function markupAt(
	def: AnyAnimeMgTemplate,
	frames: number[],
	duration: number,
	params = def.defaults,
): string[] {
	const Impl = ANIME_TEMPLATE_IMPLS[`${def.id}@${def.version}`]!;
	const out: string[] = [];
	const r = render(<Impl {...propsAt(def, frames[0]!, duration, params)} />);
	for (const f of frames) {
		act(() => r.rerender(<Impl {...propsAt(def, f, duration, params)} />));
		out.push(r.container.innerHTML);
	}
	r.unmount();
	return out;
}

describe('markup determinism (components, incl. the callout DOM leaf)', () => {
	for (const def of ANIME_CATALOG) {
		it(`${def.id}@${def.version}`, () => {
			const duration = Math.round(def.defaultDurationSeconds * FPS);
			const params = def.id === 'callout' ? { ...def.defaults, motionPath: true } : def.defaults;
			const frames = [0, 3, 9, 17, 24, 40, 75, duration - 12, duration - 5, duration - 1];
			const fresh = frames.map((f) => markupAt(def, [f], duration, params)[0]!);
			expect(new Set(fresh).size).toBeGreaterThan(3);
			const orders = [
				frames,
				[...frames].reverse(),
				[17, 0, duration - 1, 3, 75, 9, duration - 12, 40, 24, duration - 5],
			];
			for (const order of orders) {
				const got = markupAt(def, order, duration, params);
				order.forEach((f, i) => {
					expect(got[i], `${def.id} frame ${f}`).toBe(fresh[frames.indexOf(f)]);
				});
			}
		});
	}
});

describe('responsive time (S11:ATP-004): stretching keeps intro and outro frame-exact', () => {
	for (const def of ANIME_CATALOG) {
		it(`${def.id}@${def.version}`, () => {
			const short = Math.round(def.defaultDurationSeconds * FPS);
			const long = short * 3;
			const intro = animeTemplateTiming(def, { fps: FPS, localFrame: 0, durationFrames: short }).introFrames;
			const outro = animeTemplateTiming(def, { fps: FPS, localFrame: 0, durationFrames: short }).outroFrames;
			const head = Array.from({ length: intro + 1 }, (_, i) => i);
			// counter: the count length is clamped by the content only when it reaches the outro
			expect(markupAt(def, head, long)).toEqual(markupAt(def, head, short));
			const tailShort = Array.from({ length: outro }, (_, i) => short - outro + i);
			const tailLong = tailShort.map((f) => f + (long - short));
			expect(markupAt(def, tailLong, long)).toEqual(markupAt(def, tailShort, short));
			// the hold of the long clip equals the end of the intro
			expect(markupAt(def, [Math.floor(long / 2)], long)).toEqual(
				markupAt(def, [Math.floor(short / 2)], short),
			);
		});
	}
});

describe('template details', () => {
	const def = (id: string) => ANIME_CATALOG.find((d) => d.id === id)!;
	it('title-reveal: every char visible and the underline drawn at the hold; seeded random order', () => {
		const d = def('title-reveal');
		const [html] = markupAt(d, [75], 150);
		const doc = new DOMParser().parseFromString(html!, 'text/html');
		const units = [...doc.querySelectorAll<HTMLElement>('[data-unit]')];
		expect(units.map((u) => u.textContent).join('')).toBe('TitleReveal');
		for (const u of units) expect(u.style.opacity).toBe('1');
		expect(doc.querySelector('[data-part="underline"] line')?.getAttribute('stroke-dasharray')).toMatch(
			/^(\d+\.?\d*) /,
		);
		const ranks = (seed: number) => staggerRanks(10, 'random', seed);
		expect(ranks(1)).toEqual(ranks(1));
		expect(ranks(1)).not.toEqual(ranks(2));
		expect([...ranks(1)].sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
		expect(staggerRanks(5, 'center', 0)).toEqual([3, 1, 0, 2, 4]);
		const [start] = markupAt(d, [0], 150);
		expect(start).toContain('opacity: 0');
	});
	it('counter: counts from `from` to `to` with the formatter, tabular numerals', () => {
		const d = def('counter');
		const params = { ...d.defaults, from: 0, to: 2500, prefix: '$', decimals: 1 };
		const [hold, start] = markupAt(d, [100, 0], 150, params);
		expect(hold).toContain(formatCounterValue(2500, d.paramsSchema.parse(params) as never));
		expect(hold).toContain('$2,500.0');
		expect(start).toContain('$0.0');
		expect(hold).toContain('tabular-nums');
	});
	it('callout: the leader line is drawn by the drawable at the hold; the motion-path box sits at the line end', () => {
		const d = def('callout');
		const params = { ...d.defaults, motionPath: true };
		const r = render(
			(() => {
				const Impl = ANIME_TEMPLATE_IMPLS['callout@1']!;
				return <Impl {...propsAt(d, 75, 150, params)} />;
			})(),
		);
		const path = r.container.querySelector('[data-part="leader"] path')!;
		expect(path.getAttribute('pathLength')).toBe('1000');
		expect(path.getAttribute('stroke-dasharray')).toBe('1000 0');
		const geo = calloutGeometry(d.paramsSchema.parse(params) as never, { w: 1920, h: 1080 });
		const box = r.container.querySelector<HTMLElement>('[data-part="label"]')!;
		expect(Number.parseFloat(box.style.top) + Number.parseFloat(box.style.height) / 2).toBeCloseTo(
			geo.b.y,
			2,
		);
		r.unmount();
		expect(geo.pointAt(0)).toEqual(geo.a);
		expect(geo.pointAt(1).x).toBeCloseTo(geo.b.x, 6);
	});
	it('lower-third-anim: the panel is fully revealed at the hold and wiped at the start', () => {
		const d = def('lower-third-anim');
		const [hold, start] = markupAt(d, [75, 0], 150);
		expect(hold).toContain('inset(0 0% 0 0)');
		expect(start).toContain('inset(0 100% 0 0)');
		const [right] = markupAt(d, [0], 150, { ...d.defaults, side: 'right' });
		expect(right).toContain('inset(0 0 0 100%)');
	});
});
