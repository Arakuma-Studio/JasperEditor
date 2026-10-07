// edit-ux: one frame of a sequence rendered with the Program monitor's pipeline (buildProgramDoc →
// SequenceComposition in a Remotion <Thumbnail>): the Trim Monitor's outgoing/incoming frames and the comparison
// view's reference frame. `onlyClipIds` renders just those clips (a Trim Monitor side shows its own clip, as in
// Premiere); `options` lets callers bypass features (e.g. colour grading for a before/after reference).
import {
	DEFAULT_RENDER_OPTIONS,
	type RenderDoc,
	type RenderOptions,
	SequenceComposition,
} from '@jasper/compositions';
import type { ProjectDocument } from '@jasper/project';
import { useSessionState } from '@jasper/session/react';
import { Thumbnail } from '@remotion/player';
import { type ComponentType, useMemo, useRef } from 'react';
import { buildProgramDoc, playerDurationFrames } from './render-doc.ts';

export type FrameViewProps = {
	doc: ProjectDocument;
	sequenceId: string;
	frame: number;
	onlyClipIds?: readonly string[];
	options?: Partial<RenderOptions>;
	label: string;
	testId: string;
};

/** The document with sequence `sequenceId` reduced to `clipIds` (no transitions between them). */
export function isolateClips(
	doc: ProjectDocument,
	sequenceId: string,
	clipIds: readonly string[],
): ProjectDocument {
	const seq = doc.sequences[sequenceId];
	if (!seq) return doc;
	const keep = new Set(clipIds);
	const clips = Object.fromEntries(Object.entries(seq.clips).filter(([id]) => keep.has(id)));
	return {
		...doc,
		sequences: { ...doc.sequences, [sequenceId]: { ...seq, clips, transitions: {}, links: {}, groups: {} } },
	};
}

export function FrameView(props: FrameViewProps) {
	const media = useSessionState((s) => s.media);
	const prev = useRef<RenderDoc | null>(null);
	const source = useMemo(
		() => (props.onlyClipIds ? isolateClips(props.doc, props.sequenceId, props.onlyClipIds) : props.doc),
		[props.doc, props.sequenceId, props.onlyClipIds],
	);
	const seq = source.sequences[props.sequenceId];
	const renderDoc = useMemo(() => {
		if (!seq) return null;
		const d = buildProgramDoc({ doc: source, sequenceId: props.sequenceId, media }, prev.current);
		prev.current = d;
		return d;
	}, [source, seq, props.sequenceId, media]);
	const options = useMemo<RenderOptions>(
		() => ({ ...DEFAULT_RENDER_OPTIONS, isPreview: true, ...(props.options ?? {}) }),
		[props.options],
	);
	if (!seq || !renderDoc) return null;
	const duration = Math.max(1, playerDurationFrames(props.doc, props.sequenceId));
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	return (
		<div
			className="relative h-full w-full"
			role="img"
			aria-label={props.label}
			data-testid={props.testId}
			data-frame={props.frame}
		>
			<Thumbnail
				component={SequenceComposition as unknown as ComponentType<Record<string, unknown>>}
				inputProps={{ doc: renderDoc, options } as Record<string, unknown>}
				durationInFrames={duration}
				fps={fps}
				compositionWidth={seq.settings.width}
				compositionHeight={seq.settings.height}
				frameToDisplay={Math.max(0, Math.min(duration - 1, Math.round(props.frame)))}
				style={{ width: '100%', height: '100%' }}
			/>
		</div>
	);
}
