// CEA-608 (line 21) character sets and control codes, from the public specification (ANSI/CTA-608-E;
// 47 CFR §15.119). Ported from FilmCraft `crates/captions/src/cea608.rs`; see licenses/ported/captions.md.
//
// Bytes travel in pairs with odd parity in bit 7. A pair whose first byte (parity stripped) is 0x10–0x1F is a
// control code (channel 1: 0x10–0x17, channel 2: 0x18–0x1F); otherwise both bytes are characters from the basic
// set (0x00 = padding).

/** Add odd parity to a 7-bit value. */
export function withParity(b: number): number {
	const v = b & 0x7f;
	let ones = 0;
	for (let x = v; x; x >>= 1) ones += x & 1;
	return ones % 2 === 0 ? v | 0x80 : v;
}

/** Basic character set (0x20–0x7F); differs from ASCII in ten positions. */
export function basicChar(b: number): string | null {
	switch (b) {
		case 0x2a:
			return 'á';
		case 0x5c:
			return 'é';
		case 0x5e:
			return 'í';
		case 0x5f:
			return 'ó';
		case 0x60:
			return 'ú';
		case 0x7b:
			return 'ç';
		case 0x7c:
			return '÷';
		case 0x7d:
			return 'Ñ';
		case 0x7e:
			return 'ñ';
		case 0x7f:
			return '█';
	}
	return b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : null;
}

/** Special characters: control pair `0x11, 0x30 + i`. */
export const SPECIAL = ['®', '°', '½', '¿', '™', '¢', '£', '♪', 'à', ' ', 'è', 'â', 'ê', 'î', 'ô', 'û'];

/** Extended Spanish/French/miscellaneous: control pair `0x12, 0x20 + i`. */
export const EXT_12 = [
	'Á',
	'É',
	'Ó',
	'Ú',
	'Ü',
	'ü',
	'‘',
	'¡',
	'*',
	"'",
	'—',
	'©',
	'℠',
	'•',
	'“',
	'”',
	'À',
	'Â',
	'Ç',
	'È',
	'Ê',
	'Ë',
	'ë',
	'Î',
	'Ï',
	'ï',
	'Ô',
	'Ù',
	'ù',
	'Û',
	'«',
	'»',
];

/** Extended Portuguese/German/Danish: control pair `0x13, 0x20 + i`. */
export const EXT_13 = [
	'Ã',
	'ã',
	'Í',
	'Ì',
	'ì',
	'Ò',
	'ò',
	'Õ',
	'õ',
	'{',
	'}',
	'\\',
	'^',
	'_',
	'|',
	'~',
	'Ä',
	'ä',
	'Ö',
	'ö',
	'ß',
	'¥',
	'¤',
	'¦',
	'Å',
	'å',
	'Ø',
	'ø',
	'┌',
	'┐',
	'└',
	'┘',
];

/** How a character is transmitted. */
export type Encoded =
	| { kind: 'basic'; b: number }
	/**
	 * A two-byte special/extended code. Extended characters replace the preceding character, so a basic
	 * `fallback` is sent first for older decoders.
	 */
	| { kind: 'pair'; b1: number; b2: number; fallback: number | null };

const BASIC_BY_CHAR = new Map<string, number>();
for (let b = 0x20; b <= 0x7f; b++) {
	const c = basicChar(b);
	if (c !== null && !BASIC_BY_CHAR.has(c)) BASIC_BY_CHAR.set(c, b);
}

function fallbackByte(c: string): number {
	let f = '-';
	if ('ÁÀÂÃÄÅ'.includes(c)) f = 'A';
	else if ('ÉÈÊË'.includes(c)) f = 'E';
	else if ('ÍÌÎÏ'.includes(c)) f = 'I';
	else if ('ÓÒÔÕÖØ'.includes(c)) f = 'O';
	else if ('ÚÙÛÜ'.includes(c)) f = 'U';
	else if ('üù'.includes(c)) f = 'u';
	else if (c === 'ë') f = 'e';
	else if ('ïì'.includes(c)) f = 'i';
	else if ('ãäå'.includes(c)) f = 'a';
	else if ('òõöø'.includes(c)) f = 'o';
	else if (c === 'Ç') f = 'C';
	else if (c === 'ß') f = 's';
	else if ('‘“”«»'.includes(c)) f = '"';
	else if ('{┌└'.includes(c)) f = '[';
	else if ('}┐┘'.includes(c)) f = ']';
	else if (c === '¡') f = '!';
	else if ('*•'.includes(c)) f = '.';
	return BASIC_BY_CHAR.get(f) ?? 0x2d;
}

/** Encode one character (null if 608 cannot show it). */
export function encodeChar(input: string): Encoded | null {
	let c = input;
	if (c === '’' || c === 'ʼ') c = "'";
	else if (c === '\t') c = ' ';
	else if (c === '–') c = '-';
	const basic = BASIC_BY_CHAR.get(c);
	if (basic !== undefined) return { kind: 'basic', b: basic };
	const si = SPECIAL.indexOf(c);
	if (si >= 0) return { kind: 'pair', b1: 0x11, b2: 0x30 + si, fallback: null };
	const e12 = EXT_12.indexOf(c);
	if (e12 >= 0) return { kind: 'pair', b1: 0x12, b2: 0x20 + e12, fallback: fallbackByte(c) };
	const e13 = EXT_13.indexOf(c);
	if (e13 >= 0) return { kind: 'pair', b1: 0x13, b2: 0x20 + e13, fallback: fallbackByte(c) };
	return null;
}

/** Miscellaneous control codes (second byte; first byte 0x14 on channel 1). */
export const MISC = {
	RCL: 0x20, // resume caption loading (pop-on)
	BS: 0x21, // backspace
	AOF: 0x22,
	AON: 0x23,
	DER: 0x24, // delete to end of row
	RU2: 0x25, // roll-up 2/3/4 rows
	RU3: 0x26,
	RU4: 0x27,
	FON: 0x28,
	RDC: 0x29, // resume direct captioning (paint-on)
	TR: 0x2a,
	RTD: 0x2b,
	EDM: 0x2c, // erase displayed memory
	CR: 0x2d, // carriage return (roll-up)
	ENM: 0x2e, // erase non-displayed memory
	EOC: 0x2f, // end of caption (swap memories)
} as const;

const PAC_ROWS: Array<[number, boolean]> = [
	[0x11, false],
	[0x11, true],
	[0x12, false],
	[0x12, true],
	[0x15, false],
	[0x15, true],
	[0x16, false],
	[0x16, true],
	[0x17, false],
	[0x17, true],
	[0x10, false],
	[0x13, false],
	[0x13, true],
	[0x14, false],
	[0x14, true],
];

/**
 * Row (1–15) and indent column addressed by a preamble address code, if `(b1, b2)` is one (channel bit already
 * removed from `b1`).
 */
export function decodePac(b1: number, b2: number): { row: number; indent: number } | null {
	if (b2 < 0x40 || b2 > 0x7f) return null;
	const hi = b2 >= 0x60;
	const idx = PAC_ROWS.findIndex(([x, h]) => x === b1 && h === hi);
	if (idx < 0) return null;
	const a = b2 & 0x1f;
	const indent = a & 0x10 ? ((a & 0x0e) >> 1) * 4 : 0;
	return { row: idx + 1, indent };
}

/** Preamble address code for `row` (1–15) with an indent (rounded down to a multiple of 4). */
export function encodePac(row: number, indent: number): [number, number] {
	const [b1, hi] = PAC_ROWS[Math.min(15, Math.max(1, row)) - 1]!;
	const attr = indent >= 4 ? 0x10 | (Math.min(7, Math.floor(indent / 4)) << 1) : 0;
	return [b1, (hi ? 0x60 : 0x40) | attr];
}
