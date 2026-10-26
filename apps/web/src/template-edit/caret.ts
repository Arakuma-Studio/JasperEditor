// Selection of the in-place template text editor in visible-text offsets (UTF-16 code units of the text nodes; the
// editor's DOM is rebuilt from the value after every input, so positions are kept as offsets, never as nodes).
import { offsetOf } from '../mg-bundles/MarkupEditor.tsx';

export type TextRange = { start: number; end: number };

/** The selection inside `root` as visible offsets (start ≤ end), or null when it is elsewhere. */
export function readSelection(root: HTMLElement): TextRange | null {
	const sel = root.ownerDocument.getSelection?.();
	if (!sel || sel.rangeCount === 0) return null;
	const r = sel.getRangeAt(0);
	if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
	const a = offsetOf(root, r.startContainer, r.startOffset);
	const b = offsetOf(root, r.endContainer, r.endOffset);
	return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** The text node and offset of visible offset `pos` (the end of the text when past it). */
function positionAt(root: HTMLElement, pos: number): { node: Node; off: number } {
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let n = 0;
	let last: { node: Node; off: number } | null = null;
	let t: Node | null;
	while ((t = walker.nextNode())) {
		const len = (t as Text).data.length;
		if (pos <= n + len) return { node: t, off: Math.max(0, pos - n) };
		n += len;
		last = { node: t, off: len };
	}
	return last ?? { node: root, off: root.childNodes.length };
}

/** Selects visible offsets `start`…`end` (clamped) inside `root`. */
export function selectOffsets(root: HTMLElement, start: number, end: number): void {
	const sel = root.ownerDocument.getSelection?.();
	if (!sel) return;
	const lo = Math.max(0, Math.min(start, end));
	const hi = Math.max(0, Math.max(start, end));
	const a = positionAt(root, lo);
	const b = positionAt(root, hi);
	const r = root.ownerDocument.createRange();
	r.setStart(a.node, a.off);
	r.setEnd(b.node, b.off);
	sel.removeAllRanges();
	sel.addRange(r);
}

/** The visible offset under client point (x, y) inside `root`, or null (no caret API, or the point is elsewhere). */
export function offsetAtPoint(root: HTMLElement, x: number, y: number): number | null {
	const doc = root.ownerDocument as Document & {
		caretRangeFromPoint?(x: number, y: number): Range | null;
		caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
	};
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	try {
		if (typeof doc.caretPositionFromPoint === 'function') {
			const p = doc.caretPositionFromPoint(x, y);
			if (p && root.contains(p.offsetNode)) return offsetOf(root, p.offsetNode, p.offset);
		}
		if (typeof doc.caretRangeFromPoint === 'function') {
			const r = doc.caretRangeFromPoint(x, y);
			if (r && root.contains(r.startContainer)) return offsetOf(root, r.startContainer, r.startOffset);
		}
	} catch {
		// a detached root or an engine without layout: no caret position
	}
	return null;
}

/** The word (run of non-whitespace) around visible offset `pos` of `text`; the caret itself between spaces. */
export function wordAt(text: string, pos: number): TextRange {
	const n = text.length;
	const p = Math.max(0, Math.min(n, Number.isFinite(pos) ? Math.trunc(pos) : 0));
	const space = (i: number) => /\s/u.test(text[i] ?? ' ');
	let s = p;
	let e = p;
	// A caret right after a word (at its end) selects that word.
	if (space(p) && p > 0 && !space(p - 1)) {
		s = p - 1;
		e = p;
	}
	while (s > 0 && !space(s - 1)) s--;
	while (e < n && !space(e)) e++;
	return s <= e ? { start: s, end: e } : { start: p, end: p };
}
