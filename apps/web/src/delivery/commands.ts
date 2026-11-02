// Spec 19 §12: the commands of interchange and delivery. Dialogs register on first use, like Export Frame's.
import { type Clip, TITLE_LOOK_CLIP_KINDS } from '@jasper/project';
import type { UiCommand, CommandCtx } from '../commands/types.ts';
import { selectedSequenceClips, sequenceContext } from '../commands/sequence-context.ts';
import { programOverlays } from '../extensions/index.ts';
import { mediaKeyOf } from '../import/assets.ts';
import { errorText } from '../processing/engine-jobs.ts';
import { ALPHA_DIALOG, registerAlphaDialog } from './AlphaDialog.tsx';
import { GamutOverlay, gamutOverlay, type GamutOutput } from './GamutOverlay.tsx';
import {
	LAYER_STYLE_DIALOG,
	pickStyleFile,
	readStyleFile,
	registerLayerStyleDialog,
} from './LayerStyleDialog.tsx';
import { PSD_DIALOG, registerPsdDialog } from './PsdDialog.tsx';
import { registerSplitImageDialog, SPLIT_IMAGE_DIALOG } from './SplitImageDialog.tsx';

programOverlays.register({
	id: 'delivery.gamut',
	active: () => gamutOverlay.getState().enabled,
	component: GamutOverlay,
	order: 40,
});

const hasSequence = (ctx: CommandCtx) => !!sequenceContext(ctx);

function sequenceName(ctx: CommandCtx): string {
	const e = sequenceContext(ctx);
	const item = e && Object.values(e.doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === e.seq.id);
	return item?.name ?? 'Sequence';
}

/** Clips Export Title takes: anything a look applies to. */
function titleClips(ctx: CommandCtx): Clip[] {
	const e = sequenceContext(ctx);
	if (!e) return [];
	return selectedSequenceClips(e).filter((c) =>
		(TITLE_LOOK_CLIP_KINDS as readonly string[]).includes(c.kind),
	);
}

function selectedStill(ctx: CommandCtx): Extract<Clip, { kind: 'still' }> | null {
	const e = sequenceContext(ctx);
	if (!e) return null;
	const sel = selectedSequenceClips(e);
	const c = sel.length === 1 ? sel[0]! : null;
	return c?.kind === 'still' ? c : null;
}

const sendToPhotoshop: UiCommand = {
	id: 'delivery.sendToPhotoshop',
	label: 'Send to Photoshop…',
	description: 'The frame at the playhead as a layered, registered, rasterised 8-bit PSD. Lists what is baked first.',
	icon: 'app.export',
	scope: 'global',
	agentExposed: true,
	capability: 'engine',
	when: hasSequence,
	disabledReason: () => 'Open a sequence',
	run: (ctx) => {
		const e = sequenceContext(ctx);
		if (!e) return;
		registerPsdDialog();
		ctx.ui.openDialog(PSD_DIALOG, {
			session: e.session,
			engine: ctx.engine,
			sequenceId: e.seq.id,
			frame: e.playhead,
			baseName: sequenceName(ctx),
		});
	},
};

const pngSequence: UiCommand = {
	id: 'delivery.pngSequence',
	label: 'PNG Sequence with Alpha…',
	description: 'The In to Out range, or the sequence, as numbered PNGs on a transparent background.',
	icon: 'app.export',
	scope: 'global',
	agentExposed: true,
	capability: 'engine',
	when: hasSequence,
	disabledReason: () => 'Open a sequence',
	run: (ctx) => {
		const e = sequenceContext(ctx);
		if (!e) return;
		const end = Object.values(e.seq.clips).reduce((m, c) => Math.max(m, c.start + c.duration), 1);
		registerAlphaDialog();
		ctx.ui.openDialog(ALPHA_DIALOG, {
			session: e.session,
			engine: ctx.engine,
			sequenceId: e.seq.id,
			baseName: sequenceName(ctx),
			range: { start: e.seq.inPoint ?? 0, end: e.seq.outPoint ?? end },
			playhead: e.playhead,
		});
	},
};

const exportTitle: UiCommand = {
	id: 'delivery.exportTitle',
	label: 'Export Title…',
	description: 'The selected clips alone, on transparency, trimmed to what they paint with a margin, so glows do not clip.',
	icon: 'app.export',
	scope: 'global',
	agentExposed: true,
	capability: 'engine',
	when: (ctx) => titleClips(ctx).length > 0,
	disabledReason: () => 'Select a title',
	run: (ctx) => {
		const e = sequenceContext(ctx);
		const clips = titleClips(ctx);
		if (!e || !clips.length) return;
		registerAlphaDialog();
		ctx.ui.openDialog(ALPHA_DIALOG, {
			session: e.session,
			engine: ctx.engine,
			sequenceId: e.seq.id,
			clipIds: clips.map((c) => c.id),
			baseName: clips[0]!.name,
			range: {
				start: Math.min(...clips.map((c) => c.start)),
				end: Math.max(...clips.map((c) => c.start + c.duration)),
			},
			playhead: e.playhead,
		});
	},
};

const importLayerStyles: UiCommand = {
	id: 'delivery.importLayerStyles',
	label: 'Import Layer Styles…',
	description: 'The layer styles of a Photoshop .asl or .psd as looks, with a report of what was mapped and approximated.',
	scope: 'global',
	agentExposed: true,
	capability: 'engine',
	when: (ctx) => !!ctx.session && !ctx.session.getState().readOnly,
	disabledReason: () => 'Open a project',
	run: async (ctx) => {
		if (!ctx.session) return;
		const file = await pickStyleFile();
		if (!file) return;
		try {
			const read = await readStyleFile(ctx.engine, file);
			registerLayerStyleDialog();
			ctx.ui.openDialog(LAYER_STYLE_DIALOG, { session: ctx.session, engine: ctx.engine, file: read });
		} catch (e) {
			ctx.ui.toast({ kind: 'error', message: 'Import Layer Styles: not possible', detail: errorText(e) });
		}
	},
};

const splitImage: UiCommand = {
	id: 'delivery.splitImage',
	label: 'Split Image…',
	description: 'A still into its connected parts as separate clips, one undo step, for logo animation.',
	scope: 'global',
	agentExposed: true,
	capability: 'engine',
	when: (ctx) => {
		const c = selectedStill(ctx);
		return !!c && !ctx.session?.getState().readOnly;
	},
	disabledReason: () => 'Select one still image',
	run: (ctx) => {
		const e = sequenceContext(ctx);
		const clip = selectedStill(ctx);
		if (!e || !clip) return;
		const key = mediaKeyOf(e.doc.media[clip.mediaId]);
		if (!key) {
			ctx.ui.toast({ kind: 'warning', message: 'Split Image: the picture is not on the engine' });
			return;
		}
		registerSplitImageDialog();
		ctx.ui.openDialog(SPLIT_IMAGE_DIALOG, {
			session: e.session,
			engine: ctx.engine,
			clipId: clip.id,
			clipName: clip.name,
			sequenceId: e.seq.id,
			mediaKey: key,
			imageUrl: ctx.engine.url(`/media/${encodeURIComponent(key)}`),
		});
	},
};

const toggleGamut: UiCommand = {
	id: 'program.gamutOverlay',
	label: 'Gamut Warning',
	description:
		'Mark the pixels of the Program frame outside an output gamut or the legal range after 4:2:0 (EBU R 103), with percentages.',
	scope: 'program',
	agentExposed: true,
	capability: 'engine',
	checked: () => gamutOverlay.getState().enabled,
	run: () => gamutOverlay.setState((s) => ({ enabled: !s.enabled })),
};

const gamutTargets: [GamutOutput, string][] = [
	['rec709', 'Rec. 709'],
	['rec2020', 'Rec. 2020'],
	['p3d65', 'P3-D65'],
];

const gamutTarget = gamutTargets.map(
	([id, name]): UiCommand => ({
		id: `program.gamutOutput.${id}`,
		label: `Gamut Warning: Check against ${name}`,
		scope: 'program',
		agentExposed: true,
		capability: 'engine',
		checked: () => gamutOverlay.getState().output === id,
		run: () => gamutOverlay.setState({ output: id, enabled: true }),
	}),
);

export const deliveryCommands: UiCommand[] = [
	sendToPhotoshop,
	pngSequence,
	exportTitle,
	importLayerStyles,
	splitImage,
	toggleGamut,
	...gamutTarget,
];
