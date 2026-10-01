// @jasper/motion runtime contract (ARCHITECTURE §20.2, S11 §2–§3): paused timelines, the canonical seek,
// deterministic seeds, the value engine and DOM-leaf hooks, text segmentation and line grouping.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, render } from '@testing-library/react';
import { engine } from 'animejs/engine';
import fc from 'fast-check';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
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
	it('start empty and expose the rest values', () => {
		expect(TEXT_ANIMATION_IMPLS).toEqual({});
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
