// A small, total XML reader for TTML (no DOM in the pure model). Handles the XML declaration, processing
// instructions, comments, CDATA, a DOCTYPE (with an internal subset), attributes in either quote style, the five
// predefined entities and numeric character references. Malformed input throws CaptionFormatError (never another
// exception type); nesting depth and input size are bounded so hostile input cannot exhaust the stack.
import { CaptionFormatError } from './core.ts';

export type XmlAttr = { name: string; local: string; value: string };
export type XmlElement = {
	kind: 'element';
	name: string;
	local: string;
	attrs: XmlAttr[];
	children: XmlNode[];
};
export type XmlText = { kind: 'text'; text: string };
export type XmlNode = XmlElement | XmlText;

const MAX_DEPTH = 256;

const localName = (q: string) => {
	const i = q.indexOf(':');
	return i >= 0 ? q.slice(i + 1) : q;
};

function decodeEntities(s: string): string {
	if (!s.includes('&')) return s;
	return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
		switch (e) {
			case 'amp':
				return '&';
			case 'lt':
				return '<';
			case 'gt':
				return '>';
			case 'quot':
				return '"';
			case 'apos':
				return "'";
		}
		const cp = e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
		if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
		return String.fromCodePoint(cp);
	});
}

// Escaped (not literal) non-ASCII: a bundle of this code loaded without a declared charset must still parse.
const NAME = /^[A-Za-z_:\u00C0-\uFFFF][-A-Za-z0-9_:.\u00B7\u00C0-\uFFFF]*/;

/** Parse an XML document; returns the root element. */
export function parseXml(src: string): XmlElement {
	let i = 0;
	const n = src.length;
	const fail = (msg: string): never => {
		const line = src.slice(0, i).split('\n').length;
		throw new CaptionFormatError(`XML: ${msg}`, line);
	};
	const stack: XmlElement[] = [];
	let root: XmlElement | null = null;
	const top = () => stack[stack.length - 1];
	while (i < n) {
		if (src.startsWith('<!--', i)) {
			const e = src.indexOf('-->', i + 4);
			if (e < 0) fail('unterminated comment');
			i = e + 3;
			continue;
		}
		if (src.startsWith('<![CDATA[', i)) {
			const e = src.indexOf(']]>', i + 9);
			if (e < 0) fail('unterminated CDATA');
			const t = top();
			if (!t) fail('text outside the root element');
			t!.children.push({ kind: 'text', text: src.slice(i + 9, e) });
			i = e + 3;
			continue;
		}
		if (src.startsWith('<?', i)) {
			const e = src.indexOf('?>', i + 2);
			if (e < 0) fail('unterminated processing instruction');
			i = e + 2;
			continue;
		}
		if (src.startsWith('<!', i)) {
			// DOCTYPE (may contain an internal subset in brackets)
			let depth = 0;
			let j = i + 2;
			for (; j < n; j++) {
				const c = src[j];
				if (c === '[') depth++;
				else if (c === ']') depth--;
				else if (c === '>' && depth <= 0) break;
			}
			if (j >= n) fail('unterminated declaration');
			i = j + 1;
			continue;
		}
		if (src.startsWith('</', i)) {
			const m = NAME.exec(src.slice(i + 2, i + 2 + 512));
			if (!m) fail('bad closing tag');
			const name = m![0];
			let j = i + 2 + name.length;
			while (j < n && /\s/.test(src[j]!)) j++;
			if (src[j] !== '>') fail('bad closing tag');
			const open = stack.pop();
			if (!open || open.name !== name) fail(`mismatched closing tag </${name}>`);
			i = j + 1;
			continue;
		}
		if (src[i] === '<') {
			const m = NAME.exec(src.slice(i + 1, i + 1 + 512));
			if (!m) fail('bad tag');
			const name = m![0];
			let j = i + 1 + name.length;
			const attrs: XmlAttr[] = [];
			let selfClosing = false;
			for (;;) {
				while (j < n && /\s/.test(src[j]!)) j++;
				if (j >= n) fail('unterminated tag');
				if (src[j] === '>') {
					j++;
					break;
				}
				if (src.startsWith('/>', j)) {
					selfClosing = true;
					j += 2;
					break;
				}
				const am = NAME.exec(src.slice(j, j + 512));
				if (!am) fail('bad attribute');
				const an = am![0];
				j += an.length;
				while (j < n && /\s/.test(src[j]!)) j++;
				if (src[j] !== '=') fail('attribute without value');
				j++;
				while (j < n && /\s/.test(src[j]!)) j++;
				const q = src[j];
				if (q !== '"' && q !== "'") fail('unquoted attribute value');
				const e = src.indexOf(q!, j + 1);
				if (e < 0) fail('unterminated attribute value');
				attrs.push({ name: an, local: localName(an), value: decodeEntities(src.slice(j + 1, e)) });
				j = e + 1;
			}
			const el: XmlElement = { kind: 'element', name, local: localName(name), attrs, children: [] };
			const parent = top();
			if (parent) parent.children.push(el);
			else if (root) fail('more than one root element');
			else root = el;
			if (!selfClosing) {
				stack.push(el);
				if (stack.length > MAX_DEPTH) fail('elements nested too deeply');
			}
			i = j;
			continue;
		}
		const e = src.indexOf('<', i);
		const end = e < 0 ? n : e;
		const text = src.slice(i, end);
		const t = top();
		if (t) t.children.push({ kind: 'text', text: decodeEntities(text) });
		else if (text.trim()) fail('text outside the root element');
		i = end;
	}
	if (stack.length) fail(`unclosed element <${stack[stack.length - 1]!.name}>`);
	if (!root) fail('no root element');
	return root!;
}

/** Attribute by local name (namespace-agnostic, like FilmCraft's reader). */
export function xmlAttr(el: XmlElement, local: string): string | null {
	return el.attrs.find((a) => a.local === local)?.value ?? null;
}

export function xmlElements(el: XmlElement): XmlElement[] {
	return el.children.filter((c): c is XmlElement => c.kind === 'element');
}

export function* xmlDescendants(el: XmlElement): Generator<XmlElement> {
	const stack: XmlElement[] = [el];
	while (stack.length) {
		const x = stack.pop()!;
		yield x;
		const kids = xmlElements(x);
		for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]!);
	}
}
