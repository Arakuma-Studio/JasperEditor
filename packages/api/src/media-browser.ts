// Media Browser (workstream polish, Premiere's Media Browser panel): browse the engine host's file system, preview
// media and import it in place. Local engines only (like path registration, S04:SC-002).
//   GET /api/browse/roots              Home, the usual media folders, volumes and the file-system root(s)
//   GET /api/browse/list?path=         one folder: sub-folders and the files JasperEditor can import
//   GET /api/browse/info?path=         size, date and (for audio / video / stills) the ffprobe summary
//   GET /api/browse/thumbnail?path=    a JPEG thumbnail of a video frame or a still
//   GET /api/browse/file?path=         the bytes (Range), for the preview player; media files only
import { z } from 'zod';

/** What a file is, from its extension; null = not importable (hidden unless "All files" is on). */
export const BrowseCategorySchema = z.enum([
	'video',
	'audio',
	'image',
	'graphics',
	'captions',
	'timeline',
	'lut',
	'model',
	'project',
]);
export type BrowseCategory = z.infer<typeof BrowseCategorySchema>;

const EXT: Record<BrowseCategory, readonly string[]> = {
	video: [
		'mp4',
		'mov',
		'm4v',
		'mkv',
		'webm',
		'avi',
		'mxf',
		'mts',
		'm2ts',
		'ts',
		'mpg',
		'mpeg',
		'ogv',
		'3gp',
		'wmv',
		'flv',
	],
	audio: ['wav', 'aif', 'aiff', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'wma'],
	image: [
		'png',
		'jpg',
		'jpeg',
		'webp',
		'avif',
		'gif',
		'heic',
		'heif',
		'bmp',
		'tif',
		'tiff',
		'exr',
		'dpx',
		'tga',
		'jxl',
		'hdr',
		'qoi',
		'sgi',
		'pcx',
		'jp2',
	],
	graphics: ['svg', 'svgz', 'pdf', 'ai', 'psd', 'psb', 'lottie'],
	captions: ['srt', 'vtt', 'scc', 'mcc', 'stl', 'ttml', 'dfxp'],
	timeline: ['xml', 'fcpxml', 'otio', 'edl', 'aaf', 'omf', 'ale'],
	lut: ['cube', '3dl', 'spi1d', 'spi3d', 'csp', 'ocio'],
	model: ['glb', 'gltf', 'obj'],
	project: ['jasper'],
};

const BY_EXT = new Map<string, BrowseCategory>(
	(Object.entries(EXT) as [BrowseCategory, readonly string[]][]).flatMap(([c, exts]) =>
		exts.map((e) => [e, c] as const),
	),
);

/** The category of a file name (by extension, case-insensitive); null when JasperEditor does not import it. */
export function browseCategoryOf(name: string): BrowseCategory | null {
	const dot = name.lastIndexOf('.');
	if (dot <= 0 || dot === name.length - 1) return null;
	return BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** Categories the preview player can show (`/api/browse/file` serves only these). */
export const BROWSE_PREVIEWABLE: ReadonlySet<BrowseCategory> = new Set(['video', 'audio', 'image']);

export const BrowseRootSchema = z.object({
	label: z.string(),
	path: z.string(),
	kind: z.enum(['home', 'folder', 'volume', 'root']),
});
export type BrowseRoot = z.infer<typeof BrowseRootSchema>;

export const BrowseRootsSchema = z.object({
	/** Path separator of the engine host. */
	sep: z.string(),
	home: z.string(),
	roots: z.array(BrowseRootSchema),
});
export type BrowseRoots = z.infer<typeof BrowseRootsSchema>;

export const BrowseListQuerySchema = z.object({
	path: z.string().min(1).max(4096),
	/** `1`: also list files JasperEditor cannot import and hidden (dot) entries. */
	all: z.enum(['0', '1']).optional(),
});

export const BrowseEntrySchema = z.object({
	name: z.string(),
	path: z.string(),
	kind: z.enum(['folder', 'file']),
	/** Bytes (files); null for folders. */
	size: z.number().nullable(),
	modifiedAt: z.string().nullable(),
	category: BrowseCategorySchema.nullable(),
	hidden: z.boolean(),
});
export type BrowseEntry = z.infer<typeof BrowseEntrySchema>;

export const BrowseListSchema = z.object({
	path: z.string(),
	/** The containing folder; null at a root. */
	parent: z.string().nullable(),
	entries: z.array(BrowseEntrySchema),
	/** The folder holds more entries than one listing returns (the first ones by name are listed). */
	truncated: z.boolean(),
});
export type BrowseList = z.infer<typeof BrowseListSchema>;

export const BrowsePathQuerySchema = z.object({ path: z.string().min(1).max(4096) });

export const BrowseThumbnailQuerySchema = BrowsePathQuerySchema.extend({
	width: z.coerce.number().int().min(32).max(640).optional(),
});

export const BrowseInfoSchema = z.object({
	path: z.string(),
	name: z.string(),
	size: z.number(),
	modifiedAt: z.string(),
	category: BrowseCategorySchema.nullable(),
	/** ffprobe summary for audio / video / stills; null when not probed or unreadable (`error` says why). */
	media: z
		.object({
			durationSec: z.number().nullable(),
			width: z.number().nullable(),
			height: z.number().nullable(),
			fps: z.number().nullable(),
			videoCodec: z.string().nullable(),
			audioCodec: z.string().nullable(),
			sampleRate: z.number().nullable(),
			channels: z.number().nullable(),
			/** The browser can play / show the file directly (the preview player uses it). */
			browserPlayable: z.enum(['yes', 'no', 'unknown']),
		})
		.nullable(),
	error: z.string().optional(),
});
export type BrowseInfo = z.infer<typeof BrowseInfoSchema>;
