import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render } from '@testing-library/react';
import fc from 'fast-check';
import { StrictMode, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ANIMEJS_VERSION,
	createPausedTimeline,
	frameToMs,
	groupLines,
	hash32,
	needsShaping,
	resolveEase,
	seededRandom,
	seekCanonical,
	segmentText,
	useAnimeDom,
	useAnimeValues,
} from '../src/runtime/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

function gapTimeline() {
	const target = { x: 0, o: 1 };
	const timeline = createPausedTimeline();
	timeline.add(target, { x: [0, 100], duration: 400, ease: 'linear' }, 0);
	timeline.add(target, { x: [200, 300], o: [1, 0], duration: 400, ease: 'linear' }, 600);
	return { timeline, targets: [target] };
}

describe('paused timelines and the canonical seek (S11:ANM-002/003)', () => {
	it('pins anime.js 4.5.0 exactly', () => {
		const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
		expect(pkg.dependencies.animejs).toBe('4.5.0');
		expect(ANIMEJS_VERSION).toBe('4.5.0');
	});
	it('never autoplays when the caller requests autoplay', () => {
		const tl = createPausedTimeline({ autoplay: true } as never);
		tl.add({ v: 0 }, { v: [0, 1], duration: 100 });
		seekCanonical(tl, 50);
		expect(tl.paused).toBe(true);
	});
	it('canonical seek restores the gap value after visiting the end', () => {
		const fresh = gapTimeline();
		seekCanonical(fresh.timeline, 500);
		expect(fresh.targets[0]).toMatchObject({ x: 100, o: 1 });
		const visited = gapTimeline();
		seekCanonical(visited.timeline, 1000);
		seekCanonical(visited.timeline, 500);
		expect(visited.targets[0]).toMatchObject(fresh.targets[0]!);
	});
	it('frameToMs = frame * 1000 / fps', () => {
		expect(frameToMs(45, 30)).toBe(1500);
		expect(frameToMs(1, 30000 / 1001)).toBeCloseTo(33.3667, 4);
	});
});

describe('seeds and randomness (S11:ANM-007)', () => {
	it('hash32 is FNV-1a over UTF-8 and separates seed arguments', () => {
		expect(hash32('')).toBe(0x811c9dc5);
		expect(hash32('a')).toBe(0xe40c292c);
		expect(hash32('foobar')).toBe(0xbf9cf968);
		expect(hash32('é')).toBe(0x1e9de8c1);
		expect(hash32('a', 1)).not.toBe(hash32('a1'));
	});
	it('seededRandom is deterministic per seed and in [0, 1)', () => {
		const a = seededRandom(7);
		const b = seededRandom(7);
		const xs = Array.from({ length: 200 }, () => a());
		expect(xs).toEqual(Array.from({ length: 200 }, () => b()));
		expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
		expect(new Set(xs).size).toBeGreaterThan(190);
		expect(seededRandom(8)()).not.toBe(seededRandom(7)());
	});
});

function easeValue(ease: ReturnType<typeof resolveEase>, ms: number): number {
	const target = { value: 0 };
	const timeline = createPausedTimeline();
	timeline.add(target, { value: [0, 1], duration: 1000, ease });
	seekCanonical(timeline, ms);
	return target.value;
}

describe('eases', () => {
	it('resolves steps and falls back for an unknown ease', () => {
		expect(easeValue(resolveEase('outBack'), 300)).toBeCloseTo(easeValue('outBack', 300), 9);
		expect(easeValue(resolveEase('bogus'), 300)).toBeCloseTo(easeValue('out', 300), 9);
		expect(easeValue(resolveEase('steps', { steps: 4 }), 300)).toBe(0.25);
	});
});

function Values({
	ms,
	onValues,
}: {
	ms: number;
	onValues(v: readonly Readonly<{ x: number; o: number }>[]): void;
}) {
	const values = useAnimeValues('gap', gapTimeline, ms);
	onValues(values);
	return <span data-x={values[0]!.x} />;
}

describe('useAnimeValues (S11:ANM-004)', () => {
	const frames = Array.from({ length: 31 }, (_, i) => i);
	const fresh = (f: number) => {
		let out: readonly Readonly<{ x: number; o: number }>[] = [];
		const r = render(<Values ms={frameToMs(f, 30)} onValues={(v) => (out = v)} />);
		r.unmount();
		return out;
	};
	const expected = frames.map(fresh);
	it('returns frozen copies of the seeked values', () => {
		let v: readonly Readonly<{ x: number; o: number }>[] = [];
		const r = render(<Values ms={500} onValues={(values) => (v = values)} />);
		const snapshot = v;
		r.rerender(<Values ms={1000} onValues={(values) => (v = values)} />);
		expect(v[0]).toEqual({ x: 300, o: 0 });
		expect(snapshot[0]).toEqual({ x: 100, o: 1 });
		r.unmount();
		expect(Object.isFrozen(v)).toBe(true);
		expect(Object.isFrozen(v[0])).toBe(true);
	});
	it('gives identical values for shuffled frame orders (one mounted instance)', () => {
		fc.assert(
			fc.property(fc.shuffledSubarray(frames, { minLength: frames.length }), (order) => {
				let seen: readonly { x: number; o: number }[] = [];
				const r = render(<Values ms={frameToMs(order[0]!, 30)} onValues={(v) => (seen = v)} />);
				for (const f of order) {
					r.rerender(<Values ms={frameToMs(f, 30)} onValues={(v) => (seen = v)} />);
					expect(seen).toEqual(expected[f]);
				}
				r.unmount();
			}),
			{ seed: 1234, numRuns: 25 },
		);
	});
});

function Leaf({ ms, ready }: { ms: number; ready: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	useAnimeDom(
		ref,
		'leaf',
		(root) => {
			const tl = createPausedTimeline();
			tl.add(root, { opacity: [0, 1], duration: 1000, ease: 'linear' });
			return tl;
		},
		ms,
		ready,
	);
	return <div ref={ref} data-leaf="" />;
}

describe('useAnimeDom (S11:ANM-005)', () => {
	it('builds once ready, seeks per ms before paint and reverts on unmount', () => {
		const r = render(<Leaf ms={500} ready={false} />);
		const leaf = () => r.container.querySelector<HTMLElement>('[data-leaf]')!;
		expect(leaf().style.opacity).toBe('');
		r.rerender(<Leaf ms={500} ready />);
		expect(Number(leaf().style.opacity)).toBeCloseTo(0.5, 3);
		r.rerender(<Leaf ms={250} ready />);
		expect(Number(leaf().style.opacity)).toBeCloseTo(0.25, 3);
		const el = leaf();
		act(() => r.unmount());
		expect(el.style.opacity).toBe('');
	});
});

describe('runtime hardening (wp-m2-anime-core)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('createPausedTimeline drops loop / frameRate / alternate (seek-only driving)', () => {
		const tl = createPausedTimeline({ loop: true, frameRate: 5, alternate: true, loopDelay: 100 } as never);
		const o = { v: 0 };
		tl.add(o, { v: [0, 100], duration: 1000, ease: 'linear' });
		expect(tl.duration).toBe(1000);
		seekCanonical(tl, 250);
		expect(o.v).toBe(25);
		seekCanonical(tl, Number.NaN);
		expect(o.v).toBe(0);
		seekCanonical(tl, 5000);
		expect(o.v).toBe(100);
	});

	it('createPausedTimeline drops the unsafe keys from defaults too (children inherit them)', () => {
		const defaults = {
			frameRate: 1,
			loop: true,
			loopDelay: 100,
			alternate: true,
			autoplay: true,
			composition: 'blend',
			ease: 'linear',
			duration: 1000,
		} as const;
		const tl = createPausedTimeline({ defaults } as never);
		const o = { v: 0 };
		tl.add(o, { v: [0, 100] });
		expect(tl.duration).toBe(1000);
		for (const [ms, v] of [
			[250, 25],
			[750, 75],
			[500, 50],
			[1000, 100],
		] as const) {
			seekCanonical(tl, ms);
			expect(o.v, `${ms} ms`).toBe(v);
		}
		expect(defaults.loop).toBe(true);
	});

	it('resolveEase steps: non-finite counts fall back to 8', () => {
		expect(easeValue(resolveEase('steps', { steps: Number.NaN }), 300)).toBe(0.25);
		expect(easeValue(resolveEase('steps', { steps: 0 }), 600)).toBe(0);
	});

	it('useAnimeValues: StrictMode double renders and a buildKey change give the values of a fresh build', () => {
		let seen: readonly Readonly<{ v: number }>[] = [];
		function Probe({ k, ms }: { k: string; ms: number }) {
			seen = useAnimeValues(
				k,
				() => {
					const o = { v: 0 };
					const timeline = createPausedTimeline();
					timeline.add(o, { v: [0, k === 'a' ? 100 : 10], duration: 1000, ease: 'linear' });
					return { timeline, targets: [o] };
				},
				ms,
			);
			return null;
		}
		const r = render(
			<StrictMode>
				<Probe k="a" ms={500} />
			</StrictMode>,
		);
		expect(seen[0]!.v).toBe(50);
		r.rerender(
			<StrictMode>
				<Probe k="b" ms={500} />
			</StrictMode>,
		);
		expect(seen[0]!.v).toBe(5);
		r.rerender(
			<StrictMode>
				<Probe k="b" ms={1000} />
			</StrictMode>,
		);
		expect(seen[0]!.v).toBe(10);
		r.unmount();
	});

	it('useAnimeDom: StrictMode re-mount rebuilds on pristine targets; build-added attributes are removed', () => {
		function Leaf2({ ms, k }: { ms: number; k: string }) {
			const ref = useRef<HTMLDivElement>(null);
			useAnimeDom(
				ref,
				k,
				(root) => {
					// what createDrawable does outside its tweens: attributes the revert does not remove
					root.setAttribute('pathLength', String(Number(root.getAttribute('pathLength') ?? 0) + 1000));
					const tl = createPausedTimeline();
					tl.add(root, { opacity: [0, 1], duration: 1000, ease: 'linear' });
					return tl;
				},
				ms,
				true,
			);
			return <div ref={ref} data-leaf2="" />;
		}
		const r = render(
			<StrictMode>
				<Leaf2 ms={400} k="a" />
			</StrictMode>,
		);
		const el = r.container.querySelector<HTMLElement>('[data-leaf2]')!;
		expect(el.getAttribute('pathLength')).toBe('1000');
		expect(Number(el.style.opacity)).toBeCloseTo(0.4, 3);
		r.rerender(
			<StrictMode>
				<Leaf2 ms={400} k="b" />
			</StrictMode>,
		);
		expect(el.getAttribute('pathLength')).toBe('1000');
		expect(Number(el.style.opacity)).toBeCloseTo(0.4, 3);
		act(() => r.unmount());
		expect(el.getAttribute('pathLength')).toBeNull();
		expect(el.getAttribute('style')).toBeNull();
	});

	it('segmentText keeps grapheme clusters: combining marks, ZWJ emoji, flags, CRLF, NBSP', () => {
		const text = 'é 👨‍👩‍👧 🇪🇸\r\nä b';
		const s = segmentText(text, 'char');
		expect(s.map((x) => x.text)).toEqual(['é', ' ', '👨‍👩‍👧', ' ', '🇪🇸', '\r\n', 'ä', ' ', 'b']);
		expect(s.map((x) => x.text).join('')).toBe(text);
		expect(s.filter((x) => !x.space).map((x) => x.unitIndex)).toEqual([0, 1, 2, 3, 4]);
	});

	it('segmentText words: CJK/Thai dictionary words, emoji-only words, tabs; text always round-trips', () => {
		const ja = segmentText('今日は良い天気', 'word');
		expect(ja.length).toBeGreaterThan(1);
		expect(ja.map((x) => x.text).join('')).toBe('今日は良い天気');
		const th = segmentText('สวัสดีครับ', 'word');
		expect(th.map((x) => x.text).join('')).toBe('สวัสดีครับ');
		expect(segmentText('a 👋 b\tc', 'word').map((x) => [x.text, x.unitIndex])).toEqual([
			['a', 0],
			[' ', -1],
			['👋', 1],
			[' ', -1],
			['b', 2],
			['\t', -1],
			['c', 3],
		]);
		fc.assert(
			fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), fc.constantFrom('char', 'word'), (t, u) => {
				const segs = segmentText(t, u as 'char' | 'word');
				expect(segs.map((x) => x.text).join('')).toBe(t);
				const units = segs.filter((x) => !x.space);
				expect(units.map((x) => x.unitIndex)).toEqual(units.map((_, i) => i));
				expect(segs.every((x) => x.text.length > 0)).toBe(true);
			}),
			{ seed: 77, numRuns: 300 },
		);
	});

	it('segmentText without Intl.Segmenter approximates clusters', () => {
		vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
		expect(segmentText('é👍🏽🇪🇸 x', 'char').map((x) => x.text)).toEqual(['é', '👍🏽', '🇪🇸', ' ', 'x']);
		expect(segmentText('Hello, world', 'word').map((x) => x.text)).toEqual(['Hello,', ' ', 'world']);
	});

	it('needsShaping: RTL (incl. newer RTL scripts and bidi controls), complex scripts and joiners', () => {
		for (const t of [
			'𞤀𞤣𞤤𞤢𞤥', // Adlam
			'ߒߞߏ', // N'Ko
			'ܫܠܡܐ', // Syriac
			'کتاب‌ها', // Persian with ZWNJ
			'abc‏def', // RLM
			'ក្ញុំ', // Khmer
			'မြန်မာ', // Myanmar
			'བོད', // Tibetan
			'සිංහල', // Sinhala
			'ᮞᮥᮔ᮪ᮓ', // Sundanese
		])
			expect(needsShaping(t), t).toBe(true);
		for (const t of ['한국어', '日本語のテキスト', 'Привет', 'Γειά', '👨‍👩‍👧 family', 'naïve café', ''])
			expect(needsShaping(t), t).toBe(false);
	});

	it('groupLines measures through offset parents (positioned wrappers) in the container space', () => {
		const box = document.createElement('div');
		const place = (el: HTMLElement, top: number, height: number, parent: HTMLElement | null) => {
			Object.defineProperty(el, 'offsetTop', { value: top });
			Object.defineProperty(el, 'offsetHeight', { value: height });
			Object.defineProperty(el, 'offsetParent', { value: parent });
		};
		// the container sits at 500 in page space (its offset parent is the body)
		place(box, 500, 200, null);
		// two per-line mask wrappers (positioned): units are offset relative to them
		const lines = [0, 50].map((top) => {
			const w = document.createElement('div');
			place(w, top, 50, box);
			box.appendChild(w);
			return w;
		});
		for (const w of lines)
			for (let i = 0; i < 2; i++) {
				const s = document.createElement('span');
				s.className = 'u';
				place(s, 5, 40, w);
				w.appendChild(s);
			}
		expect(groupLines(box, '.u')).toEqual([0, 0, 1, 1]);
	});
});
