// @jasper/motion runtime contract (ARCHITECTURE §20.2, S11 §2–§3): paused timelines, the canonical seek,
// deterministic seeds, the value engine and DOM-leaf hooks, text segmentation and line grouping.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render } from '@testing-library/react';
import { engine } from 'animejs/engine';
import fc from 'fast-check';
import { StrictMode, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { valuesAt } from '../src/runtime/hooks.ts';
import {
	ANIMEJS_VERSION,
	createPausedTimeline,
	EASE_NAMES,
	EASES,
	frameToMs,
	groupLines,
	hash32,
	needsShaping,
	resolveEase,
	seededRandom,
	seekCanonical,
	segmentText,
	type Timeline,
	useAnimeDom,
	useAnimeValues,
} from '../src/runtime/index.ts';
import { REST_UNIT_VALUES, TEXT_ANIMATION_IMPLS } from '../src/text/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Two sequential tweens of the same property with a gap (R-ANM §1 minimal repro). */
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
	it('never autoplays and never wakes the engine loop', () => {
		const tl = createPausedTimeline({ autoplay: true } as never);
		tl.add({ v: 0 }, { v: [0, 1], duration: 100 });
		seekCanonical(tl, 50);
		expect(tl.paused).toBe(true);
		expect(engine.reqId).toBe(0);
	});
	it('a plain seek is history-dependent; the canonical seek is not (seek 1000 then 500 = fresh 500)', () => {
		const plain = gapTimeline();
		plain.timeline.seek(1000, true);
		plain.timeline.seek(500, true);
		const fresh = gapTimeline();
		seekCanonical(fresh.timeline, 500);
		expect(fresh.targets[0]).toMatchObject({ x: 100, o: 1 });
		// the hazard the canonical seek exists for
		expect(plain.targets[0]!.x).not.toBe(fresh.targets[0]!.x);
		const visited = gapTimeline();
		seekCanonical(visited.timeline, 1000);
		seekCanonical(visited.timeline, 500);
		expect(visited.targets[0]).toMatchObject(fresh.targets[0]!);
	});
	it('any visit order gives the values of a fresh build (fast-check, fixed seed)', () => {
		const frames = Array.from({ length: 31 }, (_, i) => i);
		const expected = frames.map((f) => {
			const b = gapTimeline();
			seekCanonical(b.timeline, frameToMs(f, 30));
			return { ...b.targets[0]! };
		});
		fc.assert(
			fc.property(fc.shuffledSubarray(frames, { minLength: frames.length }), (order) => {
				const b = gapTimeline();
				for (const f of order) {
					seekCanonical(b.timeline, frameToMs(f, 30));
					expect({ ...b.targets[0]! }).toEqual(expected[f]);
				}
			}),
			{ seed: 4242, numRuns: 50 },
		);
	});
	it('frameToMs = frame * 1000 / fps', () => {
		expect(frameToMs(45, 30)).toBe(1500);
		expect(frameToMs(1, 30000 / 1001)).toBeCloseTo(33.3667, 4);
	});
});

describe('seeds and randomness (S11:ANM-007)', () => {
	it('hash32 is FNV-1a over UTF-8 (parts joined with U+001F)', () => {
		expect(hash32('')).toBe(0x811c9dc5);
		expect(hash32('a')).toBe(0xe40c292c);
		expect(hash32('foobar')).toBe(0xbf9cf968);
		expect(hash32('clp_1', 'text-anim', 'in')).toBe(hash32('clp_1\u001ftext-anim\u001fin'));
		expect(hash32('é')).toBe(hash32('é'));
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

describe('eases', () => {
	it('is a closed list of anime ease names; steps resolves to a function', () => {
		expect(Object.keys(EASES).sort()).toEqual([...EASE_NAMES].sort());
		expect(resolveEase('outBack')).toBe('outBack');
		expect(resolveEase('bogus')).toBe('out');
		const step = resolveEase('steps', { steps: 4 });
		expect(typeof step).toBe('function');
		expect((step as (t: number) => number)(0.3)).toBe(0.25);
		for (const name of EASE_NAMES) {
			const tl = createPausedTimeline();
			const o = { v: 0 };
			tl.add(o, { v: [0, 1], duration: 100, ease: resolveEase(name) });
			seekCanonical(tl, 100);
			expect(o.v, name).toBeCloseTo(1, 6);
		}
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
		let out: unknown;
		const r = render(<Values ms={frameToMs(f, 30)} onValues={(v) => (out = v)} />);
		r.unmount();
		return out as readonly { x: number; o: number }[];
	};
	const expected = frames.map(fresh);
	it('returns frozen copies of the seeked values', () => {
		const v = expected[15]!;
		expect(Object.isFrozen(v)).toBe(true);
		expect(Object.isFrozen(v[0])).toBe(true);
		expect(Object.getOwnPropertySymbols(v[0])).toEqual([]);
		expect(v[0]).toEqual({ x: 100, o: 1 });
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

function Leaf({ ms, ready, builds }: { ms: number; ready: boolean; builds: Timeline[] }) {
	const ref = useRef<HTMLDivElement>(null);
	useAnimeDom(
		ref,
		'leaf',
		(root) => {
			const tl = createPausedTimeline();
			tl.add(root, { opacity: [0, 1], duration: 1000, ease: 'linear' });
			builds.push(tl);
			return tl;
		},
		ms,
		ready,
	);
	return <div ref={ref} data-leaf="" />;
}

describe('useAnimeDom (S11:ANM-005)', () => {
	it('builds once ready, seeks per ms before paint and reverts on unmount', () => {
		const builds: Timeline[] = [];
		const r = render(<Leaf ms={500} ready={false} builds={builds} />);
		const leaf = () => r.container.querySelector<HTMLElement>('[data-leaf]')!;
		expect(builds).toHaveLength(0);
		r.rerender(<Leaf ms={500} ready builds={builds} />);
		expect(builds).toHaveLength(1);
		expect(Number(leaf().style.opacity)).toBeCloseTo(0.5, 3);
		r.rerender(<Leaf ms={250} ready builds={builds} />);
		expect(builds).toHaveLength(1);
		expect(Number(leaf().style.opacity)).toBeCloseTo(0.25, 3);
		const el = leaf();
		act(() => r.unmount());
		expect(el.style.opacity).toBe('');
	});
});

describe('text units (S11:TXA-010/011)', () => {
	const texts = (s: ReturnType<typeof segmentText>) => s.map((x) => x.text);
	it('segments graphemes with whitespace as non-animated segments', () => {
		const s = segmentText('Hi 👋🏽 é!', 'char');
		expect(texts(s)).toEqual(['H', 'i', ' ', '👋🏽', ' ', 'é', '!']);
		expect(s.map((x) => x.unitIndex)).toEqual([0, 1, -1, 2, -1, 3, 4]);
		expect(s.filter((x) => x.space).every((x) => x.unitIndex === -1)).toBe(true);
	});
	it('segments words, keeps punctuation with its word and the text intact', () => {
		const text = 'Hello, (big)  world!\nNew line';
		const s = segmentText(text, 'word');
		expect(texts(s)).toEqual(['Hello,', ' ', '(big)', '  ', 'world!', '\n', 'New', ' ', 'line']);
		expect(s.filter((x) => !x.space).map((x) => x.unitIndex)).toEqual([0, 1, 2, 3, 4]);
		expect(texts(s).join('')).toBe(text);
		expect(texts(segmentText('...', 'word'))).toEqual(['...']);
		expect(segmentText('', 'word')).toEqual([]);
	});
	it('needsShaping detects RTL and complex scripts', () => {
		expect(needsShaping('Hello world')).toBe(false);
		expect(needsShaping('Ñandú 你好')).toBe(false);
		expect(needsShaping('مرحبا')).toBe(true);
		expect(needsShaping('שלום')).toBe(true);
		expect(needsShaping('नमस्ते')).toBe(true);
		expect(needsShaping('สวัสดี')).toBe(true);
	});
	it('groupLines groups by layout boxes (offsetTop/offsetHeight)', () => {
		const box = document.createElement('div');
		const boxes = [
			[0, 100],
			[60, 30],
			[0, 100],
			[100, 100],
			[130, 30],
			[190, 90],
		];
		for (const [top, height] of boxes) {
			const s = document.createElement('span');
			s.className = 'u';
			Object.defineProperty(s, 'offsetTop', { value: top });
			Object.defineProperty(s, 'offsetHeight', { value: height });
			box.appendChild(s);
		}
		box.appendChild(document.createElement('span'));
		expect(groupLines(box, '.u')).toEqual([0, 0, 0, 1, 1, 2]);
	});
});

describe('implementation tables (filled by wave 1)', () => {
	// The tables are filled by wp-m2-text-anim / wp-m2-anime-templates; the determinism suite iterates them.
	it('are keyed id@version and expose the rest values', () => {
		for (const [key, impl] of Object.entries(TEXT_ANIMATION_IMPLS)) {
			expect(key).toMatch(/^[a-z0-9-]+@\d+$/);
			expect(impl.key).toBe(key);
		}
		for (const key of Object.keys(ANIME_TEMPLATE_IMPLS)) expect(key).toMatch(/^[a-z0-9-]+@\d+$/);
		expect(REST_UNIT_VALUES).toEqual({
			opacity: 1,
			x: 0,
			y: 0,
			scale: 1,
			rotate: 0,
			blur: 0,
			letterSpacing: 0,
			reveal: 1,
		});
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

	it('resolveEase steps: non-finite counts fall back to 8', () => {
		const f = resolveEase('steps', { steps: Number.NaN }) as (t: number) => number;
		expect(f(0.3)).toBe(0.25);
		expect((resolveEase('steps', { steps: 0 }) as (t: number) => number)(0.6)).toBe(0);
	});

	it('valuesAt: frozen per-time results are cached and never affected by later seeks', () => {
		const built = gapTimeline();
		const a = valuesAt(built, 500);
		const b = valuesAt(built, 1000);
		expect(a[0]).toEqual({ x: 100, o: 1 });
		expect(b[0]).toEqual({ x: 300, o: 0 });
		expect(valuesAt(built, 500)).toBe(a);
		// the cache does not change what a fresh build gives
		const fresh = gapTimeline();
		seekCanonical(fresh.timeline, 1000);
		expect(b[0]).toEqual({ x: fresh.targets[0]!.x, o: fresh.targets[0]!.o });
	});

	it('values handed to React are rounded to 1e-6: exact rest values, no -0, no exponent notation', () => {
		const build = () => {
			const o = { opacity: 1, y: 0 };
			const timeline = createPausedTimeline();
			timeline.add(o, { opacity: [1, 0], y: [0, 40], duration: 500, ease: 'outBack' }, 0);
			return { timeline, targets: [o] };
		};
		const raw = build();
		seekCanonical(raw.timeline, 0);
		// anime.js leaves float noise on plain objects at the start of an eased tween
		expect(raw.targets[0]!.opacity !== 1 || !Object.is(raw.targets[0]!.y, 0) || raw.targets[0]!.y !== 0).toBe(
			true,
		);
		const [v] = valuesAt(build(), 0);
		expect(v).toEqual({ opacity: 1, y: 0 });
		expect(Object.is(v!.y, 0)).toBe(true);
		for (const ms of [1, 7, 33, 250, 499])
			for (const x of Object.values(valuesAt(build(), ms)[0]!)) expect(String(x)).not.toMatch(/e/);
	});

	it('useAnimeValues: StrictMode double renders and a buildKey change give the values of a fresh build', () => {
		let seen: readonly Readonly<{ v: number }>[] = [];
		let builds = 0;
		function Probe({ k, ms }: { k: string; ms: number }) {
			seen = useAnimeValues(
				k,
				() => {
					builds++;
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
		expect(builds).toBeGreaterThanOrEqual(1);
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
		const builds: number[] = [];
		function Leaf2({ ms, k }: { ms: number; k: string }) {
			const ref = useRef<HTMLDivElement>(null);
			useAnimeDom(
				ref,
				k,
				(root) => {
					// what createDrawable does outside its tweens: attributes the revert does not remove
					builds.push(root.attributes.length);
					root.setAttribute('pathLength', '1000');
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
		// StrictMode mounts, unmounts and re-mounts the effects: two builds, both on the pristine element
		expect(builds.length).toBe(2);
		expect(builds[0]).toBe(builds[1]);
		expect(Number(el.style.opacity)).toBeCloseTo(0.4, 3);
		r.rerender(
			<StrictMode>
				<Leaf2 ms={400} k="b" />
			</StrictMode>,
		);
		expect(builds.length).toBe(3);
		expect(builds[2]).toBe(builds[0]);
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
