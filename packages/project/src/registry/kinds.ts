// Clip kind capabilities (S01 §10.1 kind table, S02:TL-022, S03:KND-001 idea, ARCHITECTURE §10.4).
import type { LabelColor } from '../schema/common.ts';
import type { MediaAsset } from '../schema/media.ts';
import { type Clip, isKnownClipKind, type KnownClipKind, type TrackKind } from '../schema/sequence.ts';

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

const cap = (c: KindCapabilities) => c;

export const KIND_CAPABILITIES: Record<KnownClipKind, KindCapabilities> = {
	video: cap({
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
	}),
	audio: cap({
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
	}),
	still: cap({
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
	}),
	'animated-image': cap({
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
	}),
	text: cap({
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
	}),
	solid: cap({
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
	}),
	captions: cap({
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
	}),
	'motion-graphic': cap({
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
	}),
	composition: cap({
		kind: 'composition',
		trackKind: 'video',
		source: 'composition',
		bounded: 'no',
		visual: true,
		audio: false,
		hasTransform: true,
		hasOpacity: true,
		supportsEffects: true,
		supportsSpeed: false,
		engines: { preview: 'remotion', export: 'remotion' },
		badge: 'R',
		m1: false,
		defaultLabel: 'magenta',
		priority: 'P1',
	}),
	'nest-video': cap({
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
		engines: { preview: 'remotion', export: 'remotion' },
		badge: null,
		m1: false,
		defaultLabel: 'forest',
		priority: 'P1',
	}),
	'nest-audio': cap({
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
		m1: false,
		defaultLabel: 'forest',
		priority: 'P1',
	}),
	adjustment: cap({
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
		engines: { preview: 'remotion', export: 'remotion' },
		badge: null,
		m1: false,
		defaultLabel: 'tan',
		priority: 'P1',
	}),
};

export function kindCapabilities(kind: string): KindCapabilities | null {
	return isKnownClipKind(kind) ? KIND_CAPABILITIES[kind] : null;
}

/** Track kind a clip kind belongs on (S01:TRK-003). Unknown kinds return null (any track). */
export function trackKindFor(kind: string): TrackKind | null {
	return kindCapabilities(kind)?.trackKind ?? null;
}

export function isVisualKind(kind: string): boolean {
	return kindCapabilities(kind)?.visual ?? false;
}

export function hasTransform(clip: Clip): clip is Extract<Clip, { transform: unknown }> & Clip {
	return kindCapabilities(clip.kind)?.hasTransform ?? false;
}

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
