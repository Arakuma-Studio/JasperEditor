// Inspector UI commands (WP-2D, ARCHITECTURE §7.3): apply/remove effects, stopwatch and keyframe
// navigation for the focused property, reset, Effect Controls delete, and History stepping/clearing.
// Ids bound in keymap-defaults.ts: effectControls.removeEffect (Backspace/Delete), effectControls.toggleLoop
// (Ctrl+L), history.stepBackward/stepForward (←/→ in the History panel). The inspector.* ids are
// unbound by default and reachable from panel menus and the command palette.

import type { Command, Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { z } from 'zod';
import { ensureExpressionEngine } from '../expressions/engine.ts';
import { defaultExpressionText, rowExpressionOf, setExpressionCommand } from '../expressions/row.ts';
import { deleteMasks } from '../masks/actions.ts';
import { maskUi } from '../masks/store.ts';
import { applyEffectToClips } from '../panels/effects/drag.ts';
import { inspectorFocus } from '../panels/properties/lib/focus.ts';
import {
	animState,
	navigateKey,
	planReset,
	planStopwatch,
	planToggleKey,
	type Row,
	rowForKey,
} from '../panels/properties/lib/model.ts';
import type { CommandCtx, UiCommand } from './types.ts';

function activeSequence(session: EditorSession): Sequence | null {
	const s = session.getState();
	return s.activeSequenceId ? (s.document.sequences[s.activeSequenceId] ?? null) : null;
}

/** The focused property row of the Properties / Effect Controls panel, rebuilt from the committed doc. */
function focusedRow(
	ctx: CommandCtx,
): { session: EditorSession; seq: Sequence; row: Row; frame: number } | null {
	const session = ctx.session;
	const focus = inspectorFocus.get();
	if (!session || !focus.rowId) return null;
	const seq = activeSequence(session);
	if (!seq) return null;
	const clips = focus.clipIds.map((id) => seq.clips[id]).filter((c) => !!c);
	if (!clips.length) return null;
	const frame = ctx.transport.getState().frame;
	const row = rowForKey(session.getCommitted(), seq, clips, focus.rowId, frame, {
		effects: session.ctx.registries.effects,
		mg: session.ctx.registries.mgTemplates,
	});
	return row ? { session, seq, row, frame } : null;
}

function run(session: EditorSession, label: string, commands: Command[]): void {
	if (!commands.length) return;
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
}

const hasSession = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;
const hasFocusedRow = (ctx: CommandCtx) => hasSession(ctx) && focusedRow(ctx) !== null;

export const inspectorCommands: UiCommand[] = [
	{
		id: 'inspector.applyEffect',
		label: 'Apply Effect to Selected Clips',
		description: 'Adds an effect (by registry id) to every selected clip that accepts it, as one undo step.',
		scope: 'global',
		argsSchema: z.object({ effectId: z.string().min(1), index: z.number().int().min(0).optional() }),
		agentExposed: true,
		when: (ctx) => hasSession(ctx) && ctx.session!.getState().selection.timeline.clips.length > 0,
		run(ctx, args) {
			const { effectId, index } = args as { effectId: string; index?: number };
			const r = applyEffectToClips(
				ctx.session!,
				effectId,
				ctx.session!.getState().selection.timeline.clips,
				index,
			);
			if (!r)
				ctx.ui.toast({ kind: 'warning', message: 'The effect cannot be applied to the selected clips.' });
			else if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
		},
	},
	{
		id: 'inspector.removeEffect',
		label: 'Remove Effect',
		scope: 'global',
		argsSchema: z.object({ effectInstanceId: z.string().min(1) }).optional(),
		agentExposed: true,
		when: (ctx) => hasSession(ctx),
		run(ctx, args) {
			const id =
				(args as { effectInstanceId?: string } | undefined)?.effectInstanceId ??
				inspectorFocus.get().effectInstanceId;
			if (!id) return;
			run(ctx.session!, 'Remove Effect', [{ type: 'effect.remove', effectInstanceId: id } as Command]);
			if (inspectorFocus.get().effectInstanceId === id) inspectorFocus.set({ effectInstanceId: null });
		},
	},
	{
		id: 'effectControls.removeEffect',
		label: 'Delete Selected Keyframes or Effect',
		scope: 'effectControls',
		when: (ctx) => hasSession(ctx),
		run(ctx) {
			const session = ctx.session!;
			const keys = session.getState().selection.keyframes;
			if (keys?.keyframeIds.length) {
				run(session, `Delete ${keys.keyframeIds.length} Keyframe${keys.keyframeIds.length > 1 ? 's' : ''}`, [
					{ type: 'keyframe.remove', keyframeIds: keys.keyframeIds } as Command,
				]);
				session.selectKeyframes(null);
				return;
			}
			const fx = inspectorFocus.get().effectInstanceId;
			if (fx) {
				run(session, 'Remove Effect', [{ type: 'effect.remove', effectInstanceId: fx } as Command]);
				inspectorFocus.set({ effectInstanceId: null });
				return;
			}
			// wp masks: a mask selected in Effect Controls (its header clears the effect focus).
			const mask = maskUi.get().selected;
			if (mask) deleteMasks(session, [mask.maskId]);
		},
	},
	{
		id: 'inspector.toggleStopwatch',
		label: 'Toggle Animation (Stopwatch)',
		description:
			'Turns keyframing on for the focused property (a key at the playhead) or off (keeps the value at the playhead).',
		scope: 'global',
		when: hasFocusedRow,
		run(ctx) {
			const f = focusedRow(ctx);
			if (!f) return;
			const on = animState(f.row) === 'none';
			run(f.session, `Toggle Animation: ${f.row.label}`, planStopwatch(f.row, f.frame, on).commands);
		},
	},
	{
		// Wave expressions: AE's Animation ▸ Add Expression (Alt+Shift+=) — adds an expression to the focused property
		// (its own reference, AE's default text) or removes the one it has.
		id: 'inspector.toggleExpression',
		label: 'Add/Remove Expression',
		description: 'Adds an expression to the focused property in Effect Controls, or removes its expression.',
		scope: 'global',
		when: (ctx) => {
			const f = hasFocusedRow(ctx) ? focusedRow(ctx) : null;
			return (
				!!f &&
				f.row.bindings.length === 1 &&
				!!rowExpressionOf(f.session.getCommitted(), f.row.bindings[0]!, f.seq.id)
			);
		},
		run(ctx) {
			const f = focusedRow(ctx);
			if (f?.row.bindings.length !== 1) return;
			const doc = f.session.getCommitted();
			const rx = rowExpressionOf(doc, f.row.bindings[0]!, f.seq.id);
			if (!rx) return;
			if (rx.expression) {
				run(f.session, `Remove Expression: ${f.row.label}`, [
					{ type: 'expression.clear', target: rx.path, sequenceId: rx.ref.seq } as Command,
				]);
				return;
			}
			void ensureExpressionEngine();
			run(f.session, `Add Expression: ${f.row.label}`, [
				setExpressionCommand(rx, defaultExpressionText(doc, rx.ref)),
			]);
		},
	},
	{
		id: 'inspector.addRemoveKeyframe',
		label: 'Add/Remove Keyframe',
		scope: 'global',
		when: hasFocusedRow,
		run(ctx) {
			const f = focusedRow(ctx);
			if (!f) return;
			const plan = planToggleKey(f.row, f.seq, f.frame);
			if (!plan.commands.length && plan.skipped.length)
				ctx.ui.toast({ kind: 'info', message: 'Move the playhead over the clip to add a keyframe' });
			run(f.session, f.row.label, plan.commands);
		},
	},
	{
		id: 'inspector.nextKeyframe',
		label: 'Go to Next Keyframe',
		scope: 'global',
		repeat: true,
		when: hasFocusedRow,
		run(ctx) {
			const f = focusedRow(ctx);
			const next = f ? navigateKey(f.row, f.seq, f.frame, 1) : null;
			if (next !== null) ctx.transport.seek(next);
		},
	},
	{
		id: 'inspector.prevKeyframe',
		label: 'Go to Previous Keyframe',
		scope: 'global',
		repeat: true,
		when: hasFocusedRow,
		run(ctx) {
			const f = focusedRow(ctx);
			const prev = f ? navigateKey(f.row, f.seq, f.frame, -1) : null;
			if (prev !== null) ctx.transport.seek(prev);
		},
	},
	{
		id: 'inspector.resetProperty',
		label: 'Reset Property',
		scope: 'global',
		when: hasFocusedRow,
		run(ctx) {
			const f = focusedRow(ctx);
			if (!f) return;
			run(
				f.session,
				`Reset ${f.row.label}`,
				planReset(f.row, f.session.getCommitted(), f.seq, f.frame).commands,
			);
		},
	},
	{
		id: 'effectControls.toggleLoop',
		label: 'Loop Playback',
		scope: 'effectControls',
		checked: (ctx) => ctx.transport.getState().loop,
		run(ctx) {
			ctx.transport.setLoop(!ctx.transport.getState().loop);
		},
	},
	{
		id: 'history.stepBackward',
		label: 'Step Backward',
		scope: 'history',
		repeat: true,
		when: (ctx) => hasSession(ctx) && ctx.session!.getState().history.canUndo,
		run(ctx) {
			ctx.session!.undo();
		},
	},
	{
		id: 'history.stepForward',
		label: 'Step Forward',
		scope: 'history',
		repeat: true,
		when: (ctx) => hasSession(ctx) && ctx.session!.getState().history.canRedo,
		run(ctx) {
			ctx.session!.redo();
		},
	},
	{
		id: 'history.clear',
		label: 'Clear History…',
		scope: 'global',
		argsSchema: z.object({ confirmed: z.boolean().optional() }).optional(),
		when: (ctx) => hasSession(ctx) && ctx.session!.getState().history.entries.length > 0,
		run(ctx, args) {
			const confirmed =
				(args as { confirmed?: boolean } | undefined)?.confirmed ??
				(typeof globalThis.confirm === 'function' ? globalThis.confirm('Clear the undo history?') : false);
			if (confirmed) ctx.session!.clearHistory();
		},
	},
];
