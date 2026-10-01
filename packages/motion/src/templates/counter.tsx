// counter@1 (S11:ATP-003): the number counts from `from` to `to` over `countSeconds` (from content 0, never into
// the outro), formatted by `formatCounterValue` (locale-independent) in tabular numerals; it fades/rises in with
// its label and the outro reverses that. The timeline animates a progress 0…1; the shown value is
// `from + (to − from)·progress`, so keyframed `from`/`to` change the number without rebuilding the timeline.
import { type CounterParams, counterParams, formatCounterValue, rgbaCss } from '@jasper/mg-templates';
import { useAnimeValues } from '../runtime/index.ts';
import {
	addInOut,
	DesignStage,
	easeOf,
	px,
	TEMPLATE_FONT,
	type TemplateTiming,
	templateFit,
	templateTimeline,
} from './common.tsx';
import type { AnimeTemplateProps } from './types.ts';

/** `p` count progress, `o` opacity, `y` rise (em). */
type Values = { p: number; o: number; y: number };

export type CounterBuildInput = TemplateTiming & { countMs: number; ease: string };

/** Count length: `countSeconds`, at most up to the outro (and at least one frame's worth of ms). */
export function counterCountMs(p: Pick<CounterParams, 'countSeconds'>, t: TemplateTiming): number {
	return Math.max(1, Math.min(p.countSeconds * 1000, t.totalMs - t.outroMs));
}

/** Targets `[number, label]`. */
export function buildCounter(input: CounterBuildInput): {
	timeline: ReturnType<typeof templateTimeline>;
	targets: Values[];
} {
	const tl = templateTimeline();
	const num: Values = { p: 0, o: 0, y: 0.25 };
	const label: Values = { p: 0, o: 0, y: 0.4 };
	tl.add(num, { p: [0, 1], duration: input.countMs, ease: input.ease }, 0);
	addInOut(tl, input, num, { o: [0, 1], y: [0.25, 0] }, { at: 0, dur: 0.3, ease: 'out' });
	addInOut(tl, input, label, { o: [0, 1], y: [0.4, 0] }, { at: 0.15, dur: 0.35, ease: 'out' });
	return { timeline: tl, targets: [num, label] };
}

export function Counter(props: AnimeTemplateProps) {
	const p = counterParams.parse(props.params);
	const fit = templateFit(props.canvas);
	const timing = { totalMs: props.totalMs, introMs: props.introMs, outroMs: props.outroMs };
	const input: CounterBuildInput = { ...timing, countMs: counterCountMs(p, timing), ease: easeOf(p.ease) };
	const [num, label] = useAnimeValues(
		`counter@1|${JSON.stringify(input)}`,
		() => buildCounter(input),
		props.timeMs,
	) as readonly Readonly<Values>[];
	const value = p.from + (p.to - p.from) * num!.p;
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
					data-part="number"
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
						data-part="label"
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
