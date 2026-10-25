// Stroke Animation UI commands (docs/wp-notes/shapes.md § "Stroke Animation panel"): every panel button, the
// Graphics ▸ Stroke Animation menu and the palette run these. Each click is one transaction, one undo step (an
// animation with "Tracer on Next" carries its tracers in the same transaction). Refusals and warnings (skipped
// clips) are shown as notifications; nothing is applied when the command refuses.
import { DEFAULT_SHAPE_SECONDS, type TransactionResult } from '@jasper/project';
import { z } from 'zod';
import type { CommandCtx, UiCommand } from '../commands/types.ts';
import { assignLazy } from '../i18n/lazy.ts';
import { freeVideoTrack } from '../panels/program/edits.ts';
import { vectorUi } from '../shapes/vector.ts';
import { applyStrokeTransaction, type StrokeCommand } from './adapter.ts';
import {
	activeSequenceOf,
	buildAnimateCommands,
	effectiveFlags,
	lineTarget,
	masterTrims,
	STROKE_ACTIONS,
	STROKE_DESCRIPTIONS,
	STROKE_MENU_LABELS,
	type StrokeAction,
	shapeTargets,
	tracerCommand,
	tracerTarget,
} from './model.ts';
import { strokePrefs } from './prefs.ts';

/** Explicit flags (the panel resolves its checkboxes and Alt / Shift); absent = the checkboxes. */
const AnimateArgsSchema = z
	.strictObject({ reverse: z.boolean().optional(), animateOffset: z.boolean().optional() })
	.optional();

const W_TRIM_SKIPPED = 'W_TRIM_SKIPPED';

/** Shows a refusal or the warnings of a transaction; true when it applied. */
function report(
	ctx: CommandCtx,
	label: string,
	r: TransactionResult,
): r is Extract<TransactionResult, { ok: true }> {
	if (!r.ok) {
		ctx.ui.toast({
			kind: 'error',
			message: `${label}: not possible`,
			detail: [...new Set(r.errors.map((e) => e.message))].join('\n'),
		});
		return false;
	}
	if (r.warnings.length) {
		const skipped = r.warnings.filter((w) => w.code === W_TRIM_SKIPPED).length;
		ctx.ui.toast({
			kind: 'warning',
			message: skipped ? `${label}: ${skipped} skipped` : `${label}: applied with warnings`,
			detail: [...new Set(r.warnings.map((w) => w.message))].join('\n'),
		});
	}
	return true;
}

function apply(
	ctx: CommandCtx,
	label: string,
	sequenceId: string,
	commands: StrokeCommand[],
	extra: { selectCreated?: boolean } = {},
): Extract<TransactionResult, { ok: true }> | null {
	if (!ctx.session || !commands.length) return null;
	const r = applyStrokeTransaction(ctx.session, { label, sequenceId, commands, ...extra });
	return report(ctx, label, r) ? r : null;
}

function animate(ctx: CommandCtx, action: StrokeAction, args: z.infer<typeof AnimateArgsSchema>): void {
	const session = ctx.session;
	const style = action.style;
	if (!session || !style) return;
	const t = shapeTargets(session.getState());
	if (!t.ok) {
		ctx.ui.toast({ kind: 'info', message: t.reason });
		return;
	}
	const prefs = strokePrefs.get();
	const base = effectiveFlags(prefs, { alt: false, shift: false });
	const flags = {
		reverse: args?.reverse ?? base.reverse,
		animateOffset: args?.animateOffset ?? base.animateOffset,
	};
	const label = STROKE_MENU_LABELS[action.id];
	const commands = buildAnimateCommands(style, t.clips, prefs, flags, session.transport.getState().frame);
	const tracers: StrokeCommand[] = [];
	if (prefs.addTracer) {
		// Which clips get animated is the command's decision (skipped clips warn): a dry run tells, then one tracer per
		// animated clip goes into the same transaction (without a trim id it follows the clip's master trim).
		const probe = applyStrokeTransaction(session, {
			label,
			sequenceId: t.sequence.id,
			commands,
			dryRun: true,
		});
		if (!probe.ok) {
			report(ctx, label, probe);
			return;
		}
		for (const m of masterTrims(probe.results)) tracers.push(tracerCommand(m.clipId, null, prefs));
	}
	apply(ctx, label, t.sequence.id, [...commands, ...tracers]);
}

function reversePath(ctx: CommandCtx): void {
	const t = shapeTargets(ctx.session?.getState());
	if (!t.ok) return;
	apply(ctx, STROKE_MENU_LABELS.reversePath, t.sequence.id, [
		{ type: 'shape.reversePathDirection', clipIds: t.clips.map((c) => c.id) },
	]);
}

function addLine(ctx: CommandCtx, orientation: 'horizontal' | 'vertical'): void {
	const session = ctx.session;
	const seq = session ? activeSequenceOf(session.getState()) : null;
	if (!session || !seq || lineTarget(session.getState())) return;
	const rate = seq.settings.frameRate;
	const fps = rate.den > 0 ? rate.num / rate.den : 0;
	const durationFrames = Math.max(1, Math.round(DEFAULT_SHAPE_SECONDS * (Number.isFinite(fps) ? fps : 30)));
	const at = Math.max(0, Math.round(session.transport.getState().frame));
	const track = freeVideoTrack(seq, at, durationFrames, session.getState().views[seq.id]?.targeting.video);
	apply(
		ctx,
		orientation === 'horizontal' ? STROKE_MENU_LABELS.addHorizontalLine : STROKE_MENU_LABELS.addVerticalLine,
		seq.id,
		[
			{
				type: 'shape.addLine',
				orientation,
				at,
				durationFrames,
				// A new track (`V<n+1>`) is the command's choice: only name an existing one.
				...(seq.videoTracks.some((v) => v.id === track) ? { trackId: track } : {}),
			},
		],
		{ selectCreated: true },
	);
}

/** Add Tracer: which trim to follow when the shape has several (the panel's choice). */
const TracerArgsSchema = z.strictObject({ trimItemId: z.string().min(1).max(200).optional() }).optional();

function addTracer(ctx: CommandCtx, args: z.infer<typeof TracerArgsSchema>): void {
	const t = tracerTarget(ctx.session?.getState(), vectorUi.get().selected, args?.trimItemId ?? null);
	if (!t.ok) return;
	apply(ctx, STROKE_MENU_LABELS.addTracer, t.sequence.id, [
		tracerCommand(t.clipId, t.trimItemId, strokePrefs.get(), t.followerId),
	]);
}

const shapeReason = (ctx: CommandCtx) => {
	const t = shapeTargets(ctx.session?.getState());
	return t.ok ? undefined : t.reason;
};
const lineReason = (ctx: CommandCtx) => lineTarget(ctx.session?.getState()) ?? undefined;
const tracerReason = (ctx: CommandCtx) => {
	const t = tracerTarget(ctx.session?.getState(), vectorUi.get().selected);
	return t.ok ? undefined : t.reason;
};

function commandFor(action: StrokeAction): UiCommand {
	// Labels are getters (read in the current language); assignLazy keeps them getters.
	const common = {
		id: action.command,
		get label() {
			return STROKE_MENU_LABELS[action.id];
		},
		get description() {
			return STROKE_DESCRIPTIONS[action.id];
		},
		icon: action.icon,
		scope: 'global' as const,
		agentExposed: true,
	};
	return assignLazy({} as UiCommand, common, behaviour(action));
}

function behaviour(action: StrokeAction): Omit<UiCommand, 'id' | 'label' | 'scope'> {
	if (action.style)
		return {
			argsSchema: AnimateArgsSchema,
			when: (ctx) => !shapeReason(ctx),
			disabledReason: shapeReason,
			run: (ctx, args) => animate(ctx, action, args as z.infer<typeof AnimateArgsSchema>),
		};
	switch (action.id) {
		case 'reversePath':
			return { when: (ctx) => !shapeReason(ctx), disabledReason: shapeReason, run: reversePath };
		case 'addHorizontalLine':
		case 'addVerticalLine': {
			const orientation = action.id === 'addHorizontalLine' ? 'horizontal' : 'vertical';
			return {
				when: (ctx) => !lineReason(ctx),
				disabledReason: lineReason,
				run: (ctx) => addLine(ctx, orientation),
			};
		}
		case 'addTracer':
			return {
				argsSchema: TracerArgsSchema,
				when: (ctx) => !tracerReason(ctx),
				disabledReason: tracerReason,
				run: (ctx, args) => addTracer(ctx, args as z.infer<typeof TracerArgsSchema>),
			};
		default:
			// tracerNext: a preference toggle, always available.
			return {
				checked: () => strokePrefs.get().addTracer,
				run: () => strokePrefs.set({ addTracer: !strokePrefs.get().addTracer }),
			};
	}
}

export const strokeAnimationCommands: UiCommand[] = STROKE_ACTIONS.map(commandFor);
