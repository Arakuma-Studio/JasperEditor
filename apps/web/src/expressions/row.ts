// Expression state of an inspector row: where the expression lives (ParamPath ↔ ExpressionRef), its text, and the
// post-expression value / error at the row's time.
import {
	type PropertyStatus,
	pickWhipExpression,
	propertyStatusAt,
	worldOfDocument,
} from '@jasper/expressions';
import {
	type Command,
	type Expression,
	type ExpressionRef,
	locateExpressionTarget,
	type ParamPath,
	type ProjectDocument,
	paramPathToExpressionRef,
} from '@jasper/project';
import type { CompletionNames } from './ExpressionField.tsx';

/** Element attribute that marks a property row as a pick-whip target (its ParamPath as JSON). */
export const PICK_WHIP_ATTR = 'data-expr-path';

/** Value kinds that take expressions (the `expression.set` handler refuses the others). */
const EXPRESSION_KINDS = new Set(['number', 'vec2', 'vec3', 'color', 'boolean', 'enum', 'string']);

export type RowExpression = {
	ref: ExpressionRef;
	path: ParamPath;
	expression: Expression | null;
};

/** The expression slot of a single-binding row (null when the property cannot have one). */
export function rowExpressionOf(
	doc: ProjectDocument,
	b: { path: ParamPath | null; spec: { kind: string; animatable: string; key: string } },
	sequenceId: string,
): RowExpression | null {
	if (!b.path) return null;
	const textKey = b.spec.key === 'text.content';
	if (!textKey && (b.spec.animatable === 'no' || !EXPRESSION_KINDS.has(b.spec.kind))) return null;
	const ref = paramPathToExpressionRef(doc, b.path, sequenceId);
	if (!ref) return null;
	const loc = locateExpressionTarget(doc, ref);
	const expression = (loc?.target as { expression?: Expression } | undefined)?.expression ?? null;
	return { ref, path: b.path, expression };
}

/** Post-expression status at a stored (content) time; null when the engine is not loaded or nothing to show. */
export function rowStatus(
	doc: ProjectDocument,
	rx: RowExpression,
	t: number,
	ready: boolean,
): PropertyStatus | null {
	if (!ready || !rx.expression) return null;
	return propertyStatusAt(doc, rx.ref, t);
}

/** AE's default text when an expression is switched on: the property's own reference (`transform.position`). */
export function defaultExpressionText(doc: ProjectDocument, ref: ExpressionRef): string {
	return pickWhipExpression(doc, { ...ref, path: '\u0000self' }, ref) ?? 'value';
}

export function setExpressionCommand(
	rx: Pick<RowExpression, 'path' | 'ref'>,
	text: string,
	enabled?: boolean,
): Command {
	return {
		type: 'expression.set',
		target: rx.path,
		text,
		...(enabled === undefined ? {} : { enabled }),
		sequenceId: rx.ref.seq,
	} as Command;
}

/** Names for autocomplete: the owner clip's effects and their params, the sequence's layers. */
export function completionNames(doc: ProjectDocument, ref: ExpressionRef): CompletionNames {
	const world = worldOfDocument(doc);
	const info = world.owner(ref.seq, ref.owner);
	const seq = doc.sequences[ref.seq];
	const effects: string[] = [];
	const params: Record<string, string[]> = {};
	if (info)
		for (const n of world.children(info, 'effects')) {
			effects.push(n.name);
			params[n.name] = world.children(info, n.path).map((p) => p.name);
		}
	const layers = seq ? world.layers(ref.seq).map((id) => seq.clips[id]?.name ?? id) : [];
	return { effects, layers, params };
}

/** Every referenceable property of the sequence, by clip (the "Link to Property" menu). */
export function linkTargets(
	doc: ProjectDocument,
	from: ExpressionRef,
): { clip: string; label: string; props: { label: string; text: string }[] }[] {
	const world = worldOfDocument(doc);
	const seq = doc.sequences[from.seq];
	if (!seq) return [];
	return world.layers(from.seq).flatMap((id, i) => {
		const props = world
			.listProps(from.seq, id)
			.filter((p) => !(p.ref.owner === from.owner && p.ref.path === from.path))
			.map((p) => {
				const text = pickWhipExpression(doc, from, p.ref);
				const group = p.ref.path.startsWith('effects.')
					? `${world.children(world.owner(from.seq, id)!, 'effects').find((n) => p.ref.path.startsWith(`${n.path}.`))?.name ?? 'Effect'} ▸ `
					: '';
				return text ? { label: `${group}${p.name}`, text } : null;
			})
			.filter((x): x is { label: string; text: string } => !!x);
		return props.length ? [{ clip: id, label: `${i + 1}. ${seq.clips[id]?.name ?? id}`, props }] : [];
	});
}
