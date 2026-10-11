// Audio Meters (S05:MTR-001/002, audio-mix): live levels of the Mix as the Program monitor plays it — one bar per
// output channel (2, 1 or 6 for a 5.1 Mix) with peak and RMS, peak hold and clip LEDs on a 0 … −60 dB scale — fed by
// an AudioWorklet that taps the real preview mix after loudness normalisation and the true-peak limiter. Below: the
// BS.1770-4 / EBU R128 loudness readout (Momentary, Short-term, Integrated, Loudness Range, True Peak) with a reset,
// and the S buttons that solo an output channel on the monitor.
import { channelNames, type Layout } from '@jasper/audio-dsp';
import type { Sequence } from '@jasper/project';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { useEffect, useState } from 'react';
import { LevelMeter, MeterScale } from '../../audio/components/LevelMeter.tsx';
import { useGraphVersion, useMeterReading, useMixGraph } from '../../audio/runtime.ts';
import type { PanelProps } from '../types.ts';

const NULL_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };

/** LUFS / dB text: one decimal, "—" for silence. */
function loudnessText(v: number | null | undefined): string {
	return v !== null && v !== undefined && Number.isFinite(v) && v > -70 ? v.toFixed(1) : '—';
}

export function AudioMetersPanel({ visible }: PanelProps) {
	const session = useSessionOrNull();
	const layout = useStoreSelector(session?.store ?? NULL_STORE, (s: SessionState | null) => {
		const seq = s?.activeSequenceId
			? (s.document.sequences[s.activeSequenceId] as Sequence | undefined)
			: undefined;
		return (seq?.settings.masterLayout as Layout | undefined) ?? 'stereo';
	});
	const graph = useMixGraph();
	useGraphVersion(graph);
	const reading = useMeterReading(visible ? graph : null, 'master');
	const names = channelNames(layout);
	const channels = names.length;
	const solo = graph?.monitorSoloChannels ?? new Set<number>();
	const [, force] = useState(0);
	useEffect(() => {
		if (!graph) return;
		return graph.onChange(() => force((x) => x + 1));
	}, [graph]);
	const l = reading?.loudness;
	const tpHot = l && Number.isFinite(l.truePeakDb) && l.truePeakDb > -1;
	const barWidth = channels > 2 ? 5 : 8;
	return (
		<div
			className="flex h-full min-h-0 flex-col items-stretch px-1 pt-1.5 pb-1 select-none"
			data-testid="audio-meters"
			data-visible={visible}
			data-live={reading ? 'true' : 'false'}
		>
			<div className="flex min-h-0 w-full flex-1 gap-1">
				<LevelMeter
					reading={reading}
					channels={channels}
					barWidth={barWidth}
					gap={channels > 2 ? 1 : 2}
					data-testid="audio-meters-bars"
				/>
				<MeterScale className="mt-[7px] flex-1" />
			</div>
			<div className="mt-1 flex w-full items-center gap-[2px]">
				{names.map((n, i) => (
					<button
						key={n}
						type="button"
						disabled={!graph}
						aria-pressed={solo.has(i)}
						aria-label={`Solo ${n}`}
						title={`Solo ${n} on the monitor`}
						onClick={() => {
							if (!graph) return;
							const next = new Set(solo);
							if (next.has(i)) next.delete(i);
							else next.add(i);
							graph.setMonitorSolo(next);
						}}
						className={`text-center text-[8px] leading-[10px] ${solo.has(i) ? 'rounded-[1px] text-pr-on-accent' : 'text-pr-dim hover:text-pr-text'}`}
						style={{
							width: barWidth + (channels > 2 ? 1 : 2) - 1,
							...(solo.has(i)
								? { background: 'var(--pr-track-solo)', color: 'var(--pr-track-solo-text)' }
								: {}),
						}}
					>
						{channels > 2 ? n.slice(0, 1) : 'S'}
					</button>
				))}
				<span className="ml-auto font-pr text-[9px] leading-[10px] text-pr-muted">dB</span>
			</div>
			<div
				className="mt-1 flex flex-col gap-[1px] border-t border-pr-border pt-1 font-pr text-[9px] leading-[11px] pr-tabular"
				data-testid="audio-meters-loudness"
				title="Loudness (EBU R128)"
			>
				{(
					[
						['M', l?.momentary, 'Momentary loudness (400 ms), LUFS'],
						['S', l?.shortTerm, 'Short-term loudness (3 s), LUFS'],
						['I', l?.integrated, 'Integrated loudness since reset, LUFS'],
						['LRA', l?.lra, 'Loudness range, LU'],
						['TP', l?.truePeakDb, 'Maximum true peak since reset, dBTP'],
					] as const
				).map(([k, v, title]) => (
					<div key={k} className="flex justify-between gap-0.5" title={title} data-loudness={k}>
						<span className="text-pr-muted">{k}</span>
						<span
							className={
								k === 'TP' && tpHot ? 'text-pr-danger' : k === 'I' ? 'text-pr-text' : 'text-pr-muted'
							}
							data-value={v !== undefined && v !== null && Number.isFinite(v) ? v.toFixed(2) : ''}
						>
							{k === 'LRA'
								? v !== undefined && Number.isFinite(v) && (l?.integrated ?? -100) > -70
									? v.toFixed(1)
									: '—'
								: loudnessText(v)}
						</span>
					</div>
				))}
				<button
					type="button"
					disabled={!graph}
					onClick={() => graph?.resetLoudness()}
					className="mt-0.5 rounded-pr-control text-[9px] text-pr-muted hover:bg-pr-hover hover:text-pr-text"
					title="Reset the integrated loudness, loudness range and true peak"
					data-testid="audio-meters-reset"
				>
					Reset
				</button>
			</div>
		</div>
	);
}
