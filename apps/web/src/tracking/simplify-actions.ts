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

type Anim = { keyframes?: unknown[] };

/** Number of keyframes of a clip's animated parameters (Motion, opacity, effect params, template params). */
function clipKeyframeCount(clip: Clip): number {
	let n = 0;
	const add = (a: unknown) => {
		const k = (a as Anim | undefined)?.keyframes;
		if (Array.isArray(k)) n += k.length;
	};
	const c = clip as {
		transform?: Record<string, unknown>;
		opacity?: unknown;
		effects?: { params: Record<string, unknown> }[];
		paramKeyframes?: Record<string, unknown[]>;
	};
	for (const v of Object.values(c.transform ?? {})) add(v);
	add(c.opacity);
	for (const fx of c.effects ?? []) for (const a of Object.values(fx.params)) add(a);
	for (const k of Object.values(c.paramKeyframes ?? {})) n += k.length;
	return n;
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
