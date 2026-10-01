// Effect Controls editor of `jasper.lumetri` (S06:CGU-002): the curves and colour wheels that the generic rows
// cannot show (`hideParams` = LUMETRI_EDITOR_PARAMS); the scalar and LUT params stay generic rows with their
// keyframe lanes. Registered from commands/color.ts.
import { useSessionState } from '@jasper/session/react';
import type { EffectEditorProps } from '../extensions/index.ts';
import { useNotices } from '../panels/properties/controls/Notices.tsx';
import { useInspectorOps } from '../panels/properties/lib/ops.ts';
import { LumetriEditor } from './LumetriEditor.tsx';

export function LumetriEffectEditor(props: EffectEditorProps) {
	const doc = useSessionState((s) => s.transient ?? s.document);
	const ops = useInspectorOps(props.session);
	const notices = useNotices();
	const seq = doc.sequences[props.sequenceId];
	const clip = seq?.clips[props.clip.id];
	if (!seq || !clip) return null;
	const fx =
		((clip as { effects?: (typeof props.fx)[] }).effects ?? []).find((e) => e.id === props.fx.id) ?? props.fx;
	return (
		<div className="border-b border-pr-border-subtle pl-5" data-testid="lumetri-ec-editor">
			{notices.element}
			<LumetriEditor
				session={props.session}
				doc={doc}
				seq={seq}
				clip={clip}
				fx={fx}
				effect={props.effect}
				frame={props.frame}
				ops={ops}
				host={props.host}
				hint={notices.hint}
				confirmStopwatchOff={notices.confirmStopwatchOff}
			/>
		</div>
	);
}
