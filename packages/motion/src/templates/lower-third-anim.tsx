// lower-third-anim@1 (S11:ATP-003): the accent bar grows, the panel wipes open, the name and role words stagger in;
// the outro reverses the intro (role words leave first, the panel wipes shut, the bar shrinks). Value engine only;
// the panel width comes from the deterministic text-width estimate shared with the fframes templates.
import {
	estimateTextWidth,
	LOWER_THIRD_ANIM_BAR_W,
	LOWER_THIRD_ANIM_PHASES,
	type LowerThirdAnimParams,
	lowerThirdAnimParams,
	lowerThirdWordPhase,
	rgbaCss,
} from '@jasper/mg-templates';
import type { CSSProperties } from 'react';
import { createPausedTimeline, segmentText, type TextSegment, useAnimeValues } from '../runtime/index.ts';
import {
	addInOut,
	DesignStage,
	easeOf,
	keyedSegments,
	px,
	TEMPLATE_FONT,
	type TemplateTiming,
	templateFit,
} from './common.tsx';
import { editableParamProps } from './editable.ts';
import type { AnimeTemplateProps } from './types.ts';

/** `s` bar scale, `w` panel reveal 0…1, `o`/`x` word opacity and offset (px, towards the bar). */
type Values = { s: number; w: number; o: number; x: number };

export type LowerThirdAnimBuildInput = TemplateTiming & {
	nameWords: number;
	roleWords: number;
	ease: string;
};

/** Targets `[bar, panel, ...nameWords, ...roleWords]`. */
export function buildLowerThirdAnim(input: LowerThirdAnimBuildInput): {
	timeline: ReturnType<typeof createPausedTimeline>;
	targets: Values[];
} {
	const tl = createPausedTimeline();
	const bar: Values = { s: 0, w: 0, o: 1, x: 0 };
	const panel: Values = { s: 1, w: 0, o: 1, x: 0 };
	const word = (): Values => ({ s: 1, w: 1, o: 0, x: -24 });
	const names = Array.from({ length: input.nameWords }, word);
	const roles = Array.from({ length: input.roleWords }, word);
	// the phases are shared with the sound-design motion model (@jasper/mg-templates)
	const P = LOWER_THIRD_ANIM_PHASES;
	addInOut(tl, input, bar, { s: [0, 1] }, P.bar);
	addInOut(tl, input, panel, { w: [0, 1] }, { ...P.panel, ease: input.ease });
	const words = (list: Values[], from: number, to: number) => {
		const n = list.length;
		list.forEach((w, i) => {
			const { at, dur } = lowerThirdWordPhase(i, n, from, to);
			addInOut(tl, input, w, { o: [0, 1], x: [-24, 0] }, { at, dur, ease: input.ease, outEase: 'in' });
		});
	};
	words(names, P.names.from, P.names.to);
	words(roles, P.roles.from, P.roles.to);
	return { timeline: tl, targets: [bar, panel, ...names, ...roles] };
}

const BAR_W = LOWER_THIRD_ANIM_BAR_W;

function Words({
	segments,
	values,
	offset,
	sign,
	style,
	param,
}: {
	segments: TextSegment[];
	values: readonly Readonly<Values>[];
	offset: number;
	sign: number;
	style: CSSProperties;
	/** The string param drawn (Program-monitor editing). */
	param: string;
}) {
	return (
		<div {...editableParamProps(param)} style={{ ...style, whiteSpace: 'pre' }}>
			{keyedSegments(segments).map(({ seg, key }) => {
				if (seg.space) return <span key={key}>{seg.text}</span>;
				const v = values[offset + seg.unitIndex]!;
				return (
					<span
						key={key}
						data-unit={seg.unitIndex}
						style={{
							display: 'inline-block',
							opacity: px(v.o),
							transform: `translateX(${px(sign * v.x)}px)`,
						}}
					>
						{seg.text}
					</span>
				);
			})}
		</div>
	);
}

export function LowerThirdAnim(props: AnimeTemplateProps) {
	const p: LowerThirdAnimParams = lowerThirdAnimParams.parse(props.params);
	const fit = templateFit(props.canvas);
	const nameSegs = segmentText(p.name, 'word');
	const roleSegs = segmentText(p.role, 'word');
	const nameWords = nameSegs.filter((s) => !s.space).length;
	const roleWords = roleSegs.filter((s) => !s.space).length;
	const input: LowerThirdAnimBuildInput = {
		totalMs: props.totalMs,
		introMs: props.introMs,
		outroMs: props.outroMs,
		nameWords,
		roleWords,
		ease: easeOf(p.ease),
	};
	const values = useAnimeValues(
		`lower-third-anim@1|${JSON.stringify(input)}`,
		() => buildLowerThirdAnim(input),
		props.timeMs,
	);
	const bar = values[0]!;
	const panel = values[1]!;
	const nameSize = p.nameSize;
	const roleSize = nameSize * 0.55;
	const padX = nameSize * 0.6;
	const padY = nameSize * 0.32;
	const textW = Math.max(
		estimateTextWidth(p.name, nameSize, 700),
		p.role ? estimateTextWidth(p.role, roleSize, 400) : 0,
	);
	const panelW = textW + padX * 2;
	const panelH = nameSize * 1.2 + (p.role ? roleSize * 1.35 : 0) + padY * 2;
	const right = p.side === 'right';
	const edge = p.x * fit.designW;
	const left = right ? fit.designW - edge - BAR_W - panelW : edge;
	const top = p.y * fit.designH;
	const reveal = Math.min(1, Math.max(0, panel.w));
	const cut = px((1 - reveal) * 100);
	const sign = right ? -1 : 1;
	return (
		<DesignStage fit={fit} label="lower-third-anim@1">
			<div
				style={{
					position: 'absolute',
					left: px(right ? left + panelW : left),
					top: px(top),
					width: BAR_W,
					height: px(panelH),
					background: rgbaCss(p.barColor),
					transformOrigin: '50% 100%',
					transform: `scaleY(${px(bar.s)})`,
				}}
			/>
			<div
				style={{
					position: 'absolute',
					left: px(right ? left : left + BAR_W),
					top: px(top),
					width: px(panelW),
					height: px(panelH),
					background: rgbaCss(p.panelColor),
					clipPath: right ? `inset(0 0 0 ${cut}%)` : `inset(0 ${cut}% 0 0)`,
				}}
			/>
			<div
				style={{
					position: 'absolute',
					left: px((right ? left : left + BAR_W) + padX),
					top: px(top + padY),
					width: px(textW),
					fontFamily: TEMPLATE_FONT,
					textAlign: right ? 'right' : 'left',
				}}
			>
				<Words
					segments={nameSegs}
					values={values}
					offset={2}
					sign={sign}
					param="name"
					style={{ fontSize: nameSize, fontWeight: 700, lineHeight: 1.2, color: rgbaCss(p.nameColor) }}
				/>
				{p.role ? (
					<Words
						segments={roleSegs}
						values={values}
						offset={2 + nameWords}
						sign={sign}
						param="role"
						style={{ fontSize: roleSize, fontWeight: 400, lineHeight: 1.35, color: rgbaCss(p.roleColor) }}
					/>
				) : null}
			</div>
		</DesignStage>
	);
}
