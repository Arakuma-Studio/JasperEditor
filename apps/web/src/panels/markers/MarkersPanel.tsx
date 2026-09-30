// Markers panel body (S05:MRK-001): color swatch, name, In, Duration, Comment for the active sequence's
// markers; search; double-click (or Enter) moves the playhead to the marker. Editing arrives with the
// Marker dialog (M2); the empty state offers Add Marker (timeline.addMarker, owned by WP-2B).
import { formatTimecode, type Sequence } from '@jasper/project';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { EmptyState, labelColor, SearchField } from '@jasper/ui';
import { useState } from 'react';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import type { PanelProps } from '../types.ts';

const NULL_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };

export function MarkersPanel(_props: PanelProps) {
	const session = useSessionOrNull();
	const runtime = useShellRuntimeOrNull();
	const [query, setQuery] = useState('');
	const seq = useStoreSelector(session?.store ?? NULL_STORE, (s: SessionState | null) =>
		s?.activeSequenceId ? ((s.document.sequences[s.activeSequenceId] as Sequence | undefined) ?? null) : null,
	);
	if (!session) return <EmptyState icon="panel.markers" message="Open a project to see its markers" />;
	if (!seq) return <EmptyState icon="panel.markers" message="Open a sequence to see its markers" />;
	const opts = { dropFrame: seq.settings.dropFrame, startFrames: seq.settings.startTimecodeFrames };
	const rate = seq.settings.frameRate;
	const q = query.trim().toLowerCase();
	const markers = [...seq.markers]
		.sort((a, b) => a.frame - b.frame)
		.filter((m) => !q || m.name.toLowerCase().includes(q) || m.comment.toLowerCase().includes(q));
	const go = (frame: number) => session.transport.seek(frame);
	return (
		<div className="flex h-full flex-col" data-testid="markers-panel">
			<div className="flex h-7 shrink-0 items-center px-2">
				<SearchField
					value={query}
					onValueChange={setQuery}
					placeholder="Search markers"
					aria-label="Search markers"
					className="w-full"
				/>
			</div>
			{seq.markers.length === 0 ? (
				<EmptyState
					icon="timeline.addMarker"
					message="No markers in this sequence"
					detail="Press M in the Timeline or Program monitor to add one."
					action={
						runtime
							? { label: 'Add Marker', onClick: () => void runtime.run('timeline.addMarker') }
							: undefined
					}
				/>
			) : (
				<div className="min-h-0 flex-1 overflow-auto">
					<table className="w-full border-collapse text-left font-pr text-pr-ui">
						<thead className="sticky top-0 bg-pr-panel text-pr-small text-pr-muted">
							<tr className="h-[22px]">
								<th className="w-5" aria-label="Color" />
								<th className="font-normal">Name</th>
								<th className="font-normal">In</th>
								<th className="font-normal">Duration</th>
								<th className="font-normal">Comment</th>
							</tr>
						</thead>
						<tbody>
							{markers.map((m, i) => (
								<tr
									key={m.id}
									tabIndex={0}
									onDoubleClick={() => go(m.frame)}
									onKeyDown={(e) => e.key === 'Enter' && go(m.frame)}
									className={`h-[22px] cursor-default hover:bg-pr-hover focus:bg-pr-selected focus:outline-none ${i % 2 ? 'bg-pr-panel-alt' : ''}`}
									data-testid="marker-row"
								>
									<td className="px-1">
										<span
											className="block size-2.5 rounded-[2px]"
											style={{ background: labelColor(m.color) }}
										/>
									</td>
									<td className="truncate">{m.name || '—'}</td>
									<td className="pr-tabular text-pr-muted">{formatTimecode(m.frame, rate, opts)}</td>
									<td className="pr-tabular text-pr-muted">
										{formatTimecode(m.duration, rate, { dropFrame: opts.dropFrame })}
									</td>
									<td className="max-w-0 truncate text-pr-muted">{m.comment}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
