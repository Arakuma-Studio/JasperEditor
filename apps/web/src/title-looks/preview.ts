// Spec 19 TL-088 / TL-095: previews on the selected clip. A preview is the session's derived preview: the committed
// document with some commands applied, drawn by Program and never committed, saved or in History. Hovering starts it
// after a short delay and leaving ends it, so sweeping the pointer across a grid draws nothing.
import type { Command } from '@jasper/project';
import { derivedPreviewFor, type EditorSession } from '@jasper/session';

/** Pause over a card before Program redraws. */
export const PREVIEW_DELAY_MS = 180;

const KIND = 'title-looks.preview';

type Pending = { session: EditorSession; timer: ReturnType<typeof setTimeout> };
let pending: Pending | null = null;
let shown: EditorSession | null = null;

function cancelPending(): void {
	if (pending) clearTimeout(pending.timer);
	pending = null;
}

/** Shows `commands` on the active sequence after the delay; a later call replaces it. */
export function schedulePreview(
	session: EditorSession,
	input: { label: string; commands: Command[] },
	delayMs = PREVIEW_DELAY_MS,
): void {
	cancelPending();
	const timer = setTimeout(() => {
		pending = null;
		const sequenceId = session.getState().activeSequenceId;
		if (!sequenceId) return;
		const r = derivedPreviewFor(session).start({
			label: input.label,
			kind: KIND,
			sequenceId,
			commands: input.commands,
			omitted: [],
		});
		// A refused preview (a locked track, a gesture running) shows nothing: the click would say why.
		shown = r.ok ? session : null;
	}, delayMs);
	pending = { session, timer };
}

/** Ends a preview, or the wait for one. Other derived previews (Clean Up) are left alone. */
export function endPreview(session: EditorSession | null): void {
	cancelPending();
	const s = session ?? shown;
	if (!s) return;
	const c = derivedPreviewFor(s);
	if (c.getState().active?.kind === KIND) c.stop();
	shown = null;
}

/** A look on the targets, for the preview. */
export function lookPreviewCommands(
	clipIds: readonly string[],
	lookId: string,
	colorwayId?: string,
): Command[] {
	return [
		{
			type: 'look.apply',
			clipIds: [...clipIds],
			lookId,
			...(colorwayId ? { colorwayId } : {}),
		} as Command,
	];
}

/** Only the colourway, keeping the clip's own look and overrides. */
export function colorwayPreviewCommands(
	clipIds: readonly string[],
	colorway: { id: string; palette: unknown },
): Command[] {
	return [
		{
			type: 'look.setColorway',
			clipIds: [...clipIds],
			colorwayId: colorway.id,
			palette: colorway.palette,
		} as Command,
	];
}
