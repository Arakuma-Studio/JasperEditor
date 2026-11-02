// Render snapshot (S01:RND-001…005, ARCHITECTURE §5.5): the self-contained JSON value handed to the
// Remotion composition, the native planner and the Program overlay. Keyframes stay unevaluated.

import { buildAudioMix, playedTracks, type RenderAudioMix } from '../audio/plan.ts';
import {
	type CaptionPage,
	captionPages,
	type ResolvedCaptionStyle,
	resolveCaptionStyle,
} from '../captions/model.ts';
import { type SequenceColorInfo, sequenceColorInfo } from '../color/model.ts';
import {
	graphicsColorEffect,
	graphicsColorIn,
	nestColorEffect,
	sourceColorEffect,
} from '../color/snapshot.ts';
import { compositionOfClip, mergeProps } from '../composition/props.ts';
import { contentTimeAt } from '../derive/index.ts';
import { bindExpressions, type ExpressionWorldData, expressionWorldData } from '../expressions.ts';
import { applyGraphics } from '../gaps/graphics.ts';
import {
	interpretedFrameRate,
	type MediaTimeMap,
	mediaDisplaySize,
	mediaTimeMap,
	type PixelInterpretation,
	pixelInterpretation,
	pixelVariantKey,
} from '../interpret/model.ts';
import { evaluate } from '../keyframes.ts';
import { trackMatteTracksOf } from '../masks/track-matte.ts';
import { multicamView } from '../multicam/model.ts';
import { clipParamMediaIds, effectMediaRefs } from '../param-media.ts';
import { defaultEffectRegistry } from '../registry/effects.ts';
import { clipEngines, type EngineId, isBoundedContent, kindCapabilities } from '../registry/kinds.ts';
import { expandLumetriSpatial } from '../registry/lumetri-spatial.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import { type RenderRotoMatte, rotoIsStale, rotoStorePath } from '../roto/index.ts';
import type { Animatable, Keyframe, RGBA } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Mask } from '../schema/mask.ts';
import type { FontRef, MediaAsset } from '../schema/media.ts';
import {
	type BlendMode,
	type Clip,
	type ClipRoto,
	type ClipTracker,
	type EffectInstance,
	isKnownClipKind,
	type MgRenderer,
	type Sequence,
	type ShapeData,
	type Speed,
	type TextBox,
	type TextContent,
	type TimeInterpolation,
	type TimeRemap,
	type Transform,
} from '../schema/sequence.ts';
import type { TextAnimatorGroup, TextMoreOptions, TextPathOptions } from '../schema/text-animators.ts';
import type { CameraData, Layer3D, LightData, Renderer3D } from '../schema/three-d.ts';
import { conformSequenceRate, MAX_NEST_DEPTH, nestContentKey } from '../structure/nest.ts';
import {
	type CountingLeaderStyle,
	type SyntheticSound,
	syntheticPicture,
	syntheticSound,
} from '../structure/synthetic.ts';
import { type ResolvedTextAnimator, resolveTextAnimationWindows } from '../text-animations.ts';
import { flicksPerFrame, type Rational, rationalEquals } from '../time.ts';
import { activeRemap, needsRetime, timeInterpolationOf } from '../time-remap/model.ts';
import { clipLook, type GlobalLight, globalLightOf } from '../title-looks/model.ts';
import { transitionSideTrack, transitionTrackerOf } from '../tracking/transition.ts';
import {
	type AudioClipTransitionRender,
	audioFadeGain,
	isLayer3D,
	type RenderAudioFade,
	type RenderFade,
	type RenderMatte,
	type RenderTransition,
	resolveAudioTransitions,
	resolveVideoTransitions,
} from '../transitions.ts';
import { clipPictureTime } from './scene.ts';

export type MediaHandle = {
	url: string;
	proxyUrl: string | null;
	kind: MediaAsset['kind'];
	width: number | null;
	height: number | null;
	durationFlicks: number | null;
	hasAudio: boolean;
	rotation: 0 | 90 | 180 | 270;
	/**
	 * The picture has an alpha channel that compositing must keep (ProRes 4444, VP8/VP9 WebM with alpha,
	 * QuickTime Animation). Absent = opaque.
	 */
	alpha?: boolean;
	/**
	 * `false` when a browser (WebCodecs / `<video>`) cannot decode the original, e.g. ProRes: previews need
	 * `proxyUrl`, engine renders decode the original natively. Absent = decodable or unknown.
	 */
	browserDecodable?: boolean;
	/**
	 * pp-wma-preview: the browser cannot decode the media's audio (`needsPlaybackAudio`: WMA, AC-3, ALAC…). Previews
	 * play the engine's playback audio instead — container stream index → WAV URL — and are silent while it is `null`
	 * (being made, failed). Absent = the original's audio plays. Exports never use it: they decode the original.
	 */
	playbackAudio?: Record<string, string> | null;
	/**
	 * Interpret Footage ▸ field order / alpha: what decoders apply to the pixels (deinterlace, unpremultiply, drop or
	 * invert the alpha). The browser cannot, so previews and Remotion renders show the variant picture the engine made
	 * with exactly these filters (`pixelVariant`: proxy / display derivative); the native export applies them itself.
	 */
	pixel?: PixelInterpretation;
	/** `pixelVariantKey(pixel)`: the derivative variant of the interpreted picture ('' or absent = none). */
	pixelVariant?: string;
	/** Interpret Footage ▸ assumed frame rate / loop: interpreted media time → file time (absent = linear). */
	timeMap?: MediaTimeMap;
	/** The interpreted frame rate (absent = the file's). */
	frameRate?: Rational;
	/** A vector still (SVG / PDF): drawn as vector at the scale it is shown at, by the composition. */
	vector?: { format: 'svg' | 'pdf'; page: number; width: number; height: number };
	/** A Lottie animation drawn by the Lottie player (from `loaderUrl`: its JSON, images embedded). */
	lottie?: { fps: number; inFrame: number; outFrame: number; width: number; height: number };
	/**
	 * Lottie / vector media: the URL of the document the composition draws (the engine's `/media/<key>/lottie.json`
	 * or `/media/<key>/vector`, signed for renders). Set by the consumer that resolves URLs.
	 */
	loaderUrl?: string;
};

/**
 * imports: adds what the asset's interpretation and kind say to a media handle a consumer resolved (display size with
 * the conformed pixel aspect ratio, pixel / time interpretation, vector and Lottie descriptors). Idempotent.
 */
export function interpretMediaHandle(asset: MediaAsset, handle: MediaHandle | null): MediaHandle | null {
	if (!handle) return null;
	const out: MediaHandle = { ...handle };
	const size = mediaDisplaySize(asset);
	if (size) {
		out.width = size.width;
		out.height = size.height;
	}
	const pixel = pixelInterpretation(asset);
	if (pixel) {
		out.pixel = pixel;
		out.pixelVariant = pixelVariantKey(pixel);
		// Browsers show the engine's interpreted picture (display / proxy / master), never the original.
		out.browserDecodable = false;
		// The interpreted alpha decides whether compositing keeps it.
		if (pixel.alpha?.mode === 'ignore' && !pixel.alpha.invert) delete out.alpha;
		else if (pixel.alpha) out.alpha = true;
	}
	const tm = mediaTimeMap(asset);
	if (tm) out.timeMap = tm;
	const fr = interpretedFrameRate(asset);
	if (fr && asset.interpretation?.frameRate) out.frameRate = fr;
	if (asset.vector)
		out.vector = {
			format: asset.vector.format,
			page: asset.vector.page ?? 1,
			width: asset.vector.width,
			height: asset.vector.height,
		};
	if (asset.lottie)
		out.lottie = {
			fps: asset.lottie.fps,
			inFrame: asset.lottie.inFrame,
			outFrame: asset.lottie.outFrame,
			width: asset.lottie.width,
			height: asset.lottie.height,
		};
	if (asset.vector || asset.lottie) delete out.browserDecodable;
	return out;
}

/** The `alpha` / `browserDecodable` hints of a MediaHandle, from the asset's probe (S04:PB-004). */
export function mediaDecodeHints(
	probe: Pick<MediaAsset['probe'], 'hasAlpha' | 'streams'>,
): Pick<MediaHandle, 'alpha' | 'browserDecodable'> {
	const vs = probe.streams.find((s) => s.type === 'video');
	return {
		...(probe.hasAlpha ? { alpha: true } : {}),
		...(vs?.type === 'video' && vs.browserDecodable === false ? { browserDecodable: false } : {}),
	};
}

/**
 * Known presets supply missing animator params; window lengths are compressed to the clip duration.
 * Absent sides have no animator.
 */
export type RenderTextAnimation = { in?: ResolvedTextAnimator; out?: ResolvedTextAnimator };

export type RenderVisualSource =
	| { mediaId: string }
	| {
			text: TextContent;
			box: TextBox;
			animation?: RenderTextAnimation;
			/**
			 * AE-style animators, Path / More Options, per-character 3D and Source Text
			 * keys, unevaluated (the layer evaluates them at the content time, like shapes). Absent = none.
			 */
			animators?: TextAnimatorGroup[];
			pathOptions?: TextPathOptions;
			moreOptions?: TextMoreOptions;
			perCharacter3d?: boolean;
			sourceTextKeyframes?: Keyframe<TextContent>[];
			/** spec 13 SH-004: the box is an estimate (not measured yet); renderers and bakes leave room around it. */
			layoutPending?: true;
	  }
	| { color: RGBA }
	| {
			mg: {
				template: { id: string; version: number };
				params: Record<string, unknown>;
				canvas: { width: number; height: number };
				/** Absent means fframes. */
				renderer?: MgRenderer;
				/**
				 * Keyframes of anime template params by name (content time,
				 * unevaluated like shapes, RND-001); the layer evaluates them with the shared evaluator. Anime only.
				 */
				paramKeyframes?: Record<string, Keyframe<unknown>[]>;
				/**
				 * social-comment §7.8: the font faces and emoji the anime template draws (its `requiredAssets` over the
				 * params and every param keyframe). The faces are in `RenderSnapshot.fonts` (fontId `template:<family>`)
				 * and the emoji URLs in `RenderSnapshot.emoji` when available. Absent = the template declares none.
				 */
				assets?: RenderTemplateAssets;
			};
	  }
	/** Shape Animatables remain unevaluated until the layer renders each frame. */
	| { shape: ShapeData }
	/**
	 * A composition of an mg-bundle asset. `media[mediaId]` resolves the bundle (`url` = its serve
	 * URL). The pre-rendered alpha master is found by the consumers (engine: cache; preview: MG runtime).
	 */
	| {
			composition: RenderCompositionSource;
	  }
	/**
	 * edit-structure: a synthetic generator's picture (`solid` clips of Bars and Tone / a Universal Counting Leader),
	 * drawn from `generators.ts` at the clip's content time (the leader counts down; the bars are constant).
	 */
	| { generator: { kind: 'bars' } | { kind: 'counting-leader'; style: CountingLeaderStyle } }
	/** edit-structure (KND-012): an adjustment layer — its effects run on the composite of the tracks below. */
	| { adjustment: true }
	/** edit-structure (KND-011): a nested sequence, drawn recursively. */
	| { nest: RenderNestSource }
	/**
	 * A caption clip resolved for drawing — its style (track style ← clip overrides, defaults applied)
	 * and its pages in sequence frames with per-word frames (active-word highlight). The same pages feed sidecar and
	 * embedded caption export (`captionCuesForTrack`).
	 */
	| { captions: RenderCaptionSource }
	| { unsupported: string };

export type RenderCaptionSource = {
	style: ResolvedCaptionStyle;
	/** Pages with frames relative to the clip's first frame (frame 0 = `start`), so moving a caption keeps it. */
	pages: CaptionPage[];
	/** Caption track standard (CEA-608 tracks are drawn in a monospace caption face when the style has no font). */
	standard?: string;
};

/**
 * edit-structure: what a `nest-video` clip draws. `snapshot` is the nested sequence's own render snapshot, conformed
 * to the parent's frame rate (its frames are parent-rate frames; content times are unchanged), over the range of
 * nested frames the clip shows (`range`), with a transparent background. Frame `n` of it is shown where the clip's
 * picture time (`clipPictureTime`) is `n · flicksPerFrame(parent rate)`. `contentKey` = `nestContentKey` of the nested
 * sequence (pure function of its content; render caches key on it).
 */
export type RenderNestSource = {
	sequenceId: string;
	snapshot: RenderSnapshot;
	/** The nested sequence's own rate (the snapshot is conformed to the parent's). */
	nestedFps: Rational;
	contentKey: string;
};

export type RenderCompositionSource = {
	mediaId: string;
	compositionId: string;
	/** Effective props: the composition's defaultProps merged with the clip's overrides (MGC-003). */
	props: Record<string, unknown>;
	/** Render size of the composition (the clip's canvas). */
	canvas: { width: number; height: number };
	/**
	 * The bundle: engine media key (`/mg/bundles/<key>/` serves it; null without an engine-store locator), its
	 * content hash and Remotion version. Null when the asset is missing or not an mg-bundle.
	 */
	bundle?: { key: string | null; hash: string; remotionVersion: string } | null;
	/** The composition's own metadata; null when the bundle no longer has this composition (MGC-014). */
	info?: { width: number; height: number; fps: number; durationInFrames: number } | null;
	/**
	 * Cached pre-renders of this clip (MGC-008), filled by consumers that know them (the engine for Remotion
	 * renders: signed master URL; `resolveComposition`). `startFrame` = sequence frame shown by the master's
	 * frame 0 (default: the clip's first drawn frame, `start − headHandle`).
	 */
	prerender?: { masterUrl: string | null; previewUrl: string | null; startFrame?: number };
};

export type RenderVisualClip = {
	clipId: string;
	kind: Clip['kind'];
	trackId: string;
	name: string;
	/** Absolute sequence frame (the composition renders frame `range.start + f`). */
	start: number;
	duration: number;
	/** Flicks. */
	sourceIn: number;
	speed: Speed;
	source: RenderVisualSource;
	/** Null for kinds without Motion (adjustment). */
	transform: Transform | null;
	opacity: Animatable<number>;
	blendMode: BlendMode;
	effects: EffectInstance[];
	/**
	 * spec 19 TL-017: the sequence's light with its keys in sequence time, on clips whose look follows it (the frame's
	 * flicks convert a clip's content time back to sequence time).
	 */
	sequenceLight?: GlobalLight & { flicksPerFrame: number };
	intrinsicBox: { width: number; height: number };
	/** Layer Opacity masks; effect masks travel in effects[].masks. */
	masks?: Mask[];
	engine: EngineId;
	loop?: boolean;
	/** Bounded media content (needs trimBefore/playbackRate handling). */
	bounded: boolean;
	/**
	 * Transitions (S01 §13): frames of content drawn before `start` and after `start + duration` (handles),
	 * and the opacity ramps that multiply `opacity` (see `fadeFactor`). Absent without transitions.
	 */
	headHandle?: number;
	tailHandle?: number;
	fades?: RenderFade[];
	/**
	 * edit-structure (freeze-frame transition handles): the first `freezeHead` frames of the head handle / the last
	 * `freezeTail` frames of the tail handle are beyond the media and repeat its first / last available frame.
	 */
	freezeHead?: number;
	freezeTail?: number;
	/** edit-structure (Frame Hold): the clip shows the content at `flicks` (see `clipPictureTime`). */
	frameHold?: { flicks: number; holdFilters?: boolean };
	/**
	 * A pre-rendered picture of the whole placed layer (sequence space: Motion,
	 * effects, grade, opacity and fades baked, straight alpha) that the composition plays instead of drawing the
	 * layer — the colour-graded master of a DOM layer on the Remotion path. `startFrame` = sequence frame shown by
	 * its frame 0; `rect` = the region of the frame it covers (absent = the whole frame). Set by the engine only.
	 * `url` is a straight-alpha PNG frame sequence of `frames` frames: frame `n` is `url` + `&n=<n>` (`?n=` when the
	 * URL has no query).
	 */
	baked?: {
		url: string;
		startFrame: number;
		frames: number;
		rect?: { x: number; y: number; w: number; h: number };
	};
	/**
	 * Wave expressions (engine layer bakes): a translation added to the post-expression Position, set when a bake
	 * shifts the layer into its cropped render rect (the stored keys are shifted directly; an expression's result is
	 * shifted by the binding). Absent = none.
	 */
	expressionPositionShift?: [number, number];
	/**
	 * fx framework (clip context, additive): what effects may show about the clip's media — the project item name
	 * (Premiere "Project Item Name"), the file name and the media's embedded start timecode. Set for media clips
	 * that have effects; absent otherwise.
	 */
	sourceInfo?: { itemName: string; fileName: string; startTimecode: string | null };
	/**
	 * The clip's enabled Time Remapping (content time → media time, see time-remap/model.ts). The
	 * time-remap functions (`clipMediaTimeAt`…) read it directly from the render clip.
	 */
	timeRemap?: TimeRemap;
	/**
	 * Set for video clips whose picture is made frame by frame from media times — reverse, a time
	 * remap, Frame Blending / Optical Flow where frames fall between source frames, and variable-frame-rate media
	 * (timestamp-exact frames). Consumers draw them with the retime pipeline (preview decoder / native retime stage).
	 */
	retime?: RenderRetime;
	/**
	 * parity (roto): the computed mattes of the clip's roto objects, by roto id (objects without a result are
	 * absent). Effects with roto-object params sample them at the layer's media frame.
	 */
	rotos?: Record<string, RenderRotoMatte>;
	/**
	 * imports (Interpret Footage): how the clip's media time maps to its file (assumed frame rate, loop). Every decoder
	 * reads file time `fileTimeOf(mediaTime, t)` for the clip's media time `t`. Absent = file time = media time.
	 */
	mediaTime?: MediaTimeMap;
	/**
	 * three-d: the clip is a 3D layer (its 3D Layer switch is on): its 3D transform and material, unevaluated. The
	 * composition draws it as a plane of the sequence's 3D scene (`scene3d`); absent = a 2D layer.
	 */
	threeD?: Layer3D;
};

/** three-d: a camera or light of the snapshot (it draws nothing; it changes how the 3D layers are drawn). */
export type RenderRigClip = {
	clipId: string;
	name: string;
	/** Index of its video track, V1 = 0 (the topmost camera at a frame is the active one). */
	trackIndex: number;
	start: number;
	duration: number;
	sourceIn: number;
	speed: Speed;
	frameHold?: { flicks: number; holdFilters?: boolean };
};
export type RenderCameraClip = RenderRigClip & { camera: CameraData };
export type RenderLightClip = RenderRigClip & { light: LightData };

/**
 * three-d: the sequence's 3D scene setup — the renderer and every camera and light that is on during the range
 * (track order; their properties unevaluated). Present when the sequence has a 3D layer, a camera or a light.
 */
export type RenderScene3D = {
	renderer: Renderer3D;
	/** Draft 3D (previews only: no lights, shadows or depth of field). */
	draft?: boolean;
	shadowMapSize?: number;
	supersampling?: number;
	cameras: RenderCameraClip[];
	lights: RenderLightClip[];
};

export type RenderRetime = {
	interpolation: TimeInterpolation;
	/** Nominal frame rate of the media's video stream. */
	mediaRate: Rational;
	/** Variable-frame-rate media: frames are placed by their own timestamps. */
	vfr: boolean;
};

export type RenderAudioClip = {
	/** imports (Interpret Footage): media time → file time (assumed frame rate, loop). Absent = linear. */
	mediaTime?: MediaTimeMap;
	clipId: string;
	trackId: string;
	start: number;
	duration: number;
	sourceIn: number;
	speed: Speed;
	mediaId: string;
	/** gaps (Modify ▸ Audio Channels): `mute` = clip channels that play silence. */
	channels: { streamIndex: number; map: number[]; mute?: number[] };
	gainDb: number;
	volumeDb: Animatable<number>;
	pan: Animatable<number>;
	effects: EffectInstance[];
	/** Track fader and pan (sequence time in flicks). */
	track: { volumeDb: Animatable<number>; pan: Animatable<number> };
	/** audio-mix: channel count of the clip's audio stream (probe), when known. */
	streamChannels?: number;
	/**
	 * Audio transitions (S01:TRN-004, S10:TUI-052): frames of content played before `start` and after
	 * `start + duration` (the handles of a crossfade), and the gain ramps over the clip's edges and handles
	 * (see `audioFadeGain`, evaluated at sequence frames). Absent without audio transitions.
	 */
	headHandle?: number;
	tailHandle?: number;
	fades?: RenderAudioFade[];
	/**
	 * edit-structure: the clip plays a synthetic sound (Bars and Tone's tone, the leader's blips) instead of media;
	 * `mediaId` is then `syn:<syntheticId>` (no media handle). Sample k at content time t: `syntheticSamples`.
	 */
	generator?: SyntheticSound;
	/**
	 * edit-structure: extra gain (dB) of a clip flattened out of a nested sequence (`nest-audio`): the nested track
	 * fader and master, the nested fades and the nest clip's own gain, volume and fades, per sequence frame. Runs cover
	 * the clip's frames; outside them the nearest run applies.
	 */
	nestGain?: { start: number; end: number; db: number }[];
};

/** social-comment §7.8: what an anime template draws besides its params (see `SnapshotOptions.templateAssets`). */
export type RenderTemplateAssets = {
	fonts: { family: string; weight: number; style: 'normal' | 'italic' }[];
	/** Emoji graphemes per image pack (one entry per pack). */
	emoji: { pack: string; graphemes: string[] }[];
	/** Remote images of the remote-asset manifest by id (absent = none). */
	images?: string[];
};

/** A file of a template face: one URL, or one subset file per unicode range. */
export type TemplateFaceFile = { url: string; unicodeRange?: string };

/** Font id of a template-declared face in `RenderSnapshot.fonts` (no document font has this form). */
export function templateFontId(family: string): string {
	return `template:${family}`;
}

/** Key of an emoji image in `RenderSnapshot.emoji` / `AnimeTemplateProps.emojiUrls`. */
export function emojiTableKey(pack: string, grapheme: string): string {
	return `${pack}:${grapheme}`;
}

export type RenderSnapshot = {
	version: 1;
	sequenceId: string;
	/** `sampleRate`: the sequence audio rate (audio-mix: 44.1 / 48 / 96 kHz). */
	settings: {
		width: number;
		height: number;
		fps: Rational;
		backgroundColor: RGBA;
		sampleRate: number;
		/** color-mgmt: the working space and colour settings (absent in snapshots made before colour management). */
		color?: SequenceColorInfo;
	};
	/** Frames; export range or whole sequence. */
	range: { start: number; end: number };
	durationFrames: number;
	/**
	 * V1 (bottom) → top, then the visible caption tracks (C1 → Cn, `caption: true`) above every video
	 * track; output-disabled tracks omitted; clips sorted by start. `mattes` are full-frame
	 * colours drawn under the track's clips (the black of a dip to black). `transitions` (wave-2 transition framework)
	 * are the GPU transition stages drawn over the track's clips (each replaces its A/B clips for its span).
	 */
	videoTracks: {
		trackId: string;
		clips: RenderVisualClip[];
		mattes?: RenderMatte[];
		transitions?: RenderTransition[];
		/** Captions are burned into the picture. */
		caption?: boolean;
	}[];
	/**
	 * Hidden video tracks (output off) that a Track Matte Key reads (Premiere mattes are usually hidden
	 * tracks), V1 → top. Their clips are rendered into the matte only, never into the frame; consumers that draw the
	 * frame ignore this list. Absent = none. A layer bake's document carries the matte tracks of its clip here too.
	 */
	matteTracks?: { trackId: string; clips: RenderVisualClip[]; transitions?: RenderTransition[] }[];
	/**
	 * Clips of the tracks the mix plays (audio-mix: mute/solo are resolved by the mixer — `audioMix` — so a muted
	 * track with a pre-fader send still plays its clips; silent and muted-throughout tracks are omitted).
	 */
	audioClips: RenderAudioClip[];
	/** audio-mix: the mixer topology (strips, routes, sends, automation, solo, loudness). Absent in old snapshots. */
	audioMix?: RenderAudioMix;
	/** null = offline. */
	media: Record<string, MediaHandle | null>;
	/**
	 * `unicodeRange` (social-comment §7.8): the face is split into subset files (latin, latin-ext…); each entry loads
	 * one with its CSS unicode-range, together they are the face.
	 */
	fonts: {
		fontId: string;
		family: string;
		weight: number;
		style: 'normal' | 'italic';
		url: string;
		unicodeRange?: string;
	}[];
	/**
	 * social-comment §7.8: emoji image URLs of the anime templates' required emoji, keyed `emojiTableKey(pack,
	 * grapheme)`; an unavailable image is absent. Absent = no template draws emoji.
	 */
	emoji?: Record<string, string>;
	/** social-comment §7.8: remote image URLs of the anime templates' required images by id (unavailable ones absent). */
	images?: Record<string, string>;
	master: { volumeDb: Animatable<number> };
	/** Clips excluded from rendering (unknown kinds, S01:KND-030). */
	warnings: { clipId: string; code: string; message: string }[];
	/** three-d: cameras, lights and the 3D renderer (absent = no 3D layer, camera or light in the sequence). */
	scene3d?: RenderScene3D;
	/**
	 * Wave expressions: what expressions read besides the snapshot (every sequence, names, layer boxes), present when
	 * the document has active expressions. Consumers bind with `@jasper/expressions` `bindSnapshotExpressions`
	 * (in-process snapshots built from a bound document already carry bound Animatables).
	 */
	expressions?: ExpressionWorldData;
};

export type SnapshotOptions = {
	range?: { start: number; end: number };
	resolveMedia(asset: MediaAsset): MediaHandle | null;
	resolveFont(font: FontRef, weight: number, italic: boolean): string | null;
	/**
	 * parity (roto, additive): URL of a matte store for the headless browser (engine renders sign
	 * `rotoStorePath(key)`); default the unsigned same-origin path.
	 */
	resolveRoto?(key: string): string;
	/**
	 * social-comment §7.8: fonts and emoji of anime templates. `required` gives a clip's template assets
	 * (`@jasper/mg-templates` `templateAssetOptions` binds it to the template registry); `font` the URL of a face, or its
	 * subset files with their unicode ranges (exact family / weight / style, never a fallback; null or empty =
	 * unavailable) and `emoji` the URL of an emoji image of a
	 * pack (null = unavailable). Unavailable assets become snapshot warnings (`TEMPLATE_FONT_UNAVAILABLE`,
	 * `TEMPLATE_EMOJI_UNAVAILABLE`) that export planners turn into blockers. Absent = template assets are not resolved.
	 */
	templateAssets?: {
		required(mg: {
			template: { id: string; version: number };
			params: Record<string, unknown>;
			paramKeyframes?: Record<string, Keyframe<unknown>[]>;
		}): RenderTemplateAssets | null;
		font(face: RenderTemplateAssets['fonts'][number]): string | readonly TemplateFaceFile[] | null;
		emoji(pack: string, grapheme: string): string | null;
		/** URL of a remote image by manifest id (absent or null = unavailable). */
		image?(id: string): string | null;
	};
	/** Pre-render URLs known to the consumer. */
	resolveComposition?(clip: {
		clipId: string;
		asset: MediaAsset;
		source: RenderCompositionSource;
	}): RenderCompositionSource['prerender'] | null;
	/** edit-structure (internal): the chain of sequences being built (nest recursion, cycle guard). */
	nestStack?: readonly string[];
	/**
	 * Caption tracks drawn (burned in): 'visible' (default) = tracks whose eye is on,
	 * `'none'`, or a list of track ids/labels.
	 */
	captions?: 'visible' | 'none' | readonly string[];
};

/** The extra gain of a flattened nested audio clip at a sequence frame (0 dB without `nestGain`). */
export function nestGainDbAt(runs: RenderAudioClip['nestGain'], frame: number): number {
	if (!runs || runs.length === 0) return 0;
	let lo = 0;
	let hi = runs.length - 1;
	if (frame < runs[0]!.start) return runs[0]!.db;
	if (frame >= runs[hi]!.end) return runs[hi]!.db;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = runs[mid]!;
		if (frame < r.start) hi = mid - 1;
		else if (frame >= r.end) lo = mid + 1;
		else return r.db;
	}
	return runs[Math.max(0, Math.min(runs.length - 1, lo))]!.db;
}

const ZERO = { value: 0, keyframes: [] } as Animatable<number>;

/** parity (roto): render references of a clip's roto objects. */
function rotosOf(
	rotos: readonly ClipRoto[] | undefined,
	opts: Pick<SnapshotOptions, 'resolveRoto'>,
): { rotos?: Record<string, RenderRotoMatte> } {
	const out: Record<string, RenderRotoMatte> = {};
	for (const r of rotos ?? []) {
		const res = r.result;
		out[r.id] = {
			span: [r.span[0], r.span[1]],
			key: res?.key ?? null,
			url: res ? (opts.resolveRoto?.(res.key) ?? rotoStorePath(res.key)) : null,
			start: res?.start ?? 0,
			end: res ? res.end : -1,
			rate: { num: r.rate.num, den: r.rate.den },
			width: res?.width ?? 0,
			height: res?.height ?? 0,
			stale: rotoIsStale(r),
			name: r.name,
		};
	}
	return Object.keys(out).length ? { rotos: out } : {};
}

function streamChannelsOf(asset: MediaAsset | undefined, index: number): { streamChannels?: number } {
	const streams = asset?.probe.streams ?? [];
	const s =
		streams.find((x) => x.type === 'audio' && x.index === index) ?? streams.find((x) => x.type === 'audio');
	return s && s.type === 'audio' ? { streamChannels: s.channels } : {};
}

function relativePage(p: CaptionPage, origin: number): CaptionPage {
	return {
		...p,
		start: p.start - origin,
		end: p.end - origin,
		lines: p.lines.map((l) => l.map((w) => ({ ...w, start: w.start - origin, end: w.end - origin }))),
	};
}

function transitionFields<T>(
	x:
		| { headHandle: number; tailHandle: number; fades: T[]; freezeHead?: number; freezeTail?: number }
		| undefined,
): {
	headHandle?: number;
	tailHandle?: number;
	fades?: T[];
	freezeHead?: number;
	freezeTail?: number;
} {
	if (!x) return {};
	return {
		...(x.headHandle > 0 ? { headHandle: x.headHandle } : {}),
		...(x.tailHandle > 0 ? { tailHandle: x.tailHandle } : {}),
		...(x.fades.length ? { fades: x.fades } : {}),
		...(x.freezeHead ? { freezeHead: x.freezeHead } : {}),
		...(x.freezeTail ? { freezeTail: x.freezeTail } : {}),
	};
}

/** imports: the clip's media time map (Interpret Footage ▸ assumed frame rate / loop), when it has one. */
function mediaTimeFields(c: Clip, doc: ProjectDocument): { mediaTime?: MediaTimeMap } {
	const id = (c as { mediaId?: unknown }).mediaId;
	if (typeof id !== 'string' || c.kind === 'still') return {};
	const asset = doc.media[id];
	const tm = asset ? mediaTimeMap(asset) : null;
	return tm ? { mediaTime: tm } : {};
}

function retimeFields(
	c: Clip,
	doc: ProjectDocument,
	rate: Rational,
): Pick<RenderVisualClip, 'timeRemap' | 'retime'> {
	// Nested sequences (multi-camera clips too): the remap picks the nested frame (Frame Sampling).
	if (c.kind === 'nest-video') {
		const r = activeRemap(c);
		return r ? { timeRemap: r } : {};
	}
	if (c.kind !== 'video') return {};
	const asset = doc.media[c.mediaId];
	const vs = asset?.probe.streams.find((x) => x.type === 'video');
	// `mediaRate` = the file's frame grid (the retime decoders pick file frames); imports: whether frames fall between
	// source frames is decided at the interpreted (assumed) rate.
	const mediaRate = vs?.type === 'video' ? vs.frameRate : rate;
	const shownRate = (asset && interpretedFrameRate(asset)) ?? mediaRate;
	const vfr = asset?.probe.variableFrameRate === true;
	const remap = activeRemap(c);
	// imports: an assumed frame rate or a loop maps media time to file time non-trivially: frame-exact retime pipeline.
	const mapped = !!asset && !!mediaTimeMap(asset);
	const retimed = vfr || mapped || needsRetime(c, { sequenceRate: rate, mediaRate: shownRate, vfr });
	return {
		...(remap ? { timeRemap: remap } : {}),
		...(retimed
			? {
					retime: {
						interpolation: timeInterpolationOf(c),
						mediaRate: { num: mediaRate.num, den: mediaRate.den },
						vfr,
					},
				}
			: {}),
	};
}

export function buildRenderSnapshot(
	rawDoc: ProjectDocument,
	sequenceId: string,
	opts: SnapshotOptions,
): RenderSnapshot {
	// Wave expressions: Animatables with active expressions evaluate through their bound evaluators.
	// gaps (GR-4/5): graphics' Responsive Design (time, position) and Roll / Crawl, for every render path.
	const doc = bindExpressions(
		applyGraphics(rawDoc, (clip, s) => intrinsicBoxOf({ clip, doc: rawDoc, seq: s } as never)),
	);
	// Nested snapshots share the root's world (bindSnapshotExpressions recurses into `nest` sources).
	const world = opts.nestStack?.length ? null : expressionWorldData(rawDoc);
	const seq = doc.sequences[sequenceId];
	if (!seq) throw new Error(`Sequence not found: ${sequenceId}`);
	const stack = [...(opts.nestStack ?? []), sequenceId];
	const frame = { width: seq.settings.width, height: seq.settings.height };
	let end = 0;
	// Group once rather than scanning and allocating the entire clip list for every track.
	// Preserve document order within each track, including the stable sort's equal-start ties.
	const clipsByTrack = new Map<string, Clip[]>();
	for (const c of Object.values(seq.clips)) {
		end = Math.max(end, c.start + c.duration);
		const list = clipsByTrack.get(c.trackId);
		if (list) list.push(c);
		else clipsByTrack.set(c.trackId, [c]);
	}
	const range = opts.range ?? { start: 0, end };
	const transitions = resolveVideoTransitions(doc, seq);
	const audioTransitions = resolveAudioTransitions(doc, seq);
	const inRange = (c: Clip) => {
		const x = transitions.clips.get(c.id);
		return (
			c.enabled &&
			c.start - (x?.headHandle ?? 0) < range.end &&
			c.start + c.duration + (x?.tailHandle ?? 0) > range.start
		);
	};
	const media: Record<string, MediaHandle | null> = {};
	const useMedia = (id: string) => {
		if (id in media) return;
		const asset = doc.media[id];
		// imports: interpreted size, pixel / time interpretation, vector and Lottie descriptors.
		media[id] = asset ? interpretMediaHandle(asset, opts.resolveMedia(asset)) : null;
	};
	const useParamMedia = (params: EffectInstance['params']) => {
		for (const p of Object.values(params))
			for (const v of [p.value, ...p.keyframes.map((k) => k.value)]) {
				const id = (v as { mediaId?: unknown } | null)?.mediaId;
				if (typeof id === 'string' && id && doc.media[id]) useMedia(id);
			}
	};
	const warnings: RenderSnapshot['warnings'] = [];
	const fontKeys = new Map<string, RenderSnapshot['fonts'][number]>();
	const emojiTable: Record<string, string> = {};
	const imageTable: Record<string, string> = {};
	// social-comment §7.8: a template's declared faces join the document's fonts; its emoji join the emoji table.
	const useTemplateAssets = (clipId: string, mg: Extract<RenderVisualSource, { mg: unknown }>['mg']) => {
		const resolver = opts.templateAssets;
		const assets = resolver?.required(mg);
		if (
			!resolver ||
			!assets ||
			(assets.fonts.length === 0 && assets.emoji.length === 0 && !assets.images?.length)
		)
			return;
		mg.assets = assets;
		for (const face of assets.fonts) {
			const fontId = templateFontId(face.family);
			const key = `${fontId}:${face.weight}:${face.style === 'italic'}`;
			if (
				[...fontKeys.values()].some(
					(f) => f.fontId === fontId && f.weight === face.weight && f.style === face.style,
				)
			)
				continue;
			const found = resolver.font(face);
			const files = typeof found === 'string' ? [{ url: found }] : (found ?? []).filter((f) => !!f.url);
			// One entry per subset file (keyed by its unicode range, like the nested snapshots' entries).
			for (const f of files)
				fontKeys.set(`${key}${f.unicodeRange ? `:${f.unicodeRange}` : ''}`, {
					fontId,
					...face,
					url: f.url,
					...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
				});
			if (files.length === 0)
				warnings.push({
					clipId,
					code: 'TEMPLATE_FONT_UNAVAILABLE',
					message: `Font "${face.family}" ${face.weight}${face.style === 'italic' ? ' italic' : ''} is not available`,
				});
		}
		for (const { pack, graphemes } of assets.emoji) {
			const missing: string[] = [];
			for (const g of graphemes) {
				const key = emojiTableKey(pack, g);
				if (key in emojiTable) continue;
				const url = resolver.emoji(pack, g);
				if (url) emojiTable[key] = url;
				else missing.push(g);
			}
			if (missing.length)
				warnings.push({
					clipId,
					code: 'TEMPLATE_EMOJI_UNAVAILABLE',
					message: `Emoji ${missing.slice(0, 8).join(' ')}${missing.length > 8 ? ` (+${missing.length - 8})` : ''} of the ${pack} pack ${missing.length === 1 ? 'is' : 'are'} not available`,
				});
		}
		for (const id of assets.images ?? []) {
			if (id in imageTable) continue;
			const url = resolver.image?.(id) ?? null;
			if (url) imageTable[id] = url;
			else
				warnings.push({
					clipId,
					code: 'TEMPLATE_IMAGE_UNAVAILABLE',
					message: `Image "${id}" is not available`,
				});
		}
	};
	let itemNames: Map<string, string> | null = null;
	const sourceInfoOf = (mediaId: string): RenderVisualClip['sourceInfo'] => {
		if (!itemNames) {
			itemNames = new Map();
			for (const it of Object.values(doc.items ?? {}))
				if (it.kind === 'media' && !itemNames.has(it.mediaId)) itemNames.set(it.mediaId, it.name);
		}
		const asset = doc.media[mediaId];
		const path = asset?.locators.find((l) => l.type === 'path') as { path?: string } | undefined;
		const fileName = path?.path ? (path.path.split(/[\\/]/).pop() ?? '') : (asset?.originalName ?? '');
		return {
			itemName: itemNames.get(mediaId) ?? asset?.originalName ?? '',
			fileName,
			startTimecode: asset?.probe.startTimecode ?? null,
		};
	};

	// A nested snapshot is built at the parent's rate over the
	// nested frames a clip shows; its media and fonts join this snapshot's tables (consumers resolve them once).
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	const nestedSnapshot = (
		c: Clip & { sequenceId: string },
		kind: 'video' | 'audio',
		extent: { head: number; tail: number },
	): { snap: RenderSnapshot; nestedFps: Rational } | { error: string } => {
		const whole = doc.sequences[c.sequenceId];
		if (!whole) return { error: `Nested sequence ${c.sequenceId} is missing` };
		// wp-multicam: an enabled multi-camera clip sees only its angle (video) / its audible tracks (audio).
		const nested = multicamView(whole, c);
		if (stack.includes(c.sequenceId) || stack.length > MAX_NEST_DEPTH)
			return { error: `Nested sequence ${c.sequenceId} contains itself (nesting cycle)` };
		const f0 = Math.max(c.start - extent.head, range.start);
		const f1 = Math.min(c.start + c.duration + extent.tail, range.end) - 1;
		if (f1 < f0) return { error: 'outside the range' };
		const timeAt = (f: number) =>
			kind === 'video'
				? clipPictureTime(c, f, seq.settings.frameRate as Rational)
				: contentTimeAt(c, f, seq.settings.frameRate as Rational);
		const ta = timeAt(f0);
		const tb = timeAt(f1);
		const n0 = Math.max(0, Math.floor(Math.min(ta, tb) / F + 1e-6));
		const n1 = Math.floor(Math.max(ta, tb) / F + 1e-6) + 2;
		const nestedFps = nested.settings.frameRate as Rational;
		const conformed = rationalEquals(nestedFps, seq.settings.frameRate as Rational)
			? nested
			: conformSequenceRate(nested, seq.settings.frameRate as Rational);
		const sub = buildRenderSnapshot(
			conformed === whole ? doc : { ...doc, sequences: { ...doc.sequences, [nested.id]: conformed } },
			nested.id,
			{ ...opts, range: { start: n0, end: n1 }, nestStack: stack, captions: 'none' },
		);
		for (const [id, h] of Object.entries(sub.media)) if (!(id in media)) media[id] = h;
		for (const f of sub.fonts) {
			// subset files of a face share its key: tell them apart by their unicode range
			const key = `${f.fontId}:${f.weight}:${f.style === 'italic'}${f.unicodeRange ? `:${f.unicodeRange}` : ''}`;
			if (!fontKeys.has(key)) fontKeys.set(key, f);
		}
		for (const [k, url] of Object.entries(sub.emoji ?? {})) if (!(k in emojiTable)) emojiTable[k] = url;
		for (const [k, url] of Object.entries(sub.images ?? {})) if (!(k in imageTable)) imageTable[k] = url;
		for (const w of sub.warnings) warnings.push({ ...w, message: `In nested sequence: ${w.message}` });
		return { snap: sub, nestedFps };
	};

	// color-mgmt: the sequence's working space and colour settings.
	const colorInfo = sequenceColorInfo(seq.settings);
	const videoTracks: RenderSnapshot['videoTracks'] = [];
	const hiddenMattes: NonNullable<RenderSnapshot['matteTracks']> = [];
	// three-d: cameras and lights of the shown tracks, and whether a 3D layer is drawn.
	const cameras: RenderCameraClip[] = [];
	const lights: RenderLightClip[] = [];
	let has3dLayer = false;
	// wp masks: hidden tracks stay in the snapshot as matte-only tracks when a Track Matte Key reads them (Premiere
	// mattes are usually hidden tracks).
	const matteTracks = new Set<string>();
	for (const c of Object.values(seq.clips))
		if ((c as { enabled?: boolean }).enabled !== false)
			for (const id of trackMatteTracksOf({
				effects: ((c as { effects?: EffectInstance[] }).effects ?? []) as never,
			}))
				matteTracks.add(id);
	for (const [trackIndex, t] of seq.videoTracks.entries()) {
		const matteOnly = t.output === false && matteTracks.has(t.id);
		if (t.output === false && !matteOnly) continue;
		const clips: RenderVisualClip[] = [];
		for (const c of clipsByTrack.get(t.id) ?? []) {
			if (!inRange(c)) continue;
			if (!isKnownClipKind(c.kind)) {
				warnings.push({
					clipId: c.id,
					code: 'UNSUPPORTED_KIND',
					message: `Unsupported clip kind "${c.kind}" is not rendered`,
				});
				continue;
			}
			const caps = kindCapabilities(c.kind)!;
			// three-d: cameras and lights of shown tracks join the scene (a matte-only track's are off, as hidden).
			if ((c.kind === 'camera' || c.kind === 'light') && !matteOnly) {
				const rig: RenderRigClip = {
					clipId: c.id,
					name: c.name,
					trackIndex,
					start: c.start,
					duration: c.duration,
					sourceIn: c.sourceIn,
					speed: c.speed,
					...(c.frameHold ? { frameHold: c.frameHold } : {}),
				};
				if (c.kind === 'camera') cameras.push({ ...rig, camera: c.camera });
				else {
					lights.push({ ...rig, light: c.light });
					const env = c.light.type === 'environment' ? c.light.environmentMediaId : null;
					if (env && doc.media[env]) useMedia(env);
				}
				continue;
			}
			if (!caps.visual) continue;
			const r = c as Record<string, unknown>;
			const effects = (r.effects as EffectInstance[] | undefined) ?? [];
			const threeD = isLayer3D(c) ? (r.threeD as Layer3D) : undefined;
			if (threeD) {
				has3dLayer = true;
				// Advanced 3D draws physically: what it does not reproduce is said, not dropped silently.
				if (c.kind === 'model' && seq.threeD?.renderer !== 'advanced')
					warnings.push({
						clipId: c.id,
						code: 'THREE_D_MODEL_CLASSIC',
						message: `3D model "${c.name}" is drawn by Advanced 3D only: switch the sequence to Advanced 3D (Sequence ▸ 3D Renderer) to see it`,
					});
				if (seq.threeD?.renderer === 'advanced') {
					const mode = (r.blendMode as string | undefined) ?? 'normal';
					if (mode !== 'normal')
						warnings.push({
							clipId: c.id,
							code: 'THREE_D_ADVANCED_BLEND',
							message: `3D layer "${c.name}": Advanced 3D draws 3D layers with Normal blending (its blend mode ${mode} needs Classic 3D)`,
						});
					const lt = threeD.material?.lightTransmission;
					if (lt && (lt.value > 0 || lt.keyframes.some((k) => (k.value as number) > 0)))
						warnings.push({
							clipId: c.id,
							code: 'THREE_D_ADVANCED_TRANSMISSION',
							message: `3D layer "${c.name}": Advanced 3D shadows are opaque (Light Transmission needs Classic 3D)`,
						});
				}
			}
			let source: RenderVisualSource;
			const box = intrinsicBoxOf({ clip: c, doc, seq });
			switch (c.kind) {
				case 'video':
				case 'still':
				case 'animated-image':
				case 'model': {
					useMedia(c.mediaId);
					source = { mediaId: c.mediaId };
					break;
				}
				case 'text': {
					source = {
						text: c.content,
						box: c.box,
						...(c.layoutPending ? { layoutPending: true as const } : {}),
					};
					if (c.textAnimation && (c.textAnimation.in || c.textAnimation.out)) {
						const w = resolveTextAnimationWindows(c);
						source.animation = {
							...(w.in ? { in: w.in } : {}),
							...(w.out ? { out: w.out } : {}),
						};
						for (const key of w.unknown)
							warnings.push({
								clipId: c.id,
								code: 'UNKNOWN_TEXT_ANIMATION',
								message: `Text animation ${key} is not installed; the text is drawn without it`,
							});
					}
					// animators and friends travel unevaluated.
					if (c.animators?.length) source.animators = c.animators as TextAnimatorGroup[];
					if (c.pathOptions) source.pathOptions = c.pathOptions as TextPathOptions;
					if (c.moreOptions) source.moreOptions = c.moreOptions as TextMoreOptions;
					if (c.perCharacter3d) source.perCharacter3d = true;
					if (c.sourceTextKeyframes?.length)
						source.sourceTextKeyframes = c.sourceTextKeyframes as Keyframe<TextContent>[];
					// Styled runs and Source Text keys can use different font faces from the base style.
					const contents = [c.content, ...(c.sourceTextKeyframes ?? []).map((k) => k.value as TextContent)];
					const faces = contents.flatMap((ct) => [
						ct.style,
						...(ct.runs ?? []).map((r) => ({ ...ct.style, ...r.style })),
					]);
					for (const face of faces) {
						const font = doc.fonts[face.fontId];
						if (!font) continue;
						const key = `${font.id}:${face.weight}:${face.italic}`;
						if (fontKeys.has(key)) continue;
						const url = opts.resolveFont(font, face.weight, face.italic);
						if (url) {
							fontKeys.set(key, {
								fontId: font.id,
								family: font.family,
								weight: face.weight,
								style: face.italic ? 'italic' : 'normal',
								url,
							});
						}
					}
					break;
				}
				case 'solid': {
					// Colour mattes, black / transparent video; Bars and Tone and the counting leader draw generators.
					source = syntheticPicture(doc.synthetics[c.syntheticId]);
					break;
				}
				case 'adjustment': {
					source = { adjustment: true };
					break;
				}
				case 'nest-video': {
					const x = transitions.clips.get(c.id);
					const r = nestedSnapshot(c, 'video', { head: x?.headHandle ?? 0, tail: x?.tailHandle ?? 0 });
					if ('error' in r) {
						if (r.error !== 'outside the range')
							warnings.push({ clipId: c.id, code: 'NEST_UNAVAILABLE', message: r.error });
						source = { unsupported: c.kind };
					} else {
						r.snap.settings.backgroundColor = [0, 0, 0, 0];
						source = {
							nest: {
								sequenceId: c.sequenceId,
								snapshot: r.snap,
								nestedFps: r.nestedFps,
								contentKey: multicamContentKey(doc, c),
							},
						};
					}
					break;
				}
				case 'motion-graphic': {
					const { renderer, ...template } = c.template;
					// Template media params (avatars) resolve like effect media: handles (signed URLs in renders) in `media`.
					for (const id of clipParamMediaIds(c)) if (doc.media[id]) useMedia(id);
					source = {
						mg: {
							template,
							params: c.params,
							canvas: box,
							...(renderer === 'anime' ? { renderer } : {}),
							...(renderer === 'anime' && c.paramKeyframes && Object.keys(c.paramKeyframes).length > 0
								? { paramKeyframes: c.paramKeyframes as Record<string, Keyframe<unknown>[]> }
								: {}),
						},
					};
					if (renderer === 'anime') useTemplateAssets(c.id, source.mg);
					break;
				}
				case 'shape': {
					source = { shape: c.shape };
					break;
				}
				case 'composition': {
					const mediaId = c.composition.mediaId;
					if (mediaId) {
						useMedia(mediaId);
						const asset = doc.media[mediaId];
						const found = compositionOfClip(doc, c);
						const loc = asset?.locators.find((l) => l.type === 'engine-store');
						const comp: RenderCompositionSource = {
							mediaId,
							compositionId: c.composition.id,
							props: mergeProps(found?.info.defaultProps, c.props),
							canvas: box,
							bundle: asset?.mgBundle
								? {
										key: loc?.type === 'engine-store' ? loc.key : null,
										hash: asset.mgBundle.bundleHash,
										remotionVersion: asset.mgBundle.remotionVersion,
									}
								: null,
							info: found
								? {
										width: found.info.width,
										height: found.info.height,
										fps: found.info.fps,
										durationInFrames: found.info.durationInFrames,
									}
								: null,
						};
						const pre = asset && opts.resolveComposition?.({ clipId: c.id, asset, source: comp });
						if (pre) comp.prerender = pre;
						source = { composition: comp };
					} else source = { unsupported: c.kind };
					break;
				}
				default:
					source = { unsupported: c.kind };
			}
			// color-mgmt: the source's colour input transform (media interpretation, graphics, nested working space).
			const colorFx = colorEffectOf(c, doc, colorInfo);
			// LUT assets referenced by effect params need media handles too.
			for (const fx of colorFx ? [colorFx, ...effects] : effects) if (fx.enabled) useParamMedia(fx.params);
			// spec 19 TL-021: a look's reflection images and pattern tiles live in its layers, not in the effect's params.
			for (const ref of effectMediaRefs(effects.filter((fx) => fx.enabled)))
				if (doc.media[ref.mediaId]) useMedia(ref.mediaId);
			clips.push({
				clipId: c.id,
				kind: c.kind,
				trackId: c.trackId,
				name: c.name,
				start: c.start,
				duration: c.duration,
				sourceIn: c.sourceIn,
				speed: c.speed,
				source,
				transform: (r.transform as Transform | undefined) ?? null,
				opacity: (r.opacity as Animatable<number> | undefined) ?? { value: 100, keyframes: [] },
				blendMode: (r.blendMode as BlendMode | undefined) ?? 'normal',
				effects: colorFx ? [colorFx, ...visibleEffects(effects)] : visibleEffects(effects),
				...sequenceLightOf(effects, seq),
				intrinsicBox: box,
				...((r.masks as Mask[] | undefined)?.length ? { masks: r.masks as Mask[] } : {}),
				// edit-structure: a nest renders with the engines its nested layers need. three-d: a 3D layer is drawn by
				// the compositions' 3D renderer.
				engine:
					threeD ||
					('nest' in source && nestNeedsRemotion(source.nest.snapshot)) ||
					// imports: Lottie and vector pictures are drawn by the composition (baked for the native path).
					('mediaId' in source && (doc.media[source.mediaId]?.lottie || doc.media[source.mediaId]?.vector))
						? 'remotion'
						: (clipEngines(c)?.export ?? caps.engines.export),
				...(c.kind === 'animated-image' ? { loop: c.loop } : {}),
				...(c.frameHold && c.kind !== 'adjustment' ? { frameHold: c.frameHold } : {}),
				bounded: isBoundedContent(c),
				...transitionFields(transitions.clips.get(c.id)),
				...('mediaId' in source && effects.length > 0 ? { sourceInfo: sourceInfoOf(source.mediaId) } : {}),
				...retimeFields(c, doc, seq.settings.frameRate as Rational),
				...rotosOf(r.rotos as ClipRoto[] | undefined, opts),
				...(threeD ? { threeD } : {}),
				...mediaTimeFields(c, doc),
			});
		}
		clips.sort((a, b) => a.start - b.start);
		const mattes = (transitions.mattes.get(t.id) ?? [])
			.filter((m) => m.start < range.end && m.start + m.duration > range.start)
			// color-mgmt: a dip's colour is a graphics colour (white = HDR Graphics White in HDR).
			.map((m) => ({ ...m, color: graphicsColorIn(m.color as RGBA, colorInfo) }));
		const allStages = (transitions.stages.get(t.id) ?? []).filter(
			(x) => x.start < range.end && x.start + x.duration > range.start,
		);
		// edit-structure: adjustment clips have no transition handles (an adjustment applies only inside its range);
		// a transition on one is drawn as the adjustment fading in / out over the span (GPU stages included).
		const adjustments = new Map(clips.filter((c) => c.kind === 'adjustment').map((c) => [c.clipId, c]));
		const stages = allStages.filter((st) => {
			const sides = [st.outgoingClipId, st.incomingClipId].filter((x): x is string => !!x);
			if (!sides.some((id) => adjustments.has(id))) return true;
			const outAdj = st.outgoingClipId ? adjustments.get(st.outgoingClipId) : undefined;
			const inAdj = st.incomingClipId ? adjustments.get(st.incomingClipId) : undefined;
			const two = st.sides === 'both';
			if (outAdj)
				outAdj.fades = [
					...(outAdj.fades ?? []),
					two
						? { type: 'out', start: st.start - 1, frames: st.duration + 1 }
						: { type: 'out', start: st.start - 1, frames: st.duration },
				];
			if (inAdj)
				inAdj.fades = [
					...(inAdj.fades ?? []),
					two
						? { type: 'in', start: st.start - 1, frames: st.duration + 1 }
						: { type: 'in', start: st.start, frames: st.duration },
				];
			warnings.push({
				clipId: st.id,
				code: 'ADJUSTMENT_TRANSITION',
				message: 'A transition on an adjustment layer is drawn as the adjustment fading in/out',
			});
			return false;
		});
		for (const c of adjustments.values()) {
			delete c.headHandle;
			delete c.tailHandle;
			delete c.freezeHead;
			delete c.freezeTail;
		}
		// Trackers of the sides (S_MochaWhip's Mocha mode): each side clip's tracker over the span, in sequence px.
		const withTracks = stages.map((st): RenderTransition => {
			const tracks: NonNullable<RenderTransition['tracks']> = {};
			for (const [side, id] of [
				['out', st.outgoingClipId],
				['in', st.incomingClipId],
			] as const) {
				const sideClip = id ? (seq.clips[id] as { trackers?: ClipTracker[] } | undefined) : undefined;
				const tracker = transitionTrackerOf(sideClip?.trackers);
				const layer = tracker ? clips.find((c) => c.clipId === id) : undefined;
				if (tracker && layer)
					tracks[side] = transitionSideTrack(layer, tracker, st, seq.settings.frameRate as Rational);
			}
			return tracks.out || tracks.in ? { ...st, tracks } : st;
		});
		// Image params of GPU transitions (Gradient Wipe's custom gradient…) get media handles like effect params.
		for (const st of stages) useParamMedia(st.params);
		(matteOnly ? hiddenMattes : videoTracks).push({
			trackId: t.id,
			clips,
			...(mattes.length ? { mattes } : {}),
			...(stages.length ? { transitions: withTracks } : {}),
		});
	}
	for (const s of transitions.skipped)
		warnings.push({ clipId: s.transitionId, code: 'TRANSITION_SKIPPED', message: s.reason });

	const audioMix = buildAudioMix(seq);
	const played = playedTracks(audioMix);
	const audible = seq.audioTracks.filter((t) => played.has(t.id));
	// Caption tracks draw above every video track.
	const captionMode = opts.captions ?? 'visible';
	const fallbackFont = Object.values(doc.fonts)[0]?.id ?? '';
	seq.captionTracks.forEach((t, ti) => {
		const shown =
			captionMode === 'visible'
				? t.visible !== false
				: captionMode === 'none'
					? false
					: captionMode.includes(t.id) || captionMode.includes(`C${ti + 1}`);
		if (!shown) return;
		const clips: RenderVisualClip[] = [];
		for (const c of clipsByTrack.get(t.id) ?? []) {
			if (c.kind !== 'captions' || !inRange(c)) continue;
			const style = resolveCaptionStyle(t.styleDefaults, c.style, fallbackFont, frame.height);
			const pages = captionPages(doc, seq, c, style);
			if (!pages.length) continue;
			// faces: the style's, plus bold / italic faces used by markup
			const faces = [
				[style.weight, style.italic],
				[Math.max(style.weight, 700), style.italic],
				[style.weight, true],
				[Math.max(style.weight, 700), true],
			] as const;
			const font = doc.fonts[style.fontId];
			for (const [weight, italic] of faces) {
				if (!font) break;
				const key = `${font.id}:${weight}:${italic}`;
				if (fontKeys.has(key)) continue;
				const url = opts.resolveFont(font, weight, italic);
				if (url)
					fontKeys.set(key, {
						fontId: font.id,
						family: font.family,
						weight,
						style: italic ? 'italic' : 'normal',
						url,
					});
			}
			clips.push({
				clipId: c.id,
				kind: c.kind,
				trackId: c.trackId,
				name: c.name,
				start: c.start,
				duration: c.duration,
				sourceIn: c.sourceIn,
				speed: c.speed,
				source: {
					captions: {
						style,
						pages: pages.map((p) => relativePage(p, c.start)),
						...(t.captionStandard ? { standard: t.captionStandard } : {}),
					},
				},
				transform: c.transform,
				opacity: c.opacity,
				blendMode: 'normal',
				// color-mgmt: captions are graphics.
				effects: ((fx) => (fx ? [fx] : []))(graphicsColorEffect(c.id, colorInfo)),
				intrinsicBox: { ...frame },
				engine: clipEngines(c)?.export ?? 'remotion',
				bounded: false,
			});
		}
		clips.sort((a, b) => a.start - b.start);
		videoTracks.push({ trackId: t.id, clips, caption: true });
	});

	const audioClips: RenderAudioClip[] = [];
	// A crossfade plays the clips' handles: a clip whose handle reaches into the range is included.
	const audioInRange = (c: Clip) => {
		const x = audioTransitions.clips.get(c.id);
		return (
			c.enabled &&
			c.start - (x?.headHandle ?? 0) < range.end &&
			c.start + c.duration + (x?.tailHandle ?? 0) > range.start
		);
	};
	for (const t of audible) {
		for (const c of clipsByTrack.get(t.id) ?? []) {
			if (!audioInRange(c)) continue;
			if (c.kind === 'synthetic-audio') {
				const sound = syntheticSound(doc.synthetics[c.syntheticId]);
				if (!sound) continue;
				const x = audioTransitions.clips.get(c.id);
				audioClips.push({
					clipId: c.id,
					trackId: t.id,
					start: c.start,
					duration: c.duration,
					sourceIn: c.sourceIn,
					speed: c.speed,
					mediaId: `syn:${c.syntheticId}`,
					channels: { streamIndex: 0, map: [0, 1] },
					gainDb: c.gainDb,
					volumeDb: c.volumeDb,
					pan: c.pan,
					effects: c.effects,
					track: { volumeDb: t.volumeDb ?? ZERO, pan: t.pan ?? ZERO },
					...transitionFields(x),
					generator: sound,
				});
				continue;
			}
			if (c.kind === 'nest-audio') {
				const x = audioTransitions.clips.get(c.id);
				const r = nestedSnapshot(c, 'audio', { head: x?.headHandle ?? 0, tail: x?.tailHandle ?? 0 });
				if ('error' in r) {
					if (r.error !== 'outside the range')
						warnings.push({ clipId: c.id, code: 'NEST_UNAVAILABLE', message: r.error });
					continue;
				}
				audioClips.push(
					...flattenNestAudio(c, t, x, r.snap, seq.settings.frameRate as Rational, {
						start: range.start,
						end: range.end,
					}),
				);
				continue;
			}
			if (c.kind !== 'audio') continue;
			useMedia(c.mediaId);
			const x = audioTransitions.clips.get(c.id);
			audioClips.push({
				clipId: c.id,
				trackId: t.id,
				start: c.start,
				duration: c.duration,
				sourceIn: c.sourceIn,
				speed: c.speed,
				mediaId: c.mediaId,
				channels: c.channels,
				gainDb: c.gainDb,
				volumeDb: c.volumeDb,
				pan: c.pan,
				effects: c.effects,
				track: { volumeDb: t.volumeDb ?? ZERO, pan: t.pan ?? ZERO },
				...streamChannelsOf(doc.media[c.mediaId], c.channels.streamIndex),
				...transitionFields(x),
				...mediaTimeFields(c, doc),
			});
		}
	}
	for (const s of audioTransitions.skipped)
		warnings.push({ clipId: s.transitionId, code: 'TRANSITION_SKIPPED', message: s.reason });
	audioClips.sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId));

	return {
		version: 1,
		sequenceId,
		settings: {
			...frame,
			fps: seq.settings.frameRate,
			backgroundColor: graphicsColorIn(seq.settings.backgroundColor as RGBA, colorInfo),
			sampleRate: audioMix.sampleRate,
			color: colorInfo,
		},
		range,
		durationFrames: Math.max(0, range.end - range.start),
		videoTracks,
		...(hiddenMattes.length ? { matteTracks: hiddenMattes } : {}),
		audioClips,
		media,
		fonts: [...fontKeys.values()],
		...(Object.keys(emojiTable).length ? { emoji: emojiTable } : {}),
		...(Object.keys(imageTable).length ? { images: imageTable } : {}),
		master: { volumeDb: seq.master.volumeDb },
		audioMix,
		warnings,
		...(world ? { expressions: world } : {}),
		...(has3dLayer || cameras.length || lights.length
			? {
					scene3d: {
						renderer: seq.threeD?.renderer ?? 'classic',
						...(seq.threeD?.draft ? { draft: true } : {}),
						...(seq.threeD?.shadowMapSize ? { shadowMapSize: seq.threeD.shadowMapSize } : {}),
						...(seq.threeD?.supersampling ? { supersampling: seq.threeD.supersampling } : {}),
						cameras,
						lights,
					},
				}
			: {}),
	};
}

const MIN_DB = -200;
const gainToDb = (g: number) => (g > 0 ? Math.max(MIN_DB, 20 * Math.log10(g)) : MIN_DB);

/**
 * The audio clips of a nested sequence as clips of the parent (KND-011 sound): each nested audio clip becomes a
 * piece placed where the `nest-audio` clip `n` plays it, its content time and rate composed with the nest clip's
 * (speed, reverse, trims), and its gain composed in `nestGain`: the nested track fader and master, the nested fades
 * and the nest clip's gain, volume and fades. The outer track fader and master apply as for any clip. Effects of the
 * nest clip follow the piece's own (they act on each piece: exact for linear effects such as gain and EQ).
 */
export function flattenNestAudio(
	n: Clip,
	track: { volumeDb?: Animatable<number>; pan?: Animatable<number> },
	transition: AudioClipTransitionRender | undefined,
	sub: RenderSnapshot,
	rate: Rational,
	range: { start: number; end: number },
): RenderAudioClip[] {
	const nest = n as Clip & {
		gainDb: number;
		volumeDb: Animatable<number>;
		pan: Animatable<number>;
		effects: EffectInstance[];
	};
	const F = flicksPerFrame(rate);
	const r = n.speed.rate;
	const rev = n.speed.reverse;
	const head = transition?.headHandle ?? 0;
	const tail = transition?.tailHandle ?? 0;
	const lo = Math.max(n.start - head, range.start);
	const hi = Math.min(n.start + n.duration + tail, range.end);
	const g = (f: number) => contentTimeAt(n, f, rate) / F;
	const out: RenderAudioClip[] = [];
	for (const a of sub.audioClips) {
		const a0 = a.start - (a.headHandle ?? 0);
		const a1 = a.start + a.duration + (a.tailHandle ?? 0);
		let p0: number;
		let p1: number;
		if (!rev) {
			const fAt = (x: number) => n.start + (x - g(n.start)) / r;
			p0 = Math.max(lo, Math.ceil(fAt(a0) - 1e-6));
			p1 = Math.min(hi, Math.ceil(fAt(a1) - 1e-6));
		} else {
			const fAt = (x: number) => n.start + (n.duration - 1) - (x - n.sourceIn / F) / r;
			p0 = Math.max(lo, Math.floor(fAt(a1) + 1e-6) + 1);
			p1 = Math.min(hi, Math.floor(fAt(a0) + 1e-6) + 1);
		}
		if (p1 <= p0) continue;
		const pieceRev = a.speed.reverse !== rev;
		const contentOfA = (x: number) => contentTimeAt(a, x, rate);
		const sourceIn = Math.max(0, Math.round(contentOfA(g(pieceRev ? p1 - 1 : p0))));
		const db = new Float64Array(p1 - p0);
		// spec 14 TC-024: edge micro-fades are shorter than a frame: they stay fades of the piece (mapped to the outer
		// timeline) instead of being sampled per frame into `nestGain`.
		const innerFades = a.fades?.filter((x) => !x.edge);
		const edgeFades: RenderAudioFade[] = [];
		for (const x of a.fades ?? []) {
			if (!x.edge) continue;
			const sIn = n.sourceIn / F;
			if (!rev) edgeFades.push({ ...x, start: n.start + (x.start - g(n.start)) / r, frames: x.frames / r });
			else
				edgeFades.push({
					...x,
					type: x.type === 'in' ? 'out' : 'in',
					start: n.start + n.duration - (x.start + x.frames - sIn) / r,
					frames: x.frames / r,
				});
		}
		for (let f = p0; f < p1; f++) {
			const x = g(f);
			const inner =
				evaluate(a.track.volumeDb, x * F) +
				evaluate(sub.master.volumeDb, x * F) +
				gainToDb(audioFadeGain(innerFades, x)) +
				nestGainDbAt(a.nestGain, Math.floor(x + 1e-6));
			const fc = Math.min(n.start + n.duration - 1, Math.max(n.start, f));
			const outer =
				nest.gainDb +
				evaluate(nest.volumeDb, contentTimeAt(n, fc, rate)) +
				gainToDb(audioFadeGain(transition?.fades, f));
			db[f - p0] = Math.max(MIN_DB, inner + outer);
		}
		const runs: { start: number; end: number; db: number }[] = [];
		for (let k = 0; k < db.length; k++) {
			const v = Math.round(db[k]! * 1000) / 1000;
			const last = runs[runs.length - 1];
			if (last && Math.abs(last.db - v) < 0.01) last.end = p0 + k + 1;
			else runs.push({ start: p0 + k, end: p0 + k + 1, db: v });
		}
		const pan = isAnimatedOrNonZero(a.pan) ? a.pan : nest.pan;
		out.push({
			clipId: `${n.id}>${a.clipId}`,
			trackId: n.trackId,
			start: p0,
			duration: p1 - p0,
			sourceIn,
			speed: { ...a.speed, rate: a.speed.rate * r, reverse: pieceRev },
			mediaId: a.mediaId,
			channels: a.channels,
			gainDb: a.gainDb,
			volumeDb: a.volumeDb,
			pan,
			effects: [...a.effects, ...nest.effects],
			track: { volumeDb: track.volumeDb ?? ZERO, pan: track.pan ?? ZERO },
			...(a.generator ? { generator: a.generator } : {}),
			...(runs.length === 1 && runs[0]!.db === 0 ? {} : { nestGain: runs }),
			...(edgeFades.length ? { fades: edgeFades } : {}),
		});
	}
	return out;
}

function isAnimatedOrNonZero(a: Animatable<number>): boolean {
	return a.keyframes.length > 0 || a.value !== 0;
}

/** wp-multicam: the content key of what a nest clip shows (the angle's view for multi-camera clips). */
function multicamContentKey(doc: ProjectDocument, c: Clip & { sequenceId: string }): string {
	const whole = doc.sequences[c.sequenceId];
	const view = whole ? multicamView(whole, c) : undefined;
	if (!whole || view === whole) return nestContentKey(doc, c.sequenceId);
	return nestContentKey({ ...doc, sequences: { ...doc.sequences, [c.sequenceId]: view! } }, c.sequenceId);
}

/** A nested snapshot draws a Remotion-rendered layer (recursively). */
function nestNeedsRemotion(snap: RenderSnapshot): boolean {
	return snap.videoTracks.some(
		(t) => (t.transitions?.length ?? 0) > 0 || t.clips.some((c) => c.engine === 'remotion' || !!c.threeD),
	);
}

/** color-mgmt: the colour input effect of a visual clip (null = none needed). */
function colorEffectOf(c: Clip, doc: ProjectDocument, info: SequenceColorInfo): EffectInstance | null {
	switch (c.kind) {
		case 'video':
		case 'still':
		case 'animated-image': {
			const asset = doc.media[c.mediaId];
			return asset ? sourceColorEffect(c.id, asset, c, info) : null;
		}
		case 'nest-video': {
			const nested = doc.sequences[c.sequenceId];
			return nested ? nestColorEffect(c.id, sequenceColorInfo(nested.settings).space, info) : null;
		}
		case 'adjustment':
			return null;
		default:
			return graphicsColorEffect(c.id, info);
	}
}

/**
 * The effects renderers see: Expression Controls and other `passthrough` effects draw nothing and are left out
 * (expressions read them from the document). Returns the stored array when nothing is dropped.
 */
/** spec 19 TL-017: what a clip needs to follow the sequence's light; nothing unless its look does. */
function sequenceLightOf(
	effects: readonly EffectInstance[],
	seq: Sequence,
): { sequenceLight?: RenderVisualClip['sequenceLight'] } {
	// The clip first: this runs for every clip of a snapshot, and most have no look.
	if (clipLook(effects)?.appearance?.light?.source !== 'sequence') return {};
	const light = globalLightOf(seq);
	if (!light) return {};
	return {
		sequenceLight: { ...light, flicksPerFrame: flicksPerFrame(seq.settings.frameRate as Rational) },
	};
}

function visibleEffects(effects: EffectInstance[] | undefined): EffectInstance[] {
	if (!effects?.length) return [];
	// color-grade: Lumetri instances with spatial steps get their GPU companion stage (registry/lumetri-spatial.ts).
	const list = expandLumetriSpatial(effects);
	if (!list.some((fx) => defaultEffectRegistry.get(fx.effectId)?.passthrough)) return list;
	return list.filter((fx) => !defaultEffectRegistry.get(fx.effectId)?.passthrough);
}
