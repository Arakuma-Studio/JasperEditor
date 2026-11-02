// Spec 19 TL-116: the gamut overlay of the Program monitor. The Player's picture cannot be read back in general (it is DOM;
// only some stacks draw through a canvas), so the frame is measured by the engine, as `frame.capture` is: a job per
// paused frame, the previous one cancelled, the mask drawn over the picture with the percentages. While the picture
// plays, or until the measurement of this frame comes back, the mask is hidden: a stale mask would mark the wrong pixels.
import type { GamutCheckResult } from '@jasper/api';
import type { OUTPUT_SPACE_IDS } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState, useStoreSelector } from '@jasper/session/react';
import { useEffect, useRef, useState } from 'react';
import { createStore } from 'zustand/vanilla';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { errorText } from '../processing/engine-jobs.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { cancelJob, envelopeOf, runToEnd } from './shared.ts';

export type GamutOutput = 'working' | (typeof OUTPUT_SPACE_IDS)[number];

export const gamutOverlay = createStore<{ enabled: boolean; output: GamutOutput }>(() => ({
	enabled: false,
	output: 'rec709',
}));

/** Waits this long after the last change before measuring, so scrubbing does not queue renders. */
const SETTLE_MS = 300;

export function GamutOverlay({ session, view, viewport: _v, transport }: ProgramOverlayHostProps) {
	const engine = useEngineOrNull()?.client ?? null;
	const output = useStoreSelector(gamutOverlay, (s) => s.output);
	const frame = useStoreSelector(transport, (s) => s.frame);
	const playing = useStoreSelector(transport, (s) => s.playing);
	const revision = useSessionState((s) => s.revision);
	const sequenceId = useSessionState((s) => s.activeSequenceId);
	const [result, setResult] = useState<(GamutCheckResult & { url: string; key: string }) | null>(null);
	const [error, setError] = useState<string | null>(null);
	const running = useRef<string | null>(null);
	const key = `${sequenceId}:${frame}:${revision}:${output}`;

	useEffect(() => {
		if (!engine || !sequenceId || playing) return;
		let off = false;
		const stop = () => {
			if (running.current) void cancelJob(engine, running.current).catch(() => undefined);
			running.current = null;
		};
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const started = await engine.call('gamutCheck', {
						body: { envelope: envelopeOf(session as EditorSession), sequenceId, frame, output },
					});
					if (off) {
						void cancelJob(engine, started.id).catch(() => undefined);
						return;
					}
					running.current = started.id;
					const r = await runToEnd<GamutCheckResult>(engine, started, () => undefined);
					running.current = null;
					if (off || !r) return;
					setError(null);
					setResult({ ...r, url: engine.url(r.maskUrl), key });
				} catch (e) {
					if (!off) setError(errorText(e));
				}
			})();
		}, SETTLE_MS);
		return () => {
			off = true;
			clearTimeout(timer);
			stop();
		};
	}, [engine, session, sequenceId, frame, output, playing, key]);

	const current = !playing && result?.key === key ? result : null;
	const f = (v: number) => (v > 0 && v < 0.1 ? '< 0.1' : v.toFixed(1));
	return (
		<>
			{current ? (
				<img
					src={current.url}
					alt=""
					data-testid="gamut-mask"
					className="pointer-events-none absolute"
					style={{
						left: view.x,
						top: view.y,
						width: current.width * view.scale,
						height: current.height * view.scale,
						imageRendering: 'pixelated',
					}}
				/>
			) : null}
			<div
				data-testid="gamut-readout"
				className="pointer-events-none absolute top-2 left-2 rounded bg-pr-panel px-2 py-1 text-pr-small"
				aria-live="polite"
			>
				{error ? (
					<span className="text-pr-danger">Gamut check: {error}</span>
				) : playing ? (
					<span className="text-pr-muted">Gamut check pauses during playback</span>
				) : current ? (
					<span>
						{current.outputLabel}: {f(current.gamutPercent)} % out of gamut, {f(current.legalPercent)} % out of legal range
					</span>
				) : (
					<span className="text-pr-muted">Measuring…</span>
				)}
			</div>
		</>
	);
}
