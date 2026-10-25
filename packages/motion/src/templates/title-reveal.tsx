// title-reveal@1 (S11:ATP-003): characters rise in one by one (stagger order forward / centre / seeded random),
// the subtitle follows and an accent underline draws on; the outro plays the intro backwards. Value engine only:
// the underline's draw-on is a dash length computed from its known width (no DOM geometry).
import {
	estimateTextWidth,
	rgbaCss,
	TITLE_REVEAL_PHASES,
	type TitleRevealParams,
	titleRevealCharPhase,
	titleRevealParams,
} from '@jasper/mg-templates';
import type { CSSProperties } from 'react';
import {
	createPausedTimeline,
	needsShaping,
	segmentText,
	type TextSegment,
	useAnimeValues,
} from '../runtime/index.ts';
import {
	addInOut,
	DesignStage,
	easeOf,
	keyedSegments,
	px,
	staggerRanks,
	TEMPLATE_FONT,
	type TemplateTiming,
	templateFit,
} from './common.tsx';
import type { AnimeTemplateProps } from './types.ts';

type Values = { o: number; y: number; d: number };

type TitleRevealBuildInput = TemplateTiming & {
	units: number;
	order: TitleRevealParams['order'];
	stagger: number;
	ease: string;
	seed: number;
};

/** Units of the title: graphemes, or words for scripts that need shaping (S11:TXA-010 rule). */
function titleSegments(title: string): TextSegment[] {
	return segmentText(title, needsShaping(title) ? 'word' : 'char');
}

/**
 * The timeline: targets `[...units, subtitle, underline]`. Units: `o` opacity, `y` rise in em of the title size;
 * subtitle: `o`, `y` (em of its size); underline: `d` drawn fraction.
 */
function buildTitleReveal(input: TitleRevealBuildInput): {
	timeline: ReturnType<typeof createPausedTimeline>;
	targets: Values[];
} {
	const tl = createPausedTimeline();
	const n = input.units;
	const units: Values[] = Array.from({ length: n }, () => ({ o: 0, y: 0.5, d: 0 }));
	const subtitle: Values = { o: 0, y: 0.6, d: 0 };
	const underline: Values = { o: 1, y: 0, d: 0 };
	// Characters use the first 75 % of the intro: each lasts `charDur`, starts spread over the rest (the phases are
	// shared with the sound-design motion model, @jasper/mg-templates).
	const { dur: charDur, spread } = titleRevealCharPhase(input.stagger);
	const ranks = staggerRanks(n, input.order, input.seed);
	units.forEach((u, i) => {
		const at = n > 1 ? (ranks[i]! / (n - 1)) * spread : 0;
		addInOut(tl, input, u, { o: [0, 1], y: [0.5, 0] }, { at, dur: charDur, ease: input.ease, outEase: 'in' });
	});
	addInOut(
		tl,
		input,
		subtitle,
		{ o: [0, 1], y: [0.6, 0] },
		{ ...TITLE_REVEAL_PHASES.subtitle, ease: input.ease },
	);
	addInOut(tl, input, underline, { d: [0, 1] }, TITLE_REVEAL_PHASES.underline);
	return { timeline: tl, targets: [...units, subtitle, underline] };
}

export function TitleReveal(props: AnimeTemplateProps) {
	const p = titleRevealParams.parse(props.params);
	const fit = templateFit(props.canvas);
	const segments = titleSegments(p.title);
	const units = segments.filter((s) => !s.space).length;
	const timing = { totalMs: props.totalMs, introMs: props.introMs, outroMs: props.outroMs };
	const input: TitleRevealBuildInput = {
		...timing,
		units,
		order: p.order,
		stagger: p.stagger,
		ease: easeOf(p.ease),
		seed: props.seed,
	};
	const values = useAnimeValues(
		`title-reveal@1|${JSON.stringify(input)}`,
		() => buildTitleReveal(input),
		props.timeMs,
	);
	const subtitle = values[units]!;
	const underline = values[units + 1]!;
	const size = p.titleSize;
	const subSize = size * 0.4;
	const margin = fit.designW * 0.08;
	const textW = fit.designW - margin * 2;
	const align = p.alignment;
	const lineW = Math.min(textW, Math.max(size, estimateTextWidth(p.title, size, 700) * 0.6));
	const lineX = align === 'left' ? 0 : align === 'right' ? textW - lineW : (textW - lineW) / 2;
	const block: CSSProperties = {
		position: 'absolute',
		left: margin,
		width: textW,
		top: px(p.y * fit.designH),
		transform: 'translateY(-50%)',
		textAlign: align,
		fontFamily: TEMPLATE_FONT,
	};
	return (
		<DesignStage fit={fit} label="title-reveal@1">
			<div style={block}>
				<div
					data-part="title"
					style={{
						fontSize: size,
						fontWeight: 700,
						lineHeight: 1.1,
						color: rgbaCss(p.titleColor),
						whiteSpace: 'pre-wrap',
					}}
				>
					{keyedSegments(segments).map(({ seg, key }) => {
						if (seg.space) return <span key={key}>{seg.text}</span>;
						const v = values[seg.unitIndex]!;
						return (
							<span
								key={key}
								data-unit={seg.unitIndex}
								style={{
									display: 'inline-block',
									opacity: px(v.o),
									transform: `translateY(${px(v.y)}em)`,
								}}
							>
								{seg.text}
							</span>
						);
					})}
				</div>
				{p.underline ? (
					<svg
						width={textW}
						height={12}
						style={{ display: 'block', overflow: 'visible', margin: `${px(size * 0.12)}px 0` }}
						aria-hidden="true"
					>
						<line
							x1={px(lineX)}
							x2={px(lineX + lineW)}
							y1={6}
							y2={6}
							stroke={rgbaCss(p.accentColor)}
							strokeWidth={6}
							strokeLinecap="butt"
							strokeDasharray={`${px(lineW * underline.d)} ${px(lineW + 1)}`}
							strokeDashoffset={align === 'right' ? px(-lineW * (1 - underline.d)) : 0}
						/>
					</svg>
				) : (
					<div style={{ height: px(size * 0.2) }} />
				)}
				{p.subtitle ? (
					<div
						style={{
							fontSize: subSize,
							fontWeight: 400,
							lineHeight: 1.25,
							color: rgbaCss(p.subtitleColor),
							opacity: px(subtitle.o),
							transform: `translateY(${px(subtitle.y)}em)`,
							whiteSpace: 'pre-wrap',
						}}
					>
						{p.subtitle}
					</div>
				) : null}
			</div>
		</DesignStage>
	);
}
