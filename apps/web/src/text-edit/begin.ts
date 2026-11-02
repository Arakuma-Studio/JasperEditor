// Opening an in-place text entry (spec 19 TL-085): the Type tool's click and a double-click on a text clip. Refusals
// explain themselves at the pointer, through the same short message as the template text editor.
import type { Clip, Vec2 } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { t } from '../i18n/runtime.ts';
import { activeSequence } from '../panels/program/edits.ts';
import { showTemplateEditMessage } from '../template-edit/store.ts';
import { liveDraft } from './draft.ts';
import { endTextEntry, startTextEntry, textEntryStore } from './store.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;

/** Why this text cannot be typed on the monitor, or null. Subtitles are the Captions panel's. */
function refusal(c: TextClip, trackLocked: boolean): string | null {
	if (trackLocked) return t('The clip’s track is locked');
	if ((c.content as { expression?: { enabled?: boolean } }).expression?.enabled)
		return t('An expression drives this text: edit it in Effect Controls');
	if ((c as { threeD?: unknown }).threeD)
		return t('This text is a 3D layer: edit it in Properties');
	return null;
}

export type BeginTextEntry = {
	point: Vec2;
	frame: number;
	/** The clip under the point, if any: a text clip is edited, anything else gets a new text on top. */
	clipId?: string | null;
	client?: Vec2 | null;
};

/** Opens an entry; true when it did or explained why not. */
export function beginTextEntry(session: EditorSession, o: BeginTextEntry): boolean {
	const seq = activeSequence(session);
	if (!seq) return false;
	const point: Vec2 = [o.point[0], o.point[1]];
	if (session.getState().readOnly) {
		showTemplateEditMessage(session, t('The project is read-only'), point);
		return true;
	}
	// One entry at a time: the open one is finished first, and stays open if that is refused.
	const open = textEntryStore.getState().current;
	if (open) {
		const r = liveDraft()?.commit();
		if (r && !r.ok) return true;
		endTextEntry(open.seq);
	}
	const c = o.clipId ? seq.clips[o.clipId] : undefined;
	const text = c?.kind === 'text' && !(c as { caption?: unknown }).caption ? (c as TextClip) : null;
	if (text) {
		const locked = !!seq.videoTracks.find((tr) => tr.id === text.trackId)?.locked;
		const why = refusal(text, locked);
		if (why) {
			showTemplateEditMessage(session, why, point);
			return true;
		}
		if (session.getState().selection.timeline.clips.join() !== text.id)
			session.select('timeline', [text.id], 'replace', { primary: text.id });
	}
	startTextEntry({
		session,
		clipId: text?.id ?? null,
		point,
		frame: o.frame,
		client: o.client ?? null,
	});
	return true;
}
