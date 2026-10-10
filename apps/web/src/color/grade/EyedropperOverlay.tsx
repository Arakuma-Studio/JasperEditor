// color-grade: the Program monitor overlay of the Lumetri eyedroppers (eyedropper.ts). Inactive (renders nothing)
// until a picker is armed; then it covers the monitor with a crosshair, samples the clicked colour and disarms.
import { type PointerEvent, useEffect, useRef } from 'react';
import { eyedropper, sampleProgram, useEyedropper } from './eyedropper.ts';

export function EyedropperOverlay() {
	const req = useEyedropper();
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!req) return;
		const key = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			e.stopPropagation();
			eyedropper.cancel();
		};
		window.addEventListener('keydown', key, true);
		return () => window.removeEventListener('keydown', key, true);
	}, [req]);
	if (!req) return null;
	const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const root = ref.current?.parentElement;
		// Premiere: a 5 × 5 average, 10 × 10 with Ctrl (Cmd on macOS).
		const size = e.ctrlKey || e.metaKey ? 10 : 5;
		const c = root ? sampleProgram(root, e.clientX, e.clientY, req.clipId, size) : null;
		if (c) eyedropper.pick(c);
	};
	return (
		<div
			ref={ref}
			className="absolute inset-0 z-[6] cursor-crosshair"
			onPointerDown={onPointerDown}
			data-testid="lumetri-eyedropper-overlay"
			role="presentation"
		>
			<span className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-pr-control bg-pr-panel px-2 py-[2px] text-pr-small text-pr-text shadow-pr-overlay">
				{req.label} · Esc to cancel
			</span>
		</div>
	);
}
