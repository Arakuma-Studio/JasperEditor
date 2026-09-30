// Entity identifiers (S01:ID-001…005): `<prefix>_` + 16 Crockford base32 characters (80 bits).

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ID_BODY_LENGTH = 16;

/** Type prefixes per S01:ID-001. */
export const ID_PREFIXES = {
	project: 'prj',
	bin: 'bin',
	item: 'itm',
	media: 'med',
	synthetic: 'syn',
	sequence: 'seq',
	track: 'trk',
	transcript: 'trs',
	clip: 'clp',
	transition: 'trn',
	effect: 'fx',
	keyframe: 'kf',
	marker: 'mrk',
	link: 'lnk',
	group: 'grp',
	font: 'fnt',
	/** M2 (S09): trackers placed on a clip. */
	tracker: 'tkr',
} as const;
export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
export const ALL_ID_PREFIXES: readonly IdPrefix[] = Object.values(ID_PREFIXES);

/** Source of new ids. Injected into command handlers so tests are deterministic (S01:ARC-002). */
export interface IdSource {
	next(prefix: IdPrefix): string;
}

function encode(bytes: Uint8Array): string {
	// 16 chars x 5 bits = 80 bits = 10 bytes.
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += CROCKFORD_ALPHABET[(buffer >> bits) & 31];
		}
		buffer &= (1 << bits) - 1;
	}
	return out.slice(0, ID_BODY_LENGTH);
}

type CryptoLike = { getRandomValues<T extends ArrayBufferView>(array: T): T };

/** Cryptographically random ids (Web Crypto, available in browsers, workers and Node >= 19). */
export function createRandomIdSource(): IdSource {
	const cryptoObj = (globalThis as { crypto?: CryptoLike }).crypto;
	if (!cryptoObj?.getRandomValues) throw new Error('Web Crypto getRandomValues is not available');
	return {
		next(prefix) {
			const bytes = new Uint8Array(10);
			cryptoObj.getRandomValues(bytes);
			return `${prefix}_${encode(bytes)}`;
		},
	};
}

/** Deterministic ids for tests: a seeded PRNG (mulberry32) feeding the same encoder. */
export function createSeededIdSource(seed = 1): IdSource {
	let state = seed >>> 0;
	const nextByte = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) & 0xff;
	};
	return {
		next(prefix) {
			const bytes = new Uint8Array(10);
			for (let i = 0; i < bytes.length; i++) bytes[i] = nextByte();
			return `${prefix}_${encode(bytes)}`;
		},
	};
}

/** Sequential ids (`clp_0000000000000001`, …) — readable ids for fixtures and debugging. */
export function createCounterIdSource(start = 1): IdSource {
	let n = start;
	return {
		next(prefix) {
			let v = n++;
			let body = '';
			while (v > 0) {
				body = CROCKFORD_ALPHABET[v % 32] + body;
				v = Math.floor(v / 32);
			}
			return `${prefix}_${body.padStart(ID_BODY_LENGTH, '0')}`;
		},
	};
}

const ID_RE = /^([a-z]{2,3})_([0-9A-Z]{16})$/;

/** True for a well-formed id, optionally with the given prefix. Bodies are uppercase alphanumerics. */
export function isValidId(id: unknown, prefix?: IdPrefix): id is string {
	if (typeof id !== 'string') return false;
	const m = ID_RE.exec(id);
	if (!m) return false;
	if (prefix) return m[1] === prefix;
	return (ALL_ID_PREFIXES as readonly string[]).includes(m[1]!);
}

export function idPrefixOf(id: string): IdPrefix | null {
	const m = ID_RE.exec(id);
	if (!m) return null;
	return (ALL_ID_PREFIXES as readonly string[]).includes(m[1]!) ? (m[1] as IdPrefix) : null;
}

/** True for strings that look like entity ids (used for "touched entity" extraction). */
export function looksLikeId(s: unknown): s is string {
	return typeof s === 'string' && ID_RE.test(s);
}
