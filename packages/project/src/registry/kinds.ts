// Clip kind capabilities (S01 §10.1 kind table, S02:TL-022, S03:KND-001 idea, ARCHITECTURE §10.4).
import type { LabelColor } from '../schema/common.ts';
import type { MediaAsset } from '../schema/media.ts';
import { type Clip, isKnownClipKind, type KnownClipKind, type TrackKind } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND } from '../time.ts';

export type EngineId = 'native' | 'remotion' | 'fframes';

export type KindCapabilities = {
	kind: KnownClipKind;
	trackKind: TrackKind;
	/** Source reference field. */
	source: 'media' | 'synthetic' | 'inline' | 'template' | 'composition' | 'transcript' | 'sequence';
	/** Content-time bounds (S01:CLP-005). `loop-dependent` = bounded unless `loop` is true. */
	bounded: 'yes' | 'no' | 'loop-dependent';
	visual: boolean;
	audio: boolean;
	hasTransform: boolean;
	hasOpacity: boolean;
	supportsEffects: boolean;
	supportsSpeed: boolean;
	/** Engine producing pixels/samples (S02:TL-022): preview and export. */
	engines: { preview: EngineId; export: EngineId };
	/** Timeline engine badge (ARCHITECTURE §10.4): R = Remotion, F = fframes, null = native media. */
	badge: 'R' | 'F' | null;
	/** Implemented in M1 (others are preserved and drawn as unsupported until their milestone). */
	m1: boolean;
	defaultLabel: LabelColor;
	priority: 'P0' | 'P1' | 'P2';
};

export const KIND_CAPABILITIES: Record<KnownClipKind, KindCapabilities> = {
	video: {
		kind: 'video',
		trackKind: 'video',
		source: 'media',
		bounded: 'yes',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: true,
		engines: { preview: 'native', export: 'native' },
		badge: null,
		m1: true,
		defaultLabel: 'iris',
		priority: 'P0',
	},
	audio: {
		kind: 'audio',
		trackKind: 'audio',
		source: 'media',
		bounded: 'yes',
		visual: false,
		audio: true,
		hasTransform: false,
		hasOpacity: false,
		supportsEffects: true,
		supportsSpeed: true,
		engines: { preview: 'native', export: 'native' },
		badge: null,
		m1: true,
		defaultLabel: 'caribbean',
		priority: 'P0',
	},
	still: {
		kind: 'still',
		trackKind: 'video',
		source: 'media',
		bounded: 'no',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: false,
		engines: { preview: 'native', export: 'native' },
		badge: null,
		m1: true,
		defaultLabel: 'lavender',
		priority: 'P0',
	},
	'animated-image': {
		kind: 'animated-image',
		trackKind: 'video',
		source: 'media',
		bounded: 'loop-dependent',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: true,
		engines: { preview: 'native', export: 'native' },
		badge: null,
		m1: true,
		defaultLabel: 'lavender',
		priority: 'P0',
	},
	text: {
		kind: 'text',
		trackKind: 'video',
		source: 'inline',
		bounded: 'no',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: false,
		engines: { preview: 'remotion', export: 'remotion' },
		badge: 'R',
		m1: true,
		defaultLabel: 'lavender',
		priority: 'P0',
	},
	solid: {
		kind: 'solid',
		trackKind: 'video',
		source: 'synthetic',
		bounded: 'no',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: false,
		engines: { preview: 'native', export: 'native' },
		badge: null,
		m1: true,
		defaultLabel: 'tan',
		priority: 'P0',
	},
	captions: {
		kind: 'captions',
		trackKind: 'caption',
		source: 'transcript',
		bounded: 'yes',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: false,
		supportsSpeed: false,
		engines: { preview: 'remotion', export: 'remotion' },
		badge: 'R',
		m1: false,
		defaultLabel: 'mango',
		priority: 'P0',
	},
	'motion-graphic': {
		kind: 'motion-graphic',
		trackKind: 'video',
		source: 'template',
		bounded: 'no',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: false,
		engines: { preview: 'fframes', export: 'fframes' },
		badge: 'F',
		m1: true,
		defaultLabel: 'purple',
		priority: 'P0',
	},
	// M2 (S08:MGC-004): bounded by the composition's duration; exported natively through cached ProRes 4444
	// masters rendered by Remotion (the badge stays R).
	composition: {
		kind: 'composition',
		trackKind: 'video',
		source: 'composition',
		bounded: 'yes',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: false,
		engines: { preview: 'remotion', export: 'remotion' },
		badge: 'R',
		m1: true,
		defaultLabel: 'magenta',
		priority: 'P0',
	},
	// edit-structure: the nested sequence is drawn recursively by the compositions (preview, Remotion path) and
	// pre-rendered natively (the `nest` export extension: an intermediate per nest clip, native/hybrid/Remotion).
	'nest-video': {
		kind: 'nest-video',
		trackKind: 'video',
		source: 'sequence',
		bounded: 'yes',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: true,
		engines: { preview: 'remotion', export: 'native' },
		badge: null,
		m1: true,
		defaultLabel: 'forest',
		priority: 'P1',
	},
	'nest-audio': {
		kind: 'nest-audio',
		trackKind: 'audio',
		source: 'sequence',
		bounded: 'yes',
		visual: false,
		audio: true,
		hasTransform: false,
		hasOpacity: false,
		supportsEffects: true,
		supportsSpeed: true,
		engines: { preview: 'native', export: 'native' },
		badge: null,
		m1: true,
		defaultLabel: 'forest',
		priority: 'P1',
	},
	// edit-structure: the layer's effects run on the composite of the tracks below (KND-012).
	adjustment: {
		kind: 'adjustment',
		trackKind: 'video',
		source: 'synthetic',
		bounded: 'no',
		visual: true,
		audio: false,
		hasTransform: false,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: false,
		engines: { preview: 'remotion', export: 'native' },
		badge: null,
		m1: true,
		defaultLabel: 'tan',
		priority: 'P1',
	},
	// M2 (S11:SHP-002): drawn by the compositions (inline SVG); exported natively through the layer bake.
	shape: {
		kind: 'shape',
		trackKind: 'video',
		source: 'inline',
		bounded: 'no',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: false,
		engines: { preview: 'remotion', export: 'remotion' },
		badge: 'R',
		m1: true,
		// The graphics label (S05:DT-021 Remotion graphics), like composition clips.
		defaultLabel: 'magenta',
		priority: 'P0',
	},
	// edit-structure: the sound of a synthetic source (Bars and Tone, Universal Counting Leader), generated.
	'synthetic-audio': {
		kind: 'synthetic-audio',
		trackKind: 'audio',
		source: 'synthetic',
		bounded: 'no',
		visual: false,
		audio: true,
		hasTransform: false,
		hasOpacity: false,
		supportsEffects: true,
		supportsSpeed: false,
		engines: { preview: 'native', export: 'native' },
		badge: null,
		m1: true,
		defaultLabel: 'caribbean',
		priority: 'P1',
	},
	// three-d: a camera / a light draws nothing itself; it changes how the sequence's 3D layers are drawn (by the
	// compositions' 3D renderer: Remotion on export, the planner routes every 3D run there).
	camera: {
		kind: 'camera',
		trackKind: 'video',
		source: 'inline',
		bounded: 'no',
		visual: false,
		audio: false,
		hasTransform: false,
		hasOpacity: false,
		supportsEffects: false,
		supportsSpeed: false,
		engines: { preview: 'remotion', export: 'remotion' },
		badge: null,
		m1: true,
		// After Effects labels cameras and lights pink.
		defaultLabel: 'rose',
		priority: 'P1',
	},
	light: {
		kind: 'light',
		trackKind: 'video',
		source: 'inline',
		bounded: 'no',
		visual: false,
		audio: false,
		hasTransform: false,
		hasOpacity: false,
		supportsEffects: false,
		supportsSpeed: false,
		engines: { preview: 'remotion', export: 'remotion' },
		badge: null,
		m1: true,
		defaultLabel: 'rose',
		priority: 'P1',
	},
	model: {
		kind: 'model',
		trackKind: 'video',
		source: 'media',
		bounded: 'no',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: false,
		supportsSpeed: false,
		engines: { preview: 'remotion', export: 'remotion' },
		badge: null,
		m1: true,
		defaultLabel: 'rose',
		priority: 'P1',
	},
};

export function kindCapabilities(kind: string): KindCapabilities | null {
	return isKnownClipKind(kind) ? KIND_CAPABILITIES[kind] : null;
}

export type ClipEngines = Pick<KindCapabilities, 'badge'> & KindCapabilities['engines'];

/**
 * Engines of one clip (S11:ATP-002, ARCHITECTURE §20.1): the kind's defaults, except motion-graphic clips whose
 * template is drawn by anime.js (`template.renderer: 'anime'`), which are Remotion-rendered (badge R).
 * Null for unknown kinds.
 */
export function clipEngines(clip: { kind: string; template?: { renderer?: string } }): ClipEngines | null {
	const caps = kindCapabilities(clip.kind);
	if (!caps) return null;
	if (clip.kind === 'motion-graphic' && clip.template?.renderer === 'anime')
		return { preview: 'remotion', export: 'remotion', badge: 'R' };
	return { ...caps.engines, badge: caps.badge };
}

/** Clip kinds that live on audio tracks (audio, nest-audio, synthetic-audio). */
export function isAudioKind(kind: string): boolean {
	return kindCapabilities(kind)?.trackKind === 'audio';
}

/** Track kind a clip kind belongs on (S01:TRK-003). Unknown kinds return null (any track). */
export function trackKindFor(kind: string): TrackKind | null {
	return kindCapabilities(kind)?.trackKind ?? null;
}

export function hasTransform(clip: Clip): clip is Extract<Clip, { transform: unknown }> & Clip {
	return kindCapabilities(clip.kind)?.hasTransform ?? false;
}

/**
 * Content length (flicks) that bounds a clip's content time (S01:CLP-005), or null when unknown/unbounded:
 * the probed media duration for media clips, the composition duration for composition clips (S08:MGC-004), the
 * nested sequence's duration for nest clips (KND-011: its In/Out are ignored; needs `doc.sequences`).
 */
export function contentDurationFlicks(
	doc:
		| {
				media: Record<string, MediaAsset | undefined>;
				sequences?: Record<string, NestedSequenceLike | undefined>;
		  }
		| {
				media: Readonly<Record<string, MediaAsset>>;
				sequences?: Readonly<Record<string, NestedSequenceLike>>;
		  },
	clip:
		| Clip
		| { kind: string; mediaId?: string; sequenceId?: string; composition?: { id: string; mediaId?: string } },
): number | null {
	const media = doc.media as Record<string, MediaAsset | undefined>;
	const c = clip as {
		kind: string;
		mediaId?: string;
		sequenceId?: string;
		composition?: { id: string; mediaId?: string };
	};
	if (c.kind === 'composition') {
		const asset = c.composition?.mediaId ? media[c.composition.mediaId] : undefined;
		const info = asset?.mgBundle?.compositions.find((x) => x.id === c.composition!.id);
		return info ? Math.round((info.durationInFrames * FLICKS_PER_SECOND) / info.fps) : null;
	}
	if ((c.kind === 'nest-video' || c.kind === 'nest-audio') && c.sequenceId) {
		const seq = (doc.sequences as Record<string, NestedSequenceLike | undefined> | undefined)?.[c.sequenceId];
		if (!seq) return null;
		let end = 0;
		for (const x of Object.values(seq.clips)) end = Math.max(end, x.start + x.duration);
		const r = seq.settings.frameRate;
		return Math.round((end * FLICKS_PER_SECOND * r.den) / r.num);
	}
	if (!c.mediaId) return null;
	return media[c.mediaId]?.probe.durationFlicks ?? null;
}

/** What `contentDurationFlicks` reads of a nested sequence. */
type NestedSequenceLike = {
	settings: { frameRate: { num: number; den: number } };
	clips: Record<string, { start: number; duration: number }>;
};

/** Content-time bounded clips (S01:CLP-005). */
export function isBoundedContent(clip: Clip): boolean {
	const caps = kindCapabilities(clip.kind);
	if (!caps) return false;
	if (caps.bounded === 'loop-dependent') return !(clip as { loop?: boolean }).loop;
	return caps.bounded === 'yes';
}

/** Default label for a new project item or clip (S05:DT-021 mapping, stored in the document). */
export function defaultLabelForMedia(asset: Pick<MediaAsset, 'kind' | 'probe'>): LabelColor {
	switch (asset.kind) {
		case 'video':
			return asset.probe.streams.some((s) => s.type === 'audio') ? 'violet' : 'iris';
		case 'audio':
			return 'caribbean';
		case 'image':
		case 'animated-image':
			return 'lavender';
		default:
			return 'tan';
	}
}

/**
 * Label for a clip placed from a media item (S05:DT-021, R-PUI §3.4). Video halves use the item label
 * (Violet for video + audio media). Audio clips always get the Audio label (Caribbean) by default, also
 * when they are the audio half of a linked A/V clip, as in Premiere. A label the user chose for the item
 * (anything other than its media default) wins for every half.
 */
export function defaultLabelForPlacedClip(
	kind: Clip['kind'],
	asset: Pick<MediaAsset, 'kind' | 'probe'>,
	itemLabel?: LabelColor,
): LabelColor {
	const mediaDefault = defaultLabelForMedia(asset);
	if (itemLabel !== undefined && itemLabel !== mediaDefault) return itemLabel;
	if (kind === 'audio') return KIND_CAPABILITIES.audio.defaultLabel;
	return mediaDefault;
}
