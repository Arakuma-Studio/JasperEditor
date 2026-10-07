// The inline expression editor (AE's expression field in the timeline): CodeMirror 6 with JavaScript syntax
// highlighting and autocomplete of the expression object model (EXPRESSION_REFERENCE plus the clip's own effect
// names and the sequence's layer names). Enter on the numeric keypad or Ctrl/Cmd+Enter commits (AE), Escape cancels,
// leaving the field commits.
import {
	autocompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { bracketMatching, HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { EXPRESSION_REFERENCE, type RefScope } from '@jasper/expressions';
import { tags } from '@lezer/highlight';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export type ExpressionFieldHandle = {
	/** Inserts text at the selection (pick-whip) or replaces everything when the field is not focused. */
	insert(text: string): void;
	focus(): void;
};

export type CompletionNames = { effects: string[]; layers: string[]; params: Record<string, string[]> };

const highlight = HighlightStyle.define([
	{
		tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword],
		color: 'var(--pr-expr-keyword)',
	},
	{ tag: [tags.string, tags.special(tags.string)], color: 'var(--pr-expr-string)' },
	{ tag: [tags.number, tags.bool, tags.null], color: 'var(--pr-expr-number)' },
	{
		tag: [tags.comment, tags.lineComment, tags.blockComment],
		color: 'var(--pr-expr-comment)',
		fontStyle: 'italic',
	},
	{
		tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
		color: 'var(--pr-expr-function)',
	},
	{ tag: tags.propertyName, color: 'var(--pr-expr-property)' },
]);

const theme = EditorView.theme(
	{
		'&': {
			color: 'var(--pr-expr-text)',
			backgroundColor: 'var(--pr-expr-bg)',
			fontSize: 'var(--pr-font-size-ui)',
			border: '1px solid var(--pr-expr-border)',
			borderRadius: '2px',
		},
		'&.cm-focused': { outline: '1px solid var(--pr-accent)' },
		'.cm-content': {
			fontFamily: 'var(--pr-font-mono)',
			padding: '2px 0',
			caretColor: 'var(--pr-expr-cursor)',
		},
		'.cm-line': { padding: '0 4px' },
		'.cm-cursor': { borderLeftColor: 'var(--pr-expr-cursor)' },
		'&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
			backgroundColor: 'var(--pr-expr-selection)',
		},
		'.cm-tooltip': {
			backgroundColor: 'var(--pr-bg-panel)',
			border: '1px solid var(--pr-border)',
			color: 'var(--pr-text-primary)',
		},
		'.cm-tooltip-autocomplete ul li[aria-selected]': {
			backgroundColor: 'var(--pr-accent-fill)',
			color: 'var(--pr-on-accent)',
		},
		'.cm-completionDetail': { color: 'var(--pr-text-secondary)', fontStyle: 'normal', marginLeft: '8px' },
		'.cm-placeholder': { color: 'var(--pr-text-tertiary)' },
	},
	{ dark: true },
);

const SCOPE_AFTER: Record<string, RefScope> = {
	thisComp: 'comp',
	thisLayer: 'layer',
	thisProperty: 'property',
	marker: 'marker',
};

function entries(scope: RefScope): Completion[] {
	return EXPRESSION_REFERENCE.filter((e) => e.scope === scope).map((e) => ({
		label: e.name,
		detail: e.signature,
		info: e.doc,
		type: e.signature.includes('(') ? 'function' : 'variable',
		apply: e.snippet ? e.snippet.replace('$', '') : e.name,
	}));
}

/** Autocomplete source: globals, members after `thisComp.` / `thisLayer.` / `.`, effect and layer names in quotes. */
export function expressionCompletions(names: () => CompletionNames) {
	return (ctx: CompletionContext): CompletionResult | null => {
		// Inside a string after effect( / layer( / comp(: names.
		const str = ctx.matchBefore(/(effect|layer|param|\)\s*)\(\s*["'][^"']*$/);
		if (str) {
			const quote = str.text.search(/["']/);
			const kind = str.text.startsWith('effect') ? 'effects' : 'layers';
			const n = names();
			let list = kind === 'effects' ? n.effects : n.layers;
			if (str.text.startsWith(')')) {
				const fx = /effect\(\s*["']([^"']+)["']\s*\)\s*\(\s*["'][^"']*$/.exec(ctx.state.sliceDoc(0, ctx.pos));
				list = fx ? (n.params[fx[1]!] ?? []) : [];
			}
			return {
				from: str.from + quote + 1,
				options: list.map((label) => ({ label, type: 'text' })),
				validFor: /^[^"']*$/,
			};
		}
		const member = ctx.matchBefore(/([A-Za-z_$][\w$]*)\s*\.\s*[\w$]*$/);
		if (member) {
			const obj = /^([A-Za-z_$][\w$]*)/.exec(member.text)![1]!;
			const dot = member.text.lastIndexOf('.');
			const scope = SCOPE_AFTER[obj] ?? (/(layer|Layer)$/.test(obj) ? 'layer' : null);
			const opts = scope ? entries(scope) : [...entries('property'), ...entries('layer'), ...entries('key')];
			return { from: member.from + dot + 1, options: opts, validFor: /^[\w$]*$/ };
		}
		const word = ctx.matchBefore(/[A-Za-z_$][\w$]*/);
		if (!word && !ctx.explicit) return null;
		return {
			from: word ? word.from : ctx.pos,
			options: [...entries('global'), ...entries('selector')],
			validFor: /^[\w$]*$/,
		};
	};
}

type Props = {
	value: string;
	onCommit(text: string): void;
	onCancel?(): void;
	names(): CompletionNames;
	label: string;
	autoFocus?: boolean;
	invalid?: boolean;
	'data-testid'?: string;
};

export const ExpressionField = forwardRef<ExpressionFieldHandle, Props>(function ExpressionField(props, ref) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const latest = useRef(props);
	latest.current = props;
	const committed = useRef(props.value);

	useImperativeHandle(ref, () => ({
		insert(text: string) {
			const v = view.current;
			if (!v) return;
			if (v.hasFocus) {
				const sel = v.state.selection.main;
				v.dispatch({
					changes: { from: sel.from, to: sel.to, insert: text },
					selection: { anchor: sel.from + text.length },
				});
			} else {
				v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
				commit();
			}
		},
		focus() {
			view.current?.focus();
		},
	}));

	const commit = () => {
		const v = view.current;
		if (!v) return;
		const text = v.state.doc.toString();
		if (text === committed.current) return;
		committed.current = text;
		latest.current.onCommit(text);
	};

	const commitAndLeave = () => {
		commit();
		view.current?.contentDOM.blur();
		return true;
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once; props are read through refs
	useEffect(() => {
		if (!host.current) return;
		const extensions: Extension[] = [
			history(),
			closeBrackets(),
			bracketMatching(),
			new LanguageSupport(javascriptLanguage),
			syntaxHighlighting(highlight),
			autocompletion({
				override: [expressionCompletions(() => latest.current.names())],
				activateOnTyping: true,
			}),
			placeholder('Expression'),
			EditorView.lineWrapping,
			theme,
			keymap.of([
				{ key: 'Mod-Enter', run: commitAndLeave },
				{ key: 'NumpadEnter', run: commitAndLeave },
				{
					key: 'Escape',
					run: (v) => {
						v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: committed.current } });
						v.contentDOM.blur();
						latest.current.onCancel?.();
						return true;
					},
				},
				...closeBracketsKeymap,
				...completionKeymap,
				...historyKeymap,
				indentWithTab,
				...defaultKeymap,
			]),
			EditorView.domEventHandlers({
				blur: () => {
					commit();
					return false;
				},
				// Keep panel shortcuts (Delete, Space…) away while typing.
				keydown: (e) => {
					e.stopPropagation();
					return false;
				},
			}),
			EditorView.contentAttributes.of({
				'aria-label': props.label,
				'data-testid': props['data-testid'] ?? '',
			}),
		];
		view.current = new EditorView({
			parent: host.current,
			state: EditorState.create({ doc: props.value, extensions }),
		});
		if (props.autoFocus) view.current.focus();
		return () => {
			view.current?.destroy();
			view.current = null;
		};
	}, []);

	// External changes (undo, agents) replace the text unless the user is editing.
	useEffect(() => {
		const v = view.current;
		committed.current = props.value;
		if (!v || v.hasFocus || v.state.doc.toString() === props.value) return;
		v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
	}, [props.value]);

	return (
		<div
			ref={host}
			className="min-w-0 flex-1"
			style={props.invalid ? { boxShadow: '0 0 0 1px var(--pr-warning)' } : undefined}
		/>
	);
});
