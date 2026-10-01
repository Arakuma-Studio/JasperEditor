// Player page of the render-parity e2e (S11:ANM-014/015), bundled with esbuild and opened in Chrome: mounts the
// SequenceComposition in a @remotion/player <Player> at 1:1 and exposes `window.__parity`:
// `mount`, `seek(frame)` (resolves once the frame is painted) and `bench` (value-engine cost per frame).

import { getTextAnimationSpec } from '@jasper/project';
import { Player, type PlayerRef } from '@remotion/player';
import { type ComponentType, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { SequenceComposition } from '../../../compositions/src/SequenceComposition.tsx';
import { valuesAt } from '../../src/runtime/hooks.ts';
import { frameToMs, hash32 } from '../../src/runtime/index.ts';
import { TEXT_ANIMATION_IMPLS } from '../../src/text/index.ts';
import { PARITY_SCENE } from './doc.ts';

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
function bench(units: number, frames: number): { values: Stats; revisit: Stats } {
	const impl = TEXT_ANIMATION_IMPLS['blur@1']!;
	const spec = getTextAnimationSpec('blur', 1)!;
	const ctx = {
		units,
		side: 'in' as const,
		durationMs: frameToMs(frames, 30),
		params: spec.defaults,
		seed: hash32('bench', 'text-anim', 'in'),
		box: { width: 1920, height: 400 },
	};
	const values: number[] = [];
	const revisit: number[] = [];
	const built = impl.build(ctx);
	for (let f = 0; f < frames; f++) {
		const ms = frameToMs(f, 30);
		const t0 = performance.now();
		valuesAt(built, ms);
		values.push(performance.now() - t0);
	}
	for (let f = 0; f < frames; f++) {
		const t0 = performance.now();
		valuesAt(built, frameToMs(f, 30));
		revisit.push(performance.now() - t0);
	}
	return { values: stats(values), revisit: stats(revisit) };
}

const player = createRef<PlayerRef>();

function mount(inputProps: Record<string, unknown>) {
	const root = document.getElementById('root')!;
	createRoot(root).render(
		<Player
			ref={player}
			component={SequenceComposition as ComponentType<Record<string, unknown>>}
			inputProps={inputProps}
			durationInFrames={PARITY_SCENE.durationInFrames}
			fps={PARITY_SCENE.fps}
			compositionWidth={PARITY_SCENE.width}
			compositionHeight={PARITY_SCENE.height}
			style={{ width: PARITY_SCENE.width, height: PARITY_SCENE.height }}
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
