// The YAML subset OpenColorIO configuration files use (workstream color-mgmt), read from the published configuration
// format, not from OpenColorIO's source: block mappings and sequences, flow `{}` / `[]` collections (also spanning
// lines), `!<Tag>` tags, quoted scalars, `|` / `>` block scalars and comments. Ported from EffectCraft
// `crates/effects/src/ocio_config.rs` (MIT OR Apache-2.0, licenses/ported/color-mgmt.md). Hostile input: depth and
// size are bounded, nothing throws except `RangeError` for over-limit documents.

export type Yaml =
	| { t: 'str'; v: string }
	| { t: 'seq'; v: Yaml[] }
	| { t: 'map'; v: [string, Yaml][] }
	| { t: 'tag'; tag: string; v: Yaml }
	| { t: 'null' };

export const YNULL: Yaml = { t: 'null' };
const MAX_DEPTH = 200;
const MAX_LINES = 500_000;

export function yGet(y: Yaml | undefined, k: string): Yaml | undefined {
	if (!y) return undefined;
	if (y.t === 'map') return y.v.find(([key]) => key === k)?.[1];
	if (y.t === 'tag') return yGet(y.v, k);
	return undefined;
}
export function yStr(y: Yaml | undefined): string | undefined {
	if (!y) return undefined;
	if (y.t === 'str') return y.v;
	if (y.t === 'tag') return yStr(y.v);
	return undefined;
}
export function ySeq(y: Yaml | undefined): Yaml[] {
	if (!y) return [];
	if (y.t === 'seq') return y.v;
	if (y.t === 'tag') return ySeq(y.v);
	return [];
}
export function yTag(y: Yaml | undefined): string | undefined {
	return y?.t === 'tag' ? y.tag : undefined;
}
export function yNum(y: Yaml | undefined): number | undefined {
	const s = yStr(y)?.trim();
	if (s === undefined || s === '') return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}
export function yNums(y: Yaml | undefined): number[] {
	if (!y) return [];
	if (y.t === 'seq') return y.v.map(yNum).filter((n): n is number => n !== undefined);
	if (y.t === 'str') {
		const n = yNum(y);
		return n === undefined ? [] : [n];
	}
	if (y.t === 'tag') return yNums(y.v);
	return [];
}

/** Strips a trailing comment (a `#` outside quotes, at the start or after whitespace). */
function stripComment(line: string): string {
	let sq = false;
	let dq = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "'" && !dq) sq = !sq;
		else if (c === '"' && !sq) dq = !dq;
		else if (c === '#' && !sq && !dq && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
	}
	return line;
}

function unquote(s: string): string {
	const t = s.trim();
	if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'")))
		return t.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
	return t;
}

/** `key: value` split at the first `:` followed by a space or the end (outside quotes/brackets). */
function splitKey(s: string): [string, string] | null {
	let sq = false;
	let dq = false;
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "'" && !dq) sq = !sq;
		else if (c === '"' && !sq) dq = !dq;
		else if ((c === '{' || c === '[') && !sq && !dq) depth++;
		else if ((c === '}' || c === ']') && !sq && !dq) depth--;
		else if (
			c === ':' &&
			!sq &&
			!dq &&
			depth === 0 &&
			(i + 1 === s.length || s[i + 1] === ' ' || s[i + 1] === '\t')
		) {
			const k = s.slice(0, i).trim();
			if (!k || k.startsWith('!') || k.startsWith('{') || k.startsWith('[')) return null;
			return [unquote(k), s.slice(i + 1).trim()];
		}
	}
	return null;
}

function balance(s: string): number {
	let sq = false;
	let dq = false;
	let d = 0;
	for (const c of s) {
		if (c === "'" && !dq) sq = !sq;
		else if (c === '"' && !sq) dq = !dq;
		else if ((c === '{' || c === '[') && !sq && !dq) d++;
		else if ((c === '}' || c === ']') && !sq && !dq) d--;
	}
	return d;
}

const tagName = (t: string) => t.trim().replace(/^!/, '').replace(/^</, '').replace(/>$/, '');

class Flow {
	i = 0;
	constructor(private readonly s: string) {}
	private ws() {
		while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
	}
	value(depth: number): Yaml {
		if (depth > MAX_DEPTH) throw new RangeError('YAML nesting too deep');
		this.ws();
		const c = this.s[this.i];
		if (c === '{') {
			this.i++;
			const m: [string, Yaml][] = [];
			for (;;) {
				this.ws();
				const p = this.s[this.i];
				if (p === undefined) break;
				if (p === '}') {
					this.i++;
					break;
				}
				if (p === ',') {
					this.i++;
					continue;
				}
				const start = this.i;
				const k = this.scalar(true);
				this.ws();
				if (this.s[this.i] === ':') this.i++;
				const v = this.value(depth + 1);
				m.push([unquote(k), v]);
				if (this.i === start) this.i++;
			}
			return { t: 'map', v: m };
		}
		if (c === '[') {
			this.i++;
			const v: Yaml[] = [];
			for (;;) {
				this.ws();
				const p = this.s[this.i];
				if (p === undefined) break;
				if (p === ']') {
					this.i++;
					break;
				}
				if (p === ',') {
					this.i++;
					continue;
				}
				const start = this.i;
				v.push(this.value(depth + 1));
				if (this.i === start) this.i++;
			}
			return { t: 'seq', v };
		}
		if (c === '!') {
			const start = this.i;
			while (
				this.i < this.s.length &&
				!/\s/.test(this.s[this.i]!) &&
				this.s[this.i] !== '{' &&
				this.s[this.i] !== '['
			)
				this.i++;
			const tag = tagName(this.s.slice(start, this.i));
			this.ws();
			const p = this.s[this.i];
			const inner = p === '{' || p === '[' ? this.value(depth + 1) : YNULL;
			return { t: 'tag', tag, v: inner };
		}
		const s = this.scalar(false);
		return s === '' ? YNULL : { t: 'str', v: unquote(s) };
	}
	private scalar(key: boolean): string {
		this.ws();
		const start = this.i;
		const q = this.s[this.i];
		if (q === '"' || q === "'") {
			this.i++;
			while (this.i < this.s.length && this.s[this.i] !== q) this.i++;
			this.i = Math.min(this.i + 1, this.s.length);
			return this.s.slice(start, this.i);
		}
		while (this.i < this.s.length) {
			const c = this.s[this.i];
			if (c === ',' || c === '}' || c === ']') break;
			if (key && c === ':') break;
			this.i++;
		}
		return this.s.slice(start, this.i).trim();
	}
}

const flow = (s: string, depth: number): Yaml => new Flow(s).value(depth);

type L = { ind: number; c: string };

class Lines {
	readonly v: L[];
	constructor(text: string) {
		const raw = text.split(/\r?\n/);
		if (raw.length > MAX_LINES) throw new RangeError('YAML document too long');
		this.v = [];
		for (const l of raw) {
			const tl = l.trimStart();
			if (tl.startsWith('%') || l.trim() === '---' || l.trim() === '...') continue;
			const c = stripComment(l).trimEnd();
			const t = c.trimStart();
			if (!t) continue;
			this.v.push({ ind: c.length - t.length, c: t });
		}
	}

	value(rest0: string, indent: number, i: { n: number }, depth: number): Yaml {
		if (depth > MAX_DEPTH) throw new RangeError('YAML nesting too deep');
		const rest = rest0.trim();
		if (!rest) {
			const nx = this.v[i.n];
			if (nx && (nx.ind > indent || (nx.ind === indent && (nx.c === '-' || nx.c.startsWith('- ')))))
				return this.block(nx.ind, i, depth + 1);
			return YNULL;
		}
		if (/^[|>][-+]?$/.test(rest)) {
			const out: string[] = [];
			while (i.n < this.v.length && this.v[i.n]!.ind > indent) out.push(this.v[i.n++]!.c);
			return { t: 'str', v: out.join(rest.startsWith('>') ? ' ' : '\n') };
		}
		if (rest.startsWith('!') && !rest.includes('{') && !rest.includes('[')) {
			const tag = tagName(rest);
			const nx = this.v[i.n];
			const inner = nx && nx.ind > indent ? this.block(nx.ind, i, depth + 1) : YNULL;
			return { t: 'tag', tag, v: inner };
		}
		if (
			rest.startsWith('{') ||
			rest.startsWith('[') ||
			(rest.startsWith('!') && (rest.includes('{') || rest.includes('[')))
		) {
			let text = rest;
			while (balance(text) > 0 && i.n < this.v.length) text += ` ${this.v[i.n++]!.c}`;
			return flow(text, depth + 1);
		}
		return { t: 'str', v: unquote(rest) };
	}

	block(indent: number, i: { n: number }, depth: number): Yaml {
		if (depth > MAX_DEPTH) throw new RangeError('YAML nesting too deep');
		const first = this.v[i.n];
		if (!first) return YNULL;
		if (first.c === '-' || first.c.startsWith('- ')) {
			const items: Yaml[] = [];
			while (i.n < this.v.length) {
				const { ind, c } = this.v[i.n]!;
				if (ind !== indent || !(c === '-' || c.startsWith('- '))) break;
				i.n++;
				const rest = c.slice(1).trimStart();
				if (splitKey(rest) && !rest.startsWith('{') && !rest.startsWith('!')) {
					const inner = indent + 1 + (c.length - 1 - c.slice(1).trimStart().length);
					items.push(this.mapFrom(rest, Math.max(inner, indent + 2), i, depth + 1));
				} else items.push(this.value(rest, indent, i, depth + 1));
			}
			return { t: 'seq', v: items };
		}
		if (splitKey(first.c)) return this.mapFrom(null, indent, i, depth + 1);
		i.n++;
		return { t: 'str', v: unquote(first.c) };
	}

	mapFrom(first: string | null, indent: number, i: { n: number }, depth: number): Yaml {
		const m: [string, Yaml][] = [];
		if (first) {
			const kv = splitKey(first);
			if (kv) m.push([kv[0], this.value(kv[1], indent, i, depth + 1)]);
		}
		while (i.n < this.v.length) {
			const { ind, c } = this.v[i.n]!;
			if (ind !== indent) {
				if (ind < indent) break;
				i.n++; // over-indented stray line
				continue;
			}
			const kv = splitKey(c);
			if (!kv) break;
			i.n++;
			m.push([kv[0], this.value(kv[1], indent, i, depth + 1)]);
		}
		return { t: 'map', v: m };
	}
}

/** Parses a YAML document (the subset above). Throws `RangeError` only for documents over the size/depth limits. */
export function parseYaml(text: string): Yaml {
	const l = new Lines(text);
	const i = { n: 0 };
	const indent = l.v[0]?.ind ?? 0;
	return l.block(indent, i, 0);
}
