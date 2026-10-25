// What a person types into a social-comment count field ("1393", "1,234", "1.234", "12.3K", "1,2k", "3.4M", "1.5B",
// "１２３" from a CJK IME) → the integer the template stores. Pure and total: never throws, bounded work.
//
// Rules:
// - Spaces (incl. no-break and thin spaces), "_" and apostrophes are digit-group separators and are ignored; a leading
//   "+" is allowed. Full-width digits and letters are folded to ASCII (NFKC).
// - An optional suffix K (×1,000), M (×1,000,000) or B (×1,000,000,000), any case.
// - "." and "," are both accepted. When both appear, the last one is the decimal separator and the other groups
//   digits. One kind appearing several times groups digits ("1,234,567", "1.234.567"). One single separator followed by
//   exactly three digits and no suffix groups digits ("1,234" = "1.234" = 1234: a count cannot be 1.234); otherwise it
//   is the decimal separator ("1.5K", "1,5K", "12.5" → not a whole number).
// - Group separators must split the digits into groups of three after a first group of one to three digits.
// - With a suffix the result is rounded to the nearest integer ("1.2345K" → 1235); without one, a fraction is an error.
// - A leading "-" (or "−") makes an otherwise valid number an error ("negative").

export type CountInputError = 'empty' | 'invalid' | 'negative' | 'fraction' | 'too-large';
export type CountInputResult = { ok: true; value: number } | { ok: false; error: CountInputError };

/** Longest input looked at (a count with grouping and a suffix is far shorter). */
const MAX_INPUT = 64;
const MULTIPLIER: Readonly<Record<string, bigint>> = { k: 1_000n, m: 1_000_000n, b: 1_000_000_000n };

const groupsValid = (int: string, sep: string): boolean => {
	const parts = int.split(sep);
	return (
		parts.length > 1 &&
		/^\d{1,3}$/.test(parts[0]!) &&
		parts.slice(1).every((p) => /^\d{3}$/.test(p))
	);
};

/** Splits a number body ("1,234.5") into integer and fraction digits, or null when malformed. */
function splitNumber(body: string, hasSuffix: boolean): { int: string; frac: string } | null {
	if (!/^[\d.,]+$/.test(body) || !/\d/.test(body)) return null;
	const dots = body.split('.').length - 1;
	const commas = body.split(',').length - 1;
	if (dots === 0 && commas === 0) return { int: body, frac: '' };
	if (dots > 0 && commas > 0) {
		const decimal = body.lastIndexOf('.') > body.lastIndexOf(',') ? '.' : ',';
		const group = decimal === '.' ? ',' : '.';
		if ((decimal === '.' ? dots : commas) !== 1) return null;
		const at = body.lastIndexOf(decimal);
		const int = body.slice(0, at);
		const frac = body.slice(at + 1);
		if (!/^\d+$/.test(frac) || !groupsValid(int, group)) return null;
		return { int: int.split(group).join(''), frac };
	}
	const sep = dots > 0 ? '.' : ',';
	const count = dots + commas;
	if (count > 1) return groupsValid(body, sep) ? { int: body.split(sep).join(''), frac: '' } : null;
	const [int = '', frac = ''] = body.split(sep);
	if (!hasSuffix && /^\d{1,3}$/.test(int) && /^\d{3}$/.test(frac)) return { int: int + frac, frac: '' };
	if (!/^\d*$/.test(int) || !/^\d+$/.test(frac)) return null;
	return { int: int || '0', frac };
}

/** Parses a count typed by a person (see the module comment). `max` defaults to the template cap (1e12). */
export function parseCountInput(raw: unknown, max = 1e12): CountInputResult {
	if (typeof raw !== 'string') return { ok: false, error: 'invalid' };
	if (raw.length > MAX_INPUT) return { ok: false, error: 'invalid' };
	let s = raw.normalize('NFKC').replace(/[\s_'’]/gu, '');
	if (!s) return { ok: false, error: 'empty' };
	let negative = false;
	if (s[0] === '+') s = s.slice(1);
	else if (s[0] === '-' || s[0] === '−' || s[0] === '‐') {
		negative = true;
		s = s.slice(1);
	}
	const m = /^([\d.,]+)([kmb])?$/i.exec(s);
	if (!m) return { ok: false, error: 'invalid' };
	const suffix = m[2]?.toLowerCase();
	const parts = splitNumber(m[1]!, suffix !== undefined);
	if (!parts) return { ok: false, error: 'invalid' };
	const mult = suffix ? MULTIPLIER[suffix]! : 1n;
	const scale = 10n ** BigInt(parts.frac.length);
	const scaled = BigInt(parts.int + parts.frac) * mult;
	if (!suffix && scaled % scale !== 0n) return { ok: false, error: 'fraction' };
	// nearest integer, halves up
	const value = (scaled * 2n + scale) / (2n * scale);
	if (negative && value !== 0n) return { ok: false, error: 'negative' };
	if (value > BigInt(Math.floor(max))) return { ok: false, error: 'too-large' };
	return { ok: true, value: Number(value) };
}
