// Render snapshot (S01:RND-001…005, ARCHITECTURE §5.5): the self-contained JSON value handed to the
// Remotion composition, the native planner and the Program overlay. Keyframes stay unevaluated.
import { compositionOfClip, mergeProps } from '../composition/props.ts';
import { shapeIntrinsicBox } from '../factories.ts';
import { clipEngines, type EngineId, isBoundedContent, kindCapabilities } from '../registry/kinds.ts';
import type { Animatable, RGBA } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { FontRef, MediaAsset } from '../schema/media.ts';
import {
	type BlendMode,
	type Clip,
	type EffectInstance,
	isKnownClipKind,
	type MgRenderer,
	type ShapeData,
	type Speed,
	type TextBox,
	type TextContent,
	type Transform,
} from '../schema/sequence.ts';
import { type ResolvedTextAnimator, resolveTextAnimationWindows } from '../text-animations.ts';
import type { Rational } from '../time.ts';
import {
	type RenderAudioFade,
	type RenderFade,
	type RenderMatte,
	resolveAudioTransitions,
	resolveVideoTransitions,
} from '../transitions.ts';

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
	| { unsupported: string };

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
	 * M2 (S11:LBK-010, wp-m2-layer-bake): a pre-rendered picture of the whole placed layer (sequence space: Motion,
	 * effects, grade, opacity and fades baked, straight alpha) that the composition plays instead of drawing the
	 * layer — the colour-graded master of a DOM layer on the Remotion path. `startFrame` = sequence frame shown by
	 * its frame 0; `rect` = the region of the frame it covers (absent = the whole frame). Set by the engine only.
	 */
	baked?: { url: string; startFrame: number; rect?: { x: number; y: number; w: number; h: number } };
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
	 * colours drawn under the track's clips (the black of a dip to black).
	 */
	videoTracks: { trackId: string; clips: RenderVisualClip[]; mattes?: RenderMatte[] }[];
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
};

const ZERO = { value: 0, keyframes: [] } as Animatable<number>;

function mediaBox(asset: MediaAsset | undefined): { width: number; height: number } | null {
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	if (!asset || !vs || vs.type !== 'video') return null;
	const swap = asset.probe.rotationDegrees === 90 || asset.probe.rotationDegrees === 270;
	return swap ? { width: vs.height, height: vs.width } : { width: vs.width, height: vs.height };
}

function transitionFields(
	x: { headHandle: number; tailHandle: number; fades: RenderFade[] } | undefined,
): Pick<RenderVisualClip, 'headHandle' | 'tailHandle' | 'fades'> {
	if (!x) return {};
	return {
		...(x.headHandle > 0 ? { headHandle: x.headHandle } : {}),
		...(x.tailHandle > 0 ? { tailHandle: x.tailHandle } : {}),
		...(x.fades.length ? { fades: x.fades } : {}),
	};
}

export function buildRenderSnapshot(
	doc: ProjectDocument,
	sequenceId: string,
	opts: SnapshotOptions,
): RenderSnapshot {
	const seq = doc.sequences[sequenceId];
	if (!seq) throw new Error(`Sequence not found: ${sequenceId}`);
	const frame = { width: seq.settings.width, height: seq.settings.height };
	let end = 0;
	for (const c of Object.values(seq.clips)) end = Math.max(end, c.start + c.duration);
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

	const videoTracks: RenderSnapshot['videoTracks'] = [];
	for (const t of seq.videoTracks) {
		if (t.output === false) continue;
		const clips: RenderVisualClip[] = [];
		for (const c of Object.values(seq.clips)) {
			if (c.trackId !== t.id || !inRange(c)) continue;
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
			let box = frame;
			switch (c.kind) {
				case 'video':
				case 'still':
				case 'animated-image': {
					useMedia(c.mediaId);
					source = { mediaId: c.mediaId };
					box = mediaBox(doc.media[c.mediaId]) ?? frame;
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
					box = { width: c.box.width, height: c.box.height };
					const font = doc.fonts[c.content.style.fontId];
					if (font) {
						const key = `${font.id}:${c.content.style.weight}:${c.content.style.italic}`;
						if (!fontKeys.has(key)) {
							const url = opts.resolveFont(font, c.content.style.weight, c.content.style.italic);
							if (url) {
								fontKeys.set(key, {
									fontId: font.id,
									family: font.family,
									weight: c.content.style.weight,
									style: c.content.style.italic ? 'italic' : 'normal',
									url,
								});
							}
						}
					}
					break;
				}
				case 'solid': {
					const syn = doc.synthetics[c.syntheticId];
					source = {
						color:
							syn?.kind === 'color-matte'
								? syn.color
								: syn?.kind === 'transparent'
									? [0, 0, 0, 0]
									: [0, 0, 0, 1],
					};
					break;
				}
				case 'motion-graphic': {
					const canvas = c.canvas === 'sequence' ? frame : { width: c.canvas.width, height: c.canvas.height };
					const { renderer, ...template } = c.template;
					source = {
						mg: {
							template,
							params: c.params,
							canvas,
							...(renderer === 'anime' ? { renderer } : {}),
						},
					};
					box = canvas;
					break;
				}
				case 'shape': {
					source = { shape: c.shape };
					box = shapeIntrinsicBox(c.shape);
					break;
				}
				case 'composition': {
					const canvas = c.canvas === 'sequence' ? frame : { width: c.canvas.width, height: c.canvas.height };
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
							canvas,
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
					box = canvas;
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
				engine: clipEngines(c)?.export ?? caps.engines.export,
				...(c.kind === 'animated-image' ? { loop: c.loop } : {}),
				bounded: isBoundedContent(c),
				...transitionFields(transitions.clips.get(c.id)),
			});
		}
		clips.sort((a, b) => a.start - b.start);
		const mattes = (transitions.mattes.get(t.id) ?? []).filter(
			(m) => m.start < range.end && m.start + m.duration > range.start,
		);
		videoTracks.push({ trackId: t.id, clips, ...(mattes.length ? { mattes } : {}) });
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
		for (const c of Object.values(seq.clips)) {
			if (c.trackId !== t.id || !audioInRange(c) || c.kind !== 'audio') continue;
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
				...(x && x.headHandle > 0 ? { headHandle: x.headHandle } : {}),
				...(x && x.tailHandle > 0 ? { tailHandle: x.tailHandle } : {}),
				...(x?.fades.length ? { fades: x.fades } : {}),
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
