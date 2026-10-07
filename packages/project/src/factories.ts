// Factories for new documents and entities. Pure; ids come from an injected IdSource.
import type { IdSource } from './ids.ts';
import { DEFAULT_PRESET_ID, defaultPresetRegistry, type PresetRegistry } from './presets.ts';
import type { Animatable, RGBA, Vec2 } from './schema/common.ts';
import type { DefaultScaling, ProjectDocument, ProjectSettings, SequenceItem } from './schema/document.ts';
import { CURRENT_SCHEMA_VERSION } from './schema/document.ts';
import type { FontRef } from './schema/media.ts';
import type {
	LegacyShapeData,
	LegacyShapeType,
	Sequence,
	SequenceSettings,
	ShapeData,
	ShapeStroke,
	Speed,
	TextStyle,
	Track,
	TrackKind,
	Transform,
} from './schema/sequence.ts';

export function anim<T>(value: T): Animatable<T> {
	return { value, keyframes: [] };
}

export function defaultSpeed(): Speed {
	return { rate: 1, reverse: false, maintainPitch: true };
}

export function defaultProjectSettings(): ProjectSettings {
	return {
		defaultSequencePreset: DEFAULT_PRESET_ID,
		mediaPolicy: { copyOnImport: false },
		proxyPolicy: {
			mode: 'auto',
			preset: 'h264-720p',
			autoWhen: { minHeight: 2160, codecs: ['prores', 'dnxhd', 'hevc'], bitDepthAbove: 8 },
		},
		defaultStillDurationFrames: 150,
		defaultTransitionFrames: 30,
		defaultScaling: 'fit-if-larger',
	};
}

export function createTrack(ids: IdSource, kind: TrackKind, name: string | null = null): Track {
	const base = { id: ids.next('trk'), kind, name, locked: false, syncLock: true };
	if (kind === 'video') return { ...base, output: true };
	if (kind === 'audio') {
		return {
			...base,
			mute: false,
			solo: false,
			volumeDb: anim(0),
			pan: anim(0),
			channelFormat: 'stereo',
			effects: [],
		};
	}
	return { ...base, captionFormat: 'open', visible: true };
}

export function createSequence(
	ids: IdSource,
	settings: SequenceSettings,
	tracks: { video: number; audio: number; caption?: number } = { video: 3, audio: 3 },
	id?: string,
): Sequence {
	return {
		id: id ?? ids.next('seq'),
		settings: JSON.parse(JSON.stringify(settings)) as SequenceSettings,
		videoTracks: Array.from({ length: tracks.video }, () => createTrack(ids, 'video')),
		audioTracks: Array.from({ length: tracks.audio }, () => createTrack(ids, 'audio')),
		captionTracks: Array.from({ length: tracks.caption ?? 0 }, () => createTrack(ids, 'caption')),
		master: { volumeDb: anim(0), effects: [] },
		clips: {},
		transitions: {},
		links: {},
		groups: {},
		markers: [],
		inPoint: null,
		outPoint: null,
		workArea: null,
	};
}

export type CreateProjectOptions = {
	ids: IdSource;
	name: string;
	projectId?: string;
	preset?: string;
	presets?: PresetRegistry;
	sequenceName?: string;
};

/** A new project: one sequence (with its project item) from a preset, V1–V3 / A1–A3. */
export function createEmptyProject(opts: CreateProjectOptions): ProjectDocument {
	const presets = opts.presets ?? defaultPresetRegistry;
	const presetId = opts.preset ?? DEFAULT_PRESET_ID;
	const preset = presets.get(presetId);
	if (!preset) throw new Error(`Unknown sequence preset: ${presetId}`);
	const seq = createSequence(opts.ids, preset.settings, preset.tracks);
	const item: SequenceItem = {
		id: opts.ids.next('itm'),
		kind: 'sequence',
		name: opts.sequenceName ?? 'Sequence 01',
		sequenceId: seq.id,
		label: 'forest',
	};
	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		projectId: opts.projectId ?? opts.ids.next('prj'),
		name: opts.name,
		settings: { ...defaultProjectSettings(), defaultSequencePreset: presetId },
		rootItems: [item.id],
		items: { [item.id]: item },
		media: {},
		synthetics: {},
		transcripts: {},
		fonts: {},
		sequences: { [seq.id]: seq },
		extensions: {},
	};
}

export type Box = { width: number; height: number };

/** Scale (percent) for a placement scaling mode (S01:FX-004, S03:DM-004). */
export function scaleForMode(box: Box, frame: Box, mode: DefaultScaling | 'none' | 'fit' | 'fill'): number {
	if (box.width <= 0 || box.height <= 0) return 100;
	const fit = Math.min(frame.width / box.width, frame.height / box.height);
	const fill = Math.max(frame.width / box.width, frame.height / box.height);
	switch (mode) {
		case 'none':
			return 100;
		case 'fit':
			return fit * 100;
		case 'fill':
			return fill * 100;
		default:
			return fit < 1 ? fit * 100 : 100;
	}
}

/** Default Motion: anchor at box center, position at frame center, scale per mode. */
export function defaultTransform(box: Box, frame: Box, scaling: DefaultScaling = 'none'): Transform {
	const s = scaleForMode(box, frame, scaling);
	return {
		position: anim<Vec2>([frame.width / 2, frame.height / 2]),
		anchor: anim<Vec2>([box.width / 2, box.height / 2]),
		scale: anim(s),
		scaleWidth: anim(s),
		uniformScale: true,
		rotation: anim(0),
		flipH: false,
		flipV: false,
	};
}

export const WHITE: RGBA = [1, 1, 1, 1];
export const DEFAULT_FONT_FAMILY = 'Source Sans 3';

export function createFontRef(ids: IdSource, family = DEFAULT_FONT_FAMILY): FontRef {
	return { id: ids.next('fnt'), family, source: { type: 'bundled' } };
}

export function defaultTextStyle(fontId: string): TextStyle {
	return {
		fontId,
		weight: 400,
		italic: false,
		sizePx: 100,
		lineHeight: 1.2,
		trackingEm: 0,
		align: 'center',
		direction: 'auto',
		fill: [...WHITE],
		strokes: [],
		background: null,
		shadow: null,
		allCaps: false,
	};
}

// ---------------------------------------------------------------- shapes (M2, S11:SHP-001/003)

/** Default shape size in layer pixels (S11:SHP-003). */
export const DEFAULT_SHAPE_SIZE: Vec2 = [400, 400];
/** Default length of a new shape clip (S11:SHP-003). */
export const DEFAULT_SHAPE_SECONDS = 5;

/** A new shape: white fill, no stroke, radius 0 (S11:SHP-003). Values are static Animatables. */
export function defaultShape(
	type: LegacyShapeType,
	opts: {
		size?: Vec2;
		fill?: RGBA | null;
		stroke?: { color: RGBA; width: number; position?: ShapeStroke['position'] } | null;
		cornerRadius?: number;
	} = {},
): LegacyShapeData {
	const fill = opts.fill === undefined ? WHITE : opts.fill;
	const stroke = opts.stroke ?? null;
	return {
		type,
		size: anim<Vec2>([...(opts.size ?? DEFAULT_SHAPE_SIZE)]),
		fill: fill ? anim<RGBA>([...fill]) : null,
		stroke: stroke
			? {
					color: anim<RGBA>([...stroke.color]),
					width: anim(stroke.width),
					position: stroke.position ?? 'center',
				}
			: null,
		cornerRadius: anim(opts.cornerRadius ?? 0),
	};
}

/**
 * Values an Animatable takes: its keyframes once it has any (`evaluate` then ignores the static `value`, which
 * may be stale), otherwise the static value.
 */
const valuesOf = <T>(a: Animatable<T>): T[] =>
	a.keyframes.length > 0 ? a.keyframes.map((k) => k.value) : [a.value];
const maxOf = (a: Animatable<number>): number => Math.max(...valuesOf(a));

/**
 * Intrinsic (layer) box of a shape (S11:SHP-001): the largest size it takes (every keyframe, or the static value
 * when there are none) plus the part of the stroke drawn outside the geometry — the whole width for `outside`,
 * half for `center`. The geometry is centred in the box.
 */
export function shapeIntrinsicBox(shape: ShapeData, frame?: Box): Box {
	// wp shapes: a vector shape's layer is the frame (After Effects shape layers are comp-sized); its contents are
	// drawn around the box centre, so the box never depends on the contents.
	if (shape.type === 'vector')
		return frame ? { width: frame.width, height: frame.height } : { width: 1920, height: 1080 };
	const sizes = valuesOf(shape.size);
	const w = Math.max(...sizes.map((v) => v[0]));
	const h = Math.max(...sizes.map((v) => v[1]));
	const s = shape.stroke;
	const outside = !s
		? 0
		: s.position === 'outside'
			? maxOf(s.width)
			: s.position === 'center'
				? maxOf(s.width) / 2
				: 0;
	const pad = Math.max(0, outside) * 2;
	return { width: Math.max(0, w) + pad, height: Math.max(0, h) + pad };
}
