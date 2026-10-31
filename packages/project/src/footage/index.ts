// Spec 18 AF-DIG / AF-TAK: footage digest and takes (docs/wp-notes/agent-footage-digest.md).
export {
	DIGEST_DEFAULT_MAX_CHARS,
	DIGEST_MAX_CHARS_LIMIT,
	DIGEST_MIN_MAX_CHARS,
	type DigestOptions,
	type DigestPhrase,
	type DigestSection,
	digestBudget,
	type FootageDigest,
	type FootageError,
	packFootageDigest,
} from './digest.ts';
export { type FootageMedia, footageMedia } from './media.ts';
export {
	DIGEST_LOW_CONFIDENCE,
	type FootagePhrase,
	footagePhrases,
	PHRASE_GAP_S,
	PHRASE_MAX_S,
	type PhraseWord,
} from './phrases.ts';
export {
	findTakes,
	normaliseTakeTokens,
	TAKE_MAX_TOKENS,
	TAKE_MIN_TOKENS,
	TAKES_DEFAULT_MIN_SIMILARITY,
	TAKES_MAX_PHRASES,
	type TakeGroup,
	type TakeMember,
	type TakesResult,
	takeSimilarity,
} from './takes.ts';
