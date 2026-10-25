// Easing commands (Easing panel, Effect Controls key menu, Clip ▸ Keyframe Easing, palette, F9 shortcuts): every
// action on the keyframe selection is one transaction (one undo step). Refusals and warnings of the document
// commands are shown as toasts; a command that cannot run says why (`disabledReason`): no keyframe selection,
// a locked track, a read-only project, a selection the action does not apply to, or a missing document command.
import { EXPRESSION_PRESETS } from '@jasper/expressions';
import {
	type Command,
	copyEase,
	copyValues,
	type EaseCurve,
	EaseCurveSchema,
	EaseSectionSchema,
	type Sequence,
	type TransactionResult,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import { easeClipboard } from '../panels/easing/clipboard.ts';
import {
	applyEaseCommand,
	cleanupPathCommand,
	continuousCommand,
	createPathControllerCommand,
	type EaseDocCommand,
	easyEaseCommand,
	expressionCommands,
	keysAtPlayheadCommand,
	missingDocCommand,
	pasteEaseCommand,
	pasteValuesCommand,
	setVelocityCommand,
	spatialLinearCommand,
} from '../panels/easing/doc-commands.ts';
import { easeLibrary, pushRecent } from '../panels/easing/library.ts';
import { type EaseSelection, readEaseSelection, spatialKeyIds } from '../panels/easing/selection.ts';
import type { CommandCtx, UiCommand } from './types.ts';

type EaseEnv = { session: EditorSession; seq: Sequence; sel: EaseSelection };

function activeSequence(session: EditorSession): Sequence | null {
	const s = session.getState();
	return s.activeSequenceId ? (s.document.sequences[s.activeSequenceId] ?? null) : null;
}

/** The keyframe selection as the easing actions see it (null without a project or sequence). */
export function easeEnv(ctx: CommandCtx): EaseEnv | null {
	const session = ctx.session;
	if (!session) return null;
	const seq = activeSequence(session);
	if (!seq) return null;
	const st = session.getState();
	const sel = readEaseSelection(session.getCommitted(), seq, st.selection.keyframes, {
		registries: session.ctx.registries,
		readOnly: st.readOnly,
	});
	return { session, seq, sel };
}

/** Why the selection cannot be eased right now, else undefined. */
function selectionReason(ctx: CommandCtx): string | undefined {
	if (!ctx.session) return t('Open a project first');
	if (ctx.session.getState().gesture) return t('Finish the current drag first');
	const e = easeEnv(ctx);
	if (!e) return t('Open a sequence first');
	return e.sel.blocked ?? undefined;
}

const keyIds = (sel: EaseSelection) => sel.properties.flatMap((p) => p.keys.map((k) => k.id));

/** Every warning of a result, once each (W_EASE_SKIPPED, W_EASE_FLAT_SEGMENT, W_EASE_CLAMPED, …). */
export function warningText(r: TransactionResult): string | null {
	if (!r.ok || !r.warnings.length) return null;
	const lines = [...new Set(r.warnings.map((w) => w.message))];
	return lines.length > 4
		? `${lines.slice(0, 4).join('\n')}\n${t('… and {0} more', lines.length - 4)}`
		: lines.join('\n');
}

/** Applies document commands as one undo step; refusals and warnings become toasts. */
export function runEaseTransaction(
	ctx: CommandCtx,
	label: string,
	commands: Command[],
	sequenceId?: string,
): TransactionResult | null {
	if (!ctx.session || commands.length === 0) return null;
	const r = ctx.session.apply({ label, origin: 'user', commands, ...(sequenceId ? { sequenceId } : {}) });
	if (!r.ok) {
		ctx.ui.toast({ kind: 'warning', message: t('{0}: not possible', label), detail: r.errors[0]?.message });
		return r;
	}
	const w = warningText(r);
	if (w) ctx.ui.toast({ kind: 'warning', message: label, detail: w });
	return r;
}

/**
 * After an ease command the selection follows its result (`{affected, created, removed}`): the eased keys and the
 * keys a multi-point curve created, so a second apply reaches the same span.
 */
function selectResult(e: EaseEnv, r: TransactionResult | null): void {
	if (!r?.ok) return;
	const res = r.results[0] as { affected?: string[]; created?: string[]; removed?: string[] } | undefined;
	if (!res?.affected && !res?.created) return;
	const removed = new Set(res.removed ?? []);
	const ids = [...new Set([...e.sel.keyframeIds, ...(res.created ?? [])])].filter((id) => !removed.has(id));
	const keySel = e.session.getState().selection.keyframes;
	if (keySel && ids.length)
		e.session.selectKeyframes({ clipOrTrackId: keySel.clipOrTrackId, keyframeIds: ids });
}

/** A command on the keyframe selection, enabled when it can be eased (and its document command exists). */
function selectionCommand(
	def: Omit<UiCommand, 'scope' | 'run' | 'when' | 'disabledReason'> & {
		needs?: EaseDocCommand;
		/** Extra condition on the selection: the reason it is not met, else undefined. */
		require?(e: EaseEnv, ctx: CommandCtx): string | undefined;
		run(e: EaseEnv, ctx: CommandCtx, args: unknown): void;
	},
): UiCommand {
	const reason = (ctx: CommandCtx): string | undefined => {
		const missing = def.needs ? missingDocCommand(def.needs) : undefined;
		if (missing) return missing;
		const r = selectionReason(ctx);
		if (r) return r;
		const e = easeEnv(ctx);
		return e && def.require ? def.require(e, ctx) : undefined;
	};
	const { run } = def;
	// Label and description are read when shown (they may be translated getters), never copied.
	return {
		id: def.id,
		get label() {
			return def.label;
		},
		get description() {
			return def.description;
		},
		...(def.argsSchema ? { argsSchema: def.argsSchema } : {}),
		...(def.agentExposed ? { agentExposed: true } : {}),
		...(def.hidden ? { hidden: true } : {}),
		scope: 'global',
		when: (ctx) => reason(ctx) === undefined,
		disabledReason: reason,
		run(ctx, args) {
			const e = easeEnv(ctx);
			if (!e) return;
			run(e, ctx, args);
		},
	};
}

/** The UI text of a helper-built command: an object literal, so its strings are translated when read. */
type Text = { id: string; label: string; description?: string };

function easyEase(text: Text, side: 'both' | 'in' | 'out'): UiCommand {
	return selectionCommand({
		id: text.id,
		get label() {
			return text.label;
		},
		get description() {
			return text.description;
		},
		agentExposed: true,
		run: (e, ctx) => {
			runEaseTransaction(ctx, text.label, [easyEaseCommand(keyIds(e.sel), side)], e.seq.id);
		},
	});
}

const ApplyArgs = z
	.strictObject({
		curve: EaseCurveSchema,
		sections: z.array(EaseSectionSchema).max(3).optional(),
		/** History label (a preset name). */
		name: z.string().min(1).max(200).optional(),
	})
	.optional();

const VelocityArgs = z.strictObject({
	keyframeId: z.string().min(1).max(200),
	side: z.enum(['in', 'out', 'both']),
	speed: z.number().min(-1e9).max(1e9).optional(),
	influence: z.number().min(0.1).max(100).optional(),
});

const PasteArgs = z
	.strictObject({
		sections: z.array(EaseSectionSchema).max(3).optional(),
		mode: z.enum(['segments', 'curve']).optional(),
	})
	.optional();

const spatialRequired = (e: EaseEnv) =>
	spatialKeyIds(e.sel).length ? undefined : t('Select keys of a point property (Position, Anchor Point…)');

const overshoot = EXPRESSION_PRESETS.find((p) => p.id === 'overshoot');
const bounce = EXPRESSION_PRESETS.find((p) => p.id === 'bounce-back');

function expressionCommand(text: Text, preset: typeof overshoot): UiCommand {
	return selectionCommand({
		id: text.id,
		get label() {
			return text.label;
		},
		get description() {
			return preset ? t(preset.description) : undefined;
		},
		require: (e) => {
			if (!preset) return t('This build has no such expression preset');
			return expressionCommands(e.sel, preset.text, preset.kinds, e.seq.id).length
				? undefined
				: t('The selected properties take no expression');
		},
		run: (e, ctx) => {
			if (!preset) return;
			runEaseTransaction(
				ctx,
				text.label,
				expressionCommands(e.sel, preset.text, preset.kinds, e.seq.id),
				e.seq.id,
			);
		},
	});
}

function keysAtPlayhead(text: Text, mirror: boolean): UiCommand {
	const label = () => text.label;
	return selectionCommand({
		id: text.id,
		get label() {
			return text.label;
		},
		get description() {
			return text.description;
		},
		require: (e) => (e.sel.clipId ? undefined : t('Select clip keyframes')),
		run: (e, ctx) => {
			const ids = keyIds(e.sel);
			let command: Command;
			try {
				command = keysAtPlayheadCommand(
					e.session.getCommitted(),
					e.sel.clipId!,
					ids,
					ctx.transport.getState().frame,
					mirror,
					e.seq.id,
				);
			} catch (error) {
				ctx.ui.toast({
					kind: 'warning',
					message: t('{0}: not possible', label()),
					detail: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			const r = runEaseTransaction(ctx, label(), [command], e.seq.id);
			const pasted = r?.ok
				? (r.results[0] as { keyframeIds?: string[] } | undefined)?.keyframeIds
				: undefined;
			if (pasted?.length) e.session.selectKeyframes({ clipOrTrackId: e.sel.clipId!, keyframeIds: pasted });
		},
	});
}

/** The curve the palette's Apply uses: the Easing panel's current curve. */
const currentCurve = (): EaseCurve | null => easeLibrary.get().settings.curve;

export const easingCommands: UiCommand[] = [
	// After Effects' Keyframe Assistant shortcuts: Easy Ease F9, Easy Ease In Shift+F9, Easy Ease Out Ctrl+Shift+F9.
	easyEase(
		{
			id: 'ease.easyEase',
			label: 'Easy Ease',
			description: 'Eases the selected keys on both sides (one third influence, zero speed).',
		},
		'both',
	),
	easyEase(
		{
			id: 'ease.easyEaseIn',
			label: 'Easy Ease In',
			description: 'Eases the selected keys where the motion arrives at them.',
		},
		'in',
	),
	easyEase(
		{
			id: 'ease.easyEaseOut',
			label: 'Easy Ease Out',
			description: 'Eases the selected keys where the motion leaves them.',
		},
		'out',
	),
	selectionCommand({
		id: 'ease.apply',
		label: 'Apply Ease',
		description:
			'Applies a curve (the Easing panel’s, or the one given) to the selected keyframes: between selected keys, or around a single key; sections choose in / middle / out.',
		argsSchema: ApplyArgs,
		agentExposed: true,
		needs: 'keyframe.applyEase',
		run: (e, ctx, args) => {
			const a = args as z.infer<typeof ApplyArgs>;
			const curve = a?.curve ?? currentCurve();
			if (!curve) {
				ctx.ui.toast({ kind: 'info', message: t('Choose a curve in the Easing panel') });
				return;
			}
			const sections = a?.sections ?? easeLibrary.get().settings.sections;
			const label = a?.name ? t('Apply Ease: {0}', t(a.name)) : t('Apply Ease');
			const r = runEaseTransaction(ctx, label, [applyEaseCommand(keyIds(e.sel), curve, sections)], e.seq.id);
			selectResult(e, r);
			if (r?.ok) easeLibrary.update((s) => pushRecent(s, curve));
		},
	}),
	selectionCommand({
		id: 'ease.copy',
		label: 'Copy Ease',
		description: 'Copies the ease (and the values) of the selected keys for Paste Ease / Paste Values.',
		agentExposed: true,
		run: (e, ctx) => {
			const doc = e.session.getCommitted();
			const ids = keyIds(e.sel);
			const c = copyEase(doc, ids, e.session.ctx.registries);
			if (!c.ok) {
				ctx.ui.toast({ kind: 'info', message: t('Copy Ease: not possible'), detail: c.message });
				return;
			}
			const v = copyValues(doc, ids, e.session.ctx.registries);
			const label = e.sel.properties.map((p) => t(p.label)).join(', ');
			easeClipboard.set({ ease: c.clip, values: v.ok ? v.values : [], label });
			ctx.ui.toast({ kind: 'info', message: t('Copied the ease of {0}', label), durationMs: 2000 });
		},
	}),
	selectionCommand({
		id: 'ease.paste',
		label: 'Paste Ease',
		description: 'Gives the selected keys the copied ease, keeping their times and values.',
		argsSchema: PasteArgs,
		agentExposed: true,
		needs: 'keyframe.pasteEase',
		require: () => (easeClipboard.get() ? undefined : t('Copy an ease first')),
		run: (e, ctx, args) => {
			const clip = easeClipboard.get();
			if (!clip) return;
			const a = args as z.infer<typeof PasteArgs>;
			const sections = a?.sections ?? easeLibrary.get().settings.sections;
			const r = runEaseTransaction(
				ctx,
				t('Paste Ease'),
				[pasteEaseCommand(keyIds(e.sel), clip.ease, { sections, mode: a?.mode })],
				e.seq.id,
			);
			selectResult(e, r);
		},
	}),
	selectionCommand({
		id: 'ease.pasteValues',
		label: 'Paste Values',
		description: 'Gives the selected keys the copied values in order, keeping their times and eases.',
		needs: 'keyframe.pasteValues',
		require: () => (easeClipboard.get()?.values.length ? undefined : t('Copy keys first')),
		run: (e, ctx) => {
			const clip = easeClipboard.get();
			if (!clip) return;
			runEaseTransaction(
				ctx,
				t('Paste Keyframe Values'),
				[pasteValuesCommand(keyIds(e.sel), clip.values)],
				e.seq.id,
			);
		},
	}),
	selectionCommand({
		id: 'ease.setVelocity',
		label: 'Keyframe Velocity',
		description:
			'Sets the incoming / outgoing speed (property units per second) and influence (%) of one selected key.',
		argsSchema: VelocityArgs,
		agentExposed: true,
		hidden: true,
		needs: 'keyframe.setVelocity',
		run: (e, ctx, args) => {
			const a = args as z.infer<typeof VelocityArgs>;
			if (!e.sel.keyframeIds.includes(a.keyframeId)) {
				ctx.ui.toast({ kind: 'info', message: t('Select the keyframe first') });
				return;
			}
			runEaseTransaction(
				ctx,
				t('Keyframe Velocity'),
				[setVelocityCommand(a.keyframeId, a.side, { speed: a.speed, influence: a.influence })],
				e.seq.id,
			);
		},
	}),
	selectionCommand({
		id: 'ease.drivePath',
		label: 'Drive Along Path',
		description: 'Makes the selected point keys follow their motion path driven by one progress control.',
		needs: 'keyframe.createPathController',
		require: (e) => {
			const points = e.sel.properties.filter((p) => p.spatial);
			if (points.length !== 1 || e.sel.properties.length !== 1)
				return t('Select keys of one point property (Position, Anchor Point…)');
			return points[0]!.keys.length >= 2 ? undefined : t('Select two or more keys of the property');
		},
		run: (e, ctx) => {
			runEaseTransaction(
				ctx,
				t('Drive Along Path'),
				[createPathControllerCommand(spatialKeyIds(e.sel))],
				e.seq.id,
			);
		},
	}),
	selectionCommand({
		id: 'ease.cleanupPath',
		label: 'Clean Up Motion Path',
		description: 'Removes the redundant keys of the selected point keys’ motion path, keeping its shape.',
		needs: 'keyframes.cleanupPath',
		require: spatialRequired,
		run: (e, ctx) => {
			const r = runEaseTransaction(
				ctx,
				t('Clean Up Motion Path'),
				[cleanupPathCommand(spatialKeyIds(e.sel))],
				e.seq.id,
			);
			selectResult(e, r);
		},
	}),
	selectionCommand({
		id: 'ease.spatialLinear',
		label: 'Spatial Interpolation: Linear',
		description: 'Straight motion-path segments through the selected point keys.',
		require: spatialRequired,
		run: (e, ctx) => {
			runEaseTransaction(
				ctx,
				t('Spatial Interpolation: Linear'),
				[spatialLinearCommand(spatialKeyIds(e.sel))],
				e.seq.id,
			);
		},
	}),
	selectionCommand({
		id: 'ease.temporalContinuous',
		label: 'Temporal Interpolation: Continuous Bezier',
		description: 'Smooth speed through the selected keys (equal in and out speed).',
		run: (e, ctx) => {
			runEaseTransaction(
				ctx,
				t('Temporal Interpolation: Continuous Bezier'),
				[continuousCommand(keyIds(e.sel))],
				e.seq.id,
			);
		},
	}),
	keysAtPlayhead(
		{
			id: 'ease.duplicateAtPlayhead',
			label: 'Duplicate Keys at Playhead',
			description: 'Copies the selected keys to the playhead, keeping their spacing and eases.',
		},
		false,
	),
	keysAtPlayhead(
		{
			id: 'ease.mirrorAtPlayhead',
			label: 'Mirror Keys at Playhead',
			description:
				'Copies the selected keys to the playhead in reverse order with mirrored eases (there and back).',
		},
		true,
	),
	expressionCommand({ id: 'ease.addOvershoot', label: 'Add Overshoot Expression' }, overshoot),
	expressionCommand({ id: 'ease.addBounce', label: 'Add Bounce Expression' }, bounce),
];
