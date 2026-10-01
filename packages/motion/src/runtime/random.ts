// Deterministic seeds and randomness (S11:ANM-007): seeds come from `hash32(clipId, <purpose>)`, random numbers
// from `seededRandom(seed)` (anime.js' seeded generator; never Math.random).
import { createSeededRandom } from 'animejs/utils';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a (32-bit) over the UTF-8 bytes of the parts joined with U+001F. Unsigned; stable across realms
 * (browser, Node, Remotion workers) because it only uses integer maths.
 */
export function hash32(...parts: (string | number)[]): number {
	let h = FNV_OFFSET;
	const text = parts.map(String).join('\u001f');
	const byte = (b: number) => {
		h ^= b;
		h = Math.imul(h, FNV_PRIME);
	};
	for (const ch of text) {
		const c = ch.codePointAt(0)!;
		if (c < 0x80) byte(c);
		else if (c < 0x800) {
			byte(0xc0 | (c >> 6));
			byte(0x80 | (c & 0x3f));
		} else if (c < 0x10000) {
			byte(0xe0 | (c >> 12));
			byte(0x80 | ((c >> 6) & 0x3f));
			byte(0x80 | (c & 0x3f));
		} else {
			byte(0xf0 | (c >> 18));
			byte(0x80 | ((c >> 12) & 0x3f));
			byte(0x80 | ((c >> 6) & 0x3f));
			byte(0x80 | (c & 0x3f));
		}
	}
	return h >>> 0;
}

/** A seeded generator of numbers in [0, 1) (anime.js `createSeededRandom`, the same stream as `stagger({seed})`). */
export function seededRandom(seed: number): () => number {
	const rng = createSeededRandom(seed >>> 0);
	// 15 decimals: the generator's largest value stays below 1.
	return () => rng(0, 1, 15);
}
