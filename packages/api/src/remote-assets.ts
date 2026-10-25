// social-comment §7.8: remote platform fonts and emoji (Settings ▸ Privacy & Network, spec 04 OF-002).
import { z } from 'zod';

/** Persisted network-use preferences of the engine (`<appdir>/engine/network.json`). */
export const NetworkSettingsSchema = z.object({
	/**
	 * "Platform fonts & emoji for social templates": the engine may download the fonts and emoji images of the
	 * remote-asset manifest when a template needs them (default on). Off: nothing is downloaded; assets already cached
	 * are still used, missing ones block exports by name.
	 */
	platformAssets: z.boolean(),
});
export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>;
export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = { platformAssets: true };

/** An error of the remote-asset service (`{code, message, detail?, retryable}`, AGENTS §0). */
export const RemoteAssetErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
	detail: z.unknown().optional(),
	retryable: z.boolean(),
});
export type RemoteAssetError = z.infer<typeof RemoteAssetErrorSchema>;

const FaceSchema = z.object({
	family: z.string().min(1).max(128),
	weight: z.number().int().min(1).max(1000),
	style: z.enum(['normal', 'italic']),
});

/** `POST /api/remote-assets/prefetch`: fetch (or check) the assets a render needs before it starts. */
export const RemoteAssetPrefetchRequestSchema = z.object({
	fonts: z.array(FaceSchema).max(64).default([]),
	emoji: z
		.array(
			z.object({
				pack: z.string().min(1).max(32),
				graphemes: z.array(z.string().min(1).max(64)).max(512),
			}),
		)
		.max(8)
		.default([]),
	/** Remote image ids of the manifest. */
	images: z.array(z.string().min(1).max(64)).max(32).default([]),
});
export type RemoteAssetPrefetchRequest = z.input<typeof RemoteAssetPrefetchRequestSchema>;

/** An asset that is not available, with why. */
export const RemoteAssetMissingSchema = z.discriminatedUnion('kind', [
	FaceSchema.extend({ kind: z.literal('font'), error: RemoteAssetErrorSchema }),
	z.object({
		kind: z.literal('emoji'),
		pack: z.string(),
		grapheme: z.string(),
		error: RemoteAssetErrorSchema,
	}),
	z.object({ kind: z.literal('image'), id: z.string(), error: RemoteAssetErrorSchema }),
]);
export type RemoteAssetMissing = z.infer<typeof RemoteAssetMissingSchema>;

export const RemoteAssetPrefetchResponseSchema = z.object({
	/** Assets now available (cached or bundled). */
	available: z.number().int().min(0),
	missing: z.array(RemoteAssetMissingSchema),
});
export type RemoteAssetPrefetchResponse = z.infer<typeof RemoteAssetPrefetchResponseSchema>;

/** One download, as named in the first-fetch notice. */
export const RemoteAssetFetchSchema = z.object({
	kind: z.enum(['font', 'emoji', 'image']),
	/** `Chirp 700`, `😀 (Apple)`. */
	label: z.string(),
	/** Host the file came from. */
	host: z.string(),
	licence: z.string(),
});
export type RemoteAssetFetch = z.infer<typeof RemoteAssetFetchSchema>;

export const RemoteAssetsStatusSchema = z.object({
	settings: NetworkSettingsSchema,
	manifest: z.object({
		version: z.number().int(),
		fonts: z.number().int().min(0),
		emojiPacks: z.number().int().min(0),
		images: z.number().int().min(0),
		/** The appdir override file: absent, merged, or ignored because it is invalid (with why). */
		override: z.object({
			status: z.enum(['absent', 'loaded', 'invalid']),
			message: z.string().optional(),
		}),
	}),
	fonts: z.array(
		FaceSchema.extend({ id: z.string(), cached: z.boolean(), host: z.string(), licence: z.string() }),
	),
	emojiPacks: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			version: z.string(),
			host: z.string(),
			licence: z.string(),
			attribution: z.string().nullable(),
			cached: z.number().int().min(0),
		}),
	),
	images: z.array(z.object({ id: z.string(), cached: z.boolean(), host: z.string(), licence: z.string() })),
	/**
	 * The one-time notice after the first successful download (what, from where, the licence caveat): `pending` until an
	 * editor acknowledges it (`POST /api/remote-assets/notice/ack`).
	 */
	notice: z.object({
		pending: z.boolean(),
		firstFetchAt: z.string().nullable(),
		items: z.array(RemoteAssetFetchSchema),
	}),
});
export type RemoteAssetsStatus = z.infer<typeof RemoteAssetsStatusSchema>;

/** Event `remoteAssets.changed`: a download finished, the settings or the manifest changed. */
export const RemoteAssetsChangedEventSchema = z.object({
	reason: z.enum(['fetched', 'settings', 'manifest']),
	/** The first-fetch notice is pending (show it once, then acknowledge). */
	notice: z.boolean(),
	items: z.array(RemoteAssetFetchSchema).optional(),
});
export type RemoteAssetsChangedEvent = z.infer<typeof RemoteAssetsChangedEventSchema>;
