// Spec 19 TL-086: what clicking a look does. With clips selected it applies to them; with nothing selected it inserts a
// new title at the playhead. Everything is one undo step, and what a person would not expect is said, never hidden:
// keyframes a replaced look took with it, and pictures a look paints over.
import {
	type Clip,
	type Command,
	type ProjectDocument,
	type Sequence,
	type TransactionResult,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { type ToastRequest, toast } from '@jasper/ui';
import { t } from '../i18n/runtime.ts';
import type { LookEntry } from './library.ts';
import { rememberRecent } from './library.ts';
import { lookedClip, takesLook } from './selection.ts';

const TITLE_SECONDS = 5;
/** Sample text of a title a look creates: replaced by typing. */
const NEW_TITLE_TEXT = 'Title';

export type LookRef = Pick<LookEntry, 'lookId' | 'name' | 'recipe'>;

export type LookOutcome =
	| { ok: true; message: string; clipIds: string[]; notices: ToastRequest[] }
	| { ok: false; message: string };

function activeSequence(session: EditorSession): Sequence | null {
	const s = session.getState();
	return s.activeSequenceId ? (s.document.sequences[s.activeSequenceId] ?? null) : null;
}

/** The selected clips of the active sequence. */
export function selectedClips(session: EditorSession): Clip[] {
	const seq = activeSequence(session);
	if (!seq) return [];
	return session
		.getState()
		.selection.timeline.clips.map((id) => seq.clips[id])
		.filter((c): c is Clip => !!c);
}

/** The selected clips a look can go on. */
export function lookTargets(session: EditorSession): Clip[] {
	return selectedClips(session).filter(takesLook);
}

const refusal = (r: TransactionResult) =>
	r.ok ? '' : (r.errors[0]?.message ?? t('The look could not be applied'));

/** A face that paints a colour over the clip's own picture. */
function paintsOverPicture(look: LookRef): boolean {
	return look.recipe.layers.some((l) => {
		if (l.type !== 'face' || l.enabled === false) return false;
		const paint = l.params?.paint as { kind?: string } | undefined;
		return paint?.kind !== 'source';
	});
}

/** Sets the face of these clips to their own picture, in one step. */
function keepPictures(session: EditorSession, clipIds: readonly string[]): void {
	const seq = activeSequence(session);
	if (!seq) return;
	const commands: Command[] = [];
	for (const id of clipIds) {
		const c = seq.clips[id];
		const looked = c ? lookedClip(c) : null;
		if (!looked) continue;
		for (const l of looked.appearance.layers)
			if (l.type === 'face')
				commands.push({
					type: 'appearance.setPaint',
					effectInstanceId: looked.fx.id,
					layerId: l.id,
					paint: { kind: 'source' },
				} as Command);
	}
	if (commands.length) session.apply({ label: 'Keep Clip Picture', origin: 'user', commands });
}

/** What the person should hear about an apply they would otherwise not see. */
function noticesOf(
	session: EditorSession,
	look: LookRef,
	clips: readonly Clip[],
	dropped: number,
): ToastRequest[] {
	const out: ToastRequest[] = [];
	if (dropped > 0)
		out.push({
			kind: 'info',
			title:
				dropped === 1
					? t('{0} replaced the look: 1 keyframe went with it.', look.name)
					: t('{0} replaced the look: {1} keyframes went with it.', look.name, dropped),
		});
	const pictures = clips.filter((c) => c.kind === 'still' || c.kind === 'video').map((c) => c.id);
	if (pictures.length && paintsOverPicture(look))
		out.push({
			kind: 'warning',
			title: t('{0} paints over the picture of the clip.', look.name),
			actions: [{ label: 'Keep Clip Picture', run: () => keepPictures(session, pictures) }],
		});
	return out;
}

/** Applies a look to clips (one undo step). Refusals come back as a message. */
export function applyLookToClips(
	session: EditorSession,
	look: LookRef,
	clipIds: readonly string[],
	colorwayId?: string,
): LookOutcome {
	const seq = activeSequence(session);
	if (!seq) return { ok: false, message: t('Open a sequence first') };
	const clips = clipIds.map((id) => seq.clips[id]).filter((c): c is Clip => !!c);
	const r = session.apply({
		label: t('Apply Look: {0}', look.name),
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			{
				type: 'look.apply',
				clipIds: [...clipIds],
				lookId: look.lookId,
				...(colorwayId ? { colorwayId } : {}),
			} as Command,
		],
	});
	if (!r.ok) return { ok: false, message: refusal(r) };
	rememberRecent(look.lookId);
	const dropped = (r.results[0] as { droppedKeyframes?: number } | undefined)?.droppedKeyframes ?? 0;
	return {
		ok: true,
		clipIds: [...clipIds],
		message:
			clipIds.length === 1
				? t('Applied {0}', look.name)
				: t('Applied {0} to {1} clips', look.name, clipIds.length),
		notices: noticesOf(session, look, clips, dropped),
	};
}

/** First unlocked video track free over the range, else a new track above the top. */
function freeTrack(seq: Sequence, at: number, duration: number, preferred?: readonly string[]): string {
	const busy = (id: string) =>
		Object.values(seq.clips).some((c) => c.trackId === id && c.start < at + duration && c.start + c.duration > at);
	const open = seq.videoTracks.filter((tr) => !tr.locked);
	for (const id of preferred ?? []) if (open.some((tr) => tr.id === id) && !busy(id)) return id;
	for (const tr of open) if (!busy(tr.id)) return tr.id;
	return `V${seq.videoTracks.length + 1}`;
}

/** A new title with the look at the playhead (or `at`): one undo step, and the new clip selected. */
export function insertTitleWithLook(
	session: EditorSession,
	look: LookRef,
	opts: { at?: number; trackId?: string; colorwayId?: string } = {},
): LookOutcome {
	const seq = activeSequence(session);
	if (!seq) return { ok: false, message: t('Open a sequence first') };
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const duration = Math.max(1, Math.round(TITLE_SECONDS * fps));
	const at = Math.max(0, Math.round(opts.at ?? session.transport.getState().frame));
	const view = session.getState().views[seq.id];
	const track = opts.trackId ?? freeTrack(seq, at, duration, view?.targeting.video);
	const r = session.apply({
		label: t('Add Title: {0}', look.name),
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			{
				type: 'clip.addText',
				ref: '$title',
				at,
				duration,
				track,
				content: {
					text: NEW_TITLE_TEXT,
					style: { sizePx: Math.round(seq.settings.height / 8), align: 'center' },
				},
				transform: { position: [seq.settings.width / 2, seq.settings.height / 2] },
			} as Command,
			{
				type: 'look.apply',
				clipIds: ['$title'],
				lookId: look.lookId,
				...(opts.colorwayId ? { colorwayId: opts.colorwayId } : {}),
			} as Command,
		],
	});
	if (!r.ok) return { ok: false, message: refusal(r) };
	const id = r.refs.$title;
	if (!id) return { ok: false, message: t('The title could not be added') };
	session.select('timeline', [id], 'replace');
	rememberRecent(look.lookId);
	return { ok: true, clipIds: [id], message: t('Added a title with {0}', look.name), notices: [] };
}

/**
 * Clicking a look: on the selected clips, or a new title when nothing is selected. A selection that cannot take a look
 * is refused rather than quietly replaced by a new title.
 */
export function pickLook(session: EditorSession, look: LookRef, colorwayId?: string): LookOutcome {
	const selected = selectedClips(session);
	if (selected.length === 0) return insertTitleWithLook(session, look, colorwayId ? { colorwayId } : {});
	const targets = selected.filter(takesLook);
	if (targets.length === 0) return { ok: false, message: t('The selected clips cannot take a look.') };
	return applyLookToClips(
		session,
		look,
		targets.map((c) => c.id),
		colorwayId,
	);
}

/** Shows what an outcome needs to say beyond its status line. */
export function announce(outcome: LookOutcome): void {
	if (outcome.ok) for (const n of outcome.notices) toast(n);
	else toast({ kind: 'error', title: outcome.message });
}

/** Swaps a colourway; clicks in a row are one History entry (`coalesceKey`). */
export function setColorway(
	session: EditorSession,
	clipIds: readonly string[],
	colorway: { id: string; name: string; palette: unknown },
): TransactionResult {
	return session.apply({
		label: t('Colourway: {0}', colorway.name),
		origin: 'user',
		commands: [
			{ type: 'look.setColorway', clipIds: [...clipIds], colorwayId: colorway.id, palette: colorway.palette } as Command,
		],
		coalesceKey: `look.colorway:${clipIds.join(',')}`,
	});
}

/** The next or previous colourway of the list from the current one (wraps). */
export function stepColorway<T extends { id: string }>(
	list: readonly T[],
	currentId: string | undefined,
	dir: 1 | -1,
): T | null {
	if (list.length === 0) return null;
	const i = list.findIndex((c) => c.id === currentId);
	if (i < 0) return dir > 0 ? list[0]! : list[list.length - 1]!;
	return list[(i + dir + list.length) % list.length]!;
}

/** Is the document's sequence showing `clip` at `frame`? Hover previews say so when it is not. */
export function playheadOnClip(clip: Pick<Clip, 'start' | 'duration'>, frame: number): boolean {
	return frame >= clip.start && frame < clip.start + clip.duration;
}

/** Clips of the whole document linked to a look, for delete confirmations. */
export function clipsLinkedTo(doc: ProjectDocument, lookId: string): number {
	let n = 0;
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips))
			if (lookedClip(c as Clip)?.appearance.lookId === lookId) n++;
	return n;
}
