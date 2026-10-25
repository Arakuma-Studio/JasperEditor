// Review vocabulary per proposal feature (spec 15 EA-002): how the Review panel groups a feature's items (the groups
// and their order come from the producer's declaration in `PROPOSAL_FEATURES`; items name their group in `meta.group`,
// else `group`), and the feature's sentences (the proposal card, the Apply toast, the item noun) through a small
// registry. Sound design registers its own (grouping by `meta.role`, "n sounds on k new tracks", "Applied n of m
// sounds"); a feature without an entry gets the generic one, which names items with the feature's noun. Group names
// and nouns are model strings (translated with the rest of the catalogue).
import { proposalFeatureInfo, SOUND_DESIGN_FEATURE } from '@jasper/project';
import type { ReviewItem } from '@jasper/session';
import { t } from '../i18n/runtime.ts';

/** The counts a proposal card's sentence uses (from a preview of its undecided items). */
export type CardCounts = { sounds: number; newTracks: number; items: number };

export type ReviewVocabulary = {
	/** The group an item is listed under (lower case; `setup`, `tracks`, `other` are the review's own). */
	groupOf(item: Pick<ReviewItem, 'group' | 'meta'>): string;
	/** "<agent> proposes <title>: …" (null: the generic sentence). */
	cardSentence?(agent: string, title: string, counts: CardCounts): string | null;
	/** "12 cut kits", "1 subtitle". */
	itemsText(n: number): string;
	/** The Apply toast's title. */
	applyToast(applied: number, total: number, author: string): string;
};

const metaOf = (m: unknown): Record<string, unknown> =>
	m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
const text = (v: unknown, max = 64): string | null =>
	typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/** Common folding of every vocabulary: "track(s)" → the review's Tracks group, nothing → Other. */
function fold(key: string): string {
	const g = key.toLowerCase();
	if (g === 'track' || g === 'tracks') return 'tracks';
	return g || 'other';
}

/** The generic vocabulary of a feature: `meta.group`, else `group`; the feature's noun (else "items"). */
export function genericVocabulary(feature: string): ReviewVocabulary {
	const info = proposalFeatureInfo(feature);
	const itemsText = (n: number) =>
		info ? (n === 1 ? t(info.itemNoun.one) : t(info.itemNoun.other, n)) : n === 1 ? t('1 item') : t('{0} items', n);
	return {
		groupOf: (item) => fold(text(metaOf(item.meta).group) ?? item.group ?? ''),
		itemsText,
		applyToast: (applied, total, author) =>
			info
				? t('Applied {0} of {1} from {2}', applied, itemsText(total), author)
				: t('Applied {0} of {1} items from {2}', applied, total, author),
	};
}

/** Sound design (spec 12): rows by role (Hero / Support / Bed / Layers), "n sounds on k new tracks". */
const SOUND_VOCABULARY: ReviewVocabulary = {
	groupOf(item) {
		const g = (text(metaOf(item.meta).role) ?? item.group ?? '').toLowerCase();
		if (g === 'ambient' || g === 'ambience' || g === 'bed') return 'bed';
		return fold(g);
	},
	cardSentence(agent, title, counts) {
		if (counts.sounds <= 0) return null;
		const sounds = counts.sounds === 1 ? t('1 sound') : t('{0} sounds', counts.sounds);
		if (counts.newTracks <= 0) return t('{0} proposes {1}: {2}', agent, title, sounds);
		const tracks = counts.newTracks === 1 ? t('1 new track') : t('{0} new tracks', counts.newTracks);
		return t('{0} proposes {1}: {2} on {3}', agent, title, sounds, tracks);
	},
	itemsText: (n) => (n === 1 ? t('1 sound') : t('{0} sounds', n)),
	applyToast: (applied, total, author) => t('Applied {0} of {1} sounds from {2}', applied, total, author),
};

const REGISTRY = new Map<string, ReviewVocabulary>([[SOUND_DESIGN_FEATURE, SOUND_VOCABULARY]]);

/**
 * Registers a feature's own vocabulary (a producer whose sentences need more than its noun). Returns the undo.
 * Features without one use `genericVocabulary`.
 */
export function registerReviewVocabulary(feature: string, v: ReviewVocabulary): () => void {
	const prev = REGISTRY.get(feature);
	REGISTRY.set(feature, v);
	return () => {
		if (REGISTRY.get(feature) !== v) return;
		if (prev) REGISTRY.set(feature, prev);
		else REGISTRY.delete(feature);
	};
}

const generic = new Map<string, ReviewVocabulary>();
/** The vocabulary of a feature (its registered one, else the generic one). */
export function reviewVocabulary(feature: string): ReviewVocabulary {
	const own = REGISTRY.get(feature);
	if (own) return own;
	let g = generic.get(feature);
	if (!g) {
		g = genericVocabulary(feature);
		if (generic.size < 64) generic.set(feature, g);
	}
	return g;
}

/** The feature's declared group order (ids), and a label per declared group (translated). */
export function featureGroups(feature: string): { order: string[]; label: (id: string) => string | null } {
	const info = proposalFeatureInfo(feature);
	const groups = info?.groups ?? [];
	const byId = new Map(groups.map((g) => [g.id, g.label]));
	return {
		order: groups.map((g) => g.id),
		label: (id) => {
			const l = byId.get(id);
			return l ? t(l) : null;
		},
	};
}

/** A feature's display name in lower case for sentences ("editing automation"), else its id. */
export function featureName(feature: string): string {
	const info = proposalFeatureInfo(feature);
	return info ? t(info.name).toLocaleLowerCase() : feature;
}
