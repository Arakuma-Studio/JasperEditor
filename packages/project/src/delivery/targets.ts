// Delivery targets (spec 18 §2.5 AF-VER-003): the platforms a sequence brief (AF-BRF) and the delivery check
// (`verify_export {target}`) name: each target's identity, frame shape and upload limits (duration, frame size and
// shape, frame rate, file size, containers, loudness), with their sources and access dates in
// docs/wp-notes/agent-footage-verify.md ("Delivery targets"; a test pins that table to these values).

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

/** Containers a delivery target accepts (the export containers it takes). */
export type DeliveryContainer = 'mp4' | 'mov' | 'webm';

/**
 * A platform's upload limits and recommendations (spec 18 AF-VER-003). Every value is cited with its source and access
 * date in docs/wp-notes/agent-footage-verify.md ("Delivery targets"); the keys in `assumptions` are not stated by an
 * official source and say their basis there. Hard limits (the platform refuses the upload) become `format` rows of a
 * delivery check; recommendations become `judgement` rows.
 */
export type DeliveryLimits = {
	/** Longest upload the platform takes (s; hard limit, default account). */
	maxDurationSec: number;
	/** Shortest upload (s; hard limit), or null when none is stated. */
	minDurationSec: number | null;
	/** Largest upload file (bytes; hard limit). */
	maxFileSizeBytes: number;
	/** Recommended upload frame size (pixels, the target's aspect). */
	recommendedSize: { width: number; height: number };
	/**
	 * Accepted frame shapes, width / height (hard limit: other shapes are refused or not shown as this target), or null
	 * when any shape is taken.
	 */
	aspectRange: { min: number; max: number } | null;
	/** Recommended frame rates (fps). */
	frameRates: readonly number[];
	/** Lowest frame rate the platform takes (fps), or null when none is stated. */
	minFrameRate: number | null;
	/** Highest frame rate the platform takes (fps). */
	maxFrameRate: number;
	/** Containers it takes (hard limit). */
	containers: readonly DeliveryContainer[];
	/** Integrated loudness the platform normalises playback to (LUFS), or null when it does not. */
	loudnessLufs: number | null;
	/** True-peak ceiling of a delivery to it (dBTP). */
	truePeakDbtp: number;
};

export type DeliveryTarget = {
	id: DeliveryTargetId;
	/** English display name (a model string: the editor translates it). */
	name: string;
	/** The frame shape the platform shows full-screen. */
	aspect: DeliveryAspect;
	/** Long-form (horizontal player) or short-form (vertical feed). */
	form: 'long' | 'short';
	limits: DeliveryLimits;
	/** Limits not stated by an official source (each one's basis is in the wp-note). */
	assumptions: readonly (keyof DeliveryLimits)[];
};

const GB = 1e9;
const MB = 1e6;
/** The YouTube upload limits Shorts share (sources: the wp-note). */
const YOUTUBE_FILE = {
	maxFileSizeBytes: 256 * GB,
	frameRates: [24, 25, 30, 48, 50, 60],
	minFrameRate: null,
	maxFrameRate: 60,
	containers: ['mp4', 'mov', 'webm'],
	loudnessLufs: -14,
	truePeakDbtp: -1,
} as const;

/**
 * Delivery check true-peak ceiling of the platforms that publish none: −1 dBTP (assumption: EBU R128 s1 / AES TD1008
 * streaming practice).
 */
const SOCIAL_TRUE_PEAK = -1;

export const DELIVERY_TARGETS: readonly DeliveryTarget[] = [
	{
		id: 'youtube',
		name: 'YouTube',
		aspect: '16:9',
		form: 'long',
		limits: {
			...YOUTUBE_FILE,
			maxDurationSec: 12 * 3600,
			minDurationSec: null,
			recommendedSize: { width: 1920, height: 1080 },
			aspectRange: null,
		},
		assumptions: ['maxFrameRate', 'loudnessLufs', 'truePeakDbtp'],
	},
	{
		id: 'youtube-shorts',
		name: 'YouTube Shorts',
		aspect: '9:16',
		form: 'short',
		limits: {
			...YOUTUBE_FILE,
			maxDurationSec: 180,
			minDurationSec: null,
			recommendedSize: { width: 1080, height: 1920 },
			aspectRange: { min: 0.01, max: 1 },
		},
		assumptions: ['maxFrameRate', 'loudnessLufs', 'truePeakDbtp'],
	},
	{
		id: 'instagram-reels',
		name: 'Instagram Reels',
		aspect: '9:16',
		form: 'short',
		limits: {
			maxDurationSec: 900,
			minDurationSec: 3,
			maxFileSizeBytes: 300 * MB,
			recommendedSize: { width: 1080, height: 1920 },
			aspectRange: { min: 0.01, max: 10 },
			frameRates: [24, 25, 30, 60],
			minFrameRate: 23,
			maxFrameRate: 60,
			containers: ['mp4', 'mov'],
			loudnessLufs: null,
			truePeakDbtp: SOCIAL_TRUE_PEAK,
		},
		assumptions: ['recommendedSize', 'frameRates', 'truePeakDbtp'],
	},
	{
		id: 'tiktok',
		name: 'TikTok',
		aspect: '9:16',
		form: 'short',
		limits: {
			maxDurationSec: 600,
			minDurationSec: null,
			maxFileSizeBytes: 4 * GB,
			recommendedSize: { width: 1080, height: 1920 },
			aspectRange: null,
			frameRates: [24, 25, 30, 60],
			minFrameRate: 23,
			maxFrameRate: 60,
			containers: ['mp4', 'mov', 'webm'],
			loudnessLufs: null,
			truePeakDbtp: SOCIAL_TRUE_PEAK,
		},
		assumptions: ['recommendedSize', 'frameRates', 'truePeakDbtp'],
	},
	{
		id: 'x',
		name: 'X',
		aspect: '16:9',
		form: 'long',
		limits: {
			maxDurationSec: 1200,
			minDurationSec: 0.5,
			maxFileSizeBytes: 8 * GB,
			recommendedSize: { width: 1280, height: 720 },
			aspectRange: { min: 1 / 3, max: 3 },
			frameRates: [30, 60],
			minFrameRate: null,
			maxFrameRate: 60,
			containers: ['mp4', 'mov'],
			loudnessLufs: null,
			truePeakDbtp: SOCIAL_TRUE_PEAK,
		},
		assumptions: ['containers', 'truePeakDbtp'],
	},
	{
		id: 'linkedin',
		name: 'LinkedIn',
		aspect: '1:1',
		form: 'long',
		limits: {
			maxDurationSec: 900,
			minDurationSec: 3,
			maxFileSizeBytes: 5 * GB,
			recommendedSize: { width: 1080, height: 1080 },
			aspectRange: { min: 1 / 2.4, max: 2.4 },
			frameRates: [24, 25, 30, 60],
			minFrameRate: 10,
			maxFrameRate: 60,
			containers: ['mp4', 'mov', 'webm'],
			loudnessLufs: null,
			truePeakDbtp: SOCIAL_TRUE_PEAK,
		},
		assumptions: ['recommendedSize', 'frameRates', 'truePeakDbtp'],
	},
];

/**
 * Loudness a delivery preset normalises to when the platform publishes none (LUFS): −14, the level YouTube is
 * measured to play at (assumption, community measurement; the wp-note).
 */
export const DELIVERY_DEFAULT_LUFS = -14;

export function isDeliveryTargetId(id: unknown): id is DeliveryTargetId {
	return typeof id === 'string' && (DELIVERY_TARGET_IDS as readonly string[]).includes(id);
}

export function deliveryTarget(id: DeliveryTargetId): DeliveryTarget {
	const t = DELIVERY_TARGETS.find((x) => x.id === id);
	if (!t) throw new Error(`unknown delivery target ${id}`);
	return t;
}
