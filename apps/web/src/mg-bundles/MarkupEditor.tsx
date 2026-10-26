// The on-canvas text field (M3, wp-m3-mgtext, S08:MGU-005): a plain-text contentEditable that draws a text with
// the accent markup the composition declares (`texts.<path>.accent`): `*…*` spans in the accent colour, the
// asterisks hidden — shown (dimmed) only while the caret is inside that span, so they stay editable. The value is
// the raw string (markup included); the DOM is rebuilt from it after every input and the caret restored by
// character offset, so the browser never owns the structure. Without an accent it is a plain multi-line field.
import { accentRuns } from '@jasper/project';
import {
	type CSSProperties,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';

type Props = {
	value: string;
	onChange(v: string): void;
	/** Accent colour of `*…*` spans; null = no markup (asterisks are plain characters). */
	accent: string | null;
	multiline: boolean;
	style: CSSProperties;
	onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void;
	onBlur?(): void;
	'aria-label': string;
	'data-testid'?: string;
	'data-text-path'?: string;
};

/** Caret offset (characters of the raw value) of a DOM position inside `root`. */
export function offsetOf(root: HTMLElement, node: Node, off: number): number {
	let n = 0;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let t: Node | null;
	// Element positions: the offset counts child nodes; convert to the text before that child.
	let target = node;
	let targetOff = off;
	if (node.nodeType === Node.ELEMENT_NODE) {
		const child = node.childNodes[off];
		if (child) {
			target = child;
			targetOff = 0;
		} else {
			// After the last child: everything inside `node` counts.
			let total = 0;
			const w2 = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
			let x: Node | null;
			while ((x = w2.nextNode())) total += (x as Text).data.length;
			let before = 0;
			while ((t = walker.nextNode())) {
				if (node.contains(t)) break;
				before += (t as Text).data.length;
			}
			return before + total;
		}
	}
	while ((t = walker.nextNode())) {
		if (t === target || target.contains(t)) return n + (t === target ? targetOff : 0);
		n += (t as Text).data.length;
	}
	return n;
}

const hiddenMark = (t: Node) =>
	!!(t.parentElement?.dataset.mark !== undefined && t.parentElement.dataset.hidden);

/** Places the caret at raw offset `pos` (skipping hidden asterisks: the caret goes next to them). */
function placeCaret(root: HTMLElement, pos: number): void {
	const sel = window.getSelection();
	if (!sel) return;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let n = 0;
	let t: Node | null;
	let fallback: { node: Node; off: number } | null = null;
	while ((t = walker.nextNode())) {
		const len = (t as Text).data.length;
		if (!hiddenMark(t)) {
			if (pos >= n && pos <= n + len) {
				const r = document.createRange();
				r.setStart(t, pos - n);
				r.collapse(true);
				sel.removeAllRanges();
				sel.addRange(r);
				return;
			}
			fallback = { node: t, off: len };
		} else if (pos <= n && fallback) {
			break;
		}
		n += len;
	}
	const r = document.createRange();
	if (fallback) r.setStart(fallback.node, fallback.off);
	else r.setStart(root, root.childNodes.length);
	r.collapse(true);
	sel.removeAllRanges();
	sel.addRange(r);
}

/** Index of the accent span (counted in `runs`) that contains raw offset `pos`, or -1. */
function spanAt(value: string, pos: number | null): number {
	if (pos === null) return -1;
	const runs = accentRuns(value);
	let span = -1;
	let open = -1;
	for (let i = 0; i < runs.length; i++) {
		const r = runs[i]!;
		if (r.kind !== 'mark') continue;
		if (open < 0) {
			open = r.start;
			span++;
		} else {
			// Strictly between the asterisks: before the opening one or after the closing one is outside.
			if (pos > open && pos < r.end) return span;
			open = -1;
		}
	}
	return open >= 0 && pos > open ? span : -1;
}

export function MarkupEditor(props: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const caret = useRef<number | null>(null);
	const [active, setActive] = useState(-1);
	const { value, accent } = props;

	// Rebuild the DOM from the value (and the span that shows its asterisks), then restore the caret.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		// Empty text nodes around the asterisks give the caret a place on both sides of a hidden one.
		const nodes: Node[] = [document.createTextNode('')];
		// The span that shows its asterisks follows the caret — including the caret this rebuild restores (typing an
		// asterisk opens a span the caret must land inside).
		const focused = document.activeElement === el;
		const shown = focused && caret.current !== null ? spanAt(value, caret.current) : active;
		if (!accent) nodes.push(document.createTextNode(value));
		else {
			let span = -1;
			let inside = false;
			for (const r of accentRuns(value)) {
				const text = value.slice(r.start, r.end);
				if (r.kind === 'mark') {
					if (!inside) span++;
					const m = document.createElement('span');
					m.dataset.mark = '';
					m.textContent = text;
					if (span === shown) m.style.opacity = '0.45';
					else {
						m.dataset.hidden = '1';
						m.style.display = 'none';
					}
					nodes.push(m, document.createTextNode(''));
					inside = !inside;
				} else if (r.kind === 'accent') {
					const a = document.createElement('span');
					a.dataset.accent = '';
					a.style.color = accent;
					a.textContent = text;
					nodes.push(a);
				} else nodes.push(document.createTextNode(text));
			}
		}
		// A trailing line break needs content after it to be displayed.
		if (value.endsWith('\n')) nodes.push(document.createElement('br'));
		el.replaceChildren(...nodes);
		if (caret.current !== null && document.activeElement === el) placeCaret(el, caret.current);
	}, [value, accent, active]);

	const readCaret = useCallback(() => {
		const el = ref.current;
		const sel = window.getSelection();
		if (!el || !sel || sel.rangeCount === 0) return null;
		const r = sel.getRangeAt(0);
		if (!el.contains(r.startContainer)) return null;
		return offsetOf(el, r.startContainer, r.startOffset);
	}, []);

	// Which span shows its markup follows the caret.
	useEffect(() => {
		if (!accent) return;
		const onSel = () => {
			const p = readCaret();
			if (p === null) return;
			caret.current = p;
			setActive(spanAt(value, p));
		};
		document.addEventListener('selectionchange', onSel);
		return () => document.removeEventListener('selectionchange', onSel);
	}, [accent, value, readCaret]);

	const raw = () => {
		const el = ref.current!;
		let s = '';
		const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let t: Node | null;
		while ((t = w.nextNode())) s += (t as Text).data;
		return s;
	};

	const insert = (text: string) => {
		const el = ref.current;
		const sel = window.getSelection();
		if (!el || !sel || sel.rangeCount === 0) return;
		const r = sel.getRangeAt(0);
		const a = offsetOf(el, r.startContainer, r.startOffset);
		const b = offsetOf(el, r.endContainer, r.endOffset);
		const next = value.slice(0, a) + text + value.slice(b);
		caret.current = a + text.length;
		props.onChange(next);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: a rich single text field (accent spans) — a textarea cannot style runs
		<div
			ref={ref}
			role="textbox"
			tabIndex={0}
			aria-multiline={props.multiline}
			aria-label={props['aria-label']}
			contentEditable="plaintext-only"
			suppressContentEditableWarning
			spellCheck={false}
			data-testid={props['data-testid']}
			data-text-path={props['data-text-path']}
			data-value={value}
			style={props.style}
			onInput={() => {
				caret.current = readCaret();
				const v = raw();
				if (v !== value) props.onChange(v);
			}}
			onPaste={(e) => {
				e.preventDefault();
				insert(e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
			}}
			onKeyDown={(e) => {
				props.onKeyDown?.(e);
				if (e.defaultPrevented) return;
				if (e.key === 'Enter') {
					e.preventDefault();
					insert('\n');
				}
			}}
			// Keys typed here never reach the editor's shortcuts.
			onKeyUp={(e) => e.stopPropagation()}
			onBlur={props.onBlur}
		/>
	);
}
