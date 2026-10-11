// Entry points of "Simplify Keyframes…" (S09:TRK-023, TRU-006): the Tracking section (keys a tracker drives), the
// corner-pin editor, the Effect Controls keyframe menu (selected keys or their parameters), the timeline clip menu
// and the Clip menu command (every keyframed parameter of the selected clips).
import { type Clip, findTracker, type ProjectDocument, trackedTargets } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import {
	SIMPLIFY_DIALOG,
	type SimplifyDialogProps,
	type SimplifySelection,
} from './SimplifyKeyframesDialog.tsx';

function clipKeyframeCount(clip: Clip): number {
	let count = 0;
	// Loose document schemas preserve unknown fields alongside recognized animations.
	const add = (animation: unknown) => {
		if (
			animation !== null &&
			typeof animation === 'object' &&
			'keyframes' in animation &&
			Array.isArray(animation.keyframes)
		)
			count += animation.keyframes.length;
	};
	if ('transform' in clip) for (const animation of Object.values(clip.transform ?? {})) add(animation);
	if ('opacity' in clip) add(clip.opacity);
	if ('effects' in clip && Array.isArray(clip.effects))
		for (const effect of clip.effects)
			for (const animation of Object.values(effect?.params ?? {})) add(animation);
	if ('paramKeyframes' in clip)
		for (const keys of Object.values(clip.paramKeyframes ?? {}))
			if (Array.isArray(keys)) count += keys.length;
	return count;
}

/** True when some parameter of the clip has enough keys to simplify (3 or more). */
export function clipHasDenseKeys(clip: Clip): boolean {
	return clipKeyframeCount(clip) >= 3;
}

export function openSimplify(
	session: EditorSession,
	selection: SimplifySelection,
	subject?: string,
): Promise<unknown> {
	const props: SimplifyDialogProps = { session, selection, ...(subject ? { subject } : {}) };
	return openDialog(SIMPLIFY_DIALOG, props);
}

/** Simplify the keys a tracker baked onto the clips that follow it. */
export function openSimplifyTracker(session: EditorSession, trackerId: string): Promise<unknown> | null {
	const doc: ProjectDocument = session.getState().document;
	const loc = findTracker(doc, trackerId);
	const targets = trackedTargets(doc, trackerId);
	if (!loc || !targets.length) return null;
	const names = targets.map((t) => doc.sequences[t.sequenceId]?.clips[t.clipId]?.name || 'clip');
	return openSimplify(
		session,
		{ clipIds: targets.map((t) => t.clipId), trackedOnly: true },
		`Tracked keyframes of ${names.join(', ')} (driven by ${loc.tracker.name})`,
	);
}

/** Simplify every keyframed parameter of the given clips. */
export function openSimplifyClips(session: EditorSession, clips: readonly Clip[]): Promise<unknown> | null {
	const list = clips.filter(clipHasDenseKeys);
	if (!list.length) return null;
	return openSimplify(
		session,
		{ clipIds: list.map((c) => c.id) },
		list.length === 1
			? `Keyframes of ${list[0]!.name || list[0]!.kind}`
			: `Keyframes of ${list.length} clips`,
	);
}
