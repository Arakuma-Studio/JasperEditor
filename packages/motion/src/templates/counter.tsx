// counter@1 (S11:ATP-003): the number counts from `from` to `to` over `countSeconds` (from content 0, never into
// the outro), formatted by `formatCounterValue` (locale-independent) in tabular numerals; it fades/rises in with
// its label and the outro reverses that. A timeline of its own animates the count progress 0…1; the shown value is
// `from + (to − from)·progress`, so keyframed `from`/`to` change the number without rebuilding the timeline. The
// progress is read un-rounded right after its canonical seek (`counterProgressAt`): the 1e-6 rounding of
// `useAnimeValues` would move a 0 → 25,000,000 count in steps of 25.
import { type CounterParams, counterParams, formatCounterValue, rgbaCss } from '@jasper/mg-templates';
import { useMemo } from 'react';
import { createPausedTimeline, roundValue, seekCanonical, useAnimeValues } from '../runtime/index.ts';
import {
	addInOut,
	DesignStage,
	easeOf,
	px,
	TEMPLATE_FONT,
	type TemplateTiming,
	templateFit,
} from './common.tsx';
import type { AnimeTemplateProps } from './types.ts';

/** `o` opacity, `y` rise (em). */
type Values = { o: number; y: number };

export type CounterBuildInput = TemplateTiming & { countMs: number; ease: string };

/** Count length: `countSeconds`, at most up to the outro (and at least one frame's worth of ms). */
export function counterCountMs(p: Pick<CounterParams, 'countSeconds'>, t: TemplateTiming): number {
	return Math.max(1, Math.min(p.countSeconds * 1000, t.totalMs - t.outroMs));
}

/** Targets `[number, label]` (their fades; the count has its own timeline, `buildCounterCount`). */
export function buildCounter(input: CounterBuildInput): {
	timeline: ReturnType<typeof createPausedTimeline>;
	targets: Values[];
} {
	const tl = createPausedTimeline();
	const num: Values = { o: 0, y: 0.25 };
	const label: Values = { o: 0, y: 0.4 };
	addInOut(tl, input, num, { o: [0, 1], y: [0.25, 0] }, { at: 0, dur: 0.3, ease: 'out' });
	addInOut(tl, input, label, { o: [0, 1], y: [0.4, 0] }, { at: 0.15, dur: 0.35, ease: 'out' });
	return { timeline: tl, targets: [num, label] };
}

/** The count: progress `p` 0 → 1 from content 0 over `countMs`. */
export function buildCounterCount(input: Pick<CounterBuildInput, 'countMs' | 'ease'>): {
	timeline: ReturnType<typeof createPausedTimeline>;
	target: { p: number };
} {
	const tl = createPausedTimeline();
	const target = { p: 0 };
	tl.add(target, { p: [0, 1], duration: input.countMs, ease: input.ease }, 0);
	return { timeline: tl, target };
}

/**
 * Count progress at `ms`, un-rounded: read right after the canonical seek (a pure function of `ms`, like
 * `useAnimeValues`). Values that round to 0 or 1 (the rest states and float noise around them) are exactly 0 / 1,
 * so the first and last counts show `from` and `to` exactly.
 */
export function counterProgressAt(count: ReturnType<typeof buildCounterCount>, ms: number): number {
	seekCanonical(count.timeline, ms);
	const p = count.target.p;
	const r = roundValue(p);
	return r === 0 || r === 1 ? r : p;
}

/** The shown number at progress `p` (exactly `from` / `to` at the ends). */
export function counterValue(p: Pick<CounterParams, 'from' | 'to'>, progress: number): number {
	if (progress === 0) return p.from;
	if (progress === 1) return p.to;
	return p.from + (p.to - p.from) * progress;
}

export function Counter(props: AnimeTemplateProps) {
	const p = counterParams.parse(props.params);
	const fit = templateFit(props.canvas);
	const timing = { totalMs: props.totalMs, introMs: props.introMs, outroMs: props.outroMs };
	const input: CounterBuildInput = { ...timing, countMs: counterCountMs(p, timing), ease: easeOf(p.ease) };
	const buildKey = `counter@1|${JSON.stringify(input)}`;
	const [num, label] = useAnimeValues(buildKey, () => buildCounter(input), props.timeMs);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by buildKey (it holds countMs and ease)
	const count = useMemo(() => buildCounterCount(input), [buildKey]);
	const value = counterValue(p, counterProgressAt(count, props.timeMs));
	const labelSize = p.size * 0.3;
	return (
		<DesignStage fit={fit} label="counter@1">
			<div
				style={{
					position: 'absolute',
					left: 0,
					width: fit.designW,
					top: fit.designH / 2,
					transform: 'translateY(-50%)',
					textAlign: 'center',
					fontFamily: TEMPLATE_FONT,
				}}
			>
				<div
					style={{
						fontSize: p.size,
						fontWeight: 700,
						lineHeight: 1.05,
						color: rgbaCss(p.numberColor),
						fontVariantNumeric: 'tabular-nums',
						fontFeatureSettings: '"tnum" 1',
						whiteSpace: 'pre',
						opacity: px(num!.o),
						transform: `translateY(${px(num!.y)}em)`,
					}}
				>
					{formatCounterValue(value, p)}
				</div>
				{p.label ? (
					<div
						style={{
							fontSize: labelSize,
							fontWeight: 500,
							lineHeight: 1.3,
							letterSpacing: '0.04em',
							color: rgbaCss(p.labelColor),
							whiteSpace: 'pre',
							opacity: px(label!.o),
							transform: `translateY(${px(label!.y)}em)`,
						}}
					>
						{p.label}
					</div>
				) : null}
			</div>
		</DesignStage>
	);
}
