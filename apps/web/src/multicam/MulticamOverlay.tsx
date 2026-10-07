// Multi-Camera view overlay (wp-multicam): over the Player that draws the angle grid and the program, one clickable
// cell per camera with its number and name, the active camera outlined — yellow when stopped, red while a live
// switching pass records (Premiere's colours) — and page arrows when the cameras do not fit one page.
import type { EditorSession } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { useEffect, useState } from 'react';
import { type MulticamViewDoc, multicamClipAt } from './logic.ts';
import { pressCamera } from './recorder.ts';
import { multicamRecorderStore, multicamViewStore } from './state.ts';

type View = { x: number; y: number; scale: number };

export function MulticamOverlay(props: {
	session: EditorSession;
	sequenceId: string;
	mc: MulticamViewDoc;
	view: View;
	toast(kind: 'info' | 'warning', message: string, detail?: string): void;
}) {
	const { session, mc, view, sequenceId } = props;
	const recording = useStoreSelector(multicamRecorderStore, (s) => s.recording);
	const cuts = useStoreSelector(multicamRecorderStore, (s) => s.cuts);
	const showNames = useStoreSelector(multicamViewStore, (s) => s.showNames);
	const topDown = useStoreSelector(multicamViewStore, (s) => s.topDown);
	const [frame, setFrame] = useState(session.transport.getState().frame);
	useEffect(() => {
		let raf = 0;
		const off = session.transport.subscribe((s) => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => setFrame(s.frame));
		});
		return () => {
			off();
			cancelAnimationFrame(raf);
		};
	}, [session]);
	const seq = session.getDrawn().sequences[sequenceId];
	const at = seq ? multicamClipAt(seq, frame, topDown) : null;
	// While recording the last cut is the active camera (the gesture already shows it on the timeline).
	const active = recording && cuts.length ? cuts[cuts.length - 1]!.angle : (at?.clip.multicam.angle ?? null);
	const s = view.scale;
	const box = (r: { x: number; y: number; width: number; height: number }) => ({
		left: view.x + r.x * s,
		top: view.y + r.y * s,
		width: r.width * s,
		height: r.height * s,
	});
	const page = (d: number) =>
		multicamViewStore.setState((v) => ({ page: Math.max(0, Math.min(mc.layout.pages - 1, v.page + d)) }));
	return (
		<div className="pointer-events-none absolute inset-0" data-testid="multicam-overlay">
			{mc.cells.map((c, k) => {
				const isActive = c.angle.id === active;
				return (
					<button
						key={c.angle.id}
						type="button"
						className={`pointer-events-auto absolute flex items-start justify-start border-2 bg-transparent p-1 text-left ${
							isActive
								? recording
									? 'border-pr-danger'
									: 'border-pr-warning'
								: 'border-transparent hover:border-pr-border'
						}`}
						style={box(c.rect)}
						title={`Camera ${c.camera}: ${c.angle.name}`}
						data-testid={`multicam-cell-${c.camera}`}
						data-active={isActive ? 'true' : 'false'}
						onClick={(e) => {
							e.stopPropagation();
							pressCamera(session, k + 1, 'select', props.toast, { angleId: c.angle.id });
						}}
					>
						{showNames ? (
							<span className="rounded-pr-control bg-pr-app px-1 text-pr-small text-pr-strong">
								{c.camera} {c.angle.name}
							</span>
						) : null}
					</button>
				);
			})}
			{mc.program ? (
				<div
					className={`absolute border-2 ${recording ? 'border-pr-danger' : 'border-transparent'}`}
					style={box(mc.program)}
					data-testid="multicam-program"
				/>
			) : null}
			{mc.layout.pages > 1 ? (
				<div
					className="pointer-events-auto absolute flex items-center gap-1 rounded-pr-control bg-pr-app px-1 text-pr-small text-pr-text"
					style={{ left: view.x + 4, top: view.y + mc.height * s - 22 }}
					data-testid="multicam-pages"
				>
					<button
						type="button"
						onClick={() => page(-1)}
						disabled={mc.layout.page === 0}
						aria-label="Previous page"
					>
						‹
					</button>
					<span>
						{mc.layout.page + 1}/{mc.layout.pages}
					</span>
					<button
						type="button"
						onClick={() => page(1)}
						disabled={mc.layout.page >= mc.layout.pages - 1}
						aria-label="Next page"
					>
						›
					</button>
				</div>
			) : null}
		</div>
	);
}
