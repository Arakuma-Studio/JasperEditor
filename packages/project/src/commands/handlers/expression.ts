// expression.set / expression.clear / expression.setEnabled / effect.rename (wave expressions,
// docs/wp-notes/expressions.md). Expressions are stored on the property's Animatable (`expression`) or, for a
// text clip's Source Text, on its TextContent. The text is not compiled here (handlers are pure and the engine is
// WebAssembly): syntax and runtime errors surface at evaluation as `expressionError` and the property renders its
// keyframed value meanwhile, like After Effects.
import type { Draft } from 'immer';
import type { Expression } from '../../schema/common.ts';
import type { TextContent } from '../../schema/sequence.ts';
import type { DDoc, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { locateEffect, resolveTarget } from './param.ts';
import type { HandlerMap } from './util.ts';

export const EXPRESSION_OWNER = 'wp-m3-expressions' as const;

/** Value kinds that can carry an expression (curves, media refs and JSON props cannot). */
const EXPRESSION_KINDS = new Set(['number', 'vec2', 'color', 'boolean', 'enum', 'string']);

type Holder = { expression?: Expression; label: string };

/** The object holding the expression of a ParamPath (an Animatable draft or a text clip's content). */
function holder(doc: DDoc, cmd: { target: string[]; sequenceId?: string }, h: HandlerContext): Draft<Holder> {
	const [head, clipId, ...rest] = cmd.target;
	const key = rest.join('.');
	if (head === 'clip' && clipId && (key === 'text.content' || key === 'text.sourceText')) {
		const { seq, clip } = h.clip(doc, clipId);
		if (clip.kind !== 'text')
			return h.fail('E_INVALID_PARAM', `Source Text expressions need a text clip (${clipId} is ${clip.kind})`);
		assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
		const content = (clip as unknown as { content: Draft<TextContent> }).content;
		return content as unknown as Draft<Holder>;
	}
	const target = resolveTarget(doc, cmd, h);
	if (target.type !== 'anim')
		return h.fail('E_INVALID_PARAM', `${target.label} is not animatable, so it cannot have an expression`, {
			path: cmd.target,
		});
	if (!EXPRESSION_KINDS.has(target.rule.kind))
		return h.fail('E_INVALID_PARAM', `${target.label}: expressions are not supported on ${target.rule.kind} values`, {
			path: cmd.target,
		});
	return target.anim as unknown as Draft<Holder>;
}

export const expressionHandlers: HandlerMap = {
	'expression.set': (doc, cmd: CommandOf<'expression.set'>, h: HandlerContext) => {
		const o = holder(doc, cmd, h);
		if (cmd.text.trim() === '') {
			const had = !!o.expression;
			delete o.expression;
			return { cleared: had };
		}
		const enabled = cmd.enabled ?? true;
		o.expression = { text: cmd.text, enabled };
		return { text: cmd.text, enabled };
	},
	'expression.clear': (doc, cmd: CommandOf<'expression.clear'>, h: HandlerContext) => {
		const o = holder(doc, cmd, h);
		const had = !!o.expression;
		delete o.expression;
		return { cleared: had };
	},
	'expression.setEnabled': (doc, cmd: CommandOf<'expression.setEnabled'>, h: HandlerContext) => {
		const o = holder(doc, cmd, h);
		if (!o.expression) return h.fail('E_INVALID_PARAM', 'The property has no expression', { path: cmd.target });
		o.expression.enabled = cmd.enabled;
		return { enabled: cmd.enabled };
	},
	'effect.rename': (doc, cmd: CommandOf<'effect.rename'>, h: HandlerContext) => {
		const loc = locateEffect(doc, cmd.effectInstanceId);
		if (!loc) return h.fail('E_NOT_FOUND', `Effect instance not found: ${cmd.effectInstanceId}`);
		if (loc.clip) assertUnlocked(findTrackIn(loc.seq, loc.clip.trackId)!.track, h);
		if (loc.track) assertUnlocked(loc.track, h);
		const name = cmd.name?.trim() ?? '';
		if (name) loc.fx.name = name;
		else delete loc.fx.name;
		return { name: name || null };
	},
};
