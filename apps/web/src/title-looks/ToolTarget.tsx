// Spec 19 TL-092: the tool bar says what the canvas edits: `Clip › Layer`, while a look layer is selected.
import { useSessionState } from '@jasper/session/react';
import { cx } from '@jasper/ui';
import { LIGHT_TARGET, lookFocus, useLookFocus } from './focus.ts';
import { layerName, lookedClip } from './selection.ts';

export function ToolTarget(props: { horizontal: boolean }) {
	const focus = useLookFocus();
	const selected = useSessionState((s) => s.selection.timeline.clips);
	const seqId = useSessionState((s) => s.activeSequenceId);
	const doc = useSessionState((s) => s.document);
	if (!focus || !selected.includes(focus.clipId)) return null;
	const clip = seqId ? doc.sequences[seqId]?.clips[focus.clipId] : undefined;
	const looked = clip ? lookedClip(clip) : null;
	if (!clip || !looked) return null;
	const layer = looked.appearance.layers.find((l) => l.id === focus.target);
	const target =
		focus.target === LIGHT_TARGET
			? 'Light'
			: focus.target === 'palette'
				? 'Colours'
				: layer
					? layerName(layer)
					: null;
	if (!target) return null;
	const text = `${clip.name || clip.kind} › ${target}`;
	return (
		<button
			type="button"
			className={cx(
				'max-h-[200px] max-w-[220px] truncate rounded-pr-control px-1 text-pr-small text-pr-muted hover:text-pr-text',
				!props.horizontal && '[writing-mode:vertical-rl]',
			)}
			title={`Editing ${text}. Click to edit the clip again.`}
			onClick={() => lookFocus.set(null)}
			data-testid="tool-target"
		>
			{text}
		</button>
	);
}
