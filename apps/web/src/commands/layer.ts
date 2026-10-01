// Layer commands of the Program monitor's right-click menu (S03:XF-050, wp-clipboard-2), also in Clip ▸ Transform,
// Graphics ▸ Arrange and the Timeline clip menu (Reveal in Project, S02:TL-930). They act on the selected visual
// clips (a right-click in the monitor selects the layer under the pointer first) and each emits one transaction:
//   motion.reset / motion.resetCrop       Reset Motion / Reset Crop (`clip.removeAttributes`, as Remove Attributes)
//   motion.fit / motion.fill / motion.native   Fit to Frame / Fill Frame / Set to Native (100%) (XF-051; through
//                                         `param.set` at the playhead, so animated properties get a key, XF-024)
//   motion.anchor {point}                 Anchor ▸ Center and the 9-point grid (XF-038, the image stays put)
//   arrange.bringToFront / bringForward / sendBackward / sendToBack   Arrange ▸ (`clip.move` across video tracks)
//   clip.revealInTimeline / clip.revealInProject   view only (no document change)
// The Agent ▸ entry of XF-050 (AGT-040) is superseded by ARCHITECTURE D-18: there is no in-app agent.
import type { Clip, Command, Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { z } from 'zod';
import { hasTransform, transformCommands } from '../panels/program/edits.ts';
import {
	ANCHOR_POINTS,
	type AnchorPoint,
	ARRANGE_COMMANDS,
	ARRANGE_LABELS,
	type ArrangeOp,
	anchorPatch,
	type FitMode,
	fitPatch,
	layerStateAt,
	planArrange,
	projectItemOf,
} from '../panels/program/layer-ops.ts';
import { getProjectPanel } from '../panels/project/instances.ts';
import { activeTimeline } from '../panels/timeline/env.tsx';
import type { ShellController } from '../shell/context.tsx';
import type { CommandCtx, UiCommand } from './types.ts';

type Env = { session: EditorSession; seq: Sequence; playhead: number };

function envOf(ctx: CommandCtx): Env | null {
	const session = ctx.session;
	if (!session) return null;
	const id = activeTimeline(ctx.services)?.sequenceId() ?? session.getState().activeSequenceId;
	const seq = id ? (session.getCommitted().sequences[id] as Sequence | undefined) : undefined;
	return seq ? { session, seq, playhead: ctx.transport.getState().frame } : null;
}

const lockedTrack = (seq: Sequence, trackId: string) =>
	[...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].some((t) => t.id === trackId && t.locked);

/** Selected clips with Motion on unlocked tracks. */
function selectedLayers(e: Env): Clip[] {
	return e.session
		.getState()
		.selection.timeline.clips.map((id) => e.seq.clips[id])
		.filter((c): c is Clip => !!c && hasTransform(c) && !lockedTrack(e.seq, c.trackId));
}

/** Why a layer command is disabled, else undefined (S05:SH-031). */
function layerBlocked(ctx: CommandCtx): string | undefined {
	const s = ctx.session?.getState();
	if (!ctx.session || !s) return 'Open a project first';
	if (s.readOnly) return 'The project is open read-only';
	if (s.gesture) return 'Finish the current drag first';
	const e = envOf(ctx);
	if (!e) return 'Open a sequence first';
	return selectedLayers(e).length ? undefined : 'Select a video layer first';
}

function apply(ctx: CommandCtx, e: Env, label: string, commands: Command[]): boolean {
	if (!commands.length) {
		ctx.ui.toast({ kind: 'info', message: `${label}: nothing to change` });
		return false;
	}
	const r = e.session.apply({ label, origin: 'user', sequenceId: e.seq.id, commands });
	if (!r.ok)
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r.errors[0]?.message });
	return r.ok;
}

function layerCommand(
	id: string,
	label: string,
	description: string,
	run: (ctx: CommandCtx, e: Env, clips: Clip[], args?: unknown) => void,
	extra: Partial<UiCommand> = {},
): UiCommand {
	return {
		id,
		label,
		description,
		scope: 'global',
		...extra,
		when: (ctx) => !layerBlocked(ctx) && !extra.disabledReason?.(ctx),
		disabledReason: (ctx) => layerBlocked(ctx) ?? extra.disabledReason?.(ctx),
		run: (ctx, args) => {
			const e = envOf(ctx);
			const blocked = layerBlocked(ctx);
			if (!e || blocked) {
				ctx.ui.toast({ kind: 'info', message: blocked ?? 'Open a sequence first' });
				return;
			}
			run(ctx, e, selectedLayers(e), args);
		},
	};
}

// ---------------------------------------------------------------- reset

const hasCrop = (c: Clip) =>
	((c as { effects?: { effectId: string }[] }).effects ?? []).some((fx) => fx.effectId === 'jasper.crop');

const resetMotion = layerCommand(
	'motion.reset',
	'Reset Motion',
	'Reset Position, Scale, Rotation and Anchor Point of the selected layers (keyframes removed)',
	(ctx, e, clips) =>
		void apply(ctx, e, 'Reset Motion', [
			{
				type: 'clip.removeAttributes',
				clipIds: clips.map((c) => c.id),
				attributes: { motion: true },
			} as Command,
		]),
);

const resetCrop = layerCommand(
	'motion.resetCrop',
	'Reset Crop',
	'Remove the crop of the selected layers',
	(ctx, e, clips) => {
		const ids = clips.filter(hasCrop).map((c) => c.id);
		void apply(
			ctx,
			e,
			'Reset Crop',
			ids.length
				? [
						{
							type: 'clip.removeAttributes',
							clipIds: ids,
							attributes: { effects: ['jasper.crop'] },
						} as Command,
					]
				: [],
		);
	},
	{
		disabledReason: (ctx) => {
			const e = envOf(ctx);
			return e && selectedLayers(e).some(hasCrop) ? undefined : 'The selected layers are not cropped';
		},
	},
);

// ---------------------------------------------------------------- fit / fill / native (XF-051)

function fitCommand(id: string, mode: FitMode, label: string, description: string): UiCommand {
	return layerCommand(id, label, description, (ctx, e, clips) => {
		const doc = e.session.getCommitted();
		const frame = { width: e.seq.settings.width, height: e.seq.settings.height };
		const commands = clips.flatMap((c) => {
			const s = layerStateAt(doc, e.seq, c, e.playhead);
			const patch = s && fitPatch(s, frame, mode);
			return patch ? transformCommands(c.id, patch, s.frame, e.seq.id) : [];
		});
		apply(ctx, e, label, commands);
	});
}

// ---------------------------------------------------------------- anchor (XF-038)

const AnchorArgs = z.object({
	point: z.enum(ANCHOR_POINTS.map((p) => p.id) as [AnchorPoint, ...AnchorPoint[]]).default('center'),
});

const anchor = layerCommand(
	'motion.anchor',
	'Anchor to Center',
	'Move the anchor point to the centre (or a corner or edge) of the visible layer without moving it',
	(ctx, e, clips, args) => {
		const parsed = AnchorArgs.safeParse(args ?? {});
		const point = parsed.success ? parsed.data.point : 'center';
		const label = `Anchor to ${ANCHOR_POINTS.find((p) => p.id === point)!.label}`;
		const doc = e.session.getCommitted();
		const commands = clips.flatMap((c) => {
			const s = layerStateAt(doc, e.seq, c, e.playhead);
			const patch = s && anchorPatch(s, point);
			return patch ? transformCommands(c.id, patch, s.frame, e.seq.id) : [];
		});
		apply(ctx, e, label, commands);
	},
	{ argsSchema: AnchorArgs.optional() },
);

// ---------------------------------------------------------------- arrange

function arrangeCommand(id: string, op: ArrangeOp): UiCommand {
	const label = ARRANGE_LABELS[op];
	const plan = (ctx: CommandCtx) => {
		const e = envOf(ctx);
		return e
			? planArrange(
					e.seq,
					selectedLayers(e).map((c) => c.id),
					op,
				)
			: null;
	};
	return layerCommand(
		id,
		label,
		`${label}: move the selected layers to a ${op === 'front' || op === 'forward' ? 'higher' : 'lower'} video track at the same time`,
		(ctx, e, clips) => {
			const p = planArrange(
				e.seq,
				clips.map((c) => c.id),
				op,
			);
			if (!p.moves.length) {
				ctx.ui.toast({ kind: 'info', message: `${label}: not possible`, detail: p.reason });
				return;
			}
			const ok = apply(
				ctx,
				e,
				label,
				p.moves.map(
					(m) =>
						({
							type: 'clip.move',
							clipIds: [m.clipId],
							deltaFrames: 0,
							deltaTracks: { video: m.deltaTracks },
							createTracks: true,
						}) as Command,
				),
			);
			if (ok && p.reason) ctx.ui.toast({ kind: 'info', message: label, detail: p.reason });
		},
		{ disabledReason: (ctx) => (plan(ctx)?.moves.length ? undefined : plan(ctx)?.reason) },
	);
}

// ---------------------------------------------------------------- reveal

function shellOf(ctx: CommandCtx): ShellController | null {
	return ctx.services.get('shell');
}

const ClipArgs = z.object({ clipId: z.string().optional() });

/** `args.clipId`, else the primary selected clip (the layer the menu was opened on), else the last selected. */
function primaryClip(e: Env, args?: unknown): Clip | null {
	const parsed = ClipArgs.safeParse(args ?? {});
	const given = parsed.success ? parsed.data.clipId : undefined;
	if (given) return e.seq.clips[given] ?? null;
	const sel = e.session.getState().selection.timeline;
	const id = sel.primaryClip ?? sel.clips[sel.clips.length - 1];
	return (id && e.seq.clips[id]) || null;
}

const revealInTimeline: UiCommand = {
	id: 'clip.revealInTimeline',
	label: 'Reveal in Timeline',
	description: 'Show the selected clip in the Timeline panel',
	scope: 'global',
	argsSchema: ClipArgs.optional(),
	when: (ctx) => {
		const e = envOf(ctx);
		return !!e && !!primaryClip(e);
	},
	disabledReason: (ctx) => (envOf(ctx) ? 'Select a clip first' : 'Open a sequence first'),
	run: (ctx, args) => {
		const e = envOf(ctx);
		const clip = e && primaryClip(e, args);
		if (!e || !clip) return;
		if (!e.session.getState().selection.timeline.clips.includes(clip.id))
			e.session.select('timeline', [clip.id], 'replace');
		shellOf(ctx)?.focusPanel('timeline');
		activeTimeline(ctx.services)?.controller.reveal(clip.start);
	},
};

function itemFor(ctx: CommandCtx, args?: unknown): string | null {
	const e = envOf(ctx);
	const clip = e && primaryClip(e, args);
	return e && clip ? projectItemOf(e.session.getCommitted(), clip) : null;
}

const revealInProject: UiCommand = {
	id: 'clip.revealInProject',
	label: 'Reveal in Project',
	description: 'Select the project item of the selected clip in the Project panel',
	scope: 'global',
	argsSchema: ClipArgs.optional(),
	when: (ctx) => !!itemFor(ctx),
	disabledReason: (ctx) => {
		const e = envOf(ctx);
		if (!e) return 'Open a sequence first';
		return primaryClip(e)
			? 'This clip has no project item (text, shapes and graphics live only in the sequence)'
			: 'Select a clip first';
	},
	run: async (ctx, args) => {
		const itemId = itemFor(ctx, args);
		if (!itemId || !ctx.session) return;
		ctx.session.select('project', [itemId], 'replace', { primary: itemId });
		shellOf(ctx)?.focusPanel('project');
		// A Project panel that was closed mounts after the focus: wait for its handle.
		for (let i = 0; i < 20; i++) {
			const panel = getProjectPanel();
			if (panel?.reveal) {
				panel.reveal(itemId);
				return;
			}
			await new Promise((r) => setTimeout(r, 25));
		}
	},
};

export const layerCommands: UiCommand[] = [
	resetMotion,
	resetCrop,
	fitCommand(
		'motion.fit',
		'fit',
		'Fit to Frame',
		'Scale the selected layers to fit inside the frame, centred',
	),
	fitCommand('motion.fill', 'fill', 'Fill Frame', 'Scale the selected layers to cover the frame, centred'),
	fitCommand(
		'motion.native',
		'native',
		'Set to Native (100%)',
		'Set the scale of the selected layers to 100%',
	),
	anchor,
	...ARRANGE_COMMANDS.map(([id, op]) => arrangeCommand(id, op)),
	revealInTimeline,
	revealInProject,
];
