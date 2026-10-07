// External clipboard content (S01:CLB-010, wp-clipboard-2): what JasperEditor does with content another app put
// on the clipboard. Files are imported (LIFE-010; desktop file paths register in place, S04:IN-003) and, with
// the Timeline or Program monitor focused, placed at the playhead on the lowest targeted tracks; image data
// (a copied bitmap) is uploaded as an image asset named "Pasted image <time>" and placed the same way; plain
// text with the Timeline or Program monitor focused becomes a 5 s text clip at the playhead on the lowest
// targeted video track, centred (DM-004 default placement). Each paste that changes the document is one
// transaction (the import's "Import N files", or "Paste Text"), so one undo step (CMD-001).
import {
	type Command,
	looksLikeSvg,
	parseSvgPath,
	type Sequence,
	svgPathToShapeItems,
	svgToShapeContents,
} from '@jasper/project';
import { selectedVectorClip } from '../shapes/vector.ts';
import type { EditorSession, SequenceViewState } from '@jasper/session';
import type { CommandCtx } from '../commands/types.ts';
import { EngineImportService } from '../import/service.ts';
import { activeProjectBin, getProjectPanel } from '../panels/project/instances.ts';
import { getImportService, type ImportTarget } from '../state/services.ts';
import { type ExternalContent, imageExtension } from './system.ts';

/** Default length of a pasted text clip (CLB-010; the default graphic duration of XF-060). */
const PASTED_TEXT_SECONDS = 5;
/** Longer clipboard text is cut (a text clip is a title, not a document). */
const MAX_PASTED_TEXT = 5000;

export type ExternalPasteEnv = {
	session: EditorSession;
	seq: Sequence | null;
	view: SequenceViewState | undefined;
	playhead: number;
};

/** "Pasted image 2026-10-01 14.03.22" in local time (CLB-010). */
function pastedImageName(now: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
	return `Pasted image ${date} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`;
}

/** Clipboard text as a title: unified line ends, no trailing blanks, capped at MAX_PASTED_TEXT characters. */
function normalizePastedText(raw: string): { text: string; truncated: boolean } {
	const text = raw
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/^\n+|\n+$/g, '');
	if (text.length <= MAX_PASTED_TEXT) return { text, truncated: false };
	return { text: text.slice(0, MAX_PASTED_TEXT), truncated: true };
}

/** Lowest targeted unlocked track of a kind (CLB-003); the lowest unlocked one when none is targeted. */
function lowestTargetedTrack(
	seq: Sequence,
	view: SequenceViewState | undefined,
	kind: 'video' | 'audio',
): { id: string; label: string } | null {
	const list = kind === 'video' ? seq.videoTracks : seq.audioTracks;
	const targeted = new Set(view?.targeting[kind] ?? []);
	let i = list.findIndex((t) => targeted.has(t.id) && !t.locked);
	if (i < 0) i = list.findIndex((t) => !t.locked);
	if (i < 0) return null;
	return { id: list[i]!.id, label: `${kind === 'video' ? 'V' : 'A'}${i + 1}` };
}

/** The `clip.addText` command for pasted text (5 s at the playhead, default centred transform). */
function pastedTextCommand(seq: Sequence, track: string, at: number, text: string): Command {
	const rate = seq.settings.frameRate;
	const duration = Math.max(1, Math.round((PASTED_TEXT_SECONDS * rate.num) / rate.den));
	return {
		type: 'clip.addText',
		sequenceId: seq.id,
		at,
		duration,
		track,
		content: { text },
	} as Command;
}

/** The bin non-placed imports go to: the selected bin in a focused Project panel, else its current bin. */
function binFor(ctx: CommandCtx, session: EditorSession): string | null {
	const doc = session.getCommitted();
	if (ctx.focus.panel === 'project') {
		const sel = session.getState().selection.project;
		if (sel.primary && doc.items[sel.primary]?.kind === 'bin') return sel.primary;
		return getProjectPanel(ctx.focus.instanceId)?.getBinId() ?? null;
	}
	return activeProjectBin();
}

/** Runs a CLB-010 paste of foreign clipboard content. */
export async function pasteExternal(
	ctx: CommandCtx,
	env: ExternalPasteEnv,
	mode: 'overwrite' | 'insert',
	content: ExternalContent,
	now: Date = new Date(),
): Promise<void> {
	const { session, seq } = env;
	const place = (ctx.focus.panel === 'timeline' || ctx.focus.panel === 'program') && !!seq;
	const fileCount = content.files.length + content.paths.length + content.images.length;

	if (fileCount > 0) {
		const base = pastedImageName(now);
		const images = content.images.map((img, i) => {
			const name = content.images.length > 1 ? `${base} (${i + 1})` : base;
			const ext = imageExtension(img.type || 'image/png');
			return { file: new File([img], `${name}.${ext}`, { type: img.type || 'image/png' }), name };
		});
		const files = [...content.files, ...images.map((x) => x.file)];
		const names = [...content.files.map(() => undefined), ...images.map((x) => x.name)];
		let target: ImportTarget = { kind: 'bin', binId: binFor(ctx, session) };
		if (place && seq) {
			const video = lowestTargetedTrack(seq, env.view, 'video');
			const audio = lowestTargetedTrack(seq, env.view, 'audio');
			if (video)
				target = {
					kind: 'timeline',
					sequenceId: seq.id,
					at: env.playhead,
					trackId: video.id,
					mode,
					...(audio ? { audioTrackId: audio.id } : {}),
				};
		}
		try {
			const service = getImportService() ?? new EngineImportService({ engine: ctx.engine, session });
			const r = await service.importFiles(
				{
					...(files.length ? { files, names } : {}),
					...(content.paths.length ? { paths: content.paths } : {}),
				},
				target,
			);
			const n = r.mediaIds.length;
			if (n)
				ctx.ui.toast({
					kind: 'success',
					message: `Pasted ${n} ${n === 1 ? 'file' : 'files'}${target.kind === 'timeline' ? ' at the playhead' : ' into the project'}`,
				});
		} catch (e) {
			ctx.ui.toast({
				kind: 'error',
				message: 'Paste failed',
				detail: e instanceof Error ? e.message : String(e),
			});
		}
		return;
	}

	if (content.text === null) {
		ctx.ui.toast({
			kind: 'info',
			message: 'The clipboard holds nothing JasperEditor can paste',
			detail: 'Paste files, images, text, or clips copied in JasperEditor.',
		});
		return;
	}
	if (!place || !seq) {
		ctx.ui.toast({
			kind: 'info',
			message: 'Click the Timeline or Program monitor to paste text',
			detail: 'Text pastes as a text clip at the playhead.',
		});
		return;
	}
	if (mode === 'insert') {
		ctx.ui.toast({
			kind: 'info',
			message: 'Paste Insert takes clips and files',
			detail: 'Use Paste (Ctrl+V) to add the text as a text clip.',
		});
		return;
	}
	// wp shapes: SVG markup or SVG path data pastes as a vector shape (into the selected vector shape when one is
	// under the playhead, else a new shape clip at the playhead), one undo step.
	if (pasteSvg(ctx, env, content.text)) return;
	const { text, truncated } = normalizePastedText(content.text);
	if (!text) {
		ctx.ui.toast({ kind: 'info', message: 'The clipboard text is empty' });
		return;
	}
	const track = lowestTargetedTrack(seq, env.view, 'video');
	if (!track) {
		ctx.ui.toast({
			kind: 'warning',
			message: 'Paste Text: not possible',
			detail: 'Every video track is locked',
		});
		return;
	}
	const r = session.apply({
		label: 'Paste Text',
		origin: 'user',
		sequenceId: seq.id,
		commands: [pastedTextCommand(seq, track.label, env.playhead, text)],
		selectAfter: (res) => ({ timeline: [(res.results[0] as { clipId: string }).clipId] }),
	});
	if (!r.ok) {
		ctx.ui.toast({ kind: 'warning', message: 'Paste Text: not possible', detail: r.errors[0]?.message });
		return;
	}
	if (truncated)
		ctx.ui.toast({
			kind: 'info',
			message: 'Paste Text',
			detail: `The text was shortened to ${MAX_PASTED_TEXT} characters.`,
		});
}

/** SVG path data on its own ("M10 10 L…"): a move command first, then path syntax only. */
export function looksLikeSvgPathData(text: string): boolean {
	const t = text.trim();
	if (!/^[Mm]/.test(t) || t.length > 1_000_000 || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/.test(t)) return false;
	try {
		return parseSvgPath(t).some((sp) => sp.segs.length > 0);
	} catch {
		return false;
	}
}

/** Pastes SVG text as vector shape contents; false when the text is not SVG (the caller pastes it as text). */
export function pasteSvg(ctx: CommandCtx, env: ExternalPasteEnv, text: string): boolean {
	const { session, seq } = env;
	const svg = looksLikeSvg(text);
	if (!seq || (!svg && !looksLikeSvgPathData(text))) return false;
	let items: Record<string, unknown>[];
	let warnings: string[] = [];
	try {
		if (svg) {
			const r = svgToShapeContents(text);
			items = r.contents;
			warnings = r.warnings;
		} else items = [{ type: 'group', name: 'Pasted Path', contents: svgPathToShapeItems(text.trim()) }];
	} catch (e) {
		ctx.ui.toast({ kind: 'warning', message: 'Paste SVG: not possible', detail: e instanceof Error ? e.message : String(e) });
		return true;
	}
	if (!items.length) {
		ctx.ui.toast({ kind: 'info', message: 'The SVG has nothing a shape can draw', detail: warnings.join('; ') || undefined });
		return true;
	}
	const target = selectedVectorClip(session, env.playhead);
	const track = lowestTargetedTrack(seq, env.view, 'video');
	if (!target && !track) {
		ctx.ui.toast({ kind: 'warning', message: 'Paste SVG: not possible', detail: 'Every video track is locked' });
		return true;
	}
	const rate = seq.settings.frameRate;
	const r = session.apply({
		label: 'Paste SVG',
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			target
				? ({ type: 'shape.addItems', clipId: target.id, items, index: 0 } as Command)
				: ({
						type: 'clip.addShape',
						sequenceId: seq.id,
						at: env.playhead,
						duration: Math.max(1, Math.round((PASTED_TEXT_SECONDS * rate.num) / rate.den)),
						track: track!.label,
						name: 'Pasted SVG',
						shape: { type: 'vector', contents: items },
					} as Command),
		],
		...(target ? {} : { selectAfter: (res: { results: unknown[] }) => ({ timeline: [(res.results[0] as { clipId: string }).clipId] }) }),
	});
	if (!r.ok) ctx.ui.toast({ kind: 'warning', message: 'Paste SVG: not possible', detail: r.errors[0]?.message });
	else if (warnings.length) ctx.ui.toast({ kind: 'info', message: 'Pasted SVG', detail: `Not converted: ${warnings.join('; ')}` });
	return true;
}
