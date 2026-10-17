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
	/** wp shapes: items of a vector shape (unique within their clip). */
	shapeItem: 'shp',
	textAnimator: 'tan',
	textSelector: 'tsl',
	/** audio-mix: Audio Track Mixer sends. */
	send: 'snd',
	/** wp masks: Opacity / effect masks. */
	mask: 'msk',
	/** sim-warp: Puppet meshes and pins. */
	puppetMesh: 'pms',
	puppetPin: 'ppn',
	/** parity (roto): segmented objects (Roto Brush / faces) on a clip. */
	roto: 'rto',
	/** three-d: the 3D Camera Tracker of a clip. */
	cameraTracker: 'ctk',
	/** sound-design (spec 12 §2.2): sound cues of a sequence (`Sequence.soundDesign.cues`). */
	soundCue: 'cue',
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

/** 32-bit string hashes (FNV-1a and a murmur-style mix) seeding `createSeededIdSource`. */
function seedWords(seed: string): [number, number, number, number] {
	let a = 0x811c9dc5;
	let b = 0x9e3779b9;
	for (let i = 0; i < seed.length; i++) {
		const c = seed.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x85ebca6b);
		b = (b << 13) | (b >>> 19);
	}
	return [a >>> 0, b >>> 0, (a ^ 0xdeadbeef) >>> 0, Math.imul(b, 0xc2b2ae35) >>> 0 || 1];
}

/**
 * Deterministic ids from a seed (sfc32 stream): the same seed gives the same ids in the same order. For previews that
 * are recomputed often (a proposal's preview document): its entities keep their ids, so a renderer keeps their state.
 * Never for committed entities (two seeds could in principle meet; random ids are used for those).
 */
export function createSeededIdSource(seed: string): IdSource {
	let [a, b, c, d] = seedWords(seed);
	const next32 = (): number => {
		const t = (((a + b) | 0) + d) | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return t >>> 0;
	};
	for (let i = 0; i < 12; i++) next32();
	return {
		next(prefix) {
			const bytes = new Uint8Array(10);
			for (let i = 0; i < 10; i += 2) {
				const v = next32();
				bytes[i] = v & 0xff;
				bytes[i + 1] = (v >>> 8) & 0xff;
			}
			return `${prefix}_${encode(bytes)}`;
		},
	};
}

/** An id body (the 16 Crockford characters after the prefix). */
export const ID_BODY_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** At most this many preset bodies are taken (a transaction of 5 000 commands creates far fewer entities). */
export const MAX_PRESET_IDS = 50_000;

/** `count` fresh random id bodies (for `createPresetIdSource`). */
export function randomIdBodies(count: number): string[] {
	const src = createRandomIdSource();
	const n = Math.max(0, Math.min(MAX_PRESET_IDS, Math.floor(Number.isFinite(count) ? count : 0)));
	return Array.from({ length: n }, () => src.next('clp').slice(4));
}

/**
 * Ids taken in order from `bodies` (random bodies chosen beforehand, `randomIdBodies`), whatever the prefix, then from
 * `fallback`. An accept journals the bodies before its transaction runs, so after a crash the engine can tell whether
 * the transaction reached the document by looking for them (proposal accept journal). Malformed bodies are skipped.
 */
export function createPresetIdSource(bodies: readonly string[], fallback: IdSource): IdSource {
	const list = bodies.slice(0, MAX_PRESET_IDS).filter((b) => typeof b === 'string' && ID_BODY_RE.test(b));
	let i = 0;
	return {
		next(prefix) {
			return i < list.length ? `${prefix}_${list[i++]}` : fallback.next(prefix);
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
