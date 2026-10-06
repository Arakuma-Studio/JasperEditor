// The interchange model ("IR"): a format-neutral timeline project that every reader produces and every writer
// consumes. `jasper.ts` converts between it and JasperEditor documents; the format modules (`fcp7.ts`,
// `fcpxml.ts`, `otio.ts`, `edl.ts`, `ale.ts`, `aaf/`, `omf/`) convert between it and bytes.
//
// Conventions (every module relies on them):
//
// - **Time is integer flicks** (705 600 000 per second, `FLICKS`), everywhere: sequence positions, durations,
//   source times, keyframe times, marker times. Every broadcast frame rate (23.976 … 60) and every common sample
//   rate (32/44.1/48/88.2/96/192 kHz) has an integral number of flicks per frame / sample, so frame, sample,
//   SMPTE-timecode, FCPXML rational and Premiere-tick values (1 flick = 360 ticks) convert without rounding.
//   Values a document gives off that grid are rounded to the nearest flick by the reader (and reported).
// - A **clip** shows content time `sourceIn` at its first frame and consumes `duration × speed` of content
//   (JasperEditor S01:CLP-004): forward `content(t) = sourceIn + (t − start) × speed`; reverse plays the same
//   range backwards, so `sourceIn` is always the *lowest* content time used. A frame hold (`hold`) shows that one
//   content time for the whole clip (speed and reverse are then irrelevant).
// - **Content time** of media is media time from the first sample of the file (not timecode). A file's start
//   timecode is metadata (`IMedia.timecode`); EDL/ALE readers that only know timecode subtract it when known.
// - **Keyframes** (`Animatable`, the JasperEditor shape) of clip properties are in the clip's content time; of
//   track properties in sequence time; of transition parameters relative to the transition start.
// - **Clip markers** are in content time; **sequence markers** in sequence time; **media markers** in media time.
// - Video tracks are bottom-up (index 0 = V1); audio tracks A1 first.
// - Ids are strings, unique per kind inside one `IProject`. Readers invent them (`m1`, `s1`, `c1`, …); `jasper.ts`
//   uses the JasperEditor ids so a round trip can recognise entities.
import type {
	Animatable,
	BlendMode,
	EffectInstance,
	LabelColor,
	MarkerType,
	Transform,
	Vec2,
} from '@jasper/project';

export const FLICKS = 705_600_000;

export type Rate = { num: number; den: number };

// ---------------------------------------------------------------- project

export type IProject = {
	name: string;
	/** Bin tree. Every media item and sequence appears at most once; items not in the tree are loose. */
	root: IBinEntry[];
	media: Record<string, IMedia>;
	sequences: Record<string, ISequence>;
	/** Sequences the document presents as timelines, in document order (nested ones are not listed). */
	top: string[];
};

export type IBinEntry =
	| { type: 'bin'; name: string; label?: LabelColor; children: IBinEntry[] }
	| { type: 'media'; id: string }
	| { type: 'sequence'; id: string };

// ---------------------------------------------------------------- media

export type IMediaKind = 'video' | 'audio' | 'image' | 'animated-image' | 'generator';

/** A synthetic source (JasperEditor synthetics; FCP7 generator items; OTIO GeneratorReference). */
export type IGenerator =
	| { kind: 'black' }
	| { kind: 'transparent' }
	| { kind: 'color'; color: [number, number, number, number] }
	| { kind: 'bars-and-tone'; toneHz: number; toneDb: number }
	| { kind: 'counting-leader' };

export type ITimecode = {
	/** Frame count of the first frame at `rate` (nominal frames for drop-frame, i.e. a frame index). */
	frames: number;
	rate: Rate;
	dropFrame: boolean;
};

export type IMedia = {
	id: string;
	/** Display name (clip/master-clip name). */
	name: string;
	kind: IMediaKind;
	/**
	 * Where the bytes are: an absolute path (`/a/b.mov`, `C:/x.mxf`, `//server/share/x`) after URL decoding and
	 * resolution against the import's base directory; a relative path when the document has one and no base
	 * directory was given; null when the document names no file (offline / missing reference).
	 */
	path: string | null;
	/** A non-file URL from the document (`https://…`), kept verbatim. */
	url?: string | null;
	/** Length of the media (flicks), null when unknown. Readers grow it to cover every use. */
	duration: number | null;
	video?: { width: number; height: number; rate: Rate; pixelAspect?: Rate; alpha?: boolean; codec?: string };
	audio?: { sampleRate: number; channels: number; bitDepth?: number; streams?: number };
	timecode?: ITimecode | null;
	/** Tape / reel name (EDL, ALE, AAF tape mob). */
	reel?: string | null;
	generator?: IGenerator;
	label?: LabelColor;
	/** Media markers (media time). */
	markers: IMarker[];
	/** File size in bytes when the document records it (relink matching). */
	sizeBytes?: number | null;
	/** The document says the media is missing (OTIO MissingReference, FCP7 file without pathurl, …). */
	offline?: boolean;
	/**
	 * Audio embedded in the document (AAF EssenceData, OMF WAVE/AIFC): a complete WAV or AIFF file the caller
	 * writes next to the project and links (`path` is then the suggested file name).
	 */
	embedded?: { fileName: string; bytes: Uint8Array };
	/** JasperEditor-only data carried by formats that can (OTIO `metadata.jasper`); see `jasper.ts`. */
	jasper?: Record<string, unknown>;
};

// ---------------------------------------------------------------- sequences

export type ISequence = {
	id: string;
	name: string;
	rate: Rate;
	dropFrame: boolean;
	width: number;
	height: number;
	pixelAspect?: Rate;
	sampleRate: number;
	/** Start timecode as a frame index at `rate`. */
	startTimecode: number;
	label?: LabelColor;
	video: ITrack[];
	audio: ITrack[];
	markers: IMarker[];
	/** In/out marks (sequence time), null when not set. */
	inPoint?: number | null;
	outPoint?: number | null;
	jasper?: Record<string, unknown>;
};

export type ITrack = {
	name: string | null;
	/** Video: output on; audio: not muted. */
	enabled: boolean;
	locked: boolean;
	/** Audio tracks: solo, volume (dB) and pan (−100…100), keyframes in sequence time. */
	solo?: boolean;
	volumeDb?: Animatable<number>;
	pan?: Animatable<number>;
	/** Clips sorted by `start`, never overlapping. */
	clips: IClip[];
	transitions: ITransition[];
	jasper?: Record<string, unknown>;
};

/** What a clip shows. */
export type ISource =
	| { type: 'media'; mediaId: string }
	| { type: 'sequence'; sequenceId: string }
	/**
	 * Nothing any format can reference: a JasperEditor text, shape, motion-graphic, composition, captions or
	 * adjustment clip that was not pre-rendered. `what` names it for reports ("text clip", "adjustment layer").
	 */
	| { type: 'none'; what: string };

export type IClip = {
	id: string;
	name: string;
	/** Sequence time (flicks). */
	start: number;
	duration: number;
	/** Lowest content time used (flicks); see the module header. */
	sourceIn: number;
	speed: number;
	reverse: boolean;
	/** Frame hold: the content time shown for the whole clip, or null. */
	hold?: number | null;
	enabled: boolean;
	label?: LabelColor;
	/** Clips sharing a link id are linked (A/V of one placement). */
	link?: string | null;
	/** Clips sharing a group id are grouped. */
	group?: string | null;
	source: ISource;
	markers: IMarker[];
	// ---- video clips
	transform?: Transform;
	opacity?: Animatable<number>;
	blendMode?: BlendMode;
	// ---- audio clips
	gainDb?: number;
	volumeDb?: Animatable<number>;
	/** −100 (left) … 100 (right). */
	pan?: Animatable<number>;
	/** Source audio channels (0-based) the clip plays; absent = all / the default mapping. */
	channels?: { streamIndex: number; map: number[] } | null;
	/** Standard effects (JasperEditor effect instances; registry ids such as `jasper.gaussian-blur`). */
	effects: EffectInstance[];
	jasper?: Record<string, unknown>;
};

export type ITransition = {
	id: string;
	/** JasperEditor transition id (`jasper.cross-dissolve`, …); readers map document names through `effects.ts`. */
	effectId: string;
	/** Clip ids on the same track; null for a fade from/to nothing. At least one is set. */
	from: string | null;
	to: string | null;
	/** Sequence time span (flicks). */
	start: number;
	duration: number;
	alignment: 'center' | 'start-at-cut' | 'end-at-cut';
	params: Record<string, Animatable<unknown>>;
	jasper?: Record<string, unknown>;
};

export type IMarker = {
	start: number;
	duration: number;
	name: string;
	comment: string;
	color: LabelColor;
	type?: MarkerType;
	url?: string;
	jasper?: Record<string, unknown>;
};

export type { Animatable, Transform, Vec2 };
