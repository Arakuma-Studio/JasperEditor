import type { MediaAsset } from '@jasper/project';
import { z } from 'zod';
import {
	clipBadgeProviders,
	clipSections,
	layerDoubleClickHandlers,
	programOverlays,
	projectItemMenuExtensions,
} from '../extensions/index.ts';
import { notices } from '../home/notices.tsx';
import { CanvasTextEditorHost } from '../mg-bundles/CanvasTextEditor.tsx';
import { CompositionSection } from '../mg-bundles/CompositionSection.tsx';
import { MG_IMPORT_DIALOG, registerImportRemotionDialog } from '../mg-bundles/ImportDialog.tsx';
import { bundleErrorText, rebuildBundle } from '../mg-bundles/import.ts';
import { insertComposition } from '../mg-bundles/insert.ts';
import { MgRuntimeHost } from '../mg-bundles/RuntimeHost.tsx';
import { currentMgRuntime } from '../mg-bundles/runtime.ts';
import { startCanvasTextEdit } from '../mg-bundles/text-edit.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const InsertArgs = z.object({
	mediaId: z.string().min(1),
	compositionId: z.string().min(1),
	/** Sequence frame; default the playhead. */
	at: z.number().int().min(0).optional(),
	trackId: z.string().optional(),
});

function selectedCompositionClips(ctx: CommandCtx): string[] {
	const s = ctx.session?.store.getState();
	const seqId = s?.activeSequenceId;
	if (!s || !seqId) return [];
	const seq = s.document.sequences[seqId];
	return s.selection.timeline.clips.filter((id) => seq?.clips[id]?.kind === 'composition');
}

function bundleOfSelection(ctx: CommandCtx): MediaAsset | null {
	const s = ctx.session?.store.getState();
	const seqId = s?.activeSequenceId;
	if (!s || !seqId) return null;
	for (const id of selectedCompositionClips(ctx)) {
		const clip = s.document.sequences[seqId]?.clips[id];
		const mediaId = clip?.kind === 'composition' ? clip.composition.mediaId : undefined;
		const asset = mediaId ? s.document.media[mediaId] : undefined;
		if (asset?.mgBundle?.source.type === 'project-dir') return asset;
	}
	return null;
}

export const compositionCommands: UiCommand[] = [
	{
		id: 'mg.importRemotionProject',
		label: 'Import Remotion Project…',
		description:
			'Imports a Remotion 4.0.499 project folder (bundled with its own CLI, optionally watched) or a zip of a built bundle; its compositions become clips.',
		icon: 'panel.motionTemplates',
		scope: 'global',
		when: (ctx) => !!ctx.session && !ctx.session.getState().readOnly,
		disabledReason: (ctx) => (!ctx.session ? 'Open a project first' : undefined),
		run: (ctx) => ctx.ui.openDialog(MG_IMPORT_DIALOG, { session: ctx.session, engine: ctx.engine }),
	},
	{
		id: 'mg.insertComposition',
		label: 'Insert Composition',
		description:
			'Adds a composition of an imported Remotion bundle at the playhead on the targeted video track (default duration = the composition length).',
		icon: 'panel.motionTemplates',
		scope: 'editing',
		argsSchema: InsertArgs,
		agentExposed: true,
		hidden: true,
		when: (ctx) => !!ctx.session?.store.getState().activeSequenceId,
		run: (ctx, args) => {
			const a = InsertArgs.parse(args);
			if (!ctx.session) throw new Error('No project is open');
			insertComposition(
				ctx.session,
				{ mediaId: a.mediaId, compositionId: a.compositionId },
				{ ...(a.at !== undefined ? { at: a.at } : {}), ...(a.trackId ? { trackId: a.trackId } : {}) },
			);
		},
	},
	{
		id: 'mg.renderCompositionMasters',
		label: 'Render Composition Masters',
		description:
			'Pre-renders the ProRes 4444 masters of the selected composition clips (exports then reuse them).',
		icon: 'engine.remotion',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => selectedCompositionClips(ctx).length > 0,
		run: async (ctx) => {
			const rt = currentMgRuntime();
			const ids = selectedCompositionClips(ctx);
			if (!rt || ids.length === 0) return;
			let queued = 0;
			for (const id of ids) if (await rt.renderMaster(id)) queued++;
			ctx.ui.toast({
				kind: 'info',
				message: `Rendering ${queued} composition master${queued === 1 ? '' : 's'}`,
				detail: 'Progress appears in the Jobs panel.',
			});
		},
	},
	{
		id: 'mg.rebuildBundle',
		label: 'Rebuild Remotion Bundle',
		description: 'Re-runs `remotion bundle` for the project folder of the selected composition clip.',
		icon: 'engine.remotion',
		scope: 'editing',
		when: (ctx) => !!bundleOfSelection(ctx),
		run: async (ctx) => {
			const asset = bundleOfSelection(ctx);
			if (!asset || !ctx.session) return;
			try {
				await rebuildBundle(ctx.engine, asset, ctx.session.projectId);
				ctx.ui.toast({ kind: 'info', message: `Rebuilding ${asset.mgBundle?.source.name ?? 'bundle'}` });
			} catch (e) {
				ctx.ui.toast({ kind: 'error', message: 'Rebuild failed', detail: bundleErrorText(e) });
			}
		},
	},
];

registerImportRemotionDialog();

clipSections.register({
	id: 'composition',
	title: 'Composition',
	appliesTo: (clips) => clips.length > 0 && clips.every((c) => c.kind === 'composition'),
	component: CompositionSection,
	defaultOpen: true,
	order: 10,
});

programOverlays.register({
	id: 'mg-runtime',
	active: () => true,
	component: MgRuntimeHost,
	order: 0,
});

programOverlays.register({
	id: 'mg-text-editor',
	active: () => true,
	component: CanvasTextEditorHost,
	order: 5,
});

layerDoubleClickHandlers.register({
	id: 'mg-text',
	run: ({ session, clip, point }) => {
		if (clip.kind !== 'composition' || session.getState().readOnly) return false;
		startCanvasTextEdit(session, clip.id, { point });
		return true;
	},
});

clipBadgeProviders.register({
	id: 'mg-master',
	badge: (clip) => {
		if (clip.kind !== 'composition') return null;
		const rt = currentMgRuntime();
		const s = rt?.status(clip.id);
		if (!s) return null;
		if (s.master.state === 'ready')
			return { text: '✓', title: 'Remotion master cached for the current props', tone: 'ok' };
		if (s.master.state === 'rendering' || s.master.state === 'queued')
			return { text: 'R…', title: 'Rendering the Remotion master', tone: 'busy' };
		return null;
	},
	subscribe: (cb) => {
		// The runtime may be attached after the badge subscribes.
		let off = currentMgRuntime()?.subscribe(cb);
		const timer = setInterval(() => {
			if (!off && currentMgRuntime()) {
				off = currentMgRuntime()!.subscribe(cb);
				cb();
			}
		}, 1000);
		return () => {
			clearInterval(timer);
			off?.();
		};
	},
	version: () => currentMgRuntime()?.version() ?? 0,
});

projectItemMenuExtensions.register({
	id: 'mg-bundle',
	items: ({ session, items, readOnly }) => {
		const bundles = items
			.map((it) => (it.kind === 'media' ? session.getCommitted().media[it.mediaId] : undefined))
			.filter((m): m is MediaAsset => m?.kind === 'mg-bundle');
		if (bundles.length !== 1) return [];
		const asset = bundles[0]!;
		const engine = session.engine;
		return [
			{
				kind: 'item',
				label: 'Rebuild Remotion Bundle',
				disabled: readOnly || !engine || asset.mgBundle?.source.type !== 'project-dir',
				run: () => {
					if (engine)
						void rebuildBundle(engine, asset, session.projectId).catch((error) =>
							notices.push({ kind: 'error', message: 'Rebuild failed', detail: bundleErrorText(error) }),
						);
				},
			},
		];
	},
});
