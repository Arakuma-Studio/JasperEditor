// Spec 19 TL-086: a look card dragged to the Timeline, Program or Effect Controls. On a clip that takes a look it applies
// there; on an empty place in the Timeline it inserts a new title.
import type { EditorSession } from '@jasper/session';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import { applyLookToClips, insertTitleWithLook, type LookOutcome } from './actions.ts';
import { type LookEntry, lookEntries } from './library.ts';

export const TITLE_LOOK_MIME = 'application/x-jasper-title-look';

const LookDragSchema = z.object({
	type: z.literal('jasper/title-look'),
	lookId: z.string().min(1).max(128),
	colorwayId: z.string().min(1).max(128).optional(),
});
export type LookDrag = z.infer<typeof LookDragSchema>;

export function writeLookDrag(dt: DataTransfer, lookId: string, colorwayId?: string): void {
	const payload: LookDrag = { type: 'jasper/title-look', lookId, ...(colorwayId ? { colorwayId } : {}) };
	dt.setData(TITLE_LOOK_MIME, JSON.stringify(payload));
	dt.setData('text/plain', lookId);
	dt.effectAllowed = 'copy';
}

/** True while dragging a look (types are readable during dragover, data is not). */
export function isLookDrag(dt: DataTransfer | null): boolean {
	return !!dt && Array.from(dt.types ?? []).includes(TITLE_LOOK_MIME);
}

export function readLookDrag(dt: Pick<DataTransfer, 'getData'> | null): LookDrag | null {
	try {
		const raw = dt?.getData(TITLE_LOOK_MIME);
		if (!raw) return null;
		const r = LookDragSchema.safeParse(JSON.parse(raw));
		return r.success ? r.data : null;
	} catch {
		return null;
	}
}

function entryOf(session: EditorSession, id: string): LookEntry | undefined {
	return lookEntries(session.getCommitted()).find((e) => e.lookId === id);
}

/** A drop on one clip. */
export function dropLookOnClip(session: EditorSession, drag: LookDrag, clipId: string): LookOutcome {
	const look = entryOf(session, drag.lookId);
	if (!look) return { ok: false, message: t('That look is no longer available.') };
	return applyLookToClips(session, look, [clipId], drag.colorwayId);
}

/** A drop on an empty place: a new title there. */
export function dropLookAsTitle(
	session: EditorSession,
	drag: LookDrag,
	place: { at?: number; trackId?: string },
): LookOutcome {
	const look = entryOf(session, drag.lookId);
	if (!look) return { ok: false, message: t('That look is no longer available.') };
	return insertTitleWithLook(session, look, {
		...place,
		...(drag.colorwayId ? { colorwayId: drag.colorwayId } : {}),
	});
}
