// Text animator actions shared by the Text Animations tab, the Properties / Effect Controls sections, the
// commands, the clip context menu and the drop targets (S11:TXA-020…024). Every edit is one `clip.update
// {textAnimation}` transaction for all target clips (one undo step).
//
// Drag contract: dragging a preset card puts
//   DataTransfer['application/x-jasper-text-anim'] = JSON.stringify({type: 'jasper/text-anim', preset, version})
// Drop targets (Timeline, Program, Effect Controls) apply it to the text clip under the pointer; the side is
// chosen by the drop position (first half of the clip = In, second half = Out).
import {
	type Clip,
	latestTextAnimationSpec,
	type Sequence,
	TEXT_ANIMATION_SIDES,
	type TextAnimationSide,
	type TransactionResult,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';

export const TEXT_ANIM_MIME = 'application/x-jasper-text-anim';

export type TextAnimRef = { preset: string; version: number };
type TextAnimDragPayload = TextAnimRef & { type: 'jasper/text-anim' };

export function writeTextAnimationDrag(dt: DataTransfer, ref: TextAnimRef): void {
	const payload: TextAnimDragPayload = { type: 'jasper/text-anim', ...ref };
	dt.setData(TEXT_ANIM_MIME, JSON.stringify(payload));
	dt.setData('text/plain', `${ref.preset}@${ref.version}`);
	dt.effectAllowed = 'copy';
}

/** True while dragging a preset (types are readable during dragover, data is not). */
export function isTextAnimationDrag(dt: DataTransfer | null): boolean {
	return !!dt && Array.from(dt.types ?? []).includes(TEXT_ANIM_MIME);
}

export function readTextAnimationDrag(dt: Pick<DataTransfer, 'getData'> | null): TextAnimRef | null {
	try {
		const raw = dt?.getData(TEXT_ANIM_MIME);
		if (!raw) return null;
		const p = JSON.parse(raw) as Partial<TextAnimDragPayload>;
		return p.type === 'jasper/text-anim' && typeof p.preset === 'string' && typeof p.version === 'number'
			? { preset: p.preset, version: p.version }
			: null;
	} catch {
		return null;
	}
}

export type AnimationSide = TextAnimationSide | 'both';

const sidesOf = (side: AnimationSide): TextAnimationSide[] =>
	side === 'both' ? [...TEXT_ANIMATION_SIDES] : [side];

/** Side picked by a drop at a sequence frame over a clip: first half = In, second half = Out (TXA-020). */
export function dropSide(clip: Pick<Clip, 'start' | 'duration'>, frame: number): TextAnimationSide {
	return frame < clip.start + clip.duration / 2 ? 'in' : 'out';
}

/** Text clips among ids of the active sequence (committed document). */
export function textClipIds(session: EditorSession, ids: readonly string[]): string[] {
	const seq = activeSequence(session);
	return seq ? ids.filter((id) => seq.clips[id]?.kind === 'text') : [];
}

export function activeSequence(session: EditorSession): Sequence | null {
	const id = session.getState().activeSequenceId;
	return id ? (session.getCommitted().sequences[id] ?? null) : null;
}

/** The selected text clips of the active sequence. */
export function selectedTextClips(session: EditorSession): string[] {
	return textClipIds(session, session.getState().selection.timeline.clips);
}

export type ApplyAnimationArgs = {
	side: AnimationSide;
	preset: string;
	version?: number;
	durationFrames?: number;
	params?: Record<string, unknown>;
};

const presetLabel = (preset: string) => latestTextAnimationSpec(preset)?.label ?? preset;

/** Applies a preset to one or both sides of the clips (params reset to the preset's defaults ⊕ `params`). */
export function applyTextAnimation(
	session: EditorSession,
	clipIds: readonly string[],
	a: ApplyAnimationArgs,
): TransactionResult | null {
	const ids = textClipIds(session, clipIds);
	if (!ids.length) return null;
	const side = {
		preset: a.preset,
		...(a.version !== undefined ? { version: a.version } : {}),
		...(a.durationFrames !== undefined ? { durationFrames: a.durationFrames } : {}),
		...(a.params ? { params: a.params } : {}),
	};
	const which = a.side === 'both' ? '' : a.side === 'in' ? ' In' : ' Out';
	return session.apply({
		label: `Apply ${presetLabel(a.preset)}${which}`,
		origin: 'user',
		commands: [
			{
				type: 'clip.update',
				clipIds: ids,
				patch: { textAnimation: Object.fromEntries(sidesOf(a.side).map((s) => [s, side])) },
			},
		],
	});
}

/** Removes one or both sides from the clips. */
export function removeTextAnimation(
	session: EditorSession,
	clipIds: readonly string[],
	side: AnimationSide,
): TransactionResult | null {
	const ids = textClipIds(session, clipIds);
	if (!ids.length) return null;
	return session.apply({
		label: side === 'both' ? 'Remove Text Animation' : `Remove ${side === 'in' ? 'In' : 'Out'} Animation`,
		origin: 'user',
		commands: [
			{
				type: 'clip.update',
				clipIds: ids,
				patch: {
					textAnimation: side === 'both' ? null : { [side]: null },
				},
			},
		],
	});
}

/** One message for a refused or warned apply (toasts, panel notices); null when it went through cleanly. */
export function applyMessage(
	r: TransactionResult | null,
): { kind: 'warning' | 'error'; text: string } | null {
	if (!r) return { kind: 'warning', text: 'Select a text clip first' };
	if (!r.ok) return { kind: 'error', text: r.errors[0]?.message ?? 'The animation could not be applied' };
	const w = r.warnings.find((x) => x.code === 'W_ANIMATION_COMPRESSED');
	return w
		? { kind: 'warning', text: 'In and Out are longer than the clip; they are shortened to fit' }
		: null;
}
