// Player page of the render-parity e2e (S11:ANM-014/015), bundled with esbuild and opened in Chrome: mounts the
// scene or the SequenceComposition in a @remotion/player <Player> at 1:1 and exposes `window.__parity`:
// `mount`, `seek(frame)` (resolves once the frame is painted) and `bench` (value-engine cost per frame).
import { Player, type PlayerRef } from '@remotion/player';
import { type ComponentType, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useCurrentFrame } from 'remotion';
import { SequenceComposition } from '../../../compositions/src/SequenceComposition.tsx';
import { valuesAt } from '../../src/runtime/hooks.ts';
import {
	createPausedTimeline,
	frameToMs,
	hash32,
	resolveEase,
	seekCanonical,
} from '../../src/runtime/index.ts';
import { REST_UNIT_VALUES, type TextAnimationImpl } from '../../src/text/index.ts';
import { FixtureScene, riseImpl, SCENE } from '../determinism-fixtures.tsx';

function AnimeScene() {
	return <FixtureScene frame={useCurrentFrame()} />;
}

/** A typical 4-property preset (opacity, y, blur, scale) with a stagger, for the cost measurement. */
const fourProps: TextAnimationImpl = {
	key: 'bench-4@1',
	unitDefault: 'char',
	build({ units, durationMs }) {
		const targets = Array.from({ length: units }, () => ({ ...REST_UNIT_VALUES }));
		const timeline = createPausedTimeline();
		const per = durationMs / 3;
		const step = units > 1 ? (durationMs - per) / (units - 1) : 0;
		for (const [i, t] of targets.entries())
			timeline.add(
				t,
				{
					opacity: [0, 1],
					y: [40, 0],
					blur: [8, 0],
					scale: [0.6, 1],
					duration: per,
					ease: resolveEase('outExpo'),
				},
				i * step,
			);
		return { timeline, targets };
	},
};

type Stats = { median: number; p95: number; max: number; mean: number };
const stats = (xs: number[]): Stats => {
	const s = [...xs].sort((a, b) => a - b);
	const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
	return {
		median: at(0.5),
		p95: at(0.95),
		max: s[s.length - 1]!,
		mean: xs.reduce((a, b) => a + b, 0) / xs.length,
	};
};

/** Per-frame cost of the value engine for `units` units over a `frames`-frame window (every frame a first visit). */
function bench(
	units: number,
	frames: number,
	preset: 'rise8' | 'four',
): { values: Stats; seekOnly: Stats; revisit: Stats } {
	const impl = preset === 'rise8' ? riseImpl() : fourProps;
	const ctx = {
		units,
		side: 'in' as const,
		durationMs: frameToMs(frames, 30),
		params: {},
		seed: hash32('bench', 'text-anim', 'in'),
		box: { width: 1920, height: 400 },
	};
	const values: number[] = [];
	const seekOnly: number[] = [];
	const revisit: number[] = [];
	const built = impl.build(ctx);
	const raw = impl.build(ctx);
	for (let f = 0; f < frames; f++) {
		const ms = frameToMs(f, 30);
		let t0 = performance.now();
		valuesAt(built, ms);
		values.push(performance.now() - t0);
		t0 = performance.now();
		seekCanonical(raw.timeline, ms);
		seekOnly.push(performance.now() - t0);
	}
	for (let f = 0; f < frames; f++) {
		const t0 = performance.now();
		valuesAt(built, frameToMs(f, 30));
		revisit.push(performance.now() - t0);
	}
	return { values: stats(values), seekOnly: stats(seekOnly), revisit: stats(revisit) };
}

const player = createRef<PlayerRef>();

function mount(which: 'scene' | 'sequence', inputProps: Record<string, unknown>) {
	const root = document.getElementById('root')!;
	createRoot(root).render(
		<Player
			ref={player}
			component={
				(which === 'scene' ? AnimeScene : SequenceComposition) as ComponentType<Record<string, unknown>>
			}
			inputProps={inputProps}
			durationInFrames={SCENE.durationInFrames}
			fps={SCENE.fps}
			compositionWidth={SCENE.width}
			compositionHeight={SCENE.height}
			style={{ width: SCENE.width, height: SCENE.height }}
			controls={false}
			clickToPlay={false}
		/>,
	);
}

const nextPaint = () =>
	new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

async function seek(frame: number) {
	while (!player.current) await nextPaint();
	player.current.seekTo(frame);
	for (let i = 0; i < 100 && player.current.getCurrentFrame() !== frame; i++) await nextPaint();
	await document.fonts.ready;
	await nextPaint();
	await nextPaint();
}

(window as unknown as { __parity: unknown }).__parity = { mount, seek, bench };
