// English is the source language: every user-visible string literal is wrapped in
// `__t("…")` (template literals with substitutions become `__t("… {0} …", a)`), and `__t` looks the string up in the
// active language's catalogue (identity for English). The same rules drive the extraction (`scripts/i18n.mjs`), so the
// catalogue lists exactly what the app can ask for. Rules (positions that hold UI text):
//   1. JSX text;
//   2. JSX attributes named in ATTRS (title, aria-label, placeholder, alt, label, description, …);
//   3. object properties named in KEYS (label, title, description, detail, message, disabledReason, …) — also an arrow
//      function's returned string (`disabledReason: () => 'Open a sequence'`);
//   4. the values of `*_LABELS` / `*LABELS` / `*_NAMES` / `*_TITLES` / `*_TEXT` / `*_HINTS` / `*_REASONS` maps;
//   5. label arguments of the menu helpers (`c(id, label)`, `sub(label, items)`, `sc(id, label)`, `alias(…)`);
//   6. JSX children that are expressions (`{busy ? 'Saving…' : 'Save'}`);
//   7. the literal of an explicit `t('…')` call (recorded only: `t` is the runtime lookup);
// through `?:`, `||`, `??` and parentheses. Strings that look like identifiers, ids, CSS or paths are left alone.
//
// A string in a function body is looked up every time the function
// runs, so a re-render shows the new language. Strings at module scope would be looked up once, when the module
// loads, so they are made lazy instead:
//   - an object property (rules 3 and 4) becomes a getter, `get label() { return __t("…"); }`: the command tables,
//     option lists and `*_LABELS` maps answer in the language of the moment they are read;
//   - a label argument of a menu helper (rule 5) is left as the English source and only recorded for the catalogue:
//     the helpers (`c`, `sub` in shell/menus/model.ts, `sc` in commands/app.ts) translate it when the label is read.
import ts from 'typescript';

export const ATTRS = new Set([
	'title',
	'aria-label',
	'aria-description',
	'aria-roledescription',
	'aria-valuetext',
	'placeholder',
	'alt',
	'label',
	'description',
	'detail',
	'message',
	'primaryLabel',
	'secondaryLabel',
	'cancelLabel',
	'confirmLabel',
	'tooltip',
	'emptyMessage',
	'heading',
	'hint',
	'disabledReason',
	'subtitle',
	'caption',
	'helpText',
	'ariaLabel',
]);
export const KEYS = new Set([
	'label',
	'title',
	'description',
	'detail',
	'message',
	'placeholder',
	'disabledReason',
	'tooltip',
	'hint',
	'heading',
	'emptyMessage',
	'primaryLabel',
	'secondaryLabel',
	'ariaLabel',
	'subtitle',
	'helpText',
	'shortLabel',
	'menuLabel',
	'confirmLabel',
	'cancelLabel',
]);
const MAP_NAME = /(^|_)(LABELS?|NAMES|TITLES|TEXTS?|HINTS|REASONS|MESSAGES|DESCRIPTIONS|TOOLTIPS)$|Labels$/;
const CALL_LABEL_ARGS = { c: [1], sub: [0], sc: [1], alias: [] };

/** Whether a string reads as UI text (not an id, key, class list, path, URL or format token). */
export function isUiText(s) {
	const t = s.trim();
	if (!t || !/\p{L}/u.test(t)) return false;
	if (t.length > 2000) return false;
	if (/^[a-z0-9]+([._:/#-][a-z0-9]+)*$/.test(t)) return false; // ids, keys, single lowercase tokens
	if (/^(https?:|mailto:|data:|\/|\.\/|\.\.\/|#|--)/.test(t)) return false;
	if (
		/^[a-z-]+(\s+[a-z0-9-]+(:[a-z0-9-]+)?)+$/.test(t) &&
		/(^|\s)(flex|grid|px-|py-|text-|bg-|border|rounded|gap-|items-|w-|h-)/.test(t)
	)
		return false; // Tailwind class lists
	if (/^[A-Z][A-Z0-9_]+$/.test(t)) return false; // CONSTANT_CODES
	if (/^\{[^}]*\}$/.test(t)) return false;
	return true;
}

/** A template literal with substitutions as a catalogue key ("… {0} …") and its argument expressions. */
function templateKey(node, src) {
	let key = node.head.text;
	const args = [];
	node.templateSpans.forEach((span, i) => {
		key += `{${i}}${span.literal.text}`;
		args.push(src.slice(span.expression.getStart(), span.expression.getEnd()));
	});
	return { key, args };
}

const q = (s) => JSON.stringify(s);

const ENTITIES = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00a0',
	hellip: '…',
	mdash: '—',
	ndash: '–',
	rsquo: '’',
	lsquo: '‘',
	ldquo: '“',
	rdquo: '”',
	times: '×',
	middot: '·',
};
/** JSX text decodes HTML entities; a JS string does not: decode them before keying. */
function decodeEntities(s) {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
		if (e[0] === '#')
			return String.fromCodePoint(
				e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)),
			);
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

/**
 * Finds the translatable strings of a source file. `edit(start, end, text)` receives replacements (when transforming);
 * `found(key)` every key (when extracting).
 */
export function scan(code, fileName, { edit, found }) {
	const sf = ts.createSourceFile(
		fileName,
		code,
		ts.ScriptTarget.Latest,
		true,
		fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const src = code;
	const seen = new Set();
	/** Not inside any function or class body: evaluated once, when the module loads. */
	const atModuleScope = (n) => {
		for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p) || ts.isClassLike(p)) return false;
		return true;
	};
	/** The label is only recorded (module-scope menu helper arguments): the helper translates it lazily. */
	let recordOnly = false;
	let wrapped = 0;
	/**
	 * Wraps the strings of a property initializer and makes the property lazy (a getter, with a setter that turns it
	 * back into a plain value so code that assigns the property keeps working):
	 *   - at module scope, whatever the expression (it would otherwise be evaluated once, at load);
	 *   - inside a function, only a plain string — it captures nothing, and factories called at load
	 *     (`const importCommand = (id) => ({ id, label: 'Import…' })`) stay live too.
	 * Arrow functions are lazy already.
	 */
	const wrapProperty = (p) => {
		let init = p.initializer;
		while (ts.isParenthesizedExpression(init)) init = init.expression;
		const fn = ts.isArrowFunction(init) || ts.isFunctionExpression(init);
		const plain = ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init);
		const lazy = !fn && !ts.isComputedPropertyName(p.name) && (plain || atModuleScope(p));
		const before = wrapped;
		wrapExpr(p.initializer, 'expr');
		if (!lazy || wrapped === before) return;
		const name = p.name.getText();
		const key = ts.isIdentifier(p.name) ? q(p.name.text) : name;
		edit?.(p.getStart(), p.initializer.getStart(), `get ${name}() { return `);
		edit?.(p.initializer.getEnd(), p.initializer.getEnd(), `; }, set ${name}(v) { __set(this, ${key}, v); }`);
	};
	const wrapExpr = (e, ctx) => {
		if (!e || seen.has(e.pos)) return;
		if (ts.isParenthesizedExpression(e)) return wrapExpr(e.expression, ctx);
		if (ts.isConditionalExpression(e)) {
			wrapExpr(e.whenTrue, ctx);
			wrapExpr(e.whenFalse, ctx);
			return;
		}
		if (
			ts.isBinaryExpression(e) &&
			(e.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
				e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
		) {
			wrapExpr(e.right, ctx);
			return;
		}
		if (ts.isArrowFunction(e) && !ts.isBlock(e.body)) {
			// An arrow is lazy already: its string is wrapped even where a plain label would only be recorded.
			const prev = recordOnly;
			recordOnly = false;
			wrapExpr(e.body, ctx);
			recordOnly = prev;
			return;
		}
		if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
			if (!isUiText(e.text)) return;
			seen.add(e.pos);
			found?.(e.text);
			if (recordOnly) return;
			wrapped++;
			edit?.(
				e.getStart(),
				e.getEnd(),
				`${ctx === 'jsx' ? '{' : ''}__t(${q(e.text)})${ctx === 'jsx' ? '}' : ''}`,
			);
			return;
		}
		if (ts.isTemplateExpression(e)) {
			const { key, args } = templateKey(e, src);
			if (!isUiText(key.replace(/\{\d+\}/g, ''))) return;
			seen.add(e.pos);
			found?.(key);
			wrapped++;
			edit?.(e.getStart(), e.getEnd(), `__t(${q(key)}, ${args.join(', ')})`);
		}
	};
	const visit = (n) => {
		if (ts.isJsxText(n)) {
			const raw = n.text;
			const t = decodeEntities(raw.replace(/\s+/g, ' ').trim());
			if (t && isUiText(t) && !/^[{}]+$/.test(t)) {
				found?.(t);
				const lead = raw.match(/^\s*/)[0];
				const trail = raw.match(/\s*$/)[0];
				// JSX collapses whitespace runs with newlines; keep a single space where the text had one on the line.
				const l = lead.includes('\n') ? '' : lead ? ' ' : '';
				const r = trail.includes('\n') ? '' : trail ? ' ' : '';
				edit?.(n.getStart(), n.getEnd(), `${l ? "{' '}" : ''}{__t(${q(t)})}${r ? "{' '}" : ''}`);
			}
		} else if (
			ts.isJsxExpression(n) &&
			n.expression &&
			(ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
		) {
			// 6. JSX children that are expressions: `{busy ? 'Saving…' : 'Save'}`, `{`${n} items`}`
			wrapExpr(n.expression, 'expr');
		} else if (ts.isJsxAttribute(n)) {
			const name = n.name.getText();
			if (ATTRS.has(name) && n.initializer) {
				if (ts.isStringLiteral(n.initializer)) wrapExpr(n.initializer, 'jsx');
				else if (ts.isJsxExpression(n.initializer)) wrapExpr(n.initializer.expression, 'expr');
			}
		} else if (ts.isPropertyAssignment(n)) {
			const name = ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : null;
			if (name && KEYS.has(name)) wrapProperty(n);
		} else if (
			ts.isVariableDeclaration(n) &&
			ts.isIdentifier(n.name) &&
			MAP_NAME.test(n.name.text) &&
			n.initializer
		) {
			let init = n.initializer;
			while (
				ts.isAsExpression(init) ||
				ts.isSatisfiesExpression?.(init) ||
				ts.isParenthesizedExpression(init)
			)
				init = init.expression;
			if (ts.isObjectLiteralExpression(init))
				for (const p of init.properties) if (ts.isPropertyAssignment(p)) wrapProperty(p);
		} else if (
			ts.isCallExpression(n) &&
			ts.isIdentifier(n.expression) &&
			n.expression.text === 't' &&
			n.arguments.length &&
			(ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0]))
		) {
			// 7. an explicit `t('…')` of the runtime: the string is recorded for the catalogue (t translates it itself)
			if (isUiText(n.arguments[0].text) && !seen.has(n.arguments[0].pos)) {
				seen.add(n.arguments[0].pos);
				found?.(n.arguments[0].text);
			}
		} else if (
			ts.isCallExpression(n) &&
			ts.isIdentifier(n.expression) &&
			CALL_LABEL_ARGS[n.expression.text]
		) {
			// Module scope: the menu / command tables are built once, so the helper translates the label when it is read.
			recordOnly = atModuleScope(n);
			for (const i of CALL_LABEL_ARGS[n.expression.text]) wrapExpr(n.arguments[i], 'expr');
			recordOnly = false;
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
}

/** The transformed code (null when nothing changed). `runtime` = the import path of the `__t` module. */
export function transformI18n(code, fileName, runtime) {
	const edits = [];
	scan(code, fileName, { edit: (s, e, t) => edits.push([s, e, t]) });
	if (!edits.length) return null;
	edits.sort((a, b) => b[0] - a[0]);
	let out = code;
	let lastStart = Number.POSITIVE_INFINITY;
	for (const [s, e, t] of edits) {
		if (e > lastStart) continue; // nested (already replaced by an outer edit)
		out = out.slice(0, s) + t + out.slice(e);
		lastStart = s;
	}
	return `import { __t, __set } from ${q(runtime)};\n${out}`;
}
