// the Text panel (Premiere Window ▸ Text): Transcript, Captions and Subtitles (spec 13) tabs.
import type { Sequence } from '@jasper/project';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { EmptyState, Tabs } from '@jasper/ui';
import { useEffect, useState } from 'react';
import { SubtitlesTab } from '../../subtitles/SubtitlesTab.tsx';
import { EMPTY_SESSION_STORE } from '../session-store.ts';
import type { PanelProps } from '../types.ts';
import { CaptionsTab } from './CaptionsTab.tsx';
import { textPanelRequests } from './state.ts';
import { TranscriptTab } from './TranscriptTab.tsx';

export function TextPanel(_props: PanelProps) {
	const session = useSessionOrNull();
	const seq = useStoreSelector(session?.store ?? EMPTY_SESSION_STORE, (s: SessionState | null) =>
		s?.activeSequenceId
			? (((s.transient ?? s.document).sequences[s.activeSequenceId] as Sequence | undefined) ?? null)
			: null,
	);
	const [tab, setTab] = useState(() => textPanelRequests.get().tab);
	const [reveal, setReveal] = useState<string | undefined>(() => textPanelRequests.get().clipId);
	const [tool, setTool] = useState(() => ({
		tool: textPanelRequests.get().tool,
		seq: textPanelRequests.get().seq,
	}));
	useEffect(
		() =>
			textPanelRequests.subscribe(() => {
				const r = textPanelRequests.get();
				setTab(r.tab);
				setReveal(r.clipId);
				setTool({ tool: r.tool, seq: r.seq });
			}),
		[],
	);
	if (!session)
		return <EmptyState icon="panel.text" message="Open a project to see its transcript and captions" />;
	if (!seq)
		return <EmptyState icon="panel.text" message="Open a sequence to see its transcript and captions" />;
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="text-panel">
			<Tabs
				className="h-full"
				value={tab}
				onValueChange={(v) => setTab(v as 'transcript' | 'captions' | 'subtitles')}
				items={[
					{
						value: 'transcript',
						label: <span data-testid="text.tab.Transcript">Transcript</span>,
						content: <TranscriptTab session={session} seq={seq} request={tool} />,
					},
					{
						value: 'captions',
						label: <span data-testid="text.tab.Captions">Captions</span>,
						content: <CaptionsTab session={session} seq={seq} reveal={reveal} />,
					},
					{
						value: 'subtitles',
						label: <span data-testid="text.tab.Subtitles">Subtitles</span>,
						content: <SubtitlesTab session={session} seq={seq} />,
					},
				]}
			/>
		</div>
	);
}
