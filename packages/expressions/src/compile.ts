// Source transform of an expression into one cached QuickJS function (docs/wp-notes/expressions.md §3).
//
// Two jobs, done on a real JavaScript AST (acorn) instead of a token stream:
//
// 1. After Effects' array maths (ported from EffectCraft `crates/expr/src/rewrite.rs`, MIT OR Apache-2.0): every
//    binary `+ - * /` becomes `__add/__sub/__mul/__div(a, b)`, unary minus `__neg(a)` (numeric literals stay
//    `-5`) and the compound assignments `x op= v` become `x = __op(x, v)`. The helpers fall back to the native
//    operator for numbers and strings, so `value + [10, 0]` and `"a" + 1` both behave as in AE. `%` and `**` stay
//    native, as in rewrite.rs.
// 2. Completion values: an AE expression's result is the value of the last evaluated statement (`if (a) 1; else
//    2`). QuickJS (like every embedding API) only exposes completion values through `eval`, which re-parses the
//    text every frame. Instead every expression statement outside nested functions is rewritten to `__r = (…)`
//    and the program becomes the body of `function () { var __r; …; return __r; }`, compiled once per text and
//    called per evaluation. Compound statements reset `__r` first (ECMAScript UpdateEmpty: `1; if (false) 2`
//    completes with `undefined`). `var`/function declarations are local to each evaluation.
//
// Line breaks are preserved (the wrapper prefix shares line 1 with the user's code), so runtime error lines match
// the user's text. Nesting deeper than MAX_NESTING is rejected like rewrite.rs (the parser and QuickJS recurse per
// level).
import { type AnyNode, Parser, type Program } from 'acorn';

/** Deepest bracket / operator nesting an expression may have (rewrite.rs `MAX_NESTING`). */
const MAX_NESTING = 64;

export type CompiledSource = { ok: true; code: string } | { ok: false; error: string };

const ARITH: Record<string, string> = { '+': '__add', '-': '__sub', '*': '__mul', '/': '__div' };
const COMPOUND: Record<string, string> = { '+=': '__add', '-=': '__sub', '*=': '__mul', '/=': '__div' };
/** Statements whose completion is UpdateEmpty(…, undefined): reset `__r` before them. */
const RESETTING = new Set([
	'IfStatement',
	'ForStatement',
	'ForInStatement',
	'ForOfStatement',
	'WhileStatement',
	'DoWhileStatement',
	'SwitchStatement',
	'TryStatement',
	'WithStatement',
]);
const FUNCTIONS = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ClassDeclaration',
	'ClassExpression',
]);

function isNode(v: unknown): v is AnyNode {
	return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string' && 'start' in v;
}

function children(node: AnyNode): AnyNode[] {
	const out: AnyNode[] = [];
	const fields: [string, unknown][] = Object.entries(node);
	for (const [k, v] of fields) {
		if (k === 'loc' || k === 'range') continue;
		if (isNode(v)) out.push(v);
		else if (Array.isArray(v)) for (const x of v) if (isNode(x)) out.push(x);
	}
	return out.sort((a, b) => a.start - b.start);
}

/** The newlines of `text` (keeps line numbers when a custom rendering drops whitespace and comments). */
function newlines(text: string): string {
	let n = '';
	for (const ch of text) if (ch === '\n') n += '\n';
	return n;
}

function nestingDepth(src: string): number {
	// Brackets plus runs of prefix operators, as rewrite.rs measures it (strings and comments skipped roughly:
	// this is only a guard against parser stack exhaustion, an over-estimate is harmless).
	let depth = 0;
	let max = 0;
	let prefix = 0;
	let quote = '';
	for (let i = 0; i < src.length; i++) {
		const c = src[i]!;
		if (quote) {
			if (c === '\\') i++;
			else if (c === quote || c === '\n') quote = '';
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			quote = c;
			prefix = 0;
			continue;
		}
		if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
		if (c === '!' || c === '~' || c === '-' || c === '+') prefix++;
		else if (!/\s/.test(c)) prefix = 0;
		max = Math.max(max, depth + prefix);
	}
	return max;
}

class Emitter {
	constructor(private readonly src: string) {}

	slice(a: number, b: number): string {
		return this.src.slice(a, b);
	}

	/** Generic rendering: the node's source with its children replaced by their renderings. */
	generic(node: AnyNode, capture: boolean): string {
		let out = '';
		let pos = node.start;
		for (const c of children(node)) {
			if (c.start < pos) continue; // shorthand properties share nodes ({a} = key and value)
			out += this.slice(pos, c.start);
			out += this.gen(c, capture && !FUNCTIONS.has(node.type));
			pos = c.end;
		}
		return out + this.slice(pos, node.end);
	}

	/** A statement in a statement position (`capture` = its completion value is the expression's result). */
	statement(node: AnyNode, capture: boolean, inList: boolean): string {
		if (!capture) return this.gen(node, false);
		if (node.type === 'ExpressionStatement') {
			const expr = node.expression;
			// A lone string literal is the result ("abc"), not a directive: AE expressions are never strict code.
			return `__r=(${this.gen(expr, true)})${this.slice(expr.end, node.end)}`;
		}
		const body = this.gen(node, true);
		const resets =
			RESETTING.has(node.type) || (node.type === 'LabeledStatement' && RESETTING.has(node.body.type));
		if (!resets) return body;
		return inList ? `__r=void 0;${body}` : `{__r=void 0;${body}}`;
	}

	gen(node: AnyNode, capture: boolean): string {
		switch (node.type) {
			case 'Program':
			case 'BlockStatement':
			case 'StaticBlock': {
				let out = '';
				let pos = node.start;
				for (const s of node.body) {
					out += this.slice(pos, s.start);
					out += this.statement(s, capture && node.type !== 'StaticBlock', true);
					pos = s.end;
				}
				return out + this.slice(pos, node.end);
			}
			case 'SwitchCase': {
				let out = '';
				let pos = node.start;
				if (node.test) {
					const t = node.test;
					out += this.slice(pos, t.start) + this.gen(t, capture);
					pos = t.end;
				}
				for (const s of node.consequent) {
					out += this.slice(pos, s.start) + this.statement(s, capture, true);
					pos = s.end;
				}
				return out + this.slice(pos, node.end);
			}
			case 'IfStatement':
			case 'WhileStatement':
			case 'DoWhileStatement':
			case 'ForStatement':
			case 'ForInStatement':
			case 'ForOfStatement':
			case 'LabeledStatement':
			case 'WithStatement': {
				// Statement-position children keep capturing; the header expressions are plain.
				const stmtKeys = new Set(['consequent', 'alternate', 'body']);
				let out = '';
				let pos = node.start;
				const parts: [AnyNode, boolean][] = [];
				const fields: [string, unknown][] = Object.entries(node);
				for (const [k, v] of fields) {
					if (isNode(v)) parts.push([v, stmtKeys.has(k)]);
				}
				parts.sort((a, b) => a[0].start - b[0].start);
				for (const [c, isStmt] of parts) {
					out += this.slice(pos, c.start);
					if (isStmt && node.type === 'LabeledStatement') out += this.gen(c, capture);
					else out += isStmt ? this.statement(c, capture, false) : this.gen(c, false);
					pos = c.end;
				}
				return out + this.slice(pos, node.end);
			}
			case 'BinaryExpression': {
				const helper = ARITH[node.operator];
				if (!helper) return this.generic(node, capture);
				const l = node.left;
				const r = node.right;
				return (
					`${helper}(${newlines(this.slice(node.start, l.start))}${this.gen(l, capture)},` +
					`${newlines(this.slice(l.end, r.start))}${this.gen(r, capture)}` +
					`${newlines(this.slice(r.end, node.end))})`
				);
			}
			case 'UnaryExpression': {
				const arg = node.argument;
				if (node.operator !== '-') return this.generic(node, capture);
				if (arg.type === 'Literal' && typeof arg.value === 'number')
					return `-${this.slice(arg.start, arg.end)}`;
				return `__neg(${newlines(this.slice(node.start, arg.start))}${this.gen(arg, capture)}${newlines(this.slice(arg.end, node.end))})`;
			}
			case 'AssignmentExpression': {
				const helper = COMPOUND[node.operator];
				if (!helper) return this.generic(node, capture);
				const l = node.left;
				const r = node.right;
				const target = this.gen(l, capture);
				return `${target}=${helper}(${target},${newlines(this.slice(l.end, r.start))}(${this.gen(r, capture)}))${newlines(this.slice(r.end, node.end))}`;
			}
			default:
				return this.generic(node, capture);
		}
	}
}

const cache = new Map<string, CompiledSource>();
const MAX_CACHE = 4096;

/** Names the expression realm defines on its (non-extensible) global object; see harden.ts. */
let realmGlobals: ReadonlySet<string> = new Set();
const NEVER_HOISTED = new Set(['arguments', 'eval', '__r']);

/** Called by the runtime once its realm is built: implicit globals other than these become function locals. */
export function setRealmGlobals(names: Iterable<string>): void {
	realmGlobals = new Set(names);
	cache.clear();
}

function patternNames(node: AnyNode | null | undefined, out: Set<string>): void {
	if (!node) return;
	switch (node.type) {
		case 'Identifier':
			out.add(node.name);
			return;
		case 'ArrayPattern':
			for (const el of node.elements) patternNames(el, out);
			return;
		case 'ObjectPattern':
			for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out);
			return;
		case 'AssignmentPattern':
			patternNames(node.left, out);
			return;
		case 'RestElement':
			patternNames(node.argument, out);
			return;
		default:
			return; // member expressions assign properties, not bindings
	}
}

/**
 * Identifiers the program assigns without declaring them at its top level (sloppy-mode implicit globals). They are
 * declared as `var`s of the compiled function: the realm's global object is non-extensible (harden.ts), and an
 * expression's variables must not outlive its evaluation anyway (After Effects keeps no state between
 * evaluations). Names declared with `let`/`const`/`class` at the top level are excluded (a `var` of the same name
 * would be a redeclaration); names declared only in nested scopes are still hoisted, which is harmless (the
 * nested declaration shadows the hoisted one exactly as it shadowed the global).
 */
function implicitGlobals(program: Program): string[] {
	const assigned = new Set<string>();
	const stack: AnyNode[] = [program];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'AssignmentExpression') patternNames(node.left, assigned);
		else if (node.type === 'UpdateExpression') patternNames(node.argument, assigned);
		else if (
			(node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
			node.left.type !== 'VariableDeclaration'
		)
			patternNames(node.left, assigned);
		for (const c of children(node)) stack.push(c);
	}
	if (assigned.size === 0) return [];
	const lexical = new Set<string>();
	for (const s of program.body) {
		if (s.type === 'VariableDeclaration' && s.kind !== 'var')
			for (const d of s.declarations) patternNames(d.id, lexical);
		else if (s.type === 'ClassDeclaration' && s.id) patternNames(s.id, lexical);
	}
	return [...assigned].filter((n) => !lexical.has(n) && !realmGlobals.has(n) && !NEVER_HOISTED.has(n)).sort();
}

/**
 * Transforms an expression's text into the source of a zero-argument function returning the expression's result
 * (array maths applied). Syntax errors come back as `Error at line N: message` (AE's wording). Cached per text.
 */
export function compileExpressionSource(text: string): CompiledSource {
	const hit = cache.get(text);
	if (hit) return hit;
	const out = compileUncached(text);
	if (cache.size >= MAX_CACHE) cache.clear();
	cache.set(text, out);
	return out;
}

function compileUncached(text: string): CompiledSource {
	if (nestingDepth(text) > MAX_NESTING)
		return {
			ok: false,
			error: `Error: expression is nested too deeply (more than ${MAX_NESTING} levels of brackets or chained operators)`,
		};
	let ast: Program;
	try {
		ast = Parser.parse(text, {
			ecmaVersion: 2023,
			sourceType: 'script',
			allowReturnOutsideFunction: true,
			allowHashBang: false,
			locations: true,
		});
	} catch (e) {
		const err = e as { message?: string; loc?: { line: number } };
		const msg = (err.message ?? String(e)).replace(/\s*\(\d+:\d+\)\s*$/, '');
		return { ok: false, error: err.loc ? `Error at line ${err.loc.line}: ${msg}` : `Error: ${msg}` };
	}
	let body: string;
	try {
		body = new Emitter(text).gen(ast, true);
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof RangeError
					? 'Error: expression is too complex'
					: `Error: expression transform failed (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	// The trailing newline closes a final `//` comment.
	const locals = implicitGlobals(ast)
		.map((n) => `,${n}`)
		.join('');
	return { ok: true, code: `(function(){var __r${locals};${body}\n;return __r;})` };
}
