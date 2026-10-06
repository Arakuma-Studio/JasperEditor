// Property values ↔ expression values (AE conventions).
//
// number → number; vec2/vec3 → arrays; color → [r, g, b, a] in 0..1 (AE's colour arrays); boolean (checkbox) →
// 1 / 0; enum (popup, Dropdown Menu Control) → its 1-based item index; string / Source Text → string; layer
// (Layer Control) → a Layer object (the clip id on the wire).
//
// Results convert back to the property's kind as AE does: a 1D property needs a number ("Expression result must be
// of dimension 1, not 2"), a 2D one an array of at least two numbers (extra components are ignored), a colour at
// least three (alpha defaults to the keyframed alpha); booleans take JavaScript truthiness; popups take an index
// (rounded, clamped) or an item name; strings take String(result). Non-finite numbers are errors.

export type PropKind = 'number' | 'vec2' | 'vec3' | 'color' | 'boolean' | 'enum' | 'string' | 'layer' | 'other';

export function toExpressionValue(kind: PropKind, v: unknown, options?: readonly string[]): unknown {
	switch (kind) {
		case 'boolean':
			return v ? 1 : 0;
		case 'enum': {
			if (typeof v === 'number') return v;
			const i = options ? options.indexOf(String(v)) : -1;
			return i >= 0 ? i + 1 : 1;
		}
		case 'layer':
			return typeof v === 'string' && v ? v : null;
		case 'other':
			return v === undefined ? null : v;
		default:
			return v;
	}
}

export type Converted = { ok: true; value: unknown } | { ok: false; error: string };

type Wire = unknown;

function nonFinite(x: Wire): boolean {
	return !!x && typeof x === 'object' && '__nonFinite' in (x as object);
}

function num(x: Wire): number | null {
	if (typeof x === 'number') return Number.isFinite(x) ? x : null;
	if (typeof x === 'boolean') return x ? 1 : 0;
	return null;
}

const NOT_FINITE = 'Error: expression result is not a finite number';

function dims(r: Wire): number {
	return Array.isArray(r) ? r.length : 1;
}

function vector(r: Wire, n: number, label: string): Converted {
	if (!Array.isArray(r)) {
		if (nonFinite(r)) return { ok: false, error: NOT_FINITE };
		return { ok: false, error: `Error: expression result must be of dimension ${label}, not 1` };
	}
	if (r.length < n) return { ok: false, error: `Error: expression result must be of dimension ${label}, not ${r.length}` };
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const x = num(r[i]);
		if (x === null)
			return {
				ok: false,
				error: nonFinite(r[i]) ? NOT_FINITE : 'Error: expression result array must contain numbers',
			};
		out.push(x);
	}
	return { ok: true, value: out };
}

/** Converts a script result (JSON-decoded) to the property's value. `current` = the keyframed value. */
export function fromExpressionValue(kind: PropKind, r: Wire, current: unknown, options?: readonly string[]): Converted {
	if (r === undefined && kind !== 'string')
		return { ok: false, error: 'Error: expression result is undefined (the last statement produced no value)' };
	switch (kind) {
		case 'number': {
			if (Array.isArray(r))
				return { ok: false, error: `Error: expression result must be of dimension 1, not ${dims(r)}` };
			const x = num(r);
			if (x === null)
				return {
					ok: false,
					error: nonFinite(r) ? NOT_FINITE : `Error: expression result must be a number, not ${describe(r)}`,
				};
			return { ok: true, value: x };
		}
		case 'vec2':
			return vector(r, 2, '2');
		case 'vec3':
			return vector(r, 3, '3');
		case 'color': {
			if (!Array.isArray(r) || r.length < 3)
				return { ok: false, error: `Error: expression result must be a colour [r, g, b, a], not ${describe(r)}` };
			const rgb = vector(r.slice(0, 3), 3, '4');
			if (!rgb.ok) return rgb;
			const a = r.length > 3 ? num(r[3]) : Array.isArray(current) ? (current[3] as number) : 1;
			if (a === null) return { ok: false, error: NOT_FINITE };
			return { ok: true, value: [...(rgb.value as number[]), a] };
		}
		case 'boolean':
			return { ok: true, value: truthy(r) };
		case 'enum': {
			if (!options?.length) return { ok: true, value: current };
			if (typeof r === 'string') {
				const i = options.indexOf(r);
				if (i < 0) return { ok: false, error: `Error: "${r}" is not an item of this menu (${options.join(', ')})` };
				return { ok: true, value: r };
			}
			const x = num(r);
			if (x === null) return { ok: false, error: 'Error: expression result must be a menu item index (1-based)' };
			const i = Math.min(options.length, Math.max(1, Math.round(x))) - 1;
			return { ok: true, value: options[i] };
		}
		case 'string':
			return { ok: true, value: text(r) };
		case 'layer': {
			if (r === null) return { ok: true, value: '' };
			if (r && typeof r === 'object' && typeof (r as { __layer?: unknown }).__layer === 'string')
				return { ok: true, value: (r as { __layer: string }).__layer };
			return { ok: false, error: 'Error: expression result must be a layer' };
		}
		default:
			return { ok: false, error: 'Error: expressions are not supported on this property' };
	}
}

function truthy(r: Wire): boolean {
	if (r === null || r === undefined) return false;
	if (typeof r === 'number') return r !== 0 && !Number.isNaN(r);
	if (typeof r === 'string') return r.length > 0;
	if (typeof r === 'boolean') return r;
	if (nonFinite(r)) return (r as { __nonFinite: string }).__nonFinite !== 'NaN';
	return true;
}

function jsNumber(x: number): string {
	return String(x);
}

function text(r: Wire): string {
	if (typeof r === 'string') return r;
	if (typeof r === 'number') return jsNumber(r);
	if (typeof r === 'boolean') return String(r);
	if (r === null || r === undefined) return '';
	if (nonFinite(r)) return (r as { __nonFinite: string }).__nonFinite;
	if (Array.isArray(r)) return r.map((x) => (x === null || x === undefined ? '' : text(x))).join(',');
	if (typeof r === 'object' && '__layer' in (r as object)) return '[object Layer]';
	return '[object Object]';
}

function describe(r: Wire): string {
	if (typeof r === 'string') return `the string "${r.length > 40 ? `${r.slice(0, 40)}…` : r}"`;
	if (r === null) return 'null';
	if (Array.isArray(r)) return `an array of ${r.length}`;
	return typeof r;
}
