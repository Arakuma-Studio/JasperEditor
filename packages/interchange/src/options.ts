// Import / export options of every format (one shape so the engine, the UI and the MCP tools share them).
import type { Rate } from './model.ts';

export const FORMATS = ['fcp7', 'fcpxml', 'otio', 'edl', 'aaf', 'omf', 'ale'] as const;
export type Format = (typeof FORMATS)[number];

export type ImportOptions = {
	/** Directory relative media paths resolve against (normally the document's directory). */
	baseDir?: string | null;
	/** Name for documents without a title (EDL without `TITLE:`, ALE). */
	name?: string;
	/** EDL / ALE: the rate timecodes are read at when the document does not say (default: guessed). */
	rate?: Rate;
	/** EDL: drop-frame numbering when there is no `FCM:` line. */
	dropFrame?: boolean;
};

/** How EDL reel names are derived from media. */
export type ReelMode = 'file-name' | 'clip-name' | 'ax';

export type EdlOptions = {
	/** Video track exported (0 = V1); null = audio only. */
	videoTrack: number | null;
	/** Audio tracks (0 = A1), at most four (A, A2, A3, A4). */
	audioTracks: number[];
	reelMode: ReelMode;
	/** 8 (strict CMX 3600) or 32 (extended reel names). */
	reelLength: number;
	clipNames: boolean;
	sourceFiles: boolean;
	effectNames: boolean;
	markers: boolean;
};

export const DEFAULT_EDL_OPTIONS: EdlOptions = {
	videoTrack: 0,
	audioTracks: [0, 1, 2, 3],
	reelMode: 'file-name',
	reelLength: 8,
	clipNames: true,
	sourceFiles: true,
	effectNames: true,
	markers: true,
};

export type FcpxmlVersion = '1.9' | '1.10' | '1.11';

/** What a piece of essence stands in for: a whole media item, or one clip's rendered audio. */
export type EssenceKey = { media: string } | { clip: string };

/** Audio essence the caller (the engine) supplies for one key (and one channel when broken out to mono). */
export type AudioEssence = {
	key: EssenceKey;
	/** This essence carries only source channel `channel` (0-based), as one mono stream; null = all channels. */
	channel: number | null;
	/** Media time (flicks) of the first sample. */
	start: number;
	/** Sample frames. */
	frames: number;
	sampleRate: number;
	bits: 16 | 24;
	channels: number;
	/** Interleaved little-endian signed PCM embedded in the document, or a file the caller wrote. */
	data: { embedded: Uint8Array } | { file: string };
	/** Clip volume/gain are rendered into the samples: the document carries no gain for the clips using it. */
	effectsRendered: boolean;
};

/** A rendered video mixdown that replaces every video track with one clip. */
export type MixdownVideo = {
	path: string;
	/** Sequence time (flicks) of the file's first frame, and its length. */
	start: number;
	duration: number;
	width: number;
	height: number;
};

export type MediaOptions = {
	/** One mono slot (and essence) per channel of multichannel audio. */
	breakoutToMono: boolean;
	/** Leave the video tracks out (OMF is always audio only). */
	audioOnly: boolean;
	essence: AudioEssence[];
	mixdownVideo: MixdownVideo | null;
};

export const DEFAULT_MEDIA_OPTIONS: MediaOptions = {
	breakoutToMono: false,
	audioOnly: false,
	essence: [],
	mixdownVideo: null,
};

export type AleOptions = {
	/** Which clips are logged: the media used by the sequence (default) or every media item in the project. */
	scope: 'sequence' | 'project';
};

export type ExportOptions = {
	/** Document / title name (default: the sequence name). */
	name?: string;
	/** Write media paths relative to this directory where the format allows (OTIO, EDL, ALE). */
	relativeTo?: string | null;
	/** FCP7 `xmeml` version (4 or 5, default 4). */
	xmemlVersion?: 4 | 5;
	fcpxmlVersion?: FcpxmlVersion;
	edl?: Partial<EdlOptions>;
	/** AAF / OMF: media handling. */
	media?: Partial<MediaOptions>;
	/** AAF: 512-byte sectors (compound file v3) instead of 4096. */
	aafSmallSectors?: boolean;
	ale?: Partial<AleOptions>;
};
