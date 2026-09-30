// Audio meters placeholder (S05:MTR-001): two 8 px bars with a 2 px gap on a deep well, dB scale 0 to
// −54, S (solo) buttons under each channel. No live levels yet — the wells stay empty (MTR-002 later).
import type { PanelProps } from '../types.ts';

const SCALE = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54];

export function AudioMetersPanel({ visible }: PanelProps) {
	return (
		<div
			className="flex h-full min-h-0 flex-col items-center px-1 pt-1.5 pb-1 select-none"
			data-testid="audio-meters"
			data-visible={visible}
			title="Live levels arrive with the Program monitor audio path"
		>
			{/* Premiere order: the stereo pair on the left, the dB scale to its right (R-PUI §15.1). */}
			<div className="flex min-h-0 w-full flex-1 gap-1">
				<div className="flex gap-0.5" aria-hidden>
					<span className="w-2 rounded-[1px] bg-pr-field-deep" />
					<span className="w-2 rounded-[1px] bg-pr-field-deep" />
				</div>
				<div className="relative min-h-0 flex-1" aria-hidden>
					{SCALE.map((db) => (
						<span
							key={db}
							className="absolute left-0 -translate-y-1/2 font-pr text-[9px] leading-none text-pr-muted pr-tabular"
							style={{ top: `${(-db / 54) * 100}%` }}
						>
							{db}
						</span>
					))}
				</div>
			</div>
			<div className="mt-1 flex w-full items-center gap-1">
				<div className="flex gap-0.5">
					<button
						type="button"
						disabled
						className="w-2 text-center text-[8px] leading-[10px] text-pr-dim"
						aria-label="Solo left"
					>
						S
					</button>
					<button
						type="button"
						disabled
						className="w-2 text-center text-[8px] leading-[10px] text-pr-dim"
						aria-label="Solo right"
					>
						S
					</button>
				</div>
				<span className="font-pr text-[9px] leading-[10px] text-pr-muted">dB</span>
			</div>
		</div>
	);
}
