// Native export builder (S03:ENG-030, S04:RN-021/022, ARCHITECTURE §9.5): one input per clip with input
// seeking; per layer setpts (speed) → fps → scale to the box → format=rgba → effects in stack order (crop where it sits, crop.ts) → Motion: flips →
// scale → rotate (premultiplied, transparent, grown bounds) → alpha multiply → overlay at the offset derived from
// the @jasper/project layer matrix; bottom → top over a `color` background; audio = the offline mixer's mixdown
// (audio-mix, `audio/mixdown.ts`) as one more input, resampled with SoX when the delivered rate differs;
// keyframed Opacity and crop edges are sampled per frame into per-frame expressions (S03:ENG-032,
// `keyframed.ts`); layers whose geometry is not whole pixels (keyframed Motion, fractional position/scale/rotation/crop)
// are drawn sub-pixel by our kernel and streamed in on pipes (`stream/`, `NativeGraph.streams`);
// the selected video encoder (D-13: hardware H.264 / OpenH264 / libx264 in dev / AV1 / VP9) with bt709 tags +
// AAC (MP4, faststart) or Opus (WebM). Inputs are referenced by index only (S04:SC-004).
// Transitions (S01 §13) are built in: a clip's layer also covers its handles, the transition ramps become
// `fade=…:alpha=1` on the layer (the same linear ramps `fadeFactor` evaluates for the composition), the black
// of a dip to black is a colour layer under the track's clips (audio crossfades are part of the mixdown).

import {
	blendModeIndex,
	clipContentTime,
	clipPictureTime,
	defaultEffectRegistry,
	dissolveSeed,
	type EffectRegistry,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	isAnimated,
	maskExportRoute,
	type Rational,
	type RenderFade,
	type RenderSnapshot,
	type RenderVisualClip,
	type ResolvedLayerProps,
	resolveLayerProps,
} from '@jasper/project';
import { resamplerArgs } from '../audio/decode.ts';
import { colorTagArgs, outputFilters, svtHdrParams } from '../color/output.ts';
import { decoderArgs, sourceFilters } from '../imports/decode.ts';
import { variantHasAlpha } from '../imports/variants.ts';
import { alphaDecoder } from '../media/alpha.ts';
import { audioEncodeArgs, LEGACY_X264_CHOICE, videoEncodeArgs } from '../tools/encoders.ts';
import { sec } from '../tools/ffmpeg.ts';
import { adjustmentCropFilters, cropFeatherFilter, hardCropFilter, isFeatheredCrop } from './crop.ts';
import { CROP_EDGES, mergeResize, motionFilters, motionStage } from './keyframed.ts';
import {
	BUILTIN_NATIVE_EFFECTS,
	type LayerOverride,
	type NativeExtension,
	type PreparedExtensions,
} from './native-ext.ts';
import { audioCodecOf, type LocalMedia, type OutputSpec } from './planner.ts';
import { needsSubpixel, planStreamLayer, type StreamLayerPlan } from './stream/plan.ts';

/**
 * swscale flags for every YUV ↔ RGB conversion of the composite. Without `accurate_rnd` the default
 * converters round down (a full-frame clip came out about one code value darker per generation), and
 * without the full-chroma flags 4:2:0 chroma is up/down-sampled with the cheap horizontal path.
 */
export const SWS_FLAGS = 'flags=bicubic+accurate_rnd+full_chroma_int+full_chroma_inp';
/**
 * BT.709 tags on the frames themselves. FFmpeg 7.1 takes an encoder's colour description from its input
 * frames, so `-color_primaries` / `-color_trc` alone left ProRes masters untagged (and H.264 half tagged).
 */
export const BT709_FRAME_TAGS = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
const OFFLINE_RGBA: [number, number, number, number] = [0.55, 0.05, 0.08, 1];

type NativeSourceResolver = {
	/** Online local media for a mediaId (null = offline). */
	media(mediaId: string): LocalMedia | null;
	/** Motion-graphic master file (ProRes 4444, frame 0 = clip start) for a clip, from WP-2G. */
	mgMaster(clipId: string): string | null;
};

type NativeBuildOptions = {
	snapshot: RenderSnapshot;
	output: OutputSpec;
	outputFile: string;
	sources: NativeSourceResolver;
	threads: number;
	/** Single-frame PNG (stills): no audio, RGB output. */
	still?: boolean;
	/** M2 native extensions (ARCHITECTURE §19.6) and what their `prepare` returned for this export. */
	extensions?: { list: readonly NativeExtension[]; prepared: PreparedExtensions };
	/** audio-mix: the mixdown WAV of the export range (absent = silence; stills have no audio). */
	audio?: {
		file: string;
		sampleRate: number;
		soxr?: boolean;
		/** The delivery's checked encode of `file` (deliver.ts): muxed by stream copy instead of encoding `file`. */
		encoded?: string;
	};
	/** edit-structure: what the extensions prepared for each nested sequence (`nestPath` keys). */
	nested?: ReadonlyMap<string, PreparedExtensions>;
	/**
	 * color-mgmt: the working → output (exports) or working → display (stills) LUT filter (`lut3d=…`), null when the
	 * output is the working space. The tags, matrix and bit depth come from `output.color`.
	 */
	colorLut?: string | null;
};

type NativeGraph = {
	/** ffmpeg arguments without the global `-hide_banner … -progress` prefix. */
	args: string[];
	/** Filtergraph text (tests; also written to a script file when large). */
	filter: string;
	inputs: string[][];
	outputFrames: number;
	durationSec: number;
	/**
	 * Sub-pixel layers (stream/plan.ts): raw RGBA frames the caller writes to the composite's pipe `fd`
	 * (`streamLayer`, spawn the composite with `pipes: streams.length`, fds 3, 4, …).
	 */
	streams: { fd: number; plan: StreamLayerPlan }[];
	/**
	 * keyframes-blend: the processes before this one when the stack has blend layers (in order). Segment i's raw
	 * output (`2W×H` RGBA: composite ‖ layer) goes through the blend kernel into the next process's `pipe:3`
	 * (segment i + 1, or this graph: `backdropFd`; spawn it with `pipes: 1 + streams.length`, streams from fd 4).
	 */
	blend?: { segments: BlendSegment[]; backdropFd: number; width: number; height: number };
};

/** BLEND_MODES indexes of Stencil Alpha … Silhouette Luma. */
const STENCIL_FIRST = blendModeIndex('stencil-alpha');
const STENCIL_LAST = blendModeIndex('silhouette-luma');

/** keyframes-blend: one process of the blend pipeline and the blend its output goes through. */
export type BlendSegment = {
	/** ffmpeg arguments (without the global prefix); raw `2W×H` RGBA frames on stdout. */
	args: string[];
	filter: string;
	/** Sub-pixel streams of this process (fds after its backdrop pipe). */
	streams: { fd: number; plan: StreamLayerPlan }[];
	/** fd of this process's backdrop pipe (the previous kernel's output); null for the first. */
	backdropFd: number | null;
	/** Frames on stdout (the stack's frames + 1 margin). */
	frames: number;
	/** BLEND_MODES index of the layer. */
	mode: number;
	/** Per output frame: the layer is drawn (else the composite passes through) and its Dissolve seed. */
	active: boolean[];
	seeds: number[];
};

/** The frames a blend layer is drawn on (relative to the stack's first frame) and its Dissolve seeds. */
function blendSegmentFrames(
	plan: LayerPlan,
	mode: string,
	R0: number,
	frames: number,
): Pick<BlendSegment, 'frames' | 'mode' | 'active' | 'seeds'> {
	const active: boolean[] = [];
	const seeds: number[] = [];
	const key = 'clip' in plan ? plan.clip.clipId : 'span' in plan && plan.t ? `transition:${plan.t.id}` : '';
	const start = 'clip' in plan ? plan.clip.start : 'span' in plan && plan.t ? plan.t.start : 0;
	for (let j = 0; j < frames; j++) {
		const f = R0 + j;
		active.push(f >= plan.f0 && f < plan.f1);
		seeds.push(dissolveSeed(key, f - start));
	}
	return { frames, mode: blendModeIndex(mode), active, seeds };
}

const fmt = (n: number) => {
	const r = Math.round(n * 1e6) / 1e6;
	return Object.is(r, -0) ? '0' : String(r);
};

function colorHex([r, g, b, a]: readonly number[]): string {
	const c = (x: number) =>
		Math.round(Math.min(1, Math.max(0, x ?? 0)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `0x${c(r!)}${c(g!)}${c(b!)}${c(a ?? 1)}`;
}

function rate(r: Rational): string {
	return `${r.num}/${r.den}`;
}

/** Matrix of `in_color_matrix` for a probed stream (untagged HD is BT.709 like browsers assume). */
export function inColor(m: LocalMedia | null): string {
	const vs = m?.record.probe.streams.find((s) => s.type === 'video');
	if (vs?.type !== 'video') return '';
	const matrix = vs.color.matrix;
	// color-mgmt: BT.2020 (HDR / wide-gamut) media decode with the BT.2020 non-constant-luminance matrix.
	const cm =
		matrix === 'bt709'
			? 'bt709'
			: matrix === 'bt2020nc' || matrix === 'bt2020c'
				? 'bt2020'
				: matrix === 'bt470bg' || matrix === 'smpte170m'
					? 'bt601'
					: vs.height >= 720
						? 'bt709'
						: 'bt601';
	return `:in_color_matrix=${cm}:in_range=${vs.color.range === 'pc' ? 'pc' : 'tv'}`;
}

type LayerPlan =
	| { clip: RenderVisualClip; f0: number; f1: number }
	/** Full-frame colour under a track's clips (the black of a dip to black). */
	| { matte: { color: readonly number[] }; f0: number; f1: number }
	/** wave1c: the pre-rendered span of a GPU transition (sides + stage, a `sequence` override). */
	| {
			span: LayerOverride;
			f0: number;
			f1: number;
			/** keyframes-blend: the transition, and its sides' common blend mode (Normal when they differ). */
			t?: { id: string; start: number };
			blendMode?: string;
	  };

/**
 * Transition ramps of a layer whose first frame is sequence frame `f0`, as ffmpeg `fade` filters on the
 * alpha channel. `fade` counts frames from the layer's first one and cannot start before it, so a ramp that
 * begins earlier (a cross dissolve's ramp starts one frame before the span; a range export may start inside
 * a ramp) gets `pad` throwaway frames in front, removed again after the fades.
 */
export function fadeFilters(fades: readonly RenderFade[] | undefined, f0: number): string[] {
	const live = (fades ?? []).filter((f) => !(f.type === 'in' && f.start + f.frames <= f0));
	if (live.length === 0) return [];
	const pad = Math.max(0, ...live.map((f) => f0 - f.start));
	return [
		...(pad > 0 ? [`tpad=start=${pad}`] : []),
		...live.map((f) => `fade=t=${f.type}:s=${f.start - f0 + pad}:n=${f.frames}:alpha=1`),
		...(pad > 0 ? [`trim=start_frame=${pad}`] : []),
	];
}

/**
 * The override a layer is drawn from: the first `sequence` override (a fully placed layer, e.g. the warp stage,
 * which sources the picture itself from an earlier extension's `layer` override, ARCHITECTURE §19.6), else the
 * first `layer` override, else null.
 */
function pickOverride(
	list: readonly NativeExtension[],
	prepared: PreparedExtensions,
	clip: RenderVisualClip,
): LayerOverride | null {
	let first: LayerOverride | null = null;
	for (const ext of list) {
		const o = ext.override?.(clip, prepared.get(ext.id));
		if (!o) continue;
		if (o.space === 'sequence') return o;
		first ??= o;
	}
	return first;
}

/**
 * M2 (S11:LBK-010): the filters of a clip's colour runs (D-21), asked from the extensions that realise colour
 * effects (the colour extension: `lut3d` of the fused run, per-frame windows counted from `f0`). Used for the
 * `colorRuns` of an override (a DOM layer baked without its grade) and for the graded masters of the layer bake.
 * Pointwise LUTs on straight-alpha RGB equal grading before placement (colour ops have no spatial context).
 */
export function colorRunFilters(o: {
	clip: RenderVisualClip;
	/** The clip's props at `f0` (effects evaluated there). */
	props: ResolvedLayerProps;
	box: { width: number; height: number };
	fps: Rational;
	f0: number;
	f1: number;
	extensions: { list: readonly NativeExtension[]; prepared: PreparedExtensions };
	effects?: EffectRegistry;
}): string[] {
	const registry = o.effects ?? defaultEffectRegistry;
	const out: string[] = [];
	for (const [index, fx] of o.props.effects.entries()) {
		if (!fx.enabled || !registry.get(fx.effectId, fx.effectVersion)?.color) continue;
		for (const ext of o.extensions.list) {
			const text = ext.effectFilter?.(fx, {
				clip: o.clip,
				effects: o.props.effects,
				index,
				box: o.box,
				fps: o.fps,
				f0: o.f0,
				f1: o.f1,
				prepared: o.extensions.prepared.get(ext.id),
			});
			if (text === undefined) continue;
			if (text) out.push(text);
			break;
		}
	}
	return out;
}

type LayerSourceOptions = {
	clip: RenderVisualClip;
	/** First drawn and one-past-last sequence frame of the layer. */
	f0: number;
	f1: number;
	fps: Rational;
	/** The clip's props at `f0` (effects are evaluated there); default: resolved here. */
	props?: ResolvedLayerProps;
	sources: NativeSourceResolver;
	/** A `layer` override replaces the decoded source (other spaces are ignored here). */
	override?: LayerOverride | null;
	/** Extensions asked for the filters of effects the builder does not know. */
	extensions?: { list: readonly NativeExtension[]; prepared: PreparedExtensions };
	/** Adds an ffmpeg input (argument list before and including `-i <path>`); returns its index. */
	addInput(args: string[]): number;
	/** Label prefix for sub-graphs of the chain (unique in the filtergraph; default `src`). */
	label?: string;
	/** Leave the hard crops out: the sub-pixel layer kernel clips to them with anti-aliased edges (stream/plan.ts). */
	skipCrop?: boolean;
	/** edit-structure: the source is the composite stream `label` (adjustment layers), frame 0 = sequence `R0`. */
	composite?: { label: string; R0: number };
	/** edit-structure: how nested sequences of nest clips are drawn (see `drawStack`). */
	nest?: {
		nested?: ReadonlyMap<string, PreparedExtensions>;
		path: string;
		threads: number;
		addStream?: (plan: StreamLayerPlan) => number;
	};
};

/** Key of a nested sequence's prepared extensions: the chain of nest clip ids from the exported sequence. */
export function nestPath(parent: string, clipId: string): string {
	return parent ? `${parent}>${clipId}` : clipId;
}

type LayerSourceChain = {
	/** Input pad of the chain (`[k:v:0]`), or '' when the chain starts with a source filter (solids). */
	input: string;
	/** Filters from the decoded source to the layer after its effects (RGBA, box-sized, frames from pts 0). */
	filters: string[];
	/** Frame size of the chain's output (the rounded intrinsic box). */
	width: number;
	height: number;
	/**
	 * The chain's scale to the box (`filters[index]` = `scale=<w>:<h><options>`) when only `setsar`/`format` follow
	 * it (no effects): Motion may scale there directly (one resample, `mergeResize`). Null otherwise.
	 */
	resize: { index: number; options: string } | null;
	/** Opaque pixels or transparent black only (no partial alpha over colour, see `MotionStageOptions.opaque`). */
	opaque: boolean;
};

/**
 * A layer's picture up to, not including, Motion (ARCHITECTURE §19.5, S09:TRK-032): input seeking, speed,
 * frame rate conform, scale to the intrinsic box, `rgba`, then its effects in stack order (built-in crop/flips,
 * extension effect filters). Yields the `f1 − f0` frames of the layer starting at pts 0. Used by the native
 * builder and by the warp stage (which pipes these frames out and warps them itself).
 */
export function layerSourceChain(o: LayerSourceOptions): LayerSourceChain {
	const { clip: c, fps } = o;
	const label = o.label ?? 'src';
	const exts = o.extensions;
	const props = o.props ?? resolveLayerProps(c, clipContentTime(c, o.f0, fps));
	const override = o.override?.space === 'layer' ? o.override : null;
	const addInput = o.addInput;
	const frameSec = fps.den / fps.num;
	const bw = Math.max(1, Math.round(c.intrinsicBox.width));
	const bh = Math.max(1, Math.round(c.intrinsicBox.height));
	const f: string[] = [];
	let src: string;
	const margin = 2 * frameSec;
	let resize: LayerSourceChain['resize'] = null;
	let opaque = false;
	/** The scale to the box (+ `setsar`, `rgba`); `options` follow the size (colour matrix, swscale flags). */
	const resizeAt = (options: string) => {
		resize = { index: f.length, options };
		f.push(`scale=${bw}:${bh}${options}`, 'setsar=1', 'format=rgba');
	};
	// edit-structure (freeze-frame transition handles): the source is built for the frames the media has, then its
	// first / last frame is repeated over the frozen part of the handles (`tpad` clone).
	const firstReal = c.start - (c.headHandle ?? 0) + (c.freezeHead ?? 0);
	const lastReal = c.start + c.duration + (c.tailHandle ?? 0) - (c.freezeTail ?? 0);
	const f0 = c.freezeHead ? Math.min(Math.max(o.f0, firstReal), o.f1 - 1) : o.f0;
	const f1 = c.freezeTail ? Math.max(Math.min(o.f1, lastReal), f0 + 1) : o.f1;
	const n = f1 - f0;
	const padHead = f0 - o.f0;
	const padTail = o.f1 - f1;
	// edit-structure (Frame Hold): the content time of the picture (constant under a hold).
	const pictureSec = (frame: number) => clipPictureTime(c, frame, fps) / FLICKS_PER_SECOND;
	/** Repeats one decoded frame for the layer's frames (frame holds). */
	const holdFilters = () => [
		'trim=end_frame=1',
		'setpts=PTS-STARTPTS',
		`loop=loop=${n}:size=1`,
		`setpts=N/(${fps.num}/${fps.den})/TB`,
		`fps=${rate(fps)}`,
		`trim=end_frame=${n}`,
	];

	const local = 'mediaId' in c.source ? o.sources.media(c.source.mediaId) : null;
	const mg = c.kind === 'motion-graphic' ? o.sources.mgMaster(c.clipId) : null;
	if (o.composite) {
		// edit-structure: an adjustment layer's source is the composite below it.
		src = `[${o.composite.label}]`;
		f.push(
			`trim=start_frame=${f0 - o.composite.R0}`,
			'setpts=PTS-STARTPTS',
			`trim=end_frame=${n}`,
			'format=rgba',
		);
	} else if (override?.still) {
		// edit-structure: a still picture for the whole layer (Bars and Tone).
		const k = addInput([
			'-loop',
			'1',
			'-framerate',
			rate(fps),
			'-t',
			sec(n * frameSec + margin),
			'-i',
			override.path,
		]);
		src = `[${k}:v:0]`;
		f.push('setpts=PTS-STARTPTS', `fps=${rate(fps)}`, `trim=end_frame=${n}`);
		resizeAt(`:${SWS_FLAGS}`);
	} else if (override && override.contentOrigin !== undefined) {
		// edit-structure: the intermediate holds the clip's content from `contentOrigin` (counting leader): seek and
		// play it like media (speed, frame hold).
		const startSec = Math.max(0, pictureSec(f0) - override.contentOrigin / FLICKS_PER_SECOND);
		const k = addInput([
			...(override.decoder ? ['-c:v', override.decoder] : []),
			'-ss',
			sec(startSec),
			'-t',
			sec(c.frameHold ? margin : n * frameSec * c.speed.rate + margin),
			'-i',
			override.path,
		]);
		src = `[${k}:v:0]`;
		if (c.frameHold) f.push(...holdFilters());
		else f.push(`setpts=(PTS-STARTPTS)/${fmt(c.speed.rate)}`, `fps=${rate(fps)}`, `trim=end_frame=${n}`);
		resizeAt(`:${SWS_FLAGS}`);
	} else if (override) {
		// A held clip shows the master's frame at its held local frame (a retimed intermediate already holds it).
		const held = !!c.frameHold && !override.retimed;
		const shown = held ? c.start + heldLocalFrame(c, fps) : f0;
		const k = addInput([
			...(override.decoder ? ['-c:v', override.decoder] : []),
			'-ss',
			sec((shown - override.startFrame) * frameSec),
			'-t',
			sec(held ? margin : n * frameSec + margin),
			'-i',
			override.path,
		]);
		src = `[${k}:v:0]`;
		if (held) f.push(...holdFilters());
		else f.push('setpts=PTS-STARTPTS', `fps=${rate(fps)}`, `trim=end_frame=${n}`);
		resizeAt(`:${SWS_FLAGS}`);
		if (override.retimed) opaque = !(local?.record.probe.hasAlpha ?? false);
	} else if ('nest' in c.source) {
		// edit-structure: the nested sequence's own stack (transparent background, nested frame size, parent rate),
		// drawn in this graph; its frames are mapped to the layer's by the clip's picture time.
		const sub = c.source.nest.snapshot;
		const childPath = nestPath(o.nest?.path ?? '', c.clipId);
		const prepared = o.nest?.nested?.get(childPath);
		const subChains: string[] = [];
		const out = drawStack({
			snap: sub,
			P: `${label}n`,
			addInput,
			chains: subChains,
			...(o.nest?.addStream ? { addStream: o.nest.addStream } : {}),
			sources: o.sources,
			threads: o.nest?.threads ?? 1,
			...(exts && prepared ? { exts: { list: exts.list, prepared } } : {}),
			...(o.nest?.nested ? { nested: o.nest.nested } : {}),
			path: childPath,
		});
		src = `${subChains.join(';\n')};\n[${out}]`;
		const F = flicksPerFrame(fps);
		const n0 = sub.range.start;
		if (c.frameHold) {
			const kh = Math.max(0, Math.floor(c.frameHold.flicks / F + 1e-6) - n0);
			f.push(`trim=start_frame=${kh}`, ...holdFilters());
		} else {
			// Exact frame mapping: output frame j shows nested frame floor(k + j·speed) (as the composition does).
			const k = clipPictureTime(c, f0, fps) / F - n0;
			const i0 = Math.max(0, Math.floor(k + 1e-6));
			// (A fine time base first: `setpts` truncates to it, and the stack's 1/fps would merge frames.)
			f.push(
				`trim=start_frame=${i0}`,
				'settb=AVTB',
				`setpts=(N+${fmt(i0 - k)})/${fmt(c.speed.rate)}/(${fps.num}/${fps.den})/TB`,
				`fps=fps=${rate(fps)}:round=up:start_time=0`,
				`trim=end_frame=${n}`,
			);
		}
		f.push('format=rgba');
	} else if ((c.kind === 'video' || c.kind === 'animated-image') && local) {
		const startSec = pictureSec(f0);
		const srcDur = c.frameHold ? margin : n * frameSec * c.speed.rate + margin;
		const dec = alphaDecoder(local.record.probe);
		// imports (Interpret Footage): decode transfer, deinterlace and alpha interpretation right after decoding.
		const interp = sourceFilters(local.record, local.pixel);
		// WebM alpha is a second VP8/VP9 stream whose keyframes need not line up with the colour stream's:
		// after an input seek to a colour keyframe libvpx may get a non-key alpha frame first and reject
		// every packet ("Bitstream not supported", seen with VP8). Such inputs are decoded from their start
		// and trimmed in the graph (overlays are short).
		const decodeFromStart = dec !== null && startSec > 0;
		const k = addInput([
			...(dec ? ['-c:v', dec] : []),
			...decoderArgs(local.record),
			...(decodeFromStart ? ['-t', sec(startSec + srcDur)] : ['-ss', sec(startSec), '-t', sec(srcDur)]),
			'-i',
			local.path,
		]);
		src = `[${k}:v:0]`;
		f.push(...interp);
		if (decodeFromStart) f.push(`trim=start=${fmt(startSec)}`);
		if (c.frameHold) f.push(...holdFilters());
		else f.push(`setpts=(PTS-STARTPTS)/${fmt(c.speed.rate)}`, `fps=${rate(fps)}`, `trim=end_frame=${n}`);
		resizeAt(`${inColor(local)}:${SWS_FLAGS}`);
		opaque = !variantHasAlpha(local.record, local.pixel ?? null);
	} else if (c.kind === 'still' && local) {
		// imports: a prepared display picture (Photoshop composite) has its interpretation applied already.
		const file = local.display ?? local.path;
		const k = addInput([
			...(local.display ? [] : decoderArgs(local.record)),
			'-loop',
			'1',
			'-framerate',
			rate(fps),
			'-t',
			sec(n * frameSec + margin),
			'-i',
			file,
		]);
		src = `[${k}:v:0]`;
		if (!local.display) f.push(...sourceFilters(local.record, local.pixel));
		f.push('setpts=PTS-STARTPTS', `fps=${rate(fps)}`, `trim=end_frame=${n}`);
		resizeAt(`${local.display ? '' : inColor(local)}:${SWS_FLAGS}`);
		opaque = !variantHasAlpha(local.record, local.pixel ?? null);
	} else if (c.kind === 'motion-graphic' && mg) {
		const shown = c.frameHold ? c.start + heldLocalFrame(c, fps) : f0;
		const startSec = (shown - c.start) * frameSec;
		const k = addInput([
			'-ss',
			sec(startSec),
			'-t',
			sec(c.frameHold ? margin : n * frameSec + margin),
			'-i',
			mg,
		]);
		src = `[${k}:v:0]`;
		if (c.frameHold) f.push(...holdFilters());
		else f.push('setpts=PTS-STARTPTS', `fps=${rate(fps)}`, `trim=end_frame=${n}`);
		resizeAt('');
	} else {
		// Solids, and offline media as the "Media Offline" colour card (S04:AS-010).
		const rgba = 'color' in c.source ? c.source.color : OFFLINE_RGBA;
		opaque = (rgba[3] ?? 1) >= 1;
		src = '';
		f.push(
			`color=c=${colorHex(rgba)}:s=${bw}x${bh}:r=${rate(fps)}:d=${fmt(n * frameSec + frameSec)}`,
			'format=rgba',
			`trim=end_frame=${n}`,
		);
	}

	// Effects in stack order (schema v8: Crop where it sits, crop.ts); only native-capable ones reach here.
	// Effects the builder does not know are asked to the M2 extensions (§19.6), e.g. fused colour LUTs.
	for (const [index, fx] of props.effects.entries()) {
		if (!fx.enabled) continue;
		if (!BUILTIN_NATIVE_EFFECTS.has(fx.effectId)) {
			for (const ext of exts?.list ?? []) {
				const text = ext.effectFilter?.(fx, {
					clip: c,
					effects: props.effects,
					index,
					box: { width: bw, height: bh },
					fps,
					f0,
					f1,
					prepared: exts?.prepared.get(ext.id),
				});
				if (text === undefined) continue;
				if (text) f.push(text);
				break;
			}
			continue;
		}
		if (fx.effectId === 'jasper.crop') {
			// edit-structure: an adjustment layer's crops limit its region: applied after the effects (below).
			if (o.composite) continue;
			const applied = c.effects[index];
			if (!applied) continue;
			// Edge Feather: the alpha × the shared feather profile, at its place on every path (crop.ts).
			if (isFeatheredCrop(applied)) {
				f.push(cropFeatherFilter({ clip: c, effect: applied, f0, f1, fps, bw, bh, label: `${label}cf${index}` }));
				continue;
			}
			// Hard crops of a sub-pixel layer are the kernel's anti-aliased clip (stream/plan.ts `cropAt`).
			if (o.skipCrop) continue;
			const cut = hardCropFilter({
				clip: c,
				effect: applied,
				params: fx.params,
				f0,
				f1: n > 1 ? f1 : f0 + 1,
				fps,
				bw,
				bh,
				label: `${label}cr${index}`,
			});
			if (cut) f.push(cut);
		} else if (fx.effectId === 'jasper.flip-horizontal') f.push('hflip');
		else if (fx.effectId === 'jasper.flip-vertical') f.push('vflip');
	}
	if (o.composite) {
		// edit-structure (KND-012): the adjusted composite replaces the original (premultiplied, alpha 1: a blur darkens
		// the frame edges as in Premiere), then the crops limit the region (each window mirrored by the flips after its
		// crop; feathered ones fade it in); opacity and fades then mix it in (overlay).
		f.push(
			'premultiply=inplace=1',
			'lutrgb=a=maxval',
			...adjustmentCropFilters({
				clip: c,
				f0,
				f1: n > 1 ? f1 : f0 + 1,
				fps,
				bw,
				bh,
				label,
				paramsAt: (i) => props.effects[i]?.params ?? {},
			}),
		);
	}
	if (padHead > 0 || padTail > 0) {
		f.push(
			`tpad=${padHead > 0 ? `start=${padHead}:start_mode=clone` : ''}${padHead > 0 && padTail > 0 ? ':' : ''}${padTail > 0 ? `stop=${padTail}:stop_mode=clone` : ''}`,
		);
	}
	// Effects after the box scale: Motion scales separately; only colour ops, flips and a static crop (transparent
	// black) keep the pixels opaque-or-clear.
	const afterResize = resize ? (resize as { index: number }).index + 3 : -1;
	if (f.length !== afterResize) resize = null;
	for (const fx of props.effects) {
		if (!fx.enabled || fx.effectId === 'jasper.flip-horizontal' || fx.effectId === 'jasper.flip-vertical')
			continue;
		if (fx.effectId === 'jasper.crop') {
			// A static hard crop cuts to transparent black; keyframed edges and Edge Feather leave partial alpha.
			const applied = c.effects.find((x) => x.id === fx.id);
			if (applied && !isFeatheredCrop(applied) && !CROP_EDGES.some((e) => isAnimated(applied.params[e])))
				continue;
		}
		if (defaultEffectRegistry.get(fx.effectId, fx.effectVersion)?.color) continue;
		opaque = false;
	}
	return {
		input: src,
		filters: f,
		width: bw,
		height: bh,
		resize,
		opaque: opaque && (!override || !!override.retimed),
	};
}

/**
 * keyframes-blend: the blend mode a layer composites with — a clip's own; a pre-rendered GPU transition span the sides'
 * common mode (as the composition's stage); mattes are Normal.
 */
function layerBlendMode(layer: LayerPlan): string {
	if ('clip' in layer) return layer.clip.blendMode ?? 'normal';
	if ('span' in layer) return layer.blendMode ?? 'normal';
	return 'normal';
}

/** A transparent `W×H` RGBA stream the length of the stack (a blend layer is placed on it). */
function transparentBase(ctx: StackContext, label: string): string {
	const { snap } = ctx;
	const fps = snap.settings.fps;
	const frameSec = fps.den / fps.num;
	const T = (snap.range.end - snap.range.start) * frameSec;
	ctx.chains.push(
		`color=c=black@0:s=${snap.settings.width}x${snap.settings.height}:r=${rate(fps)}:d=${fmt(T + frameSec)},format=rgba[${label}]`,
	);
	return label;
}

/** What `drawStack` needs to composite one snapshot's video tracks (the sequence, or a nested sequence). */
type StackContext = {
	snap: RenderSnapshot;
	/** Label prefix (unique per stack in the graph). */
	P: string;
	addInput(args: string[]): number;
	chains: string[];
	/** Main-graph sub-pixel streams; absent in decoder graphs (warp/stream decoders): nested layers there need none. */
	addStream?: (plan: StreamLayerPlan) => number;
	sources: NativeSourceResolver;
	threads: number;
	exts?: { list: readonly NativeExtension[]; prepared: PreparedExtensions };
	/** edit-structure: what the extensions prepared for nested sequences, by nest path (`clipId>clipId…`). */
	nested?: ReadonlyMap<string, PreparedExtensions>;
	/** Nest path of this stack ('' = the sequence). */
	path: string;
	/**
	 * keyframes-blend (the sequence's own stack only): ends the current process of the pipeline at a blend layer —
	 * `backdrop` (the composite below) and `layer` (the layer on transparency) go to the blend kernel — and returns the
	 * label of the kernel's output in the next process, where the stack continues.
	 */
	blend?: { cut(backdrop: string, layer: string, plan: LayerPlan, mode: string): string };
};

/**
 * Composites the video tracks of `ctx.snap` bottom → top over its background and returns the label of the
 * `W×H` RGBA stream (frame 0 = `snap.range.start`, `range.end − range.start` frames + 1 margin frame).
 * edit-structure: adjustment layers process the composite so far (`split`), nest clips draw their nested stack
 * (recursively, `layerSourceChain`).
 */
function drawStack(ctx: StackContext): string {
	// keyframes-blend: `ctx.chains` / `ctx.addInput` / `ctx.addStream` are read at each use: a blend cut (`ctx.blend`)
	// moves the rest of the stack to the next process of the pipeline.
	const { snap, P, sources: srcs, threads, exts } = ctx;
	const fps = snap.settings.fps;
	const W = snap.settings.width;
	const H = snap.settings.height;
	const R0 = snap.range.start;
	const R1 = snap.range.end;
	const frameSec = fps.den / fps.num;
	const T = (R1 - R0) * frameSec;
	// Background: sequence-sized, sequence colour, one extra frame of margin (the final trim is exact).
	const bgLabel = `${P}bg`;
	ctx.chains.push(
		`color=c=${colorHex(snap.settings.backgroundColor)}:s=${W}x${H}:r=${rate(fps)}:d=${fmt(T + frameSec)},format=rgba[${bgLabel}]`,
	);
	let last = bgLabel;
	let li = 0;

	const layers: LayerPlan[] = [];
	for (const track of snap.videoTracks) {
		for (const m of track.mattes ?? []) {
			const f0 = Math.max(m.start, R0);
			const f1 = Math.min(m.start + m.duration, R1);
			if (f1 > f0) layers.push({ matte: m, f0, f1 });
		}
		// wave1c: GPU transitions an extension pre-rendered: their spans replace the sides (drawn above the track's
		// clips, like the composition's stage); the side clips are drawn only outside them.
		const spans: {
			t: { id: string; start: number; duration: number };
			ov: LayerOverride;
			sides: Set<string>;
			blendMode: string;
		}[] = [];
		for (const t of track.transitions ?? []) {
			const ov = exts
				? (exts.list.map((e) => e.transitionOverride?.(t, exts.prepared.get(e.id)) ?? null).find((x) => x) ??
					null)
				: null;
			if (ov) {
				const sides = new Set([t.outgoingClipId, t.incomingClipId].filter((x): x is string => !!x));
				const modes = new Set(track.clips.filter((c) => sides.has(c.clipId)).map((c) => c.blendMode));
				spans.push({ t, ov, sides, blendMode: modes.size === 1 ? [...modes][0]! : 'normal' });
			}
		}
		for (const c of track.clips) {
			// With transitions a clip is drawn from its head handle to the end of its tail handle (S01:TRN-003).
			let f0 = Math.max(c.start - (c.headHandle ?? 0), R0);
			let f1 = Math.min(c.start + c.duration + (c.tailHandle ?? 0), R1);
			for (const sp of spans) {
				if (!sp.sides.has(c.clipId)) continue;
				const a = sp.t.start;
				const b = sp.t.start + sp.t.duration;
				// The span sits at one end of the clip (it is a side): cut that end off.
				if (a <= f0) f0 = Math.max(f0, b);
				else f1 = Math.min(f1, a);
			}
			if (f1 > f0) layers.push({ clip: c, f0, f1 });
		}
		for (const sp of spans) {
			const f0 = Math.max(sp.t.start, R0);
			const f1 = Math.min(sp.t.start + sp.t.duration, R1);
			if (f1 > f0)
				layers.push({ span: sp.ov, f0, f1, t: { id: sp.t.id, start: sp.t.start }, blendMode: sp.blendMode });
		}
	}

	const half = frameSec / 2;
	for (const layer of layers) {
		// keyframes-blend: a layer with a blend mode is drawn onto a transparent frame and handed, with the composite
		// below it, to the blend kernel between two processes of the pipeline (`ctx.blend.cut`).
		const blendMode = ctx.blend ? layerBlendMode(layer) : 'normal';
		let backdrop: string | null = null;
		if (blendMode !== 'normal' && !('clip' in layer && layer.clip.kind === 'adjustment')) {
			backdrop = last;
			last = transparentBase(ctx, `${P}tb${li}`);
		}
		// One layer onto `last` (a closure: the paths return early).
		const drawLayer = (): void => {
			const { f0, f1 } = layer;
			const n = f1 - f0;
			const t0 = (f0 - R0) * frameSec;
			const shift = `setpts=PTS-STARTPTS+round(${f0 - R0}*${fps.den}/(${fps.num}*TB))`;
			const enable = `enable='between(t,${fmt(t0 - half)},${fmt(t0 + n * frameSec - half)})'`;
			if ('matte' in layer) {
				const label = `${P}l${li++}`;
				ctx.chains.push(
					`color=c=${colorHex(layer.matte.color)}:s=${W}x${H}:r=${rate(fps)}:d=${fmt(n * frameSec + frameSec)},format=rgba,trim=end_frame=${n},${shift}[${label}]`,
					`[${last}][${label}]overlay=x=0:y=0:format=rgb:eof_action=pass:${enable}[o${label}]`,
				);
				last = `o${label}`;
				return;
			}
			if ('span' in layer) {
				const ov = layer.span;
				const label = `${P}l${li++}`;
				const rect = ov.rect ?? null;
				const k = ctx.addInput([
					...(ov.decoder ? ['-c:v', ov.decoder] : []),
					...(ov.still
						? ['-loop', '1', '-framerate', rate(fps)]
						: ['-ss', sec((f0 - ov.startFrame) * frameSec)]),
					'-t',
					sec(n * frameSec + 2 * frameSec),
					'-i',
					ov.path,
				]);
				const g = [
					'setpts=PTS-STARTPTS',
					`fps=${rate(fps)}`,
					`trim=end_frame=${n}`,
					`scale=${rect ? `${rect.w}:${rect.h}` : `${W}:${H}`}:${SWS_FLAGS}`,
					'setsar=1',
					'format=rgba',
					shift,
				];
				ctx.chains.push(
					`[${k}:v:0]${g.join(',')}[${label}]`,
					`[${last}][${label}]overlay=x=${rect?.x ?? 0}:y=${rect?.y ?? 0}:format=rgb:eof_action=pass:${enable}[o${label}]`,
				);
				last = `o${label}`;
				return;
			}
			const c = layer.clip;
			const props = resolveLayerProps(c, clipContentTime(c, f0, fps));
			const label = `${P}l${li++}`;
			const margin = 2 * frameSec;

			// M2 (§19.6): a pre-rendered picture from an extension replaces the source ('layer') or the whole placed
			// layer ('sequence', overlaid at 0,0 with only the transition fades applied here).
			const override = exts ? pickOverride(exts.list, exts.prepared, c) : null;
			if (override?.space === 'sequence') {
				// M2 (S11:LBK-004/005/010): `still` = one image looped for the layer's frames (like still clips);
				// `rect` = the intermediate covers only that region, overlaid at its position; `colorRuns` = the clip's
				// colour runs are applied here, to the straight-alpha override stream.
				const rect = override.rect ?? null;
				const k = ctx.addInput([
					...(override.decoder ? ['-c:v', override.decoder] : []),
					...(override.still
						? ['-loop', '1', '-framerate', rate(fps)]
						: ['-ss', sec((f0 - override.startFrame) * frameSec)]),
					'-t',
					sec(n * frameSec + margin),
					'-i',
					override.path,
				]);
				const g = [
					'setpts=PTS-STARTPTS',
					`fps=${rate(fps)}`,
					`trim=end_frame=${n}`,
					`scale=${rect ? `${rect.w}:${rect.h}` : `${W}:${H}`}:${SWS_FLAGS}`,
					'setsar=1',
					'format=rgba',
					...(override.colorRuns && exts
						? colorRunFilters({
								clip: c,
								props,
								box: { width: rect?.w ?? W, height: rect?.h ?? H },
								fps,
								f0,
								f1: layer.f1,
								extensions: exts,
							})
						: []),
					...(override.includesFades ? [] : fadeFilters(c.fades, f0)),
					shift,
				];
				ctx.chains.push(`[${k}:v:0]${g.join(',')}[${label}]`);
				const next = `o${label}`;
				ctx.chains.push(
					`[${last}][${label}]overlay=x=${rect?.x ?? 0}:y=${rect?.y ?? 0}:format=rgb:eof_action=pass:${enable}[${next}]`,
				);
				last = next;
				return;
			}

			// Sub-pixel layers (keyframed Motion, or a static one between pixels): the warp kernel draws them into a small
			// frame streamed on a pipe, overlaid at a whole-pixel offset (stream/plan.ts).
			const box = {
				bw: Math.max(1, Math.round(c.intrinsicBox.width)),
				bh: Math.max(1, Math.round(c.intrinsicBox.height)),
			};
			// wp masks: Opacity masks are drawn by the kernel too (coverage × picture before the warp, stream/run.ts).
			if (needsSubpixel(c, props, box) || maskExportRoute(c) === 'stream') {
				const decInputs: string[][] = [];
				const chain = layerSourceChain({
					clip: c,
					f0,
					f1,
					fps,
					props,
					sources: srcs,
					override,
					...(exts ? { extensions: exts } : {}),
					addInput: (args) => {
						decInputs.push(args);
						return decInputs.length - 1;
					},
					label,
					skipCrop: true,
					nest: { nested: ctx.nested, path: ctx.path, threads },
				});
				const plan = planStreamLayer({ clip: c, f0, f1, R0, fps, props, chain, inputs: decInputs, W, H });
				if (!ctx.addStream)
					throw new Error(
						`Sub-pixel layer ${c.clipId} inside a nested sequence whose nest clip is drawn sub-pixel (route through Remotion)`,
					);
				const fd = ctx.addStream(plan);
				const k = ctx.addInput([
					...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${plan.outW}x${plan.outH}`],
					...['-framerate', rate(fps), '-i', `pipe:${fd}`],
				]);
				ctx.chains.push(
					`[${k}:v:0]${['setpts=PTS-STARTPTS', ...fadeFilters(c.fades, f0), shift].join(',')}[${label}]`,
				);
				const next = `o${label}`;
				ctx.chains.push(
					`[${last}][${label}]overlay=x=${plan.x}:y=${plan.y}:format=rgb:eof_action=pass:${enable}[${next}]`,
				);
				last = next;
				return;
			}

			// edit-structure (KND-012): an adjustment layer's source is the composite so far; its output (effects,
			// crop as transparency, opacity, fades) goes back over that composite.
			let composite: { label: string; R0: number } | undefined;
			if (c.kind === 'adjustment') {
				const keep = `${label}k`;
				const adj = `${label}s`;
				ctx.chains.push(`[${last}]split[${keep}][${adj}]`);
				last = keep;
				// keyframes-blend: an adjustment layer with a blend mode: its output goes to the kernel with the composite.
				if (blendMode !== 'normal') {
					backdrop = keep;
					last = transparentBase(ctx, `${label}tb`);
				}
				composite = { label: adj, R0 };
			}
			// Source decode, source chain and effects (shared with the warp stage), then Motion.
			const source = layerSourceChain({
				clip: c,
				f0,
				f1,
				fps,
				props,
				sources: srcs,
				override,
				...(exts ? { extensions: exts } : {}),
				addInput: ctx.addInput,
				label,
				...(composite ? { composite } : {}),
				nest: {
					nested: ctx.nested,
					path: ctx.path,
					threads,
					...(ctx.addStream ? { addStream: ctx.addStream } : {}),
				},
			});
			const src = source.input;
			const f = source.filters;

			// Motion → Opacity: M = P + R·S·(q − A) (S03:DM-010), flips → scale → rotation about the centre → alpha;
			// keyframed Motion / Opacity sampled per frame into per-frame expressions (S03:ENG-032, keyframed.ts). The
			// Motion scale folds into the source's scale to the box when no effect sits between them (one resample).
			const motion = motionStage({
				clip: c,
				f0,
				f1,
				R0,
				fps,
				props,
				bw: source.width,
				bh: source.height,
				W,
				H,
				label,
				opaque: source.opaque,
				threads: threads,
			});
			if (!(source.resize && mergeResize(f, source.resize, motion))) f.push(...motionFilters(motion));
			f.push(...fadeFilters(c.fades, f0));
			// Shift the layer to its place on the timeline in whole frames. `setpts` truncates its result, so an
			// offset written in decimal seconds (3.333333 s for frame 100 at 30 fps) landed one frame early.
			f.push(shift);
			ctx.chains.push(`${src}${f.join(',')}[${label}]`);

			const { x, y } = motion;
			const next = `o${label}`;
			ctx.chains.push(
				`[${last}][${label}]overlay=x=${x}:y=${y}:format=rgb:eof_action=pass:${enable}[${next}]`,
			);
			last = next;
		};
		drawLayer();
		if (blendMode !== 'normal' && ctx.blend) {
			if (backdrop === null) throw new Error('blend layer without a backdrop');
			last = ctx.blend.cut(backdrop, last, layer, blendMode);
		}
	}

	return last;
}

export function buildNativeGraph(o: NativeBuildOptions): NativeGraph {
	const { snapshot: snap, output } = o;
	const exts = o.extensions;
	const fps = snap.settings.fps;
	const W = snap.settings.width;
	const H = snap.settings.height;
	const R0 = snap.range.start;
	const R1 = snap.range.end;
	const frameSec = fps.den / fps.num;

	const encoder = output.encoder ?? LEGACY_X264_CHOICE;
	const enc = o.still
		? null
		: videoEncodeArgs(encoder, {
				crf: output.crf,
				speed: output.speed ?? 'balanced',
				width: output.width,
				height: output.height,
				fps: output.fps,
				...(output.bitrateKbps ? { bitrateKbps: output.bitrateKbps } : {}),
				...(output.proresProfile ? { proresProfile: output.proresProfile } : {}),
				...(output.gop ? { gop: output.gop } : {}),
				...(output.noBFrames ? { noBFrames: true } : {}),
				// color-mgmt: bit depth, colour code points, HDR metadata.
				...(output.color
					? {
							bitDepth: output.color.bitDepth,
							colorCodes: output.color.codes,
							svtHdr: svtHdrParams(output.color),
						}
					: {}),
			});
	// keyframes-blend: the composite runs as a pipeline of ffmpeg processes when the stack has blend layers: each blend
	// layer ends a process (its output = the composite below ‖ the layer on transparency, side by side, raw RGBA) and
	// the blend kernel's result starts the next one as its first input (`pipe:3`). The last process encodes.
	type Proc = {
		inputs: string[][];
		streams: NativeGraph['streams'];
		chains: string[];
		/** fd of the backdrop pipe (the previous kernel's output); null in the first process. */
		backdropFd: number | null;
	};
	const newProc = (backdrop: boolean): Proc => ({
		inputs: [],
		streams: [],
		chains: [],
		backdropFd: backdrop ? 3 : null,
	});
	let proc = newProc(false);
	const segments: BlendSegment[] = [];
	const stackFrames = R1 - R0 + 1;
	const ctx: StackContext = {
		snap,
		P: '',
		addInput: (args) => {
			proc.inputs.push(args);
			return proc.inputs.length - 1;
		},
		chains: proc.chains,
		addStream: (plan) => {
			const fd = 3 + (proc.backdropFd !== null ? 1 : 0) + proc.streams.length;
			proc.streams.push({ fd, plan });
			return fd;
		},
		sources: o.sources,
		threads: o.threads,
		...(exts ? { exts } : {}),
		...(o.nested ? { nested: o.nested } : {}),
		path: '',
		blend: {
			cut: (backdrop, layer, plan, mode) => {
				const label = `bk${segments.length}`;
				proc.chains.push(
					`[${backdrop}][${layer}]hstack=inputs=2,trim=end_frame=${stackFrames},setpts=PTS-STARTPTS[${label}]`,
				);
				segments.push({
					args: [
						...proc.inputs.flat(),
						'-filter_complex',
						proc.chains.join(';\n'),
						'-map',
						`[${label}]`,
						'-frames:v',
						String(stackFrames),
						'-fps_mode',
						'passthrough',
						'-f',
						'rawvideo',
						'-pix_fmt',
						'rgba',
						'pipe:1',
					],
					filter: proc.chains.join(';\n'),
					streams: proc.streams,
					backdropFd: proc.backdropFd,
					...blendSegmentFrames(plan, mode, R0, stackFrames),
				});
				proc = newProc(true);
				ctx.chains = proc.chains;
				const k = ctx.addInput([
					...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`],
					...['-framerate', rate(fps), '-i', 'pipe:3'],
				]);
				const out = `bd${segments.length}`;
				proc.chains.push(`[${k}:v:0]setpts=PTS-STARTPTS[${out}]`);
				return out;
			},
		},
	};
	let last = drawStack(ctx);
	const { inputs, streams, chains } = proc;
	const addInput = ctx.addInput;
	// keyframes-blend: Stencil / Silhouette cut the whole stack below them, the sequence background included; what
	// they reveal is the background (as in After Effects, where they reveal the comp background), so the result goes
	// over the background colour once more.
	if (
		segments.some((sg) => sg.mode >= STENCIL_FIRST && sg.mode <= STENCIL_LAST) &&
		snap.settings.backgroundColor[3]! > 0
	) {
		const T = (R1 - R0) * frameSec;
		chains.push(
			`color=c=${colorHex(snap.settings.backgroundColor)}:s=${W}x${H}:r=${rate(fps)}:d=${fmt(T + frameSec)},format=rgba[fbg]`,
			`[fbg][${last}]overlay=x=0:y=0:format=rgb:eof_action=pass[fstack]`,
		);
		last = 'fstack';
	}

	// Output conversion: rate, size (fit/fill/stretch), bt709 TV-range 4:2:0 (S04:RN-021, EX-003/004).
	const vout: string[] = [];
	const sameRate = output.fps.num * fps.den === fps.num * output.fps.den;
	if (!sameRate) vout.push(`fps=${rate(output.fps)}`);
	if (output.width !== W || output.height !== H) {
		if (output.scaling === 'stretch') vout.push(`scale=${output.width}:${output.height}`);
		else if (output.scaling === 'fill')
			vout.push(
				`scale=${output.width}:${output.height}:force_original_aspect_ratio=increase`,
				`crop=${output.width}:${output.height}`,
			);
		else
			vout.push(
				`scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease`,
				`pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
			);
	}
	vout.push(`trim=end_frame=${output.frames}`, 'setpts=PTS-STARTPTS');
	// color-mgmt: stills are the display rendition (working → display LUT), exports the output colour space.
	if (o.still) vout.push(...(o.colorLut ? ['format=rgba', o.colorLut] : []), 'format=rgb24');
	else {
		// The encoder's pixel format (yuv420p; nv12 + hwupload for QSV/VAAPI; 4:2:2/4:4:4 10-bit for ProRes).
		if (output.color) vout.push(...outputFilters(output.color, o.colorLut ?? null, SWS_FLAGS));
		else vout.push(`scale=out_color_matrix=bt709:out_range=tv:${SWS_FLAGS}`, 'setsar=1', BT709_FRAME_TAGS);
		vout.push(...enc!.filters);
	}
	chains.push(`[${last}]${vout.join(',')}[vout]`);

	// Audio (skipped for stills): the offline mixer's mixdown (audio-mix: clip levels, pan, buses, sends, automation,
	// 5.1, loudness normalisation — `audio/mixdown.ts`), resampled with SoX to the delivered rate when it differs.
	/** The input index of a stream-copied audio encode (no audio filter chain then). */
	let copiedAudio: number | null = null;
	if (!o.still && !output.videoOnly) {
		const totalSamples = Math.round(output.durationSec * output.audioSampleRate);
		const layout = output.audioChannels === 1 ? 'mono' : output.audioChannels === 6 ? '5.1' : 'stereo';
		if (o.audio?.encoded) {
			copiedAudio = addInput(['-i', o.audio.encoded]);
		} else if (o.audio) {
			const k = addInput(['-i', o.audio.file]);
			const rs =
				o.audio.sampleRate !== output.audioSampleRate
					? [`aresample=${output.audioSampleRate}:${resamplerArgs(o.audio.soxr ?? false)}`]
					: [];
			chains.push(
				`[${k}:a]${[...rs, `aformat=sample_fmts=fltp:channel_layouts=${layout}`, `apad=whole_len=${totalSamples}`, `atrim=end_sample=${totalSamples}`].join(',')}[aout]`,
			);
		} else {
			chains.push(`anullsrc=r=${output.audioSampleRate}:cl=${layout},atrim=end_sample=${totalSamples}[aout]`);
		}
	}

	const filter = chains.join(';\n');
	const args: string[] = [...(enc?.pre ?? [])];
	for (const inp of inputs) args.push(...inp);
	args.push('-filter_complex', filter, '-map', '[vout]');
	if (o.still) {
		args.push('-frames:v', '1', '-update', '1', '-f', 'image2', '-c:v', 'png', o.outputFile);
	} else {
		args.push(
			...(output.videoOnly ? [] : ['-map', copiedAudio !== null ? `${copiedAudio}:a:0` : '[aout]']),
			...enc!.video,
			...(output.color
				? colorTagArgs(output.color)
				: ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']),
			'-r',
			rate(output.fps),
			'-frames:v',
			String(output.frames),
			...(output.videoOnly
				? ['-an']
				: copiedAudio !== null
					? ['-c:a', 'copy']
					: [
							...audioEncodeArgs(
								audioCodecOf(encoder, output),
								output.audioBitrateKbps,
								output.audioChannels,
							),
							'-ar',
							String(output.audioSampleRate),
							'-ac',
							String(output.audioChannels),
						]),
			'-threads',
			String(Math.max(1, o.threads)),
			...(encoder.container !== 'webm' ? ['-movflags', '+faststart'] : []),
			'-f',
			encoder.container,
			o.outputFile,
		);
	}
	return {
		args,
		filter,
		inputs,
		outputFrames: output.frames,
		durationSec: output.durationSec,
		streams,
		...(segments.length > 0 ? { blend: { segments, backdropFd: 3, width: W, height: H } } : {}),
	};
}
/** edit-structure: the clip-local frame a frame hold shows (the composition's `pictureLocalFrame`). */
function heldLocalFrame(c: RenderVisualClip, fps: Rational): number {
	const hold = c.frameHold;
	if (!hold) return 0;
	const i = Math.round((hold.flicks - c.sourceIn) / (flicksPerFrame(fps) * c.speed.rate));
	return c.speed.reverse ? c.duration - 1 - i : i;
}
