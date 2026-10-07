// Vertical level meter (audio-mix; Premiere Audio Meters / mixer strip meters): one bar per channel on a dB scale,
// peak (bright) over RMS (dim), green → yellow (−18 dB) → red (−6 dB), peak hold lines (1.5 s, then 20 dB/s
// release), and a clip LED per channel above the bars that latches at 0 dBFS until clicked.
import { linToDb, MeterBallistics } from '@jasper/audio-dsp';
import type { MeterReading } from '@jasper/compositions';
import { useEffect, useRef, useState } from 'react';

export const METER_FLOOR_DB = -60;

/** Fraction of the meter height (0 bottom … 1 top) of a dB value. */
export function meterPos(db: number, floor = METER_FLOOR_DB): number {
	if (!Number.isFinite(db) || db <= floor) return 0;
	return Math.min(1, Math.max(0, (db - floor) / -floor));
}

function cssVar(el: Element, name: string, fallback: string): string {
	const v = getComputedStyle(el).getPropertyValue(name).trim();
	return v || fallback;
}

type Props = {
	reading: MeterReading | null;
	channels: number;
	/** Channel labels under the bars (optional). */
	labels?: readonly string[];
	/** Bar width in CSS px (default 8). */
	barWidth?: number;
	gap?: number;
	className?: string;
	'data-testid'?: string;
};

export function LevelMeter({ reading, channels, barWidth = 8, gap = 2, className, ...rest }: Props) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const ballistics = useRef<{ peak: MeterBallistics; rms: MeterBallistics }[]>([]);
	const [clipped, setClipped] = useState<boolean[]>([]);
	const last = useRef<{ peak: number[]; rms: number[] }>({ peak: [], rms: [] });

	// latch clip LEDs
	useEffect(() => {
		if (!reading) return;
		if (reading.clipped.some((c, i) => c && !clipped[i])) {
			setClipped((prev) => Array.from({ length: channels }, (_, i) => !!prev[i] || !!reading.clipped[i]));
		}
	}, [reading, channels, clipped]);

	useEffect(() => {
		const el = canvas.current;
		if (!el) return;
		let raf = 0;
		const draw = () => {
			raf = requestAnimationFrame(draw);
			const dpr = window.devicePixelRatio || 1;
			const w = el.clientWidth;
			const h = el.clientHeight;
			if (w <= 0 || h <= 0) return;
			if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
				el.width = Math.round(w * dpr);
				el.height = Math.round(h * dpr);
			}
			const g = el.getContext('2d');
			if (!g) return;
			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			g.clearRect(0, 0, w, h);
			const green = cssVar(el, '--pr-meter-green', 'green');
			const yellow = cssVar(el, '--pr-meter-yellow', 'yellow');
			const red = cssVar(el, '--pr-meter-red', 'red');
			const hold = cssVar(el, '--pr-meter-peak-hold', 'white');
			const well = cssVar(el, '--pr-bg-field-deep', cssVar(el, '--pr-bg-field', 'black'));
			const now = performance.now();
			const r = reading && now - reading.at < 400 ? reading : null;
			while (ballistics.current.length < channels)
				ballistics.current.push({ peak: new MeterBallistics(), rms: new MeterBallistics({ holdMs: 0 }) });
			const grad = g.createLinearGradient(0, h, 0, 0);
			grad.addColorStop(0, green);
			grad.addColorStop(meterPos(-18), green);
			grad.addColorStop(meterPos(-18) + 0.001, yellow);
			grad.addColorStop(meterPos(-6), yellow);
			grad.addColorStop(meterPos(-6) + 0.001, red);
			grad.addColorStop(1, red);
			for (let c = 0; c < channels; c++) {
				const x = c * (barWidth + gap);
				g.fillStyle = well;
				g.fillRect(x, 0, barWidth, h);
				const b = ballistics.current[c]!;
				const peakDb = linToDb(r?.peak[c] ?? 0, -200);
				const rmsDb = linToDb(r?.rms[c] ?? 0, -200);
				const p = b.peak.update(peakDb, now);
				const q = b.rms.update(rmsDb, now);
				last.current.peak[c] = p.displayDb;
				last.current.rms[c] = q.displayDb;
				const ph = meterPos(p.displayDb) * h;
				const rh = meterPos(q.displayDb) * h;
				g.globalAlpha = 0.55;
				g.fillStyle = grad;
				g.fillRect(x, h - ph, barWidth, ph);
				g.globalAlpha = 1;
				g.fillRect(x, h - rh, barWidth, rh);
				const hy = meterPos(p.holdDb) * h;
				if (hy > 1) {
					g.fillStyle = p.holdDb > -6 ? red : hold;
					g.fillRect(x, h - hy, barWidth, 1);
				}
			}
		};
		raf = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(raf);
	}, [reading, channels, barWidth, gap]);

	const width = channels * barWidth + (channels - 1) * gap;
	return (
		<div className={`flex min-h-0 flex-col ${className ?? ''}`} style={{ width }} {...rest}>
			<div className="flex shrink-0" style={{ gap }}>
				{Array.from({ length: channels }, (_, c) => (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: one LED per channel
						key={c}
						type="button"
						title={clipped[c] ? 'Clipped: click to reset' : 'No clipping'}
						aria-label={`Clip indicator ${c + 1}${clipped[c] ? ' (clipped)' : ''}`}
						data-clipped={clipped[c] ? 'true' : 'false'}
						onClick={() => setClipped([])}
						className="h-[5px] rounded-[1px]"
						style={{
							width: barWidth,
							background: clipped[c] ? 'var(--pr-meter-red)' : 'var(--pr-bg-field-deep, var(--pr-bg-field))',
						}}
					/>
				))}
			</div>
			<canvas ref={canvas} className="mt-0.5 min-h-0 w-full flex-1" />
		</div>
	);
}

/** dB scale labels for a meter of the same height (0 at the top, −54 near the bottom, 6 dB steps). */
export function MeterScale({ className, step = 6 }: { className?: string; step?: number }) {
	const marks: number[] = [];
	for (let db = 0; db > METER_FLOOR_DB; db -= step) marks.push(db);
	return (
		<div className={`relative min-h-0 ${className ?? ''}`} aria-hidden>
			{marks.map((db) => (
				<span
					key={db}
					className="absolute left-0 -translate-y-1/2 font-pr text-[9px] leading-none text-pr-muted pr-tabular"
					style={{ top: `${(1 - meterPos(db)) * 100}%` }}
				>
					{db}
				</span>
			))}
		</div>
	);
}
