import {
	type Command,
	type MediaAsset,
	mediaLoaderPath,
	type Sequence,
	svgToShapeContents,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import { z } from 'zod';
import { lowestTargetedTrack } from '../clipboard/external.ts';
import { clipMenuExtensions, type MenuItemSpec, projectItemMenuExtensions } from '../extensions/index.ts';
import { LOTTIE_EXPORT_DIALOG, registerImportsDialogs } from '../imports/dialogs.tsx';
import { INTERPRET_FOOTAGE_DIALOG, registerInterpretDialog } from '../imports/interpret-dialog.tsx';
import type { CommandCtx, UiCommand } from './types.ts';

registerInterpretDialog();
registerImportsDialogs();

const writable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

/** Media an Interpret Footage acts on: the selected Project panel items, else the selected timeline clips' media. */
export function interpretTargets(session: EditorSession, panel: string | null): string[] {
	const st = session.getState();
	const doc = st.document;
	const fromItems = st.selection.project.items.flatMap((id) => {
		const it = doc.items[id];
		return it?.kind === 'media' || it?.kind === 'subclip' ? [it.mediaId] : [];
	});
	if (panel === 'project' || fromItems.length) {
		if (fromItems.length) return [...new Set(fromItems)];
	}
	const seqId = st.activeSequenceId;
	const seq = seqId ? (doc.sequences[seqId] as Sequence | undefined) : undefined;
	if (!seq) return [];
	return [
		...new Set(
			st.selection.timeline.clips.flatMap((id) => {
				const clip = seq.clips[id];
				const m = clip && 'mediaId' in clip ? clip.mediaId : undefined;
				return typeof m === 'string' && doc.media[m] ? [m] : [];
			}),
		),
	];
}

const interpretable = (a: MediaAsset | undefined) =>
	!!a && (a.kind === 'video' || a.kind === 'image' || a.kind === 'animated-image');

function sourceSequence(ctx: CommandCtx): string | null {
	const s = ctx.session;
	if (!s) return null;
	if (ctx.focus.panel === 'project') {
		const st = s.getState();
		const item = st.selection.project.primary ? st.document.items[st.selection.project.primary] : undefined;
		if (item?.kind === 'sequence') return item.sequenceId;
	}
	return s.getState().activeSequenceId ?? Object.keys(s.getCommitted().sequences)[0] ?? null;
}

/** Adds an SVG as a vector shape clip (at the playhead, on the lowest targeted video track), one undo step. */
export function addSvgAsShape(ctx: CommandCtx, text: string, name: string): boolean {
	const session = ctx.session;
	if (!session) return false;
	const st = session.getState();
	const seqId = st.activeSequenceId;
	const seq = seqId ? (st.document.sequences[seqId] as Sequence | undefined) : undefined;
	if (!seq) {
		ctx.ui.toast({ kind: 'info', message: 'Open a sequence to add the SVG as a shape layer' });
		return false;
	}
	let conv: ReturnType<typeof svgToShapeContents>;
	try {
		conv = svgToShapeContents(text);
	} catch (e) {
		ctx.ui.toast({
			kind: 'warning',
			message: 'Not an SVG document',
			detail: e instanceof Error ? e.message : String(e),
		});
		return false;
	}
	if (!conv.contents.length) {
		ctx.ui.toast({
			kind: 'info',
			message: 'The SVG has nothing a shape layer can draw',
			detail: conv.warnings.join('; ') || undefined,
		});
		return false;
	}
	const track = lowestTargetedTrack(seq, st.views[seq.id], 'video');
	if (!track) {
		ctx.ui.toast({ kind: 'warning', message: 'Every video track is locked' });
		return false;
	}
	const frames = Math.max(
		1,
		Math.round(
			(st.document.settings.defaultStillDurationFrames * seq.settings.frameRate.num) /
				(seq.settings.frameRate.den * 30),
		),
	);
	const r = session.apply({
		label: 'Import SVG as Shape Layer',
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			{
				type: 'clip.addShape',
				sequenceId: seq.id,
				at: ctx.transport.getState().frame,
				duration: frames,
				track: track.label,
				name,
				shape: { type: 'vector', contents: conv.contents },
			} as Command,
		],
		selectAfter: (res) => ({
			timeline: [(res.results[0] as { clipId: string }).clipId],
		}),
	});
	if (!r.ok) {
		ctx.ui.toast({
			kind: 'warning',
			message: 'Import SVG as Shape Layer: not possible',
			detail: r.errors[0]?.message,
		});
		return false;
	}
	if (conv.warnings.length)
		ctx.ui.toast({
			kind: 'info',
			message: `Shape layer "${name}"`,
			detail: `Not converted: ${conv.warnings.join('; ')}`,
		});
	return true;
}

function pickSvg(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.svg,image/svg+xml';
		input.style.display = 'none';
		input.addEventListener(
			'change',
			() => {
				resolve(input.files?.[0] ?? null);
				input.remove();
			},
			{ once: true },
		);
		input.addEventListener('cancel', () => {
			resolve(null);
			input.remove();
		});
		document.body.appendChild(input);
		input.click();
	});
}

export const importsCommands: UiCommand[] = [
	{
		id: 'media.interpretFootage',
		label: 'Interpret Footage…',
		description:
			'Frame rate, pixel aspect ratio, field order, alpha channel and loop of the selected media (Project panel items or timeline clips)',
		scope: 'global',
		when: (ctx) =>
			writable(ctx) &&
			interpretTargets(ctx.session!, ctx.focus.panel).some((id) =>
				interpretable(ctx.session!.getCommitted().media[id] as MediaAsset | undefined),
			),
		disabledReason: () => 'Select footage in the Project panel or clips in the timeline',
		run: (ctx) => {
			const s = ctx.session;
			if (!s) return;
			const mediaIds = interpretTargets(s, ctx.focus.panel).filter((id) =>
				interpretable(s.getCommitted().media[id] as MediaAsset | undefined),
			);
			if (mediaIds.length) void openDialog(INTERPRET_FOOTAGE_DIALOG, { session: s, mediaIds });
		},
		agentExposed: true,
	},
	{
		id: 'export.lottie',
		label: 'Lottie…',
		description:
			'Export the sequence (shapes, text, solids, stills, nests, Lottie clips) as a Lottie animation',
		scope: 'global',
		when: (ctx) => !!sourceSequence(ctx),
		disabledReason: () => 'Open or select a sequence to export',
		run: (ctx) => {
			const sequenceId = sourceSequence(ctx);
			if (!ctx.session || !sequenceId) return;
			void openDialog(LOTTIE_EXPORT_DIALOG, { session: ctx.session, engine: ctx.engine, sequenceId });
		},
		agentExposed: true,
	},
	{
		id: 'project.createShapeLayer',
		label: 'Create Shape Layer',
		description: 'Convert an imported SVG item into an editable vector shape clip at the playhead',
		scope: 'global',
		argsSchema: z.object({ mediaId: z.string() }),
		when: (ctx) => writable(ctx) && !!ctx.session!.getState().activeSequenceId,
		disabledReason: () => 'Open a sequence first',
		run: async (ctx, args) => {
			const s = ctx.session;
			const mediaId = (args as { mediaId?: string } | undefined)?.mediaId;
			const asset = s && mediaId ? (s.getCommitted().media[mediaId] as MediaAsset | undefined) : undefined;
			if (asset?.vector?.format !== 'svg') {
				ctx.ui.toast({ kind: 'info', message: 'Select an SVG item' });
				return;
			}
			try {
				addSvgAsShape(ctx, await svgTextOf(ctx, asset), asset.originalName.replace(/\.svgz?$/i, ''));
			} catch (e) {
				ctx.ui.toast({ kind: 'warning', message: 'Create Shape Layer: not possible', detail: String(e) });
			}
		},
		agentExposed: true,
	},
	{
		id: 'project.importSvgAsShape',
		label: 'Import SVG as Shape Layer…',
		description: 'Convert an SVG file into an editable vector shape clip at the playhead',
		scope: 'global',
		when: (ctx) => writable(ctx) && !!ctx.session!.getState().activeSequenceId,
		disabledReason: () => 'Open a sequence first',
		run: async (ctx) => {
			const file = await pickSvg();
			if (!file) return;
			if (file.size > 32 * 1024 * 1024) {
				ctx.ui.toast({ kind: 'warning', message: 'The SVG is too large (32 MB at most)' });
				return;
			}
			addSvgAsShape(ctx, await file.text(), file.name.replace(/\.svg$/i, ''));
		},
		agentExposed: false,
	},
];

/** The SVG text of an SVG media item (the engine serves it decompressed). */
async function svgTextOf(ctx: CommandCtx, asset: MediaAsset): Promise<string> {
	const path = mediaLoaderPath(asset);
	if (!path) throw new Error('The SVG is not on the engine');
	const base = ctx.engine.mediaUrl('x').replace(/\/media\/.*$/, '');
	const r = await fetch(`${base}${path}`);
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.text();
}

projectItemMenuExtensions.register({
	id: 'imports',
	order: 15,
	items: ({ session, items, readOnly, runCommand }) => {
		const doc = session.getCommitted();
		const assets = items.flatMap((it) => {
			const m = (it as { mediaId?: string }).mediaId;
			const a = m ? (doc.media[m] as MediaAsset | undefined) : undefined;
			return (it.kind === 'media' || it.kind === 'subclip') && a ? [a] : [];
		});
		if (!assets.length) return [];
		const out: MenuItemSpec[] = [];
		if (assets.some(interpretable))
			out.push({
				kind: 'submenu',
				label: 'Modify',
				items: [
					{
						kind: 'item',
						label: 'Interpret Footage…',
						disabled: readOnly,
						run: () =>
							void openDialog(INTERPRET_FOOTAGE_DIALOG, {
								session,
								mediaIds: [...new Set(assets.filter(interpretable).map((a) => a.id))],
							}),
					},
				],
			});
		const svg = assets.length === 1 && assets[0]!.vector?.format === 'svg' ? assets[0]! : null;
		if (svg && runCommand)
			out.push({
				kind: 'item',
				label: 'Create Shape Layer',
				disabled: readOnly || !session.getState().activeSequenceId,
				run: () => runCommand('project.createShapeLayer', { mediaId: svg.id }),
			});
		return out;
	},
});

clipMenuExtensions.register({
	id: 'imports',
	order: 15,
	items: ({ session, clip, selection }) => {
		const doc = session.getCommitted();
		const seqId = session.getState().activeSequenceId;
		const seq = seqId ? (doc.sequences[seqId] as Sequence | undefined) : undefined;
		if (!seq) return [];
		const ids = selection.includes(clip.id) ? selection : [clip.id];
		const mediaIds = [
			...new Set(
				ids.flatMap((id) => {
					const clip = seq.clips[id];
					const m = clip && 'mediaId' in clip ? clip.mediaId : undefined;
					return typeof m === 'string' && interpretable(doc.media[m] as MediaAsset | undefined) ? [m] : [];
				}),
			),
		];
		if (!mediaIds.length) return [];
		return [
			{
				kind: 'submenu',
				label: 'Modify',
				items: [
					{
						kind: 'item',
						label: 'Interpret Footage…',
						disabled: session.getState().readOnly,
						run: () => void openDialog(INTERPRET_FOOTAGE_DIALOG, { session, mediaIds }),
					},
				],
			},
		];
	},
});
