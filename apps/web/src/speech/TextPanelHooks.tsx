import type { Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Button } from '@jasper/ui';
import { useSyncExternalStore } from 'react';
import { useCapabilities } from '../state/engine.tsx';
import { transcriptionWatcher } from './jobs.ts';
import { openGenerateTranscript } from './register.ts';

export function GenerateTranscriptButton(props: {
	session: EditorSession;
	seq: Sequence;
	variant: 'primary' | 'quiet';
}) {
	const { flags } = useCapabilities();
	const available = flags.has('transcription');
	return (
		<Button
			variant={props.variant}
			disabled={!available || props.session.getState().readOnly}
			title={
				available ? 'Transcribe the sequence with speech to text' : 'Requires transcription on the engine.'
			}
			onClick={() => openGenerateTranscript(props.session, { kind: 'sequence', sequenceId: props.seq.id })}
			data-testid="text.transcript.generate"
		>
			Generate Transcript…
		</Button>
	);
}

const subscribe = (l: () => void) => transcriptionWatcher.subscribe(l);
let snapshot: ReturnType<typeof transcriptionWatcher.list> = [];
let version = '';
function getSnapshot() {
	const list = transcriptionWatcher.list();
	const v = list.map((w) => `${w.jobId}:${w.progress}:${w.stage}`).join('|');
	if (v !== version) {
		version = v;
		snapshot = list.map((w) => ({ ...w }));
	}
	return snapshot;
}

export function TranscriptionStatus(props: { session: EditorSession; seq: Sequence }) {
	const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	const mine = list.filter(
		(w) =>
			w.session === props.session &&
			(w.target.type === 'sequence'
				? w.target.sequenceId === props.seq.id
				: Object.values(props.seq.clips).some(
						(c) => (c as { mediaId?: string }).mediaId === (w.target as { mediaId: string }).mediaId,
					)),
	);
	if (!mine.length) return null;
	return (
		<div
			className="flex shrink-0 flex-col gap-0.5 border-b border-pr-border-subtle bg-pr-panel-alt px-2 py-1 text-pr-small text-pr-muted"
			data-testid="text.transcript.transcribing"
		>
			{mine.map((w) => (
				<span key={w.jobId}>
					Transcribing {w.target.name} · {w.progress !== null ? `${Math.round(w.progress * 100)} %` : w.stage}
				</span>
			))}
		</div>
	);
}
