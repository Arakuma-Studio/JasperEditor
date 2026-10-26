// callout@1 (S11:ATP-003): the target dot pops in with a pulse ring, the leader line draws on and the label box
// appears at the line's end — or, with `motionPath`, travels along the line while it draws. The leader line is the
// one SVG leaf driven by anime.js on the DOM (`createDrawable`, through `useAnimeDom`, S11:ANM-005); everything else
// is the value engine. The motion path is evaluated on the line's own geometry (a straight segment or a quadratic
// curve, arc-length parametrised in JS), so the box follows the drawn line exactly without DOM measurement.
import {
	CALLOUT_PHASES,
	calloutGeometry,
	calloutParams,
	estimateTextWidth,
	rgbaCss,
} from '@jasper/mg-templates';
import { createDrawable } from 'animejs/svg';
import { useRef } from 'react';
import { createPausedTimeline, useAnimeDom, useAnimeValues } from '../runtime/index.ts';
import {
	addInOut,
	DesignStage,
	easeOf,
	type Phase,
	phaseTimes,
	px,
	TEMPLATE_FONT,
	type TemplateTiming,
	templateFit,
} from './common.tsx';
import { editableParamProps } from './editable.ts';
import type { AnimeTemplateProps } from './types.ts';

/** `s` scale, `o` opacity, `m` motion-path progress 0…1 (label). */
type Values = { s: number; o: number; m: number };

// The phases and the leader line's geometry are shared with the sound-design motion model (@jasper/mg-templates).
const CALLOUT_PULSE_PHASE: Phase = CALLOUT_PHASES.pulse;
const CALLOUT_LINE_PHASE: Phase = CALLOUT_PHASES.line;

type CalloutBuildInput = TemplateTiming & { ease: string; motionPath: boolean };

/** Value targets `[dot, ring, label]`. */
function buildCallout(input: CalloutBuildInput): {
	timeline: ReturnType<typeof createPausedTimeline>;
	targets: Values[];
} {
	const tl = createPausedTimeline();
	const dot: Values = { s: 0, o: 1, m: 0 };
	const ring: Values = { s: 1, o: 0, m: 0 };
	const label: Values = { s: 0.85, o: 0, m: input.motionPath ? 0 : 1 };
	addInOut(tl, input, dot, { s: [0, 1] }, CALLOUT_PHASES.dot);
	// The pulse ring is intro-only (it has already faded when the outro starts). Its opacity is keyed from content
	// 0 (0 → 0.8 while the dot pops, then 0.8 → 0 while the ring grows), so seeks before the pulse — the first
	// frames and head handles — show no ring (a tween starting later would hold its from-value 0.8 there).
	const pulse = phaseTimes(input, CALLOUT_PULSE_PHASE);
	const fadeIn = Math.max(1, pulse.introStart);
	tl.add(
		ring,
		{
			o: [
				{ from: 0, to: 0.8, duration: fadeIn, ease: 'out' },
				{ to: 0, duration: pulse.introDur, ease: 'out' },
			],
		},
		0,
	);
	addInOut(tl, input, ring, { s: [1, 2.6] }, CALLOUT_PULSE_PHASE, { outro: false });
	if (input.motionPath) {
		// Intro only: in the outro the box fades out where it stands while the line undraws.
		addInOut(tl, input, label, { m: [0, 1] }, { ...CALLOUT_LINE_PHASE, ease: input.ease }, { outro: false });
		addInOut(tl, input, label, { o: [0, 1], s: [0.85, 1] }, CALLOUT_PHASES.labelWithPath);
	} else {
		addInOut(tl, input, label, { o: [0, 1], s: [0.85, 1] }, CALLOUT_PHASES.label);
	}
	return { timeline: tl, targets: [dot, ring, label] };
}

/**
 * The leader line leaf: `createDrawable` on the ref-owned `<path>` (React renders it without children and never
 * sets the dash attributes anime.js writes), drawn on in the line phase and undrawn (from its start) in the outro.
 */
function buildCalloutLine(el: SVGPathElement, input: CalloutBuildInput) {
	const [line] = createDrawable(el);
	if (!line) return null;
	const tl = createPausedTimeline();
	const pt = phaseTimes(input, CALLOUT_LINE_PHASE);
	tl.add(line, { draw: ['0 0', '0 1'], duration: pt.introDur, ease: input.ease }, pt.introStart);
	if (pt.outroStart !== null)
		tl.add(line, { draw: ['0 1', '1 1'], duration: pt.outroDur, ease: 'inOut' }, pt.outroStart);
	return tl;
}

export function Callout(props: AnimeTemplateProps) {
	const p = calloutParams.parse(props.params);
	const fit = templateFit(props.canvas);
	const input: CalloutBuildInput = {
		totalMs: props.totalMs,
		introMs: props.introMs,
		outroMs: props.outroMs,
		ease: easeOf(p.ease),
		motionPath: p.motionPath,
	};
	const key = `callout@1|${JSON.stringify(input)}`;
	const [dot, ring, label] = useAnimeValues(key, () => buildCallout(input), props.timeMs);
	const geo = calloutGeometry(p, { w: fit.designW, h: fit.designH }, px);
	const pathRef = useRef<SVGPathElement>(null);
	// The geometry is part of the key: a new `d` rebuilds the drawable (keyframed targets rebuild per frame).
	useAnimeDom(pathRef, `${key}|${geo.d}`, (el) => buildCalloutLine(el, input), props.timeMs, true);
	const anchor = geo.pointAt(label!.m);
	const padX = p.textSize * 0.55;
	const boxW = estimateTextWidth(p.label, p.textSize, 600) + padX * 2;
	const boxH = p.textSize * 1.6;
	// The box sits beside its anchor, on the side away from the target.
	const leftward = geo.b.x < geo.a.x;
	const boxX = leftward ? anchor.x - boxW - p.lineWidth : anchor.x + p.lineWidth;
	const dotR = p.dotSize / 2;
	return (
		<DesignStage fit={fit} label="callout@1">
			<svg
				width={fit.designW}
				height={fit.designH}
				style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
				aria-hidden="true"
			>
				<path
					ref={pathRef}
					d={geo.d}
					fill="none"
					stroke={rgbaCss(p.lineColor)}
					strokeWidth={p.lineWidth}
					strokeLinecap="round"
				/>
				<circle
					cx={px(geo.a.x)}
					cy={px(geo.a.y)}
					r={px(dotR * ring!.s)}
					fill="none"
					stroke={rgbaCss(p.dotColor)}
					strokeWidth={Math.max(1, p.dotSize / 6)}
					opacity={px(ring!.o)}
				/>
				<circle
					cx={px(geo.a.x)}
					cy={px(geo.a.y)}
					r={px(Math.max(0, dotR * dot!.s))}
					fill={rgbaCss(p.dotColor)}
				/>
			</svg>
			<div
				{...editableParamProps('label')}
				style={{
					position: 'absolute',
					left: px(boxX),
					top: px(anchor.y - boxH / 2),
					width: px(boxW),
					height: px(boxH),
					borderRadius: px(boxH * 0.18),
					background: rgbaCss(p.boxColor),
					color: rgbaCss(p.textColor),
					fontFamily: TEMPLATE_FONT,
					fontSize: p.textSize,
					fontWeight: 600,
					lineHeight: `${px(boxH)}px`,
					textAlign: 'center',
					whiteSpace: 'pre',
					opacity: px(label!.o),
					transform: `scale(${px(label!.s)})`,
					transformOrigin: leftward ? '100% 50%' : '0% 50%',
				}}
			>
				{p.label}
			</div>
		</DesignStage>
	);
}
