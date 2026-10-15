// The 120×24 mini waveform of a Sound Library row (spec 12 §2.7): the engine's peaks (`getSoundVisual`), a tick at
// the peak in the accent colour and a faint wash over the part before it (what plays before the aligned point when
// the sound is inserted peak-aligned). Visual data is fetched lazily and kept in a small shared cache.
import type { SoundVisual } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { memo, useEffect, useState } from 'react';
import { decodeBase64, waveformColumns } from '../../sound/model.ts';

export const WAVE_W = 120;
export const WAVE_H = 24;

const CACHE_MAX = 400;
const cache = new Map<string, Promise<{ cols: Float32Array; peakSec: number; durationSec: number } | null>>();

/** Columns of a sound's waveform (cached per sound id and snapshot). */
export function loadWaveform(
	engine: Pick<EngineClient, 'getSoundVisual'>,
	soundId: string,
): Promise<{ cols: Float32Array; peakSec: number; durationSec: number } | null> {
	let p = cache.get(soundId);
	if (p) {
		cache.delete(soundId);
		cache.set(soundId, p);
		return p;
	}
	p = engine
		.getSoundVisual(soundId)
		.then((v: SoundVisual) => ({
			cols: waveformColumns(decodeBase64(v.peaks.data), v.peaks.perSecond, v.durationSec, WAVE_W),
			peakSec: v.peakSec,
			durationSec: v.durationSec,
		}))
		.catch(() => {
			cache.delete(soundId);
			return null;
		});
	cache.set(soundId, p);
	while (cache.size > CACHE_MAX) {
		const first = cache.keys().next().value;
		if (first === undefined) break;
		cache.delete(first);
	}
	return p;
}

/** Forget cached waveforms (the library changed). */
export function clearWaveformCache(): void {
	cache.clear();
}

function wavePath(cols: Float32Array): string {
	const mid = WAVE_H / 2;
	let d = '';
	for (let x = 0; x < cols.length; x++) {
		const h = Math.max(0.5, cols[x]! * (WAVE_H - 2));
		d += `M${x + 0.5} ${(mid - h / 2).toFixed(2)}v${h.toFixed(2)}`;
	}
	return d;
}

export const MiniWaveform = memo(function MiniWaveform(props: {
	engine: Pick<EngineClient, 'getSoundVisual'>;
	soundId: string;
	/** From the entry (the tick shows before the visual data arrives). */
	peakSec: number;
	durationSec: number;
	compact?: boolean;
}) {
	const [data, setData] = useState<{ cols: Float32Array } | null>(null);
	useEffect(() => {
		let live = true;
		setData(null);
		void loadWaveform(props.engine, props.soundId).then((d) => {
			if (live && d) setData({ cols: d.cols });
		});
		return () => {
			live = false;
		};
	}, [props.engine, props.soundId]);
	const dur = props.durationSec > 0 ? props.durationSec : 1;
	const px = Math.max(0, Math.min(WAVE_W, (props.peakSec / dur) * WAVE_W));
	const h = props.compact ? 18 : WAVE_H;
	return (
		<svg
			width={WAVE_W}
			height={h}
			viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
			preserveAspectRatio="none"
			aria-hidden="true"
			className="shrink-0 rounded-[2px] bg-pr-field-deep"
			data-waveform={data ? 'ready' : 'loading'}
		>
			<rect x={0} y={0} width={px} height={WAVE_H} fill="var(--pr-accent)" fillOpacity={0.14} />
			{data ? (
				<path d={wavePath(data.cols)} stroke="var(--pr-text-secondary)" strokeWidth={1} fill="none" />
			) : (
				<line x1={0} x2={WAVE_W} y1={WAVE_H / 2} y2={WAVE_H / 2} stroke="var(--pr-border-strong)" />
			)}
			<line
				x1={px}
				x2={px}
				y1={0}
				y2={WAVE_H}
				stroke="var(--pr-accent)"
				strokeWidth={1.5}
				data-peak-tick={px.toFixed(1)}
			/>
		</svg>
	);
});
