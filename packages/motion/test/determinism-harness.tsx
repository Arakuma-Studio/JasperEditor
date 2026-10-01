// Determinism harness (S11:ANM-013, ANM-008/009, ANM-003/007): every text animator implementation and every anime
// template implementation must give the same output for a frame whatever order the frames are visited in, equal
// to a fresh build (or a fresh mount) per frame. `determinism.test.tsx` runs it over TEXT_ANIMATION_IMPLS and
// ANIME_TEMPLATE_IMPLS, so presets and templates join the suite by being registered; the functions return reports
// (instead of asserting) so the harness itself is tested against deliberately broken fixtures.
import type { AnyAnimeMgTemplate } from '@jasper/mg-templates';
import { type TextAnimationSide, type TextAnimationSpec, toJsonSchema } from '@jasper/project';
import { act, cleanup, render } from '@testing-library/react';
import fc from 'fast-check';
import { type ComponentType, StrictMode } from 'react';
import { roundValue, valuesAt } from '../src/runtime/hooks.ts';
import { frameToMs, hash32, seekCanonical, type Timeline, useAnimeValues } from '../src/runtime/index.ts';
import type { AnimeTemplateProps } from '../src/templates/index.ts';
import {
	REST_UNIT_VALUES,
	type TextAnimationBuildContext,
	type TextAnimationImpl,
	type UnitValues,
} from '../src/text/index.ts';

type Report = { label: string; failures: string[] };

/** Fixed fast-check seeds: every run visits the same shuffled orders (reproducible failures). */
const SHUFFLE_SEEDS = [1, 4242, 90210] as const;
const SHUFFLES_PER_SEED = 4;

type Values = readonly Readonly<Record<string, number>>[];
type Build = () => { timeline: Timeline; targets: Record<string, number>[] };

const sameNumber = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/** First difference between two value lists, or null (numbers compared exactly; ±0 render alike). */
function diffValues(a: Values, b: Values): string | null {
	if (a.length !== b.length) return `${a.length} targets vs ${b.length}`;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
		for (const k of keys) {
			const u = x[k];
			const v = y[k];
			if (typeof u !== 'number' || typeof v !== 'number' || !sameNumber(u, v))
				return `target ${i}.${k}: ${String(u)} vs ${String(v)}`;
		}
	}
	return null;
}

const copy = (targets: Record<string, number>[]): Values =>
	targets.map((t) => {
		const o: Record<string, number> = {};
		for (const k of Object.keys(t)) o[k] = t[k]!;
		return o;
	});

/** Frame visit orders checked against fresh builds: in order, reversed, shuffled and with revisits. */
export function visitOrders(frames: readonly number[]): { name: string; order: number[] }[] {
	const out = [
		{ name: 'in order', order: [...frames] },
		{ name: 'reversed', order: [...frames].reverse() },
	];
	for (const seed of SHUFFLE_SEEDS) {
		const shuffles = fc.sample(fc.shuffledSubarray([...frames], { minLength: frames.length }), {
			seed,
			numRuns: SHUFFLES_PER_SEED,
		});
		for (const [i, order] of shuffles.entries()) out.push({ name: `shuffled (seed ${seed} #${i})`, order });
		const revisits = fc.sample(
			fc.array(fc.constantFrom(...frames), { minLength: frames.length, maxLength: frames.length * 2 }),
			{ seed, numRuns: 1 },
		)[0]!;
		out.push({ name: `revisits (seed ${seed})`, order: revisits });
	}
	return out;
}

/** Counts calls of the wall clock and unseeded randomness while `fn` runs (S11:ANM-003/007). */
function wallClockCalls<T>(fn: () => T, which: ('random' | 'date' | 'perf')[] = ['random', 'date', 'perf']) {
	const calls: string[] = [];
	const restore: (() => void)[] = [];
	const wrap = <O extends object>(obj: O, key: keyof O & string, name: string) => {
		const orig = obj[key] as unknown as (...a: unknown[]) => unknown;
		(obj as Record<string, unknown>)[key] = function (this: unknown, ...a: unknown[]) {
			calls.push(name);
			return orig.apply(this, a);
		};
		restore.push(() => {
			(obj as Record<string, unknown>)[key] = orig;
		});
	};
	if (which.includes('random')) wrap(Math, 'random', 'Math.random');
	if (which.includes('date')) wrap(Date, 'now', 'Date.now');
	if (which.includes('perf') && typeof performance !== 'undefined')
		wrap(performance, 'now', 'performance.now');
	try {
		return { result: fn(), calls };
	} finally {
		for (const r of restore.reverse()) r();
	}
}

/**
 * The value-engine contract of one build function over `frames` (at `fps`): fresh build per frame = one build
 * visited in every order of `visitOrders`; the hook path (`useAnimeValues`) agrees; builds share no targets; no
 * wall clock or unseeded randomness while building or seeking.
 */
function checkValueBuild(label: string, build: Build, frames: readonly number[], fps: number): Report {
	const failures: string[] = [];
	const fresh = new Map<number, Values>();
	const clock = wallClockCalls(() => {
		for (const f of frames) {
			const b = build();
			seekCanonical(b.timeline, frameToMs(f, fps));
			fresh.set(f, copy(b.targets));
		}
	});
	if (clock.calls.length)
		failures.push(`wall clock / unseeded randomness: ${[...new Set(clock.calls)].join(', ')}`);
	const a = build();
	const b = build();
	if (a.targets.some((t) => b.targets.includes(t)))
		failures.push('two builds share target objects (ANM-008)');
	if (a.targets.length === 0) failures.push('the build has no targets');
	if (new Set(a.targets).size !== a.targets.length)
		failures.push('one target object is used twice in a build');
	for (const { name, order } of visitOrders(frames)) {
		const one = build();
		for (const f of order) {
			seekCanonical(one.timeline, frameToMs(f, fps));
			const d = diffValues(copy(one.targets), fresh.get(f)!);
			if (d) {
				failures.push(`${name}: frame ${f} differs from a fresh build (${d})`);
				break;
			}
		}
	}
	// The hook path, mounted once, shuffled.
	let seen: Values = [];
	function Probe({ ms }: { ms: number }) {
		seen = useAnimeValues(label, build, ms);
		return null;
	}
	const order = visitOrders(frames)[2]!.order;
	const r = render(<Probe ms={frameToMs(order[0]!, fps)} />);
	for (const f of order) {
		r.rerender(<Probe ms={frameToMs(f, fps)} />);
		// the hook hands React values rounded to 1e-6
		const want = fresh
			.get(f)!
			.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, roundValue(v)])));
		const d = diffValues(seen, want);
		if (d) {
			failures.push(`useAnimeValues: frame ${f} differs from a fresh build (${d})`);
			break;
		}
	}
	r.unmount();
	return { label, failures };
}

/** Frames `-2 … ceil(durationMs·fps/1000) + 2` (window plus clamped handles). */
function windowFrames(durationMs: number, fps: number): number[] {
	const n = Math.ceil((durationMs * fps) / 1000);
	return Array.from({ length: n + 5 }, (_, i) => i - 2);
}

/** Param variants of a text preset: its defaults, then every enum value of each enum param, one at a time. */
export function paramVariants(spec: TextAnimationSpec | undefined): Record<string, unknown>[] {
	if (!spec) return [{}];
	const out: Record<string, unknown>[] = [{ ...spec.defaults }];
	let props: Record<string, { enum?: unknown[] }> = {};
	try {
		props = (toJsonSchema(spec.paramsSchema as never) as { properties?: typeof props }).properties ?? {};
	} catch {
		props = {};
	}
	for (const [key, p] of Object.entries(props))
		for (const v of p.enum ?? []) {
			if (v === spec.defaults[key]) continue;
			const variant = { ...spec.defaults, [key]: v };
			if (spec.paramsSchema.safeParse(variant).success) out.push(variant);
		}
	return out;
}

const UNIT_KEYS = Object.keys(REST_UNIT_VALUES).sort();

type TextCase = { label: string; ctx: TextAnimationBuildContext; fps: number };

/** [fps, window frames]: 30 fps and an odd rate whose frame times are not whole milliseconds. */
const RATES: readonly (readonly [number, number])[] = [
	[30, 18],
	[24, 13],
];

/** The contexts a text implementation is checked with: sides × unit counts × param variants × two frame rates. */
function textAnimationCases(impl: TextAnimationImpl, spec?: TextAnimationSpec): TextCase[] {
	const sides: readonly TextAnimationSide[] = spec?.phases ?? ['in', 'out'];
	const out: TextCase[] = [];
	const variants = paramVariants(spec);
	for (const side of sides)
		for (const [vi, params] of variants.entries())
			for (const units of vi === 0 ? [1, 5, 37] : [7])
				for (const [fps, frames] of vi === 0 && units === 5 ? RATES : RATES.slice(0, 1))
					out.push({
						label: `${impl.key} ${side} units=${units} fps=${fps} params=${JSON.stringify(params)}`,
						fps,
						ctx: {
							units,
							// six units per line (line units and line-aware presets)
							lineOf: Array.from({ length: units }, (_, i) => Math.floor(i / 6)),
							side,
							durationMs: frameToMs(frames, fps),
							params,
							seed: hash32('clp_DETERMINISM00000', 'text-anim', side),
							box: { width: 800, height: 240 },
						},
					});
	return out;
}

/**
 * One text implementation (S11:ANM-013 + the build contract of ARCHITECTURE §20.2): one target per unit with
 * exactly the UnitValues keys, finite numbers; timeline `durationMs` long; order independence (checkValueBuild);
 * rest state outside the window (ANM-009: `in` ends at rest, `out` starts at rest).
 */
export function checkTextAnimation(impl: TextAnimationImpl, spec?: TextAnimationSpec): Report[] {
	return textAnimationCases(impl, spec).map(({ label, ctx, fps }) => {
		const failures: string[] = [];
		const build = () => impl.build(ctx) as { timeline: Timeline; targets: Record<string, number>[] };
		let probe: ReturnType<Build>;
		try {
			probe = build();
		} catch (e) {
			return { label, failures: [`build threw: ${(e as Error).message}`] };
		}
		if (probe.targets.length !== ctx.units)
			failures.push(`${probe.targets.length} targets for ${ctx.units} units`);
		if (!(Number.isFinite(probe.timeline.duration) && probe.timeline.duration <= ctx.durationMs + 0.5))
			failures.push(`timeline lasts ${probe.timeline.duration} ms, window is ${ctx.durationMs} ms`);
		const frames = windowFrames(ctx.durationMs, fps);
		for (const f of frames) {
			seekCanonical(probe.timeline, frameToMs(f, fps));
			for (const [i, t] of probe.targets.entries()) {
				const keys = Object.keys(t).sort();
				if (keys.join() !== UNIT_KEYS.join()) {
					failures.push(`target ${i} keys ${keys.join()} ≠ UnitValues`);
					break;
				}
				const bad = keys.find((k) => !Number.isFinite(t[k]));
				if (bad) failures.push(`frame ${f}: target ${i}.${bad} = ${t[bad]}`);
			}
			if (failures.length) break;
		}
		// What React renders (useAnimeValues, rounded) equals the un-animated layer exactly. Both sides rest at the end
		// of their timeline: the layer seeks an Out window mirrored (its last frame is the timeline's start,
		// `activeTextAnimation` in @jasper/motion/text), so an Out timeline also ends at rest.
		const restAt = ctx.durationMs;
		for (const [i, t] of valuesAt(build(), restAt).entries())
			for (const k of UNIT_KEYS) {
				const want = REST_UNIT_VALUES[k as keyof UnitValues];
				if (t[k] !== want) {
					failures.push(`${ctx.side} at ${restAt} ms: target ${i}.${k} = ${t[k]}, rest is ${want} (ANM-009)`);
					break;
				}
			}
		failures.push(...checkValueBuild(label, build, frames, fps).failures);
		if (impl.caretVisible) failures.push(...checkCaret(impl, ctx, build, frames, fps));
		return { label, failures };
	});
}

/**
 * A caret that blinks (`caretVisible`) is part of the frame's output: lit/dark at every frame of the window equals
 * the fresh-build answer whatever the visit order, without the wall clock (S11:ANM-003).
 */
function checkCaret(
	impl: TextAnimationImpl,
	ctx: TextAnimationBuildContext,
	build: Build,
	frames: readonly number[],
	fps: number,
): string[] {
	const caretOf = (b: ReturnType<Build>, f: number) => {
		const ms = frameToMs(f, fps);
		seekCanonical(b.timeline, ms);
		const shown = b.targets.filter((t) => (t.reveal ?? 1) >= 1).length;
		return impl.caretVisible!({ ...ctx, ms, durationMs: ctx.durationMs, fps, shown });
	};
	const inWindow = frames.filter((f) => f >= 0 && frameToMs(f, fps) < ctx.durationMs);
	const failures: string[] = [];
	const fresh = new Map<number, boolean>();
	const clock = wallClockCalls(() => {
		for (const f of inWindow) fresh.set(f, caretOf(build(), f));
	});
	if (clock.calls.length) failures.push(`caret: wall clock / unseeded randomness: ${clock.calls.join(', ')}`);
	for (const { name, order } of visitOrders(inWindow)) {
		const one = build();
		const f = order.find((f) => caretOf(one, f) !== fresh.get(f));
		if (f !== undefined) {
			failures.push(`caret ${name}: frame ${f} differs from a fresh build`);
			break;
		}
	}
	return failures;
}

/**
 * The markup of `el` with every inline style's declarations sorted: React appends a property that appears later
 * (e.g. a `filter` once blur > 0) after the existing ones, a fresh mount writes them in object order — the same
 * style, serialised differently.
 */
function canonicalHtml(el: HTMLElement): string {
	const copy = el.cloneNode(true) as HTMLElement;
	for (const node of [copy, ...copy.querySelectorAll<HTMLElement>('[style]')]) {
		const style = node.getAttribute('style');
		if (style === null) continue;
		const decls = style
			.split(';')
			.map((d) => d.trim())
			.filter(Boolean)
			.sort();
		node.setAttribute('style', decls.join('; '));
	}
	return copy.innerHTML;
}

type TemplateCase = { label: string; props: (frame: number) => AnimeTemplateProps; frames: number[] };

/** Props of a template at a content frame: intro + 12 hold frames + outro at 30 fps, the first canvas. */
function templateCase(key: string, def: AnyAnimeMgTemplate | undefined): TemplateCase {
	const fps = 30;
	const intro = def?.introFrames ?? 15;
	const outro = def?.outroFrames ?? 15;
	const total = intro + 12 + outro;
	const canvas = def?.canvases[0] ?? { width: 1920, height: 1080 };
	const frames = Array.from({ length: total + 2 }, (_, i) => i - 1);
	return {
		label: `${key} ${canvas.width}x${canvas.height}`,
		frames,
		props: (frame) => ({
			params: { ...(def?.defaults ?? {}) },
			timeMs: frameToMs(frame, fps),
			totalMs: frameToMs(total, fps),
			introMs: frameToMs(intro, fps),
			outroMs: frameToMs(outro, fps),
			canvas,
			seed: hash32('clp_DETERMINISM00000', 'template'),
		}),
	};
}

/**
 * One anime template implementation (S11:ANM-013): the DOM it renders for a frame (after layout effects, i.e.
 * DOM-leaf seeks) is the same mounted once and visited in every order as mounted fresh for that frame, also under
 * StrictMode; rendering never calls Math.random.
 */
export function checkTemplate(
	key: string,
	Component: ComponentType<AnimeTemplateProps>,
	def: AnyAnimeMgTemplate | undefined,
): Report {
	const { label, props, frames } = templateCase(key, def);
	const failures: string[] = [];
	const html = canonicalHtml;
	const fresh = new Map<number, string>();
	try {
		const clock = wallClockCalls(() => {
			for (const f of frames) {
				const r = render(<Component {...props(f)} />);
				fresh.set(f, html(r.container));
				act(() => r.unmount());
			}
		}, ['random']);
		if (clock.calls.length) failures.push('Math.random while rendering (ANM-007)');
		for (const { name, order } of visitOrders(frames)) {
			const r = render(<Component {...props(order[0]!)} />);
			for (const f of order) {
				r.rerender(<Component {...props(f)} />);
				if (html(r.container) !== fresh.get(f)) {
					failures.push(`${name}: frame ${f} differs from a fresh mount`);
					break;
				}
			}
			act(() => r.unmount());
		}
		const mid = frames[Math.floor(frames.length / 2)]!;
		const strict = render(
			<StrictMode>
				<Component {...props(mid)} />
			</StrictMode>,
		);
		if (html(strict.container) !== fresh.get(mid)) failures.push(`StrictMode: frame ${mid} differs`);
		act(() => strict.unmount());
	} catch (e) {
		failures.push(`render threw: ${(e as Error).message}`);
	} finally {
		cleanup();
	}
	return { label, failures };
}
