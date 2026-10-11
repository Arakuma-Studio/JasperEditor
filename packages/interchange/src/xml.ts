// A small, iterative (no recursion, so deep or hostile documents cannot overflow the stack) XML reader and a
// pretty-printing writer. Enough XML 1.0 for the interchange formats: declaration, DOCTYPE (with an internal
// subset), comments, processing instructions, CDATA, the five predefined entities and character references.
// Namespaces are not interpreted (`a:b` is the element name). Malformed input → `XmlError`.

export type XNode = {
	name: string;
	attrs: Record<string, string>;
	/** Child elements and text, in document order. */
	children: (XNode | string)[];
	parent: XNode | null;
};

export class XmlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'XmlError';
	}
}

const MAX_DEPTH = 4096;

function decodeEntities(s: string): string {
	if (!s.includes('&')) return s;
	return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, e: string) => {
		if (e[0] === '#') {
			const cp =
				e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
			if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
			return String.fromCodePoint(cp);
		}
		switch (e) {
			case 'lt':
				return '<';
			case 'gt':
				return '>';
			case 'amp':
				return '&';
			case 'quot':
				return '"';
			case 'apos':
				return "'";
			case 'nbsp':
				return ' ';
			default:
				// Unknown entity (HTML-ish producers): keep the text as is rather than failing the import.
				return m;
		}
	});
}

const NAME_RE = /[A-Za-z_:À-￿][-A-Za-z0-9_:.·À-￿]*/y;

/** Parse a document; returns its root element. */
export function parseXml(text: string): XNode {
	let s = text;
	if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	const len = s.length;
	let i = 0;
	const docRoot: XNode = { name: '#document', attrs: {}, children: [], parent: null };
	let cur = docRoot;
	let depth = 0;
	let root: XNode | null = null;
	const fail = (msg: string): never => {
		const line = s.slice(0, i).split('\n').length;
		throw new XmlError(`${msg} (line ${line})`);
	};
	const readName = (): string => {
		NAME_RE.lastIndex = i;
		const m = NAME_RE.exec(s);
		if (!m) return fail('expected a name');
		i += m[0].length;
		return m[0];
	};
	const skipWs = () => {
		while (i < len) {
			const c = s.charCodeAt(i);
			if (c === 32 || c === 9 || c === 10 || c === 13) i++;
			else break;
		}
	};
	while (i < len) {
		const lt = s.indexOf('<', i);
		if (lt < 0) {
			const tail = s.slice(i);
			if (cur !== docRoot) fail(`unclosed element <${cur.name}>`);
			if (tail.trim()) fail('text after the root element');
			break;
		}
		if (lt > i) {
			const raw = s.slice(i, lt);
			if (cur === docRoot) {
				if (raw.trim()) fail('text outside the root element');
			} else cur.children.push(decodeEntities(raw));
			i = lt;
		}
		if (s.startsWith('<!--', i)) {
			const e = s.indexOf('-->', i + 4);
			if (e < 0) fail('unterminated comment');
			i = e + 3;
			continue;
		}
		if (s.startsWith('<![CDATA[', i)) {
			const e = s.indexOf(']]>', i + 9);
			if (e < 0) fail('unterminated CDATA section');
			if (cur === docRoot) fail('CDATA outside the root element');
			cur.children.push(s.slice(i + 9, e));
			i = e + 3;
			continue;
		}
		if (s.startsWith('<?', i)) {
			const e = s.indexOf('?>', i + 2);
			if (e < 0) fail('unterminated processing instruction');
			i = e + 2;
			continue;
		}
		if (s.startsWith('<!', i)) {
			// DOCTYPE (possibly with an internal subset in brackets).
			let j = i + 2;
			let bracket = 0;
			let quote = 0;
			for (; j < len; j++) {
				const c = s.charCodeAt(j);
				if (quote) {
					if (c === quote) quote = 0;
				} else if (c === 34 || c === 39) quote = c;
				else if (c === 91) bracket++;
				else if (c === 93) bracket--;
				else if (c === 62 && bracket <= 0) break;
			}
			if (j >= len) fail('unterminated declaration');
			i = j + 1;
			continue;
		}
		if (s.charCodeAt(i + 1) === 47) {
			i += 2;
			const name = readName();
			skipWs();
			if (s[i] !== '>') fail(`malformed end tag </${name}>`);
			i++;
			if (cur === docRoot || cur.name !== name)
				fail(`mismatched end tag </${name}>${cur !== docRoot ? ` (expected </${cur.name}>)` : ''}`);
			cur = cur.parent!;
			depth--;
			continue;
		}
		i++;
		const name = readName();
		const node: XNode = { name, attrs: {}, children: [], parent: cur };
		for (;;) {
			skipWs();
			if (i >= len) fail(`unterminated start tag <${name}>`);
			const c = s[i];
			if (c === '>' || c === '/') break;
			const an = readName();
			skipWs();
			if (s[i] !== '=') fail(`attribute ${an} without a value`);
			i++;
			skipWs();
			const q = s[i];
			if (q !== '"' && q !== "'") fail(`unquoted attribute ${an}`);
			const e = s.indexOf(q, i + 1);
			if (e < 0) fail(`unterminated attribute ${an}`);
			node.attrs[an] = decodeEntities(s.slice(i + 1, e)).replace(/[\t\n\r]/g, ' ');
			i = e + 1;
		}
		if (cur === docRoot) {
			if (root) fail('more than one root element');
			root = node;
		}
		cur.children.push(node);
		if (s[i] === '/') {
			if (s[i + 1] !== '>') fail(`malformed empty tag <${name}>`);
			i += 2;
		} else {
			i++;
			cur = node;
			depth++;
			if (depth > MAX_DEPTH) fail('elements nested too deeply');
		}
	}
	if (cur !== docRoot) fail(`unclosed element <${cur.name}>`);
	if (!root) fail('no root element');
	root!.parent = null;
	return root!;
}

export function elements(n: XNode | null | undefined): XNode[] {
	if (!n) return [];
	return n.children.filter((c): c is XNode => typeof c !== 'string');
}

export function child(n: XNode | null | undefined, name: string): XNode | null {
	if (!n) return null;
	for (const c of n.children) if (typeof c !== 'string' && c.name === name) return c;
	return null;
}

export function children(n: XNode | null | undefined, name: string): XNode[] {
	return elements(n).filter((c) => c.name === name);
}

/** Text content (all descendant text), trimmed. */
export function text(n: XNode | null | undefined): string {
	if (!n) return '';
	let out = '';
	const stack: (XNode | string)[] = [n];
	while (stack.length) {
		const x = stack.pop()!;
		if (typeof x === 'string') out += x;
		else for (let k = x.children.length - 1; k >= 0; k--) stack.push(x.children[k]!);
	}
	return out.trim();
}

/** Text of the first child `name`, or null when absent. */
export function childText(n: XNode | null | undefined, name: string): string | null {
	const c = child(n, name);
	return c ? text(c) : null;
}

export function childNum(n: XNode | null | undefined, name: string): number | null {
	const t = childText(n, name);
	if (t === null || t === '') return null;
	const v = Number(t);
	return Number.isFinite(v) ? v : null;
}

export function childInt(n: XNode | null | undefined, name: string): number | null {
	const v = childNum(n, name);
	return v === null ? null : Math.round(v);
}

export function parseBool(t: string | null | undefined): boolean | null {
	if (t === null || t === undefined) return null;
	const v = t.trim().toLowerCase();
	if (v === 'true' || v === '1' || v === 'yes') return true;
	if (v === 'false' || v === '0' || v === 'no') return false;
	return null;
}

export function childBool(n: XNode | null | undefined, name: string): boolean | null {
	return parseBool(childText(n, name));
}

/** Follow a chain of child names. */
export function path(n: XNode | null | undefined, names: readonly string[]): XNode | null {
	let cur: XNode | null | undefined = n;
	for (const nm of names) {
		cur = child(cur, nm);
		if (!cur) return null;
	}
	return cur ?? null;
}

export function pathText(n: XNode | null | undefined, names: readonly string[]): string | null {
	const p = path(n, names);
	return p ? text(p) : null;
}

/** All descendant elements in document order (iterative). */
export function descendants(n: XNode): XNode[] {
	const out: XNode[] = [];
	const stack: XNode[] = [n];
	while (stack.length) {
		const x = stack.pop()!;
		out.push(x);
		const els = elements(x);
		for (let k = els.length - 1; k >= 0; k--) stack.push(els[k]!);
	}
	return out;
}

export function escapeXml(s: string, attr = false): string {
	let out = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	if (attr)
		out = out.replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');
	// Characters XML 1.0 cannot carry at all.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping illegal control characters
	return out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

export type Attrs = readonly (readonly [string, string | number | boolean | null | undefined])[];

/** Number formatting for documents: integers as is, others with up to 6 decimals, no exponent. */
export function num(v: number): string {
	if (!Number.isFinite(v)) return '0';
	if (Number.isInteger(v)) return String(v);
	const s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
	return s === '-0' ? '0' : s;
}

export class XmlWriter {
	private out: string[] = [];
	private stack: string[] = [];
	constructor(
		opts: { doctype?: string; indent?: string; standalone?: boolean } = {},
		private readonly indent = opts.indent ?? '\t',
	) {
		this.out.push(
			`<?xml version="1.0" encoding="UTF-8"${opts.standalone === false ? ' standalone="no"' : ''}?>\n`,
		);
		if (opts.doctype) this.out.push(`<!DOCTYPE ${opts.doctype}>\n`);
	}

	private pad(): string {
		return this.indent.repeat(this.stack.length);
	}

	private attrs(a: Attrs): string {
		let r = '';
		for (const [k, v] of a) if (v !== null && v !== undefined) r += ` ${k}="${escapeXml(String(v), true)}"`;
		return r;
	}

	open(name: string, attrs: Attrs = []): this {
		this.out.push(`${this.pad()}<${name}${this.attrs(attrs)}>\n`);
		this.stack.push(name);
		return this;
	}

	close(): this {
		const name = this.stack.pop();
		if (name === undefined) throw new Error('XmlWriter: close without open');
		this.out.push(`${this.pad()}</${name}>\n`);
		return this;
	}

	empty(name: string, attrs: Attrs = []): this {
		this.out.push(`${this.pad()}<${name}${this.attrs(attrs)}/>\n`);
		return this;
	}

	/** `<name>value</name>` (numbers through `num`). */
	text(name: string, value: string | number | boolean, attrs: Attrs = []): this {
		const v = typeof value === 'number' ? num(value) : String(value);
		this.out.push(`${this.pad()}<${name}${this.attrs(attrs)}>${escapeXml(v)}</${name}>\n`);
		return this;
	}

	finish(): string {
		while (this.stack.length) this.close();
		return this.out.join('');
	}
}

/** FCP7 booleans. */
export const boolStr = (b: boolean) => (b ? 'TRUE' : 'FALSE');
