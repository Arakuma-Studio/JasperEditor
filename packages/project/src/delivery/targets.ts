// Delivery targets (spec 18 §2.7, AF-VER-010): the platforms a sequence brief (AF-BRF) and the delivery check
// (`verify_export {target}`) name. This table holds each target's identity and frame shape; the measured limits a
// delivery check compares against (duration, resolution, frame rate, loudness, file size) are added beside these
// fields with their sources in docs/wp-notes/agent-footage.md.

/** Stable ids, persisted in `Sequence.brief.platform` (schema v11): never rename or reuse one. */
export const DELIVERY_TARGET_IDS = [
	'youtube',
	'youtube-shorts',
	'instagram-reels',
	'tiktok',
	'x',
	'linkedin',
] as const;
export type DeliveryTargetId = (typeof DELIVERY_TARGET_IDS)[number];

/** Frame shapes a brief and a delivery target name ("W:H"). */
export const DELIVERY_ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const;
export type DeliveryAspect = (typeof DELIVERY_ASPECTS)[number];

export type DeliveryTarget = {
	id: DeliveryTargetId;
	/** English display name (a model string: the editor translates it). */
	name: string;
	/** The frame shape the platform shows full-screen. */
	aspect: DeliveryAspect;
	/** Long-form (horizontal player) or short-form (vertical feed). */
	form: 'long' | 'short';
};

export const DELIVERY_TARGETS: readonly DeliveryTarget[] = [
	{ id: 'youtube', name: 'YouTube', aspect: '16:9', form: 'long' },
	{ id: 'youtube-shorts', name: 'YouTube Shorts', aspect: '9:16', form: 'short' },
	{ id: 'instagram-reels', name: 'Instagram Reels', aspect: '9:16', form: 'short' },
	{ id: 'tiktok', name: 'TikTok', aspect: '9:16', form: 'short' },
	{ id: 'x', name: 'X', aspect: '16:9', form: 'long' },
	{ id: 'linkedin', name: 'LinkedIn', aspect: '1:1', form: 'long' },
];

export function isDeliveryTargetId(id: unknown): id is DeliveryTargetId {
	return typeof id === 'string' && (DELIVERY_TARGET_IDS as readonly string[]).includes(id);
}

export function deliveryTarget(id: DeliveryTargetId): DeliveryTarget {
	const t = DELIVERY_TARGETS.find((x) => x.id === id);
	if (!t) throw new Error(`unknown delivery target ${id}`);
	return t;
}
