// Fixture implementations for the determinism suite (S11:ANM-013) and the render parity e2e (ANM-014): a text
// animator and an anime template written against the public runtime like the shipped ones (not shipped
// themselves), and a scene combining an animated title, a template with an SVG DOM leaf and an animated shape.
import { createDrawable } from 'animejs/svg';
import { useRef } from 'react';
import {
	createPausedTimeline,
	frameToMs,
	hash32,
	resolveEase,
	seededRandom,
	segmentText,
	useAnimeDom,
	useAnimeValues,
} from '../src/runtime/index.ts';
import type { AnimeTemplateProps } from '../src/templates/index.ts';
import {
	REST_UNIT_VALUES,
	type TextAnimationBuildContext,
	type TextAnimationImpl,
	type UnitValues,
} from '../src/text/index.ts';

const HIDDEN: UnitValues = {
	opacity: 0,
	x: 12,
	y: 40,
	scale: 0.6,
	rotate: -15,
	blur: 6,
	letterSpacing: 0.2,
	reveal: 0,
};
const KEYS = Object.keys(REST_UNIT_VALUES) as (keyof UnitValues)[];

/** A staggered rise in a seeded random order with an overshooting ease (every UnitValues property animated). */
export function riseImpl(
	key = 'fixture-rise@1',
	mutate?: (targets: UnitValues[]) => UnitValues[],
): TextAnimationImpl {
	return {
		key,
		unitDefault: 'char',
		build({ units, side, durationMs, params, seed }) {
			const targets = Array.from({ length: units }, () => ({ ...REST_UNIT_VALUES }));
			const rand = seededRandom(seed);
			const order = targets.map((_, i) => i);
			for (let i = order.length - 1; i > 0; i--) {
				const j = Math.floor(rand() * (i + 1));
				[order[i], order[j]] = [order[j]!, order[i]!];
			}
			const per = durationMs / 2;
			const step = units > 1 ? (durationMs - per) / (units - 1) : 0;
			const timeline = createPausedTimeline();
			order.forEach((u, k) => {
				const props: Record<string, [number, number]> = {};
				// Both sides end at rest: the layer plays an Out window mirrored (activeTextAnimation).
				for (const p of KEYS) props[p] = [side === 'in' ? HIDDEN[p] : HIDDEN[p] * 0.5, REST_UNIT_VALUES[p]];
				timeline.add(
					targets[u]!,
					{ ...props, duration: per, ease: resolveEase(String(params.ease ?? 'outBack')) },
					k * step,
				);
			});
			return { timeline, targets: mutate ? mutate(targets) : targets };
		},
	};
}

/** A bar wipe + a fade-out of the same property (two tweens with a gap) and a drawn SVG line (DOM leaf). */
export function FixtureTemplate({ timeMs, totalMs, introMs, outroMs, seed, canvas }: AnimeTemplateProps) {
	const [bar] = useAnimeValues(
		`fixture|${totalMs}|${introMs}|${outroMs}|${seed}`,
		() => {
			const v = { w: 0, o: 0 };
			const timeline = createPausedTimeline();
			timeline.add(v, { w: [0, 600], o: [0, 1], duration: introMs, ease: 'outExpo' }, 0);
			timeline.add(v, { o: [1, 0], duration: outroMs, ease: 'in' }, totalMs - outroMs);
			return { timeline, targets: [v] };
		},
		timeMs,
	);
	const line = useRef<SVGPathElement>(null);
	useAnimeDom(
		line,
		`line|${introMs}`,
		(root) => {
			const timeline = createPausedTimeline();
			timeline.add(createDrawable(root), { draw: ['0 0', '0 1'], duration: introMs, ease: 'linear' }, 0);
			return timeline;
		},
		timeMs,
		true,
	);
	return (
		<svg width={canvas.width} height={canvas.height} role="img" aria-label="fixture">
			<rect x={40} y={40} height={20} width={bar!.w} opacity={bar!.o} fill="#3e99f5" />
			<path ref={line} d="M40 100 L640 100" stroke="#fff" strokeWidth={6} fill="none" />
		</svg>
	);
}

/** An animated title: char units, the rise animator `in` over `inFrames`, `out` over the last `outFrames`. */
function FixtureTitle(props: {
	text: string;
	frame: number;
	fps: number;
	durationFrames: number;
	inFrames: number;
	outFrames: number;
	seed: string;
}) {
	const { text, frame, fps, durationFrames, inFrames, outFrames, seed } = props;
	const segments = segmentText(text, 'char');
	const units = segments.filter((s) => !s.space).length;
	const side = frame >= durationFrames - outFrames ? 'out' : 'in';
	const local = side === 'in' ? frame : frame - (durationFrames - outFrames);
	const ctx: TextAnimationBuildContext = {
		units,
		side,
		durationMs: frameToMs(side === 'in' ? inFrames : outFrames, fps),
		params: { ease: 'outBack' },
		seed: hash32(seed, 'text-anim', side),
		box: { width: 1000, height: 200 },
	};
	const values = useAnimeValues(
		`${text}|${side}|${ctx.durationMs}|${seed}`,
		() => riseImpl().build(ctx),
		frameToMs(local, fps),
	);
	return (
		<p
			style={{
				margin: 0,
				fontFamily: 'sans-serif',
				fontSize: 72,
				fontWeight: 700,
				color: '#fff',
				whiteSpace: 'pre',
			}}
		>
			{segments.map((s, i) => {
				if (s.space) return s.text;
				const v = values[s.unitIndex]!;
				return (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
						key={i}
						style={{
							display: 'inline-block',
							opacity: v.opacity,
							transform: `translate(${v.x}px, ${v.y}px) scale(${v.scale}) rotate(${v.rotate}deg)`,
							filter: v.blur > 0 ? `blur(${v.blur}px)` : undefined,
							letterSpacing: `${v.letterSpacing}em`,
						}}
					>
						{s.text}
					</span>
				);
			})}
		</p>
	);
}

/** An animated shape (value engine): a rounded rectangle that grows and turns. */
function FixtureShape({ frame, fps }: { frame: number; fps: number }) {
	const [v] = useAnimeValues(
		'shape',
		() => {
			const s = { w: 40, r: 0, hue: 0 };
			const timeline = createPausedTimeline();
			timeline.add(s, { w: [40, 220], r: [0, 90], duration: 900, ease: 'inOutExpo' }, 100);
			timeline.add(s, { hue: [0, 200], duration: 1200, ease: 'linear' }, 0);
			return { timeline, targets: [s] };
		},
		frameToMs(frame, fps),
	);
	return (
		<svg width={300} height={300} style={{ position: 'absolute', right: 40, bottom: 40 }} aria-label="shape">
			<rect
				x={150 - v!.w / 2}
				y={150 - v!.w / 2}
				width={v!.w}
				height={v!.w}
				rx={18}
				fill={`hsl(${v!.hue} 80% 55%)`}
				transform={`rotate(${v!.r} 150 150)`}
			/>
		</svg>
	);
}

export const SCENE = { width: 1280, height: 720, fps: 30, durationInFrames: 40 } as const;

/** The parity scene at `frame`: background, animated title (in/out), anime template, animated shape. */
export function FixtureScene({ frame }: { frame: number }) {
	const { fps, durationInFrames, width } = SCENE;
	return (
		<div style={{ position: 'absolute', inset: 0, background: '#14161c', overflow: 'hidden' }}>
			<div style={{ position: 'absolute', left: 80, top: 260 }}>
				<FixtureTitle
					text="Déjà vu 👋🏽 anime"
					frame={frame}
					fps={fps}
					durationFrames={durationInFrames}
					inFrames={18}
					outFrames={12}
					seed="clp_PARITY000000001"
				/>
			</div>
			<FixtureTemplate
				params={{}}
				timeMs={frameToMs(frame, fps)}
				totalMs={frameToMs(durationInFrames, fps)}
				introMs={frameToMs(15, fps)}
				outroMs={frameToMs(10, fps)}
				canvas={{ width, height: 200 }}
				seed={hash32('clp_PARITY000000002', 'template')}
			/>
			<FixtureShape frame={frame} fps={fps} />
		</div>
	);
}
