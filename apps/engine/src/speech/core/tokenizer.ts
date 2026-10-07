// Whisper token ids → text from the model's `tokenizer.json` (byte-level BPE: each vocabulary entry is a string of
// "printable" stand-in characters, one per byte, using the GPT-2 byte↔unicode table; special tokens are listed as
// added tokens). Only decoding is needed (Whisper produces tokens; we never encode text), so BPE merges are not
// used. Ported from FilmCraft `crates/speech/src/whisper/tokenizer.rs` (MIT OR Apache-2.0); word splitting and
// punctuation merging follow OpenAI Whisper's `tokenizer.split_to_word_tokens` / `timing.merge_punctuations`
// (MIT) so languages written without spaces (Chinese, Japanese, Thai, Lao, Burmese, Cantonese) split per
// character group instead of becoming one giant "word".

/** GPT-2's byte → printable character table, inverted. */
function unicodeToByte(): Map<string, number> {
	const bs: number[] = [];
	for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
	for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
	for (let b = 0xae; b <= 0xff; b++) bs.push(b);
	const cs = [...bs];
	let n = 0;
	for (let b = 0; b < 256; b++) {
		if (!bs.includes(b)) {
			bs.push(b);
			cs.push(256 + n);
			n++;
		}
	}
	const m = new Map<string, number>();
	for (let i = 0; i < bs.length; i++) m.set(String.fromCodePoint(cs[i]), bs[i]);
	return m;
}

export type TokenizerJson = {
	model: { vocab: Record<string, number> };
	added_tokens: Array<{ id: number; content: string }>;
};

const decoder = new TextDecoder('utf-8', { fatal: false });

export class WhisperTokenizer {
	private readonly bytes: Array<Uint8Array | undefined>;
	readonly special = new Map<string, number>();
	readonly specialById = new Map<number, string>();
	readonly eot: number;
	readonly sot: number;
	readonly sotPrev: number | null;
	readonly transcribe: number;
	readonly translate: number | null;
	readonly noTimestamps: number;
	readonly noSpeech: number | null;
	/** `<|0.00|>`; every later id is a timestamp in 0.02 s steps. */
	readonly timestampBegin: number;
	/** Language tokens (`"en"` → id) in vocabulary order, multilingual models only. */
	readonly languages: Array<[string, number]>;

	/**
	 * `multilingual`: whether the model was trained on many languages (OpenAI: vocabulary ≥ 51865 tokens). The
	 * English-only models list the language tokens too, but take a bare `<|startoftranscript|>` prompt.
	 */
	constructor(json: TokenizerJson, multilingual = true) {
		const table = unicodeToByte();
		const vocab = json.model?.vocab;
		if (!vocab) throw new Error('tokenizer.json: no model.vocab');
		let max = 0;
		for (const id of Object.values(vocab)) if (id > max) max = id;
		this.bytes = new Array(max + 1);
		for (const [tok, id] of Object.entries(vocab)) {
			const out: number[] = [];
			for (const ch of tok) {
				const b = table.get(ch);
				if (b !== undefined) out.push(b);
			}
			this.bytes[id] = Uint8Array.from(out);
		}
		for (const a of json.added_tokens ?? []) {
			this.special.set(a.content, a.id);
			this.specialById.set(a.id, a.content);
		}
		const need = (k: string): number => {
			const v = this.special.get(k);
			if (v === undefined) throw new Error(`tokenizer.json: no ${k}`);
			return v;
		};
		this.eot = need('<|endoftext|>');
		this.sot = need('<|startoftranscript|>');
		this.sotPrev = this.special.get('<|startofprev|>') ?? null;
		this.transcribe = need('<|transcribe|>');
		this.translate = this.special.get('<|translate|>') ?? null;
		this.noTimestamps = need('<|notimestamps|>');
		this.noSpeech = this.special.get('<|nospeech|>') ?? this.special.get('<|nocaptions|>') ?? null;
		this.timestampBegin = need('<|0.00|>');
		const tr = this.translate;
		this.languages = !multilingual
			? []
			: [...this.special.entries()]
					.filter(
						([k, id]) =>
							id > this.sot &&
							(tr === null || id < tr) &&
							k.startsWith('<|') &&
							k.endsWith('|>') &&
							k.length <= 10,
					)
					.map(([k, id]): [string, number] => [k.slice(2, -2), id])
					.sort((a, b) => a[1] - b[1]);
	}

	get multilingual(): boolean {
		return this.languages.length > 0;
	}

	languageToken(code: string): number | null {
		return this.languages.find(([c]) => c === code)?.[1] ?? null;
	}

	isTimestamp(id: number): boolean {
		return id >= this.timestampBegin;
	}

	/** Bytes of a regular token (empty for special tokens). */
	tokenBytes(id: number): Uint8Array {
		if (this.specialById.has(id)) return EMPTY;
		return this.bytes[id] ?? EMPTY;
	}

	decode(ids: readonly number[]): string {
		const parts = ids.map((i) => this.tokenBytes(i));
		const len = parts.reduce((s, p) => s + p.length, 0);
		const all = new Uint8Array(len);
		let o = 0;
		for (const p of parts) {
			all.set(p, o);
			o += p.length;
		}
		return decoder.decode(all);
	}

	/**
	 * Every special token that must never be sampled as text: all specials except end-of-text and the timestamps
	 * (OpenAI's `suppress_tokens = "-1"` adds the task/start tokens; the language tokens are specials too).
	 */
	nonTextSpecials(): number[] {
		return [...this.special.values()].filter((id) => id !== this.eot && id < this.timestampBegin);
	}

	/**
	 * Split text tokens into words (OpenAI `split_to_word_tokens`). Languages written without spaces split at
	 * unicode-complete token groups; the others at tokens starting with a space or being punctuation.
	 */
	splitToWordTokens(tokens: readonly number[], language: string): Array<{ word: string; tokens: number[] }> {
		if (NO_SPACE_LANGUAGES.has(language)) return this.splitOnUnicode(tokens);
		const sub = this.splitOnUnicode(tokens);
		const out: Array<{ word: string; tokens: number[] }> = [];
		for (const s of sub) {
			const special = s.tokens[0] >= this.eot;
			const withSpace = s.word.startsWith(' ');
			const trimmed = s.word.trim();
			const punctuation = trimmed.length > 0 && [...trimmed].every((c) => ASCII_PUNCTUATION.has(c));
			if (special || withSpace || punctuation || out.length === 0)
				out.push({ word: s.word, tokens: [...s.tokens] });
			else {
				const last = out[out.length - 1];
				last.word += s.word;
				last.tokens.push(...s.tokens);
			}
		}
		return out;
	}

	/** Groups of tokens that decode to complete UTF-8 (no replacement character mid-sequence). */
	private splitOnUnicode(tokens: readonly number[]): Array<{ word: string; tokens: number[] }> {
		const out: Array<{ word: string; tokens: number[] }> = [];
		let current: number[] = [];
		let start = 0;
		const full = this.decode(tokens);
		for (const t of tokens) {
			current.push(t);
			const d = this.decode(current);
			const bad = d.indexOf('�');
			if (bad < 0 || full[start + bad] === '�') {
				out.push({ word: d, tokens: current });
				current = [];
				start += d.length;
			}
		}
		if (current.length) out.push({ word: this.decode(current), tokens: current });
		return out;
	}
}

const EMPTY = new Uint8Array(0);
const ASCII_PUNCTUATION = new Set([...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~']);
/** OpenAI: languages whose words are not separated by spaces. */
export const NO_SPACE_LANGUAGES = new Set(['zh', 'ja', 'th', 'lo', 'my', 'yue']);

/** OpenAI defaults (`transcribe(prepend_punctuations=…, append_punctuations=…)`). */
export const PREPEND_PUNCTUATIONS = '"\'“¿([{-';
export const APPEND_PUNCTUATIONS = '"\'.。,，!！?？:：”)]}、';
