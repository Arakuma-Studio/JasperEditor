// Render snapshot (S01:RND-001…005, ARCHITECTURE §5.5): the self-contained JSON value handed to the
// Remotion composition, the native planner and the Program overlay. Keyframes stay unevaluated.
import { compositionOfClip, mergeProps } from '../composition/props.ts';
import { contentTimeAt } from '../derive/index.ts';
import { evaluate } from '../keyframes.ts';
import { clipEngines, type EngineId, isBoundedContent, kindCapabilities } from '../registry/kinds.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import type { Animatable, Keyframe, RGBA } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { FontRef, MediaAsset } from '../schema/media.ts';
import {
	type BlendMode,
	type Clip,
	type ClipTracker,
	type EffectInstance,
	isKnownClipKind,
	type MgRenderer,
	type ShapeData,
	type Speed,
	type TextBox,
	type TextContent,
	type Transform,
} from '../schema/sequence.ts';
import { conformSequenceRate, MAX_NEST_DEPTH, nestContentKey } from '../structure/nest.ts';
import {
	type CountingLeaderStyle,
	type SyntheticSound,
	syntheticPicture,
	syntheticSound,
} from '../structure/synthetic.ts';
import { type ResolvedTextAnimator, resolveTextAnimationWindows } from '../text-animations.ts';
import { flicksPerFrame, type Rational, rationalEquals } from '../time.ts';
import { transitionSideTrack, transitionTrackerOf } from '../tracking/transition.ts';
import {
	type AudioClipTransitionRender,
	audioFadeGain,
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
};

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
 * M2 (S11:TXA-009): the animators of a text clip as rendered — params with the preset defaults merged (known
 * presets) and window lengths compressed to the clip (TXA-004). Absent sides have no animator.
 */
export type RenderTextAnimation = { in?: ResolvedTextAnimator; out?: ResolvedTextAnimator };

export type RenderVisualSource =
	| { mediaId: string }
	| { text: TextContent; box: TextBox; animation?: RenderTextAnimation }
	| { color: RGBA }
	| {
			mg: {
				template: { id: string; version: number };
				params: Record<string, unknown>;
				canvas: { width: number; height: number };
				/** M2 (S11:ATP-002): absent = `fframes`. */
				renderer?: MgRenderer;
				/**
				 * wp-m2-anime-templates (S11:ATP-006): keyframes of anime template params by name (content time,
				 * unevaluated like shapes, RND-001); the layer evaluates them with the shared evaluator. Anime only.
				 */
				paramKeyframes?: Record<string, Keyframe<unknown>[]>;
			};
	  }
	/** M2 (S11:SHP-001): a shape; Animatables unevaluated (RND-001), evaluated per frame by the layer. */
	| { shape: ShapeData }
	/**
	 * M2 (S08): a composition of an `mg-bundle` asset. `media[mediaId]` resolves the bundle (`url` = its serve
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
	| { unsupported: string };

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

/** Source of a composition clip in the snapshot (S08:MGC-008; wp-m2-mg fields are additive). */
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
	intrinsicBox: { width: number; height: number };
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
	 * M2 (S11:LBK-010, wp-m2-layer-bake): a pre-rendered picture of the whole placed layer (sequence space: Motion,
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
	 * fx framework (clip context, additive): what effects may show about the clip's media — the project item name
	 * (Premiere "Project Item Name"), the file name and the media's embedded start timecode. Set for media clips
	 * that have effects; absent otherwise.
	 */
	sourceInfo?: { itemName: string; fileName: string; startTimecode: string | null };
};

export type RenderAudioClip = {
	clipId: string;
	trackId: string;
	start: number;
	duration: number;
	sourceIn: number;
	speed: Speed;
	mediaId: string;
	channels: { streamIndex: number; map: number[] };
	gainDb: number;
	volumeDb: Animatable<number>;
	pan: Animatable<number>;
	effects: EffectInstance[];
	/** Track fader and pan (sequence time in flicks). */
	track: { volumeDb: Animatable<number>; pan: Animatable<number> };
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

export type RenderSnapshot = {
	version: 1;
	sequenceId: string;
	settings: { width: number; height: number; fps: Rational; backgroundColor: RGBA; sampleRate: 48000 };
	/** Frames; export range or whole sequence. */
	range: { start: number; end: number };
	durationFrames: number;
	/**
	 * V1 (bottom) → top; output-disabled tracks omitted; clips sorted by start. `mattes` are full-frame
	 * colours drawn under the track's clips (the black of a dip to black). `transitions` (wave-2 transition framework)
	 * are the GPU transition stages drawn over the track's clips (each replaces its A/B clips for its span).
	 */
	videoTracks: {
		trackId: string;
		clips: RenderVisualClip[];
		mattes?: RenderMatte[];
		transitions?: RenderTransition[];
	}[];
	/** After mute/solo resolution. */
	audioClips: RenderAudioClip[];
	/** null = offline. */
	media: Record<string, MediaHandle | null>;
	fonts: { fontId: string; family: string; weight: number; style: 'normal' | 'italic'; url: string }[];
	master: { volumeDb: Animatable<number> };
	/** Clips excluded from rendering (unknown kinds, S01:KND-030). */
	warnings: { clipId: string; code: string; message: string }[];
};

export type SnapshotOptions = {
	range?: { start: number; end: number };
	resolveMedia(asset: MediaAsset): MediaHandle | null;
	resolveFont(font: FontRef, weight: number, italic: boolean): string | null;
	/** M2 (S08, additive): pre-render URLs of a composition clip known to the consumer. */
	resolveComposition?(clip: {
		clipId: string;
		asset: MediaAsset;
		source: RenderCompositionSource;
	}): RenderCompositionSource['prerender'] | null;
	/** edit-structure (internal): the chain of sequences being built (nest recursion, cycle guard). */
	nestStack?: readonly string[];
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

export function buildRenderSnapshot(
	doc: ProjectDocument,
	sequenceId: string,
	opts: SnapshotOptions,
): RenderSnapshot {
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
		media[id] = asset ? opts.resolveMedia(asset) : null;
	};
	const warnings: RenderSnapshot['warnings'] = [];
	const fontKeys = new Map<string, RenderSnapshot['fonts'][number]>();
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

	// ---- edit-structure: nested sequences (KND-011). A nested snapshot is built at the parent's rate over the
	// nested frames a clip shows; its media and fonts join this snapshot's tables (consumers resolve them once).
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	const nestedSnapshot = (
		c: Clip & { sequenceId: string },
		kind: 'video' | 'audio',
		extent: { head: number; tail: number },
	): { snap: RenderSnapshot; nestedFps: Rational } | { error: string } => {
		const nested = doc.sequences[c.sequenceId];
		if (!nested) return { error: `Nested sequence ${c.sequenceId} is missing` };
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
			conformed === nested ? doc : { ...doc, sequences: { ...doc.sequences, [nested.id]: conformed } },
			nested.id,
			{ ...opts, range: { start: n0, end: n1 }, nestStack: stack },
		);
		for (const [id, h] of Object.entries(sub.media)) if (!(id in media)) media[id] = h;
		for (const f of sub.fonts) {
			const key = `${f.fontId}:${f.weight}:${f.style === 'italic'}`;
			if (!fontKeys.has(key)) fontKeys.set(key, f);
		}
		for (const w of sub.warnings) warnings.push({ ...w, message: `In nested sequence: ${w.message}` });
		return { snap: sub, nestedFps };
	};

	const videoTracks: RenderSnapshot['videoTracks'] = [];
	for (const t of seq.videoTracks) {
		if (t.output === false) continue;
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
			if (!caps.visual) continue;
			const r = c as Record<string, unknown>;
			let source: RenderVisualSource;
			const box = intrinsicBoxOf({ clip: c, doc, seq });
			switch (c.kind) {
				case 'video':
				case 'still':
				case 'animated-image': {
					useMedia(c.mediaId);
					source = { mediaId: c.mediaId };
					break;
				}
				case 'text': {
					source = { text: c.content, box: c.box };
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
					// M2 (wp-m2-text-anim, S11:TXA-010): styled runs may use other faces than the base style.
					const base = c.content.style;
					const faces = [base, ...(c.content.runs ?? []).map((r) => ({ ...base, ...r.style }))];
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
								contentKey: nestContentKey(doc, c.sequenceId),
							},
						};
					}
					break;
				}
				case 'motion-graphic': {
					const { renderer, ...template } = c.template;
					source = {
						mg: {
							template,
							params: c.params,
							canvas: box,
							...(renderer === 'anime' ? { renderer } : {}),
							// wp-m2-anime-templates (S11:ATP-006)
							...(renderer === 'anime' && c.paramKeyframes && Object.keys(c.paramKeyframes).length > 0
								? { paramKeyframes: c.paramKeyframes as Record<string, Keyframe<unknown>[]> }
								: {}),
						},
					};
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
			// M2 (S06:LUT-003): LUT assets referenced by effect params (`{mediaId}`) get media handles too.
			for (const fx of (r.effects as EffectInstance[] | undefined) ?? []) {
				if (!fx.enabled) continue;
				for (const p of Object.values(fx.params)) {
					const refs = [p.value, ...p.keyframes.map((k) => k.value)];
					for (const v of refs) {
						const id = (v as { mediaId?: unknown } | null)?.mediaId;
						if (typeof id === 'string' && id && doc.media[id]) useMedia(id);
					}
				}
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
				source,
				transform: (r.transform as Transform | undefined) ?? null,
				opacity: (r.opacity as Animatable<number> | undefined) ?? { value: 100, keyframes: [] },
				blendMode: (r.blendMode as BlendMode | undefined) ?? 'normal',
				effects: (r.effects as EffectInstance[] | undefined) ?? [],
				intrinsicBox: box,
				// edit-structure: a nest renders with the engines its nested layers need.
				engine:
					'nest' in source && nestNeedsRemotion(source.nest.snapshot)
						? 'remotion'
						: (clipEngines(c)?.export ?? caps.engines.export),
				...(c.kind === 'animated-image' ? { loop: c.loop } : {}),
				...(c.frameHold && c.kind !== 'adjustment' ? { frameHold: c.frameHold } : {}),
				bounded: isBoundedContent(c),
				...transitionFields(transitions.clips.get(c.id)),
				...('mediaId' in source && ((r.effects as EffectInstance[] | undefined) ?? []).length > 0
					? { sourceInfo: sourceInfoOf(source.mediaId) }
					: {}),
			});
		}
		clips.sort((a, b) => a.start - b.start);
		const mattes = (transitions.mattes.get(t.id) ?? []).filter(
			(m) => m.start < range.end && m.start + m.duration > range.start,
		);
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
		for (const st of stages)
			for (const p of Object.values(st.params))
				for (const v of [p.value, ...p.keyframes.map((k) => k.value)]) {
					const id = (v as { mediaId?: unknown } | null)?.mediaId;
					if (typeof id === 'string' && id && doc.media[id]) useMedia(id);
				}
		videoTracks.push({
			trackId: t.id,
			clips,
			...(mattes.length ? { mattes } : {}),
			...(stages.length ? { transitions: withTracks } : {}),
		});
	}
	for (const s of transitions.skipped)
		warnings.push({ clipId: s.transitionId, code: 'TRANSITION_SKIPPED', message: s.reason });

	const anySolo = seq.audioTracks.some((t) => t.solo);
	const audible = seq.audioTracks.filter((t) => !t.mute && (!anySolo || t.solo));
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
				...transitionFields(x),
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
			backgroundColor: seq.settings.backgroundColor,
			sampleRate: 48000,
		},
		range,
		durationFrames: Math.max(0, range.end - range.start),
		videoTracks,
		audioClips,
		media,
		fonts: [...fontKeys.values()],
		master: { volumeDb: seq.master.volumeDb },
		warnings,
	};
}

// ---------------------------------------------------------------- edit-structure: nested audio

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
		for (let f = p0; f < p1; f++) {
			const x = g(f);
			const inner =
				evaluate(a.track.volumeDb, x * F) +
				evaluate(sub.master.volumeDb, x * F) +
				gainToDb(audioFadeGain(a.fades, x)) +
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
		});
	}
	return out;
}

function isAnimatedOrNonZero(a: Animatable<number>): boolean {
	return a.keyframes.length > 0 || a.value !== 0;
}

/** A nested snapshot draws a Remotion-rendered layer (recursively). */
function nestNeedsRemotion(snap: RenderSnapshot): boolean {
	return snap.videoTracks.some(
		(t) => (t.transitions?.length ?? 0) > 0 || t.clips.some((c) => c.engine === 'remotion'),
	);
}
