// The CLAP text encoder's tokenizer (spec 12 P6-E14, WP-E9): RoBERTa's byte-level BPE (the GPT-2 scheme), from the
// pinned `vocab.json` and `merges.txt` of laion/larger_clap_general: text is split with the GPT-2 pattern, each piece's
// UTF-8 bytes are mapped to printable characters, merged by rank, and wrapped as `<s> … </s>`. No lower-casing, no
// prefix space (`add_prefix_space: false`). Checked against the reference tokenizer on the build server (wp-note
// "Phase 6 → WP-E9"). Pure apart from reading nothing: the caller passes the file contents.

export const BOS_ID = 0;
export const PAD_ID = 1;
export const EOS_ID = 2;
export const UNK_ID = 3;
/** Most tokens given to the text encoder (CLAP's training length), `<s>` and `</s>` included. */
export const MAX_TEXT_TOKENS = 77;

const PIECE_RE = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/** GPT-2's reversible byte → character map (printable bytes map to themselves, the others above U+0100). */
function byteToUnicode(): string[] {
	const bs: number[] = [];
	for (let b = 33; b <= 126; b++) bs.push(b);
	for (let b = 161; b <= 172; b++) bs.push(b);
	for (let b = 174; b <= 255; b++) bs.push(b);
	const cs = [...bs];
	let n = 0;
	for (let b = 0; b < 256; b++)
		if (!bs.includes(b)) {
			bs.push(b);
			cs.push(256 + n);
			n++;
		}
	const out = new Array<string>(256);
	bs.forEach((b, i) => {
		out[b] = String.fromCodePoint(cs[i]!);
	});
	return out;
}

export class ClapTokenizer {
	private readonly vocab: Map<string, number>;
	private readonly ranks: Map<string, number>;
	private readonly bytes = byteToUnicode();
	private readonly cache = new Map<string, number[]>();
	private readonly encoder = new TextEncoder();

	/** `vocabJson`: the contents of vocab.json; `merges`: of merges.txt. Throws on a malformed file. */
	constructor(vocabJson: string, merges: string) {
		const v = JSON.parse(vocabJson) as unknown;
		if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('vocab.json is not an object');
		this.vocab = new Map();
		for (const [k, id] of Object.entries(v as Record<string, unknown>))
			if (typeof id === 'number' && Number.isInteger(id) && id >= 0) this.vocab.set(k, id);
		if (this.vocab.get('<s>') !== BOS_ID || this.vocab.get('</s>') !== EOS_ID)
			throw new Error('vocab.json does not have the RoBERTa special tokens');
		this.ranks = new Map();
		let rank = 0;
		for (const line of merges.split('\n')) {
			if (!line || line.startsWith('#version')) continue;
			const parts = line.trimEnd().split(' ');
			if (parts.length !== 2) continue;
			this.ranks.set(`${parts[0]} ${parts[1]}`, rank++);
		}
		if (this.ranks.size === 0) throw new Error('merges.txt has no merges');
	}

	/** BPE of one pre-tokenized piece (already byte-mapped). */
	private bpe(piece: string): number[] {
		const hit = this.cache.get(piece);
		if (hit) return hit;
		let word = [...piece];
		while (word.length > 1) {
			let best = -1;
			let bestRank = Number.POSITIVE_INFINITY;
			for (let i = 0; i < word.length - 1; i++) {
				const r = this.ranks.get(`${word[i]} ${word[i + 1]}`);
				if (r !== undefined && r < bestRank) {
					bestRank = r;
					best = i;
				}
			}
			if (best < 0) break;
			const a = word[best]!;
			const b = word[best + 1]!;
			const next: string[] = [];
			for (let i = 0; i < word.length; i++) {
				if (i < word.length - 1 && word[i] === a && word[i + 1] === b) {
					next.push(a + b);
					i++;
				} else next.push(word[i]!);
			}
			word = next;
		}
		const ids = word.map((t) => this.vocab.get(t) ?? UNK_ID);
		if (this.cache.size >= 10_000) this.cache.clear();
		this.cache.set(piece, ids);
		return ids;
	}

	/** Token ids `<s> … </s>`, at most MAX_TEXT_TOKENS (longer text is cut, `</s>` kept). */
	encode(text: string): number[] {
		const ids: number[] = [BOS_ID];
		const max = MAX_TEXT_TOKENS - 1;
		for (const m of String(text).matchAll(PIECE_RE)) {
			let mapped = '';
			for (const b of this.encoder.encode(m[0])) mapped += this.bytes[b]!;
			for (const id of this.bpe(mapped)) {
				if (ids.length >= max) break;
				ids.push(id);
			}
			if (ids.length >= max) break;
		}
		ids.push(EOS_ID);
		return ids;
	}
}
