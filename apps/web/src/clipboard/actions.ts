// Clipboard actions per panel (S01 §20, S03:XF-050, EC-023/032, FX-011/012): Copy / Cut / Paste / Paste Insert /
// Paste Attributes / Remove Attributes for the focused panel. The Timeline and the Program monitor copy clips,
// Effect Controls copies keyframes or effects, the Project panel copies items (S01:SEL-001: the focused panel
// decides). Copies read the committed document (SES-007); every paste is one document command, so one undo step
// (CMD-001), and the selection follows the pasted content (SEL-006).
import {
	buildClipsPayload,
	buildEffectsPayload,
	buildItemsPayload,
	buildKeyframesPayload,
	type Clip,
	type ClipboardPayload,
	type Command,
	type ParamPath,
	type Sequence,
	type TransactionResult,
} from '@jasper/project';
import type { EditorSession, SequenceViewState } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import type { CommandCtx } from '../commands/types.ts';
import { deleteItems } from '../panels/project/actions.ts';
import { getProjectPanel } from '../panels/project/instances.ts';
import { inspectorFocus } from '../panels/properties/lib/focus.ts';
import { rowForKey } from '../panels/properties/lib/model.ts';
import { activeTimeline } from '../panels/timeline/env.tsx';
import {
	type AttributesDialogResult,
	PASTE_ATTRIBUTES_DIALOG,
	REMOVE_ATTRIBUTES_DIALOG,
} from './AttributesDialog.tsx';
import {
	pasteAttributeOptions,
	removeAttributeOptions,
	toPasteAttributes,
	toRemoveAttributes,
} from './attributes.ts';
import { pasteExternal } from './external.ts';
import {
	type ClipboardData,
	type PasteSource,
	pasteSourceOf,
	readSystemClipboard,
	withDesktopFiles,
	writeClipboard,
} from './system.ts';

export type ClipboardTarget = 'timeline' | 'effectControls' | 'project';
export type ClipboardArgs = { clipboard?: ClipboardData | null; event?: ClipboardEvent };

/** Which panel's clipboard a global Edit command acts on (S01:SEL-001). */
export function clipboardTarget(ctx: CommandCtx): ClipboardTarget | null {
	switch (ctx.focus.panel) {
		case 'project':
			return 'project';
		case 'effectControls':
			return 'effectControls';
		case 'timeline':
		case 'program':
			return 'timeline';
		default:
			return ctx.session && activeSeq(ctx) ? 'timeline' : null;
	}
}

type Env = { session: EditorSession; seq: Sequence; view: SequenceViewState | undefined; playhead: number };

function activeSeq(ctx: CommandCtx): Sequence | null {
	const session = ctx.session;
	if (!session) return null;
	const id = activeTimeline(ctx.services)?.sequenceId() ?? session.getState().activeSequenceId;
	return id ? ((session.getCommitted().sequences[id] as Sequence | undefined) ?? null) : null;
}

function envOf(ctx: CommandCtx): Env | null {
	const seq = activeSeq(ctx);
	if (!ctx.session || !seq) return null;
	return {
		session: ctx.session,
		seq,
		view: ctx.session.getState().views[seq.id],
		playhead: ctx.transport.getState().frame,
	};
}

const selectedClips = (e: Env): Clip[] =>
	e.session
		.getState()
		.selection.timeline.clips.map((id) => e.seq.clips[id])
		.filter((c): c is Clip => !!c);

function primaryClip(e: Env): Clip | null {
	const sel = e.session.getState().selection.timeline;
	const id = sel.primaryClip ?? sel.clips[sel.clips.length - 1];
	return (id && e.seq.clips[id]) || null;
}

/** Why mutating clipboard commands are disabled (S05:SH-031), else undefined. */
export function editBlocked(ctx: CommandCtx): string | undefined {
	const s = ctx.session?.getState();
	if (!ctx.session || !s) return 'Open a project first';
	if (s.readOnly) return 'The project is open read-only';
	if (s.gesture) return 'Finish the current drag first';
	return undefined;
}

/** What Copy would copy in this panel, or why it cannot. */
function copyPayload(ctx: CommandCtx, target: ClipboardTarget): ClipboardPayload | string {
	const session = ctx.session;
	if (!session) return 'Open a project first';
	const doc = session.getCommitted();
	const now = new Date().toISOString();
	if (target === 'project') {
		const items = session.getState().selection.project.items.filter((id) => doc.items[id]);
		if (!items.length) return 'Select project items to copy';
		return buildItemsPayload(doc, items, { now });
	}
	const e = envOf(ctx);
	if (!e) return 'Open a sequence first';
	if (target === 'timeline') {
		const clips = selectedClips(e);
		if (!clips.length) return 'Select clips to copy';
		return buildClipsPayload(
			doc,
			e.seq.id,
			clips.map((c) => c.id),
			{
				primaryClipId: e.session.getState().selection.timeline.primaryClip,
				now,
			},
		);
	}
	const primary = primaryClip(e);
	if (!primary) return 'Select a clip first';
	const keys = session.getState().selection.keyframes;
	if (keys?.keyframeIds.length && e.seq.clips[keys.clipOrTrackId]) {
		try {
			return buildKeyframesPayload(doc, keys.clipOrTrackId, keys.keyframeIds, { now });
		} catch {
			// stale key selection: fall back to the effects
		}
	}
	const fx = selectedEffect(e, primary);
	const effects = (primary as { effects?: { id: string }[] }).effects ?? [];
	if (!fx && !effects.length) return 'Select an effect or keyframes to copy';
	return buildEffectsPayload(doc, primary.id, { effectIds: fx ? [fx] : undefined, now });
}

/** The effect selected in Effect Controls when it belongs to `clip`. */
function selectedEffect(_e: Env, clip: Clip): string | null {
	const f = inspectorFocus.get();
	const id = f.source === 'effectControls' ? f.effectInstanceId : null;
	return id && ((clip as { effects?: { id: string }[] }).effects ?? []).some((x) => x.id === id) ? id : null;
}

export function copySelection(ctx: CommandCtx, target: ClipboardTarget, args: ClipboardArgs = {}): boolean {
	const p = copyPayload(ctx, target);
	if (typeof p === 'string') {
		ctx.ui.toast({ kind: 'info', message: p });
		return false;
	}
	writeClipboard(p, { event: args.event });
	return true;
}

/** Cut = Copy + Clear; on the Timeline a lift that leaves a gap (CLB-011). */
export function cutSelection(ctx: CommandCtx, target: ClipboardTarget, args: ClipboardArgs = {}): void {
	const blocked = editBlocked(ctx);
	if (blocked) {
		ctx.ui.toast({ kind: 'info', message: blocked });
		return;
	}
	const p = copyPayload(ctx, target);
	if (typeof p === 'string') {
		ctx.ui.toast({ kind: 'info', message: p });
		return;
	}
	const session = ctx.session!;
	if (target === 'effectControls' && p.kind === 'effects') {
		const e = envOf(ctx);
		const clip = e && primaryClip(e);
		if (!e || !clip || !selectedEffect(e, clip)) {
			ctx.ui.toast({ kind: 'info', message: 'Select an effect or keyframes to cut' });
			return;
		}
	}
	if (target === 'project') {
		writeClipboard(p, { event: args.event });
		// Only the selected items: the payload's extra roots (nested sequences' items) stay in the project.
		const doc = session.getCommitted();
		deleteItems(
			session,
			session.getState().selection.project.items.filter((id) => doc.items[id]),
		);
		return;
	}
	let commands: Command[] = [];
	if (p.kind === 'clips')
		commands = [{ type: 'clip.lift', clipIds: p.clips!.clips.map((c) => c.id), groups: false } as Command];
	else if (p.kind === 'keyframes') {
		commands = [
			{
				type: 'keyframe.remove',
				keyframeIds: p.keyframes!.tracks.flatMap((t) => t.keyframes.map((k) => k.id)),
			} as Command,
		];
	} else if (p.kind === 'effects')
		commands = p.effects!.effects.map(
			(fx) => ({ type: 'effect.remove', effectInstanceId: fx.id }) as Command,
		);
	writeClipboard(p, { event: args.event });
	if (!commands.length) return;
	const r = session.apply({ label: 'Cut', origin: 'user', commands });
	if (!r.ok) report(ctx, 'Cut', r);
	else if (p.kind === 'keyframes') session.selectKeyframes(null);
}

async function sourceOf(args: ClipboardArgs): Promise<PasteSource> {
	// CLB-010: a paste event without files may still have desktop file-manager files on the OS clipboard.
	return pasteSourceOf(args.clipboard ? await withDesktopFiles(args.clipboard) : await readSystemClipboard());
}

function report(ctx: CommandCtx, label: string, r: TransactionResult | null): void {
	if (!r) return;
	if (!r.ok) {
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r.errors[0]?.message });
		return;
	}
	const w = r.warnings.find((x) => x.code === 'W_CLIP_SKIPPED' || x.code === 'W_TRANSITION_REMOVED');
	if (w) ctx.ui.toast({ kind: 'info', message: label, detail: w.message });
}

function noPayload(ctx: CommandCtx, src: Exclude<PasteSource, { kind: 'payload' }>): void {
	if (src.kind === 'error') ctx.ui.toast({ kind: 'error', message: 'Cannot paste', detail: src.message });
	else if (src.kind === 'external')
		ctx.ui.toast({
			kind: 'info',
			message: 'The clipboard holds no JasperEditor content',
			detail: 'Copy clips, effects, keyframes or project items in JasperEditor first.',
		});
	else ctx.ui.toast({ kind: 'info', message: 'Nothing to paste' });
}

/** Lowest targeted track of a kind as a label (CLB-003); V1 / A1 when nothing of that kind is targeted. */
function lowestTargeted(e: Env, kind: 'video' | 'audio'): string {
	const list = kind === 'video' ? e.seq.videoTracks : e.seq.audioTracks;
	const targeted = new Set(e.view?.targeting[kind] ?? []);
	const i = list.findIndex((t) => targeted.has(t.id) && !t.locked);
	return `${kind === 'video' ? 'V' : 'A'}${(i < 0 ? 0 : i) + 1}`;
}

/** The ParamPath of the property row focused in Effect Controls / Properties, for keyframe pastes. */
function focusedParam(e: Env, clip: Clip): ParamPath | undefined {
	const f = inspectorFocus.get();
	if (!f.rowId || !f.clipIds.includes(clip.id)) return undefined;
	const row = rowForKey(e.session.getCommitted(), e.seq, [clip], f.rowId, e.playhead, {
		effects: e.session.ctx.registries.effects,
		mg: e.session.ctx.registries.mgTemplates,
	});
	return (row?.bindings.find((b) => b.clip.id === clip.id)?.path as ParamPath | undefined) ?? undefined;
}

export async function pasteInto(
	ctx: CommandCtx,
	target: ClipboardTarget,
	mode: 'overwrite' | 'insert',
	args: ClipboardArgs = {},
): Promise<void> {
	const blocked = editBlocked(ctx);
	if (blocked) {
		ctx.ui.toast({ kind: 'info', message: blocked });
		return;
	}
	const src = await sourceOf(args);
	if (src.kind === 'external') {
		// CLB-010: files, image data and text from other apps.
		const seq = activeSeq(ctx);
		const session = ctx.session!;
		return pasteExternal(
			ctx,
			{
				session,
				seq,
				view: seq ? session.getState().views[seq.id] : undefined,
				playhead: ctx.transport.getState().frame,
			},
			mode,
			src.content,
		);
	}
	if (src.kind !== 'payload') return noPayload(ctx, src);
	const p = src.payload;
	const session = ctx.session!;
	if (target === 'project') {
		if (p.kind !== 'project-items') {
			ctx.ui.toast({ kind: 'info', message: 'Paste clips, effects and keyframes in the Timeline' });
			return;
		}
		const panel = getProjectPanel(ctx.focus.panel === 'project' ? ctx.focus.instanceId : null);
		const doc = session.getCommitted();
		const sel = session.getState().selection.project;
		const selectedBin = sel.primary && doc.items[sel.primary]?.kind === 'bin' ? sel.primary : null;
		const binId = selectedBin ?? panel?.getBinId() ?? null;
		const r = session.apply({
			label: 'Paste',
			origin: 'user',
			commands: [{ type: 'project.pasteItems', payload: p, binId }],
			selectAfter: (res) => ({ project: (res.results[0] as { itemIds: string[] }).itemIds }),
		});
		report(ctx, 'Paste', r);
		return;
	}
	const e = envOf(ctx);
	if (!e) {
		ctx.ui.toast({ kind: 'info', message: 'Open a sequence first' });
		return;
	}
	if (p.kind === 'project-items') {
		ctx.ui.toast({ kind: 'info', message: 'Paste project items in the Project panel' });
		return;
	}
	if (p.kind === 'clips' && target === 'timeline') {
		const label = mode === 'insert' ? 'Paste Insert' : 'Paste';
		const r = session.apply({
			label,
			origin: 'user',
			sequenceId: e.seq.id,
			commands: [
				{
					type: 'clip.paste',
					payload: p,
					at: e.playhead,
					mode,
					tracks: { video: lowestTargeted(e, 'video'), audio: lowestTargeted(e, 'audio') },
				},
			],
			selectAfter: (res) => ({ timeline: (res.results[0] as { clipIds: string[] }).clipIds }),
		});
		report(ctx, label, r);
		if (r.ok) {
			// CLB-003: the playhead moves to the end of the pasted content.
			const end = (r.results[0] as { end: number }).end;
			ctx.transport.seek(end);
			activeTimeline(ctx.services)?.controller.reveal(end);
		}
		return;
	}
	if (p.kind === 'keyframes') {
		const clip = primaryClip(e);
		if (!clip) {
			ctx.ui.toast({ kind: 'info', message: 'Select a clip to paste keyframes onto' });
			return;
		}
		const targetPath = focusedParam(e, clip);
		const r = session.apply({
			label: 'Paste Keyframes',
			origin: 'user',
			sequenceId: e.seq.id,
			commands: [
				{
					type: 'keyframe.paste',
					payload: p,
					clipId: clip.id,
					at: { sequenceFrame: e.playhead },
					...(targetPath ? { target: targetPath } : {}),
				},
			],
		});
		report(ctx, 'Paste Keyframes', r);
		if (r.ok)
			session.selectKeyframes({
				clipOrTrackId: clip.id,
				keyframeIds: (r.results[0] as { keyframeIds: string[] }).keyframeIds,
			});
		return;
	}
	// Effects (or the effects of copied clips, in Effect Controls) go onto every selected clip (EC-032).
	const targets = selectedClips(e);
	if (!targets.length) {
		ctx.ui.toast({ kind: 'info', message: 'Select clips to paste the effects onto' });
		return;
	}
	const r = session.apply({
		label: 'Paste Effects',
		origin: 'user',
		sequenceId: e.seq.id,
		commands: [{ type: 'effect.paste', payload: p, clipIds: targets.map((c) => c.id) }],
	});
	report(ctx, 'Paste Effects', r);
}

export async function pasteAttributes(ctx: CommandCtx, args: ClipboardArgs = {}): Promise<void> {
	const blocked = editBlocked(ctx);
	const e = envOf(ctx);
	if (blocked || !e) {
		ctx.ui.toast({ kind: 'info', message: blocked ?? 'Open a sequence first' });
		return;
	}
	const targets = selectedClips(e);
	if (!targets.length) {
		ctx.ui.toast({ kind: 'info', message: 'Select the clips to paste attributes onto' });
		return;
	}
	const src = await sourceOf(args);
	if (src.kind !== 'payload') return noPayload(ctx, src);
	const p = src.payload;
	if (p.kind !== 'clips' && p.kind !== 'effects') {
		ctx.ui.toast({
			kind: 'info',
			message: 'Copy a clip first',
			detail: 'Paste Attributes takes the attributes of a copied clip.',
		});
		return;
	}
	const options = pasteAttributeOptions(p, targets, e.session.ctx.registries.effects);
	const sourceName =
		p.kind === 'clips'
			? (p.clips!.clips.find((c) => c.id === p.clips!.primaryClipId) ?? p.clips!.clips[0])?.name
			: undefined;
	const res = await openDialog<AttributesDialogResult>(PASTE_ATTRIBUTES_DIALOG, {
		mode: 'paste',
		options,
		sourceName,
		targetCount: targets.length,
	});
	if (!res?.keys.length) return;
	const r = e.session.apply({
		label: 'Paste Attributes',
		origin: 'user',
		sequenceId: e.seq.id,
		commands: [
			{
				type: 'clip.pasteAttributes',
				payload: p,
				clipIds: targets.map((c) => c.id),
				attributes: toPasteAttributes(res.keys),
				scaleTimes: res.scaleTimes,
			},
		],
	});
	report(ctx, 'Paste Attributes', r);
}

export async function removeAttributes(ctx: CommandCtx): Promise<void> {
	const blocked = editBlocked(ctx);
	const e = envOf(ctx);
	if (blocked || !e) {
		ctx.ui.toast({ kind: 'info', message: blocked ?? 'Open a sequence first' });
		return;
	}
	const targets = selectedClips(e);
	if (!targets.length) {
		ctx.ui.toast({ kind: 'info', message: 'Select clips first' });
		return;
	}
	const options = removeAttributeOptions(targets, e.session.ctx.registries.effects);
	const res = await openDialog<AttributesDialogResult>(REMOVE_ATTRIBUTES_DIALOG, {
		mode: 'remove',
		options,
		targetCount: targets.length,
	});
	if (!res?.keys.length) return;
	const r = e.session.apply({
		label: 'Remove Attributes',
		origin: 'user',
		sequenceId: e.seq.id,
		commands: [
			{
				type: 'clip.removeAttributes',
				clipIds: targets.map((c) => c.id),
				attributes: toRemoveAttributes(res.keys),
			},
		],
	});
	report(ctx, 'Remove Attributes', r);
}

/** Why Copy is disabled in the target panel, else undefined. */
export function copyBlocked(ctx: CommandCtx, target: ClipboardTarget | null): string | undefined {
	if (!ctx.session) return 'Open a project first';
	if (!target) return 'Nothing to copy here';
	const s = ctx.session.getState();
	if (target === 'project')
		return s.selection.project.items.length ? undefined : 'Select project items to copy';
	const e = envOf(ctx);
	if (!e) return 'Open a sequence first';
	if (target === 'timeline') return selectedClips(e).length ? undefined : 'Select clips to copy';
	return primaryClip(e) ? undefined : 'Select a clip first';
}

/** Why Paste is disabled in the target panel, else undefined (the clipboard itself is read on paste). */
export function pasteBlocked(ctx: CommandCtx, target: ClipboardTarget | null): string | undefined {
	const b = editBlocked(ctx);
	if (b) return b;
	if (!target) return 'Nothing to paste into here';
	if (target === 'project') return undefined;
	const e = envOf(ctx);
	if (!e) return 'Open a sequence first';
	if (target === 'effectControls' && !primaryClip(e)) return 'Select a clip first';
	return undefined;
}

/** Why Paste / Remove Attributes are disabled, else undefined. */
export function attributesBlocked(ctx: CommandCtx): string | undefined {
	const b = editBlocked(ctx);
	if (b) return b;
	const e = envOf(ctx);
	if (!e) return 'Open a sequence first';
	return selectedClips(e).length ? undefined : 'Select the target clips first';
}
