// Info panel body (S05:INF-001): selection details (type, name, In/Out, duration, speed, engine) and the
// active sequence (playhead, duration, tracks). 11 px key–value rows; updates at most every 100 ms
// during playback (no per-frame React renders, PERF-004).
import {
	type Clip,
	formatTimecode,
	kindCapabilities,
	type Sequence,
	sequenceDuration,
} from '@jasper/project';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector, useTransportFrame } from '@jasper/session/react';
import { EmptyState } from '@jasper/ui';
import type { ReactNode } from 'react';
import type { PanelProps } from '../types.ts';

type Row = [string, ReactNode];

function Rows({ title, rows }: { title: string; rows: Row[] }) {
	return (
		<section className="flex flex-col gap-0.5">
			<h3 className="text-pr-ui font-semibold text-pr-text">{title}</h3>
			<dl className="grid grid-cols-[96px_1fr] gap-x-2 text-pr-small leading-[18px]">
				{rows.map(([k, v]) => (
					<div key={k} className="contents">
						<dt className="text-pr-muted">{k}</dt>
						<dd className="truncate text-pr-text pr-tabular">{v}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

const NULL_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };

function selectedClips(s: SessionState | null): { seq: Sequence; clips: Clip[] } | null {
	if (!s?.activeSequenceId) return null;
	const seq = s.document.sequences[s.activeSequenceId] as Sequence | undefined;
	if (!seq) return null;
	return { seq, clips: s.selection.timeline.clips.map((id) => seq.clips[id]).filter((c): c is Clip => !!c) };
}

function Playhead({ seq }: { seq: Sequence }) {
	const t = useTransportFrame(100);
	const { frameRate, dropFrame, startTimecodeFrames } = seq.settings;
	return <>{formatTimecode(t.frame, frameRate, { dropFrame, startFrames: startTimecodeFrames })}</>;
}

export function InfoPanel(_props: PanelProps) {
	const session = useSessionOrNull();
	const state = useStoreSelector(session?.store ?? NULL_STORE, (s: SessionState | null) => s);
	if (!session || !state) return <EmptyState icon="panel.info" message="Open a project to see details" />;
	const sel = selectedClips(state);
	const items = state.selection.project.items.map((id) => state.document.items[id]).filter(Boolean);
	const seq = sel?.seq ?? null;
	const tc = (f: number) =>
		seq
			? formatTimecode(f, seq.settings.frameRate, {
					dropFrame: seq.settings.dropFrame,
					startFrames: seq.settings.startTimecodeFrames,
				})
			: String(f);
	const dur = (f: number) =>
		seq ? formatTimecode(f, seq.settings.frameRate, { dropFrame: seq.settings.dropFrame }) : String(f);
	const clip = sel?.clips[0];
	return (
		<div className="flex h-full flex-col gap-3 overflow-auto p-2" data-testid="info-panel">
			{clip ? (
				<Rows
					title={sel && sel.clips.length > 1 ? `${sel.clips.length} clips selected` : clip.name || 'Clip'}
					rows={[
						['Type', clip.kind],
						['Start', tc(clip.start)],
						['End', tc(clip.start + clip.duration)],
						['Duration', dur(clip.duration)],
						['Speed', `${Math.round(clip.speed.rate * 100)}%${clip.speed.reverse ? ' (reverse)' : ''}`],
						['Engine', engineLabel(clip.kind)],
						['Enabled', clip.enabled ? 'Yes' : 'No'],
					]}
				/>
			) : items.length ? (
				<Rows
					title={items.length > 1 ? `${items.length} items selected` : (items[0]?.name ?? 'Item')}
					rows={[
						['Type', items[0]?.kind ?? ''],
						['Label', items[0]?.label ?? ''],
					]}
				/>
			) : (
				<EmptyState
					icon="panel.info"
					message="Select a clip or project item to see its details"
					className="h-auto py-4"
				/>
			)}
			{seq ? (
				<Rows
					title="Sequence"
					rows={[
						['Playhead', <Playhead key="p" seq={seq} />],
						['Duration', dur(sequenceDuration(seq))],
						['Frame size', `${seq.settings.width} × ${seq.settings.height}`],
						[
							'Frame rate',
							`${(seq.settings.frameRate.num / seq.settings.frameRate.den).toFixed(3).replace(/\.?0+$/, '')} fps`,
						],
						['Tracks', `${seq.videoTracks.length} video, ${seq.audioTracks.length} audio`],
						['Clips', String(Object.keys(seq.clips).length)],
					]}
				/>
			) : null}
		</div>
	);
}

const ENGINE_NAMES = { native: 'Native', remotion: 'Remotion', fframes: 'fframes' } as const;
function engineLabel(kind: string): string {
	const caps = kindCapabilities(kind);
	if (!caps) return 'Unsupported';
	const { preview, export: out } = caps.engines;
	return preview === out
		? ENGINE_NAMES[preview]
		: `${ENGINE_NAMES[preview]} preview, ${ENGINE_NAMES[out]} export`;
}
