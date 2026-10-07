// Export planner (ARCHITECTURE §9.5, S04 §11): builds the render snapshot with engine-local media,
// classifies every layer for the native path and returns an S04:RP-010 RenderPlan with per-clip blockers
// (RP-008) and warnings (offline media, VFR sources, missing fonts). Paths: `native` | `remotion`, and M2
// `hybrid` = the native composite with layers an extension baked (S11:LBK-002).

import { createHash } from 'node:crypto';
import type { EncoderChoice, ExportSettings, RenderPlan } from '@jasper/api';
import { installAudioFxProcessors } from '@jasper/audio-fx';
import { mgRegistry } from '@jasper/mg-templates';
import {
	blendModeInfo,
	buildRenderSnapshot,
	clipContentTime,
	defaultEffectRegistry,
	type EffectRegistry,
	hasAudioProcessor,
	hasEffectMasks,
	isAnimated,
	loadProject,
	type MediaAsset,
	type MediaHandle,
	maskExportRoute,
	mediaDecodeHints,
	type PixelInterpretation,
	type ProjectDocument,
	pixelInterpretation,
	type Rational,
	type RenderSnapshot,
	type RenderVisualClip,
	ROTO_OBJECT_PARAMS,
	rationalEquals,
	resolveLayerProps,
	rotoExportIssues,
	type SnapshotOptions,
	transitionSpec,
} from '@jasper/project';
import { lutRefs } from '../color/extension.ts';
import { type ExportColor, ExportColorError, exportColorOf } from '../color/output.ts';
import type { FontCatalogService } from '../fonts/catalog.ts';
import { alphaDecoder } from '../media/alpha.ts';
import type { MediaRecord, MediaRegistry } from '../media/registry.ts';
// wp-m2-anime-templates (S11:ATP-002/008/010)
import {
	missingTemplates,
	missingTemplatesDetail,
	missingTemplatesMessage,
	TEMPLATE_NOT_INSTALLED,
} from '../mg/templates.ts';
import { type EncoderRequest, LEGACY_X264_CHOICE } from '../tools/encoders.ts';
import { CaptionExportError, captionBurnMode, captionPlanWarnings } from './captions.ts';
import { BUILTIN_NATIVE_EFFECTS, type NativeExtension } from './native-ext.ts';
import { needsSubpixel } from './stream/plan.ts';

// audio-fx: the audio effect processors (clip effects and track / submix / Mix inserts) for the offline mixer.
installAudioFxProcessors();

export type PlanCapabilities = {
	/** ffmpeg + encoders present (self-check). */
	native: boolean;
	remotionLocal: 'ready' | 'needs-browser-download' | 'unavailable';
	fframes: 'ready' | 'unavailable';
	/** WP-2G registered an mgMasterProvider. */
	mgMasters: boolean;
	/** `ffmpeg -decoders` of the engine's build; absent = unknown (assume the usual decoders exist). */
	decoders?: readonly string[];
};

export class PlanError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'PlanError';
	}
}

// edit-structure: nest clips draw their nested stack in the same graph; adjustment layers process the composite.
const NATIVE_VISUAL_KINDS = new Set([
	'video',
	'still',
	'solid',
	'motion-graphic',
	'nest-video',
	'adjustment',
]);

export type OutputSpec = {
	width: number;
	height: number;
	fps: Rational;
	/** Exact output frame count (S04:RN-022). */
	frames: number;
	durationSec: number;
	scaling: 'fit' | 'fill' | 'stretch';
	crf: number;
	x264Preset: 'veryfast' | 'medium' | 'slow';
	speed: 'fast' | 'balanced' | 'best';
	/** Video encoder (D-13); null = no usable encoder (the native path is blocked). */
	encoder: EncoderChoice | null;
	/** audio-mix: 1, 2 or 6 (discrete 5.1). */
	audioChannels: 1 | 2 | 6;
	audioBitrateKbps: number;
	/** audio-mix: delivered sample rate (the mix runs at the sequence rate and is resampled with SoX when different). */
	audioSampleRate: number;
	/** audio-mix: 24-bit PCM requested (MOV). */
	audioPcm?: boolean;
	/** audio-mix: two-pass loudness normalisation of the final mix. */
	normalize: { targetLufs: number; truePeakDb: number } | null;
	/** Average video bitrate override (see ExportSettings `video.bitrateKbps`). */
	bitrateKbps?: number;
	/** ProRes profile of a `prores` export. */
	proresProfile?: 'hq' | '4444';
	/** wp interchange: straight-alpha ProRes 4444 on a transparent background, no audio (Remotion path). */
	alpha?: boolean;
	/** color-mgmt: the colour space, tags, bit depth and HDR metadata written (absent = 8-bit BT.709 SDR). */
	color?: ExportColor;
};

export type LocalMedia = {
	path: string;
	record: MediaRecord;
	/** imports (Interpret Footage): the asset's pixel interpretation (deinterlace, alpha), applied by every decoder. */
	pixel?: PixelInterpretation | null;
	/**
	 * imports: a picture to decode instead of the file (set by the `imports` extension's `prepare`: the composite of a
	 * Photoshop document, its pixel interpretation already applied).
	 */
	display?: string;
};

export type PlannedExport = {
	plan: RenderPlan & { planId: string; documentRevision: number };
	document: ProjectDocument;
	sequenceId: string;
	range: { start: number; end: number };
	/** Snapshot whose media handles point at engine-local files (`url` = absolute path). */
	snapshot: RenderSnapshot;
	/** mediaId → online local file. */
	media: Record<string, LocalMedia>;
	output: OutputSpec;
	/** wp captions: caption tracks burned in (snapshot option) and the caption output settings. */
	captions?: SnapshotOptions['captions'];
	captionSettings?: ExportSettings['captions'];
};

/** The engine media key of an asset (engine-store locator), or null. */
export function mediaKeyOf(asset: Pick<MediaAsset, 'locators'>): string | null {
	for (const l of asset.locators) if (l.type === 'engine-store') return l.key;
	return null;
}

function fpsNum(r: Rational): number {
	return r.num / r.den;
}

function exportRange(
	doc: ProjectDocument,
	sequenceId: string,
	settings: ExportSettings,
): { start: number; end: number } {
	const seq = doc.sequences[sequenceId]!;
	let end = 0;
	for (const c of Object.values(seq.clips)) end = Math.max(end, c.start + c.duration);
	let r: { start: number; end: number };
	switch (settings.range.type) {
		case 'in-out':
			r = { start: seq.inPoint ?? 0, end: seq.outPoint ?? end };
			break;
		case 'work-area':
			r = seq.workArea ? { start: seq.workArea.start, end: seq.workArea.end } : { start: 0, end };
			break;
		case 'custom':
			r = { start: settings.range.startFrame, end: settings.range.endFrame };
			break;
		default:
			r = { start: 0, end };
	}
	if (!(r.end > r.start)) throw new PlanError('VALIDATION_FAILED', 400, 'The export range is empty');
	return r;
}

/** Deterministic plan id over revision, document content, settings and capabilities (S04:RP-011). */
function planIdOf(parts: unknown): string {
	return `pln_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)}`;
}

type PlanInput = {
	envelope: { revision: number; document: unknown };
	sequenceId: string;
	settings: ExportSettings;
	/** Force a range (stills: one frame). */
	rangeOverride?: { start: number; end: number };
	/** Single PNG frame: no video encoder needed. */
	still?: boolean;
};

type PlanDeps = {
	registry: MediaRegistry;
	fonts: FontCatalogService;
	capabilities: PlanCapabilities;
	/** Encoder selection (D-13); absent = libx264 (unit tests of the planner alone). */
	selectEncoder?: (req: EncoderRequest) => EncoderChoice | null;
	/** LGPL-only mode: never fall back to an encoder inside Remotion's bundled (GPL) ffmpeg. */
	lgplOnly?: boolean;
	/** M2 native extensions (ARCHITECTURE §19.6), consulted by `nativeBlockers`. */
	extensions?: readonly NativeExtension[];
	/** Effect registry for extension effect lookups (default: the built-in registry). */
	effects?: EffectRegistry;
	/** parity (roto): frames a matte set holds on this engine (null = gone, e.g. cleaned from the cache). */
	rotoSet?: (key: string) => Promise<{ start: number; end: number } | null>;
};

/** color-mgmt: the (nested) sequences of a snapshot that blend in linear light ('' = the exported one). */
function linearBlendSequences(snap: RenderSnapshot, name = ''): string[] {
	const out = snap.settings.color?.blendLinear ? [name] : [];
	for (const t of snap.videoTracks)
		for (const c of t.clips)
			if ('nest' in c.source) out.push(...linearBlendSequences(c.source.nest.snapshot, c.name));
	return out;
}

export async function planExport(input: PlanInput, deps: PlanDeps): Promise<PlannedExport> {
	let document: ProjectDocument;
	try {
		const loaded = loadProject(input.envelope, { mgTemplates: mgRegistry }); // wp-m2-anime-templates: re-stamp renderers
		document = loaded.document;
	} catch (e) {
		throw new PlanError('VALIDATION_FAILED', 400, `Invalid project: ${(e as Error).message}`);
	}
	const seq = document.sequences[input.sequenceId];
	if (!seq) throw new PlanError('NOT_FOUND', 404, `Sequence ${input.sequenceId} not found`);
	const settings = input.settings;
	const range = input.rangeOverride ?? exportRange(document, input.sequenceId, settings);

	// ---- media resolution (engine-store keys only: never trust path locators from a client, S04:SC-003)
	const media: Record<string, LocalMedia> = {};
	const offline: string[] = [];
	for (const asset of Object.values(document.media)) {
		const key = mediaKeyOf(asset);
		const record = key ? deps.registry.get(key) : null;
		const path = record ? await deps.registry.resolvePath(record.mediaKey) : null;
		if (record && path) media[asset.id] = { path, record, pixel: pixelInterpretation(asset) };
		else offline.push(asset.id);
	}
	const fontFallbacks = new Set<string>();
	// wp captions: caption settings name existing tracks; burn-in is a snapshot option.
	let captionWarnings: RenderPlan['warnings'] = [];
	try {
		captionWarnings = captionPlanWarnings(document, seq, settings, range);
	} catch (e) {
		if (e instanceof CaptionExportError) throw new PlanError('VALIDATION_FAILED', 400, e.message);
		throw e;
	}
	const snapshot = buildRenderSnapshot(document, input.sequenceId, {
		captions: captionBurnMode(settings),
		range,
		resolveMedia: (asset): MediaHandle | null => {
			const m = media[asset.id];
			if (!m) return null;
			return localHandle(asset, m);
		},
		resolveFont: (font, weight, italic) => {
			const r = deps.fonts.resolve(font.family, weight, italic);
			if (r?.fallback) fontFallbacks.add(font.id);
			return r?.url ?? null;
		},
	});

	// ---- wp-m2-anime-templates (S11:ATP-010, FIX-008): templates this build lacks block every path (native,
	// Remotion, stills) instead of exporting the placeholder card.
	const missing = missingTemplates(snapshot);
	if (missing.length > 0)
		throw new PlanError(
			TEMPLATE_NOT_INSTALLED,
			409,
			missingTemplatesMessage(missing),
			missingTemplatesDetail(missing),
		);
	// ---- end wp-m2-anime-templates

	// ---- classification
	const blockers: RenderPlan['blockers'] = [];
	const warnings: RenderPlan['warnings'] = [];
	// ---- parity (roto): object mattes render on every path from computed matte sets; frames without one would come
	// out unmatted, so they block every path (never silently dropped). Stale mattes are a warning.
	{
		const issues = rotoExportIssues(snapshot);
		const missing = issues.filter((i) => i.kind === 'not-computed');
		if (missing.length)
			throw new PlanError('ROTO_NOT_COMPUTED', 409, missing.map((i) => i.message).join('; '), {
				rotos: missing.map(({ clipId, rotoId, frames }) => ({ clipId, rotoId, frames })),
			});
		for (const i of issues) warnings.push({ code: 'ROTO_STALE', message: i.message, itemIds: [i.clipId] });
		if (deps.rotoSet)
			for (const c of allVisualClips(snapshot))
				for (const [id, m] of Object.entries(c.rotos ?? {})) {
					if (!m.key) continue;
					if (
						!c.effects.some(
							(fx) =>
								fx.enabled && (ROTO_OBJECT_PARAMS[fx.effectId] ?? []).some((n) => fx.params[n]?.value === id),
						)
					)
						continue;
					const have = await deps.rotoSet(m.key);
					if (!have || have.start > m.start || have.end < m.end)
						throw new PlanError(
							'ROTO_MATTES_MISSING',
							409,
							`The computed mattes of roto "${m.name}" (clip "${c.name}") are no longer on this engine (cleaned from the media cache or computed elsewhere): propagate it again`,
							{ clipId: c.clipId, rotoId: id },
						);
				}
	}
	// edit-structure: the clips of nested sequences are drawn natively too (in the same graph): they are classified
	// with the sequence's own clips.
	const visual = allVisualClips(snapshot);
	const mgClips: string[] = [];
	// M2 (S11:LBK-002, wp-m2-layer-bake): layers an extension pre-renders with a graphics engine (DOM layers baked
	// through Remotion) — listed as graphics groups; the native path is then `hybrid`.
	const baked: { clipId: string; engine: 'remotion'; frames: number }[] = [];
	for (const reason of nestBlockers(snapshot))
		blockers.push({ path: 'native', reason: reason.reason, itemId: reason.clipId });
	// color-mgmt: linear-light compositing (Blend using 1.0 gamma / Linearize Working Space) is drawn by the GPU
	// compositor; the native compositor blends encoded values, so it is refused (the Remotion path renders it).
	for (const where of linearBlendSequences(snapshot))
		blockers.push({
			path: 'native',
			reason: `${where ? `nested sequence of clip "${where}": ` : ''}Blend using 1.0 gamma composites in linear light on the GPU compositor (the native compositor blends encoded values)`,
		});
	for (const c of visual) {
		for (const reason of nativeBlockers(c, deps.capabilities, deps.extensions ?? [], deps.effects))
			blockers.push({ itemId: c.clipId, path: 'native', reason });
		const bakeEngine = (deps.extensions ?? []).map((e) => e.bakes?.(c) ?? null).find((x) => x !== null);
		if (bakeEngine)
			baked.push({
				clipId: c.clipId,
				engine: bakeEngine,
				frames: c.duration + (c.headHandle ?? 0) + (c.tailHandle ?? 0),
			});
		else if (c.kind === 'motion-graphic' && !isAnimeTemplate(c)) mgClips.push(c.clipId);
		// Alpha WebM needs the libvpx decoder on the native path (Remotion decodes it in the browser).
		const dec = 'mediaId' in c.source ? alphaDecoder(media[c.source.mediaId]?.record.probe) : null;
		if (dec && deps.capabilities.decoders && !deps.capabilities.decoders.includes(dec))
			blockers.push({
				itemId: c.clipId,
				path: 'native',
				reason: `${c.kind} clip "${c.name}" has an alpha channel that needs the ${dec} decoder, which this ffmpeg build lacks`,
			});
	}
	// Transition framework: GPU transitions are shader stages of the compositions; the native builder renders only the
	// built-in ramps (cross dissolve, dip to black). wave1c: an extension that pre-renders the span (A + B + stage,
	// layer-bake) keeps the export native (`hybrid`): only the span is rendered by Remotion. Without one, the export
	// goes through Remotion.
	for (const track of allVideoTracks(snapshot))
		for (const t of track.transitions ?? []) {
			const engine = (deps.extensions ?? [])
				.map((e) => e.bakesTransition?.(t, track.trackId) ?? null)
				.find((x) => x !== null);
			if (engine) {
				baked.push({ clipId: t.id, engine, frames: t.duration });
				continue;
			}
			const spec = transitionSpec(t.effectId);
			blockers.push({
				itemId: t.id,
				path: 'native',
				reason: `transition "${spec?.label ?? t.effectId}" is a GPU transition and no span renderer is available (rendered by the Remotion path)`,
			});
		}
	// audio-mix: every path's audio is the offline mixer's (clip levels, pan, buses, sends, automation, 5.1,
	// normalisation), so audio never blocks a path — except effects the mixer cannot run, which block them all.
	const unrenderable = unrenderableAudioEffects(snapshot);
	if (unrenderable.length > 0)
		throw new PlanError(
			'AUDIO_EFFECT_UNSUPPORTED',
			409,
			`Audio effects without an export processor: ${[...new Set(unrenderable.map((u) => u.effectId))].join(', ')}`,
			{ effects: unrenderable },
		);
	const audioOut = audioOutputOf(seq, settings, deps.selectEncoder ? null : null);
	const video0 = settings.video;
	const encoder = deps.selectEncoder
		? deps.selectEncoder({
				purpose: 'export',
				codec: video0?.codec ?? 'h264',
				...(video0?.encoder ? { encoder: video0.encoder } : {}),
			})
		: LEGACY_X264_CHOICE;
	if (!deps.capabilities.native)
		blockers.push({ path: 'native', reason: 'ffmpeg (with a video encoder and aac) is not available' });
	else if (!encoder && !input.still)
		blockers.push({
			path: 'native',
			reason: 'no usable video encoder (H.264, AV1 or VP9) in this ffmpeg build',
		});

	// ---- warnings
	const offlineUsed = new Set<string>();
	for (const c of visual)
		if ('mediaId' in c.source && snapshot.media[c.source.mediaId] === null) offlineUsed.add(c.clipId);
	for (const a of snapshot.audioClips) if (snapshot.media[a.mediaId] === null) offlineUsed.add(a.clipId);
	if (offlineUsed.size > 0) {
		warnings.push({
			code: 'OFFLINE_MEDIA',
			message: `${offlineUsed.size} clip(s) use offline media and render as "Media Offline"`,
			itemIds: [...offlineUsed],
		});
	}
	// color-mgmt: LUTs and custom OCIO configs used by colour steps (grades, input LUTs, OCIO interpretations) that are
	// offline: those steps are skipped (the clips render ungraded / uninterpreted there), so the export says so.
	const lutOffline = new Set<string>();
	for (const c of visual)
		for (const id of lutRefs(c)) {
			const kind = document.media[id]?.kind;
			if ((kind === 'lut' || kind === 'color-config') && !media[id]) lutOffline.add(c.clipId);
		}
	if (lutOffline.size > 0)
		warnings.push({
			code: 'LUT_OFFLINE',
			message: `${lutOffline.size} clip(s) use an offline LUT or colour config; the colour steps using it are skipped`,
			itemIds: [...lutOffline],
		});
	// Workstream `time`: VFR media are mapped by their real timestamps by the retime stage (native) and the preview
	// decoder (Remotion); only an engine without the retime stage still conforms them.
	const vfr = new Set<string>();
	for (const c of visual) {
		if (
			'mediaId' in c.source &&
			media[c.source.mediaId]?.record.probe.variableFrameRate &&
			!(deps.extensions ?? []).some((e) => e.retimes?.(c))
		)
			vfr.add(c.clipId);
	}
	if (vfr.size > 0) {
		warnings.push({
			code: 'VFR_SOURCE',
			message: 'Variable-frame-rate sources are conformed to the sequence frame rate (no retime stage)',
			itemIds: [...vfr],
		});
	}
	if (fontFallbacks.size > 0) {
		const ids = visual
			.filter(
				(c) =>
					(c.kind === 'text' && 'text' in c.source && fontFallbacks.has(c.source.text.style.fontId)) ||
					('captions' in c.source && fontFallbacks.has(c.source.captions.style.fontId)),
			)
			.map((c) => c.clipId);
		warnings.push({
			code: 'FONT_FALLBACK',
			message: 'Some fonts are not bundled; the default family is used instead',
			itemIds: ids,
		});
	}
	for (const w of snapshot.warnings) warnings.push({ code: w.code, message: w.message, itemIds: [w.clipId] });
	warnings.push(...captionWarnings);
	// M2 (§19.6): warnings of the extensions for the clips they provide (e.g. MG_FPS_MISMATCH).
	for (const ext of deps.extensions ?? []) {
		if (!ext.warnings) continue;
		for (const c of visual) {
			if (!ext.kinds?.has(c.kind) && !ext.claimsLayer?.(c)) continue;
			for (const w of ext.warnings(c, { fps: snapshot.settings.fps }))
				warnings.push({ code: w.code, message: w.message, itemIds: [c.clipId] });
		}
	}
	if (encoder?.message) warnings.push({ code: 'ENCODER_FALLBACK', message: encoder.message });

	// ---- output spec
	const seqFps = seq.settings.frameRate;
	const video = settings.video;
	const outFps = video?.frameRate ?? seqFps;
	const durationSec = ((range.end - range.start) * seqFps.den) / seqFps.num;
	const output: OutputSpec = {
		width: video?.width ?? seq.settings.width,
		height: video?.height ?? seq.settings.height,
		fps: { num: outFps.num, den: outFps.den },
		frames: rationalEquals(outFps, seqFps)
			? range.end - range.start
			: Math.max(1, Math.round((durationSec * outFps.num) / outFps.den)),
		durationSec,
		scaling: video?.scaling ?? 'fit',
		crf: video?.quality.value ?? 18,
		x264Preset:
			video?.encoderSpeed === 'fast' ? 'veryfast' : video?.encoderSpeed === 'best' ? 'slow' : 'medium',
		speed: video?.encoderSpeed ?? 'balanced',
		encoder,
		audioChannels: audioOut.channels,
		audioBitrateKbps: settings.audio?.bitrateKbps ?? (audioOut.channels === 6 ? 384 : 192),
		audioSampleRate: audioOut.sampleRate,
		audioPcm: settings.audio?.codec === 'pcm',
		normalize: audioOut.normalize,
		...(video?.bitrateKbps ? { bitrateKbps: video.bitrateKbps } : {}),
		...(video?.proresProfile ? { proresProfile: video.proresProfile } : {}),
		...(video?.alpha ? { alpha: true } : {}),
	};
	if (
		video?.alpha &&
		(video.codec !== 'prores' || video.proresProfile !== '4444' || settings.container !== 'mov')
	)
		throw new PlanError('VALIDATION_FAILED', 400, 'Alpha output needs ProRes 4444 in a MOV container');
	// color-mgmt: the written colour space (working by default), bit depth and HDR metadata.
	try {
		output.color = exportColorOf(
			video,
			snapshot.settings.color,
			input.still ? null : (encoder?.encoder ?? null),
		);
	} catch (e) {
		if (e instanceof ExportColorError) throw new PlanError('VALIDATION_FAILED', 400, e.message);
		throw e;
	}
	if (output.color.hdr && output.color.bitDepth === 8 && !input.still)
		warnings.push({
			code: 'HDR_8BIT',
			message: `${output.color.space.label} at 8 bits per component bands in smooth gradients; choose ProRes, AV1 or VP9 for 10-bit`,
		});
	if (output.color.hdr && !input.still && settings.container === 'webm' && encoder?.encoder === 'libvpx-vp9')
		warnings.push({
			code: 'HDR_METADATA_UNSUPPORTED',
			message: 'VP9 in WebM carries the PQ/HLG tags but no mastering-display or content-light metadata here',
		});
	if (!rationalEquals(outFps, seqFps)) {
		warnings.push({
			code: 'FRAME_RATE_CONVERSION',
			message: `Export frame rate ${fpsNum(outFps).toFixed(3)} differs from the sequence (${fpsNum(seqFps).toFixed(3)}); frames are sampled nearest-frame and motion may judder`,
		});
	}

	// ---- path choice (S04:RP-001, RP-012)
	const nativeEligible = blockers.length === 0;
	// `hybrid` = the native composite with baked graphics layers (S04 §11.2, S11:LBK-002).
	const nativePath = baked.length > 0 ? 'hybrid' : 'native';
	let path: 'native' | 'hybrid' | 'remotion';
	if (video?.alpha) {
		// Alpha masters are drawn by the compositions on a transparent page (the layer-bake master settings).
		if (settings.engine === 'native' || deps.capabilities.remotionLocal === 'unavailable')
			throw new PlanError(
				'PATH_NOT_ELIGIBLE',
				409,
				'Alpha output renders on the Remotion path, which is unavailable',
				{
					blockers: [{ path: 'native', reason: 'alpha output' }],
				},
			);
		path = 'remotion';
	} else if (settings.engine === 'native') {
		if (!nativeEligible) {
			throw new PlanError('PATH_NOT_ELIGIBLE', 409, 'The native path cannot render this sequence', {
				blockers,
			});
		}
		path = nativePath;
	} else if (settings.engine === 'remotion') {
		if (deps.capabilities.remotionLocal === 'unavailable') {
			throw new PlanError('PATH_NOT_ELIGIBLE', 409, 'Remotion rendering is unavailable on this engine', {
				blockers: [{ path: 'hybrid', reason: 'Remotion renderer or compositions bundle missing' }],
			});
		}
		path = 'remotion';
	} else path = nativeEligible ? nativePath : 'remotion';

	// S11:LBK-024: baking needs the browser too; a pending download is not a blocker.
	if (path === 'hybrid' && deps.capabilities.remotionLocal === 'needs-browser-download')
		warnings.push({
			code: 'BROWSER_DOWNLOAD',
			message: 'Baking graphics layers first downloads a headless browser',
		});
	if (path === 'remotion') {
		if (!encoder && deps.lgplOnly && !input.still) {
			throw new PlanError(
				'ENCODER_UNAVAILABLE',
				409,
				'No LGPL-compatible video encoder is available for the Remotion path',
			);
		}
		if (deps.capabilities.remotionLocal === 'unavailable')
			warnings.push({
				code: 'REMOTION_UNAVAILABLE',
				message: 'Remotion rendering is unavailable on this engine',
			});
		else if (deps.capabilities.remotionLocal === 'needs-browser-download')
			warnings.push({
				code: 'BROWSER_DOWNLOAD',
				message: 'The first Remotion render downloads a headless browser',
			});
		if (!rationalEquals(outFps, seqFps)) {
			output.fps = { ...seqFps };
			output.frames = range.end - range.start;
			warnings.push({
				code: 'FRAME_RATE_IGNORED',
				message: 'The Remotion path renders at the sequence frame rate in M1',
			});
		}
		const seqAspect = seq.settings.width / seq.settings.height;
		if (Math.abs(output.width / output.height - seqAspect) > 0.01) {
			output.width = seq.settings.width;
			output.height = seq.settings.height;
			warnings.push({
				code: 'SIZE_IGNORED',
				message: 'The Remotion path keeps the sequence aspect ratio in M1',
			});
		}
	}

	const frames = range.end - range.start;
	const pixels = output.width * output.height;
	const pixelFactor = Math.max(0.25, pixels / (1920 * 1080));
	// Baked layers (uncached): Remotion at ~8 fps over each layer's drawn span (S04:RP-009 seed).
	const bakeSeconds = path === 'hybrid' ? baked.reduce((s, b) => s + b.frames / 8, 0) * pixelFactor : 0;
	const estimateSeconds =
		path !== 'remotion' ? (durationSec / 1.5) * pixelFactor + bakeSeconds : (frames / 8) * pixelFactor;
	const bpp = 0.1 * 2 ** ((18 - output.crf) / 6);
	const estimateBytes = Math.round(
		(pixels * fpsNum(output.fps) * durationSec * bpp) / 8 +
			(output.audioBitrateKbps * 1000 * durationSec) / 8,
	);

	const graphicsGroups: RenderPlan['segments'][number]['graphicsGroups'] =
		path === 'remotion'
			? [{ id: 'g1', engine: 'remotion', itemIds: visual.map((c) => c.clipId) }]
			: [
					...mgClips.map((id, i) => ({ id: `mg${i + 1}`, engine: 'fframes' as const, itemIds: [id] })),
					...baked.map((b, i) => ({ id: `lb${i + 1}`, engine: b.engine, itemIds: [b.clipId] })),
				];
	const documentRevision = input.envelope.revision;
	const planId = planIdOf({
		documentRevision,
		doc: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
		sequenceId: input.sequenceId,
		settings,
		caps: deps.capabilities,
		encoder: encoder?.encoder ?? null,
		range,
	});
	const plan: PlannedExport['plan'] = {
		planId,
		documentRevision,
		path,
		segments: [
			{
				startFrame: range.start,
				endFrame: range.end,
				mode: path === 'remotion' ? 'remotion' : mgClips.length + baked.length > 0 ? 'mixed' : 'native',
				graphicsGroups,
			},
		],
		audio: {
			mode: 'native-mix',
			...(audioOut.normalize ? { normalize: audioOut.normalize } : {}),
			sampleRate: output.audioSampleRate,
			channels: output.audioChannels,
			codec: audioCodecOf(encoder, output),
		},
		blockers,
		warnings,
		estimate: { seconds: Math.round(estimateSeconds * 10) / 10, bytes: Math.max(0, estimateBytes) },
		...(encoder ? { encoder } : {}),
	};
	return {
		plan,
		document,
		sequenceId: input.sequenceId,
		range,
		snapshot,
		media,
		output,
		captions: captionBurnMode(settings),
		captionSettings: settings.captions,
	};
}

/** Enabled audio effects (clips, tracks, submixes, the Mix) with no export processor (`registerAudioProcessor`). */
export function unrenderableAudioEffects(
	snapshot: RenderSnapshot,
): { itemId: string; effectId: string; where: 'clip' | 'strip' }[] {
	const out: { itemId: string; effectId: string; where: 'clip' | 'strip' }[] = [];
	for (const a of snapshot.audioClips)
		for (const fx of a.effects)
			if (fx.enabled && !hasAudioProcessor(fx.effectId))
				out.push({ itemId: a.clipId, effectId: fx.effectId, where: 'clip' });
	for (const s of snapshot.audioMix?.strips ?? [])
		if (!s.inaudible || s.kind !== 'track')
			for (const fx of s.inserts)
				if (!hasAudioProcessor(fx.effectId))
					out.push({ itemId: s.id, effectId: fx.effectId, where: 'strip' });
	return out;
}

/** Delivered audio format: channels, rate (Opus is 48 kHz only) and the loudness normalisation in effect. */
export function audioOutputOf(
	seq: {
		settings: { audioSampleRate?: number; masterLayout?: string };
		master: { loudness?: { enabled: boolean; targetLufs: number; truePeakDb: number } };
	},
	settings: Pick<ExportSettings, 'audio'>,
	_encoder: unknown,
): { channels: 1 | 2 | 6; sampleRate: number; normalize: { targetLufs: number; truePeakDb: number } | null } {
	const a = settings.audio;
	const master = seq.settings.masterLayout === '5.1' ? 6 : seq.settings.masterLayout === 'mono' ? 1 : 2;
	const channels = (a?.channels ?? (master === 6 ? 6 : 2)) as 1 | 2 | 6;
	const sampleRate = a?.codec === 'opus' ? 48000 : (a?.sampleRate ?? seq.settings.audioSampleRate ?? 48000);
	const l = seq.master.loudness;
	const normalize =
		a?.normalize === null
			? null
			: a?.normalize
				? { targetLufs: a.normalize.targetLufs, truePeakDb: a.normalize.truePeakDb ?? -1 }
				: l?.enabled
					? { targetLufs: l.targetLufs, truePeakDb: l.truePeakDb }
					: null;
	return { channels, sampleRate, normalize };
}

/** The audio codec of the deliverable (ffmpeg encoder name). */
export function audioCodecOf(encoder: EncoderChoice | null, output: Pick<OutputSpec, 'audioPcm'>): string {
	const base = encoder?.audioEncoder ?? 'aac';
	if (base.startsWith('pcm_')) return output.audioPcm ? 'pcm_s24le' : base;
	return base;
}

function localHandle(asset: MediaAsset, m: LocalMedia): MediaHandle {
	const r = m.record;
	return {
		url: m.path,
		proxyUrl: null,
		kind: asset.kind,
		width: r.display?.width ?? null,
		height: r.display?.height ?? null,
		durationFlicks: r.probe.durationFlicks,
		hasAudio: r.hasAudio,
		rotation: r.probe.rotationDegrees,
		...mediaDecodeHints(r.probe),
	};
}

/** A motion-graphic clip rendered by Remotion (`renderer: 'anime'`, S11:ATP-002), not by fframes. */
export function isAnimeTemplate(c: Pick<RenderVisualClip, 'kind' | 'source'>): boolean {
	return c.kind === 'motion-graphic' && 'mg' in c.source && c.source.mg.renderer === 'anime';
}

/**
 * Reasons a visual layer cannot go through the native builder (S04:RN-020, ARCHITECTURE §9.5), with the M2
 * extensions (§19.6): extension kinds are native-capable, a claimed layer skips the generic Motion / opacity /
 * effect checks, and effects an extension supports are not blockers.
 */
export function nativeBlockers(
	c: RenderVisualClip,
	caps: PlanCapabilities,
	exts: readonly NativeExtension[] = [],
	effects: EffectRegistry = defaultEffectRegistry,
): string[] {
	const out: string[] = [];
	const label = `${c.kind} clip "${c.name}"`;
	// three-d: 3D layers are planes of the sequence's 3D scene (depth sort, lights, shadows, depth of field), drawn by
	// the compositions' 3D renderer: the export renders them on the Remotion path (never baked one by one, which would
	// flatten them in their 2D place).
	if (c.threeD) return [`3D layer "${c.name}" is drawn by the 3D renderer (Remotion path)`];
	for (const ext of exts) {
		if (ext.kinds?.has(c.kind) || ext.claimsLayer?.(c)) out.push(...(ext.blockers?.(c) ?? []));
	}
	const extKind = exts.some((e) => e.kinds?.has(c.kind));
	// edit-structure: generator pictures (Bars and Tone, counting leader) come from the synthetic extension.
	if ('generator' in c.source && !exts.some((e) => e.id === 'synthetic'))
		out.push(`${label} draws a generator that needs the synthetic extension`);
	// Workstream `time`: reverse, time remaps, Frame Blending / Optical Flow and VFR media are rendered by the retime
	// extension (or inside a whole-layer bake); without it they would play linearly — a named blocker instead.
	const retimed =
		exts.some((e) => e.retimes?.(c)) ||
		exts.some((e) => e.claimsLayer?.(c) && (e.bakes?.(c) ?? null) !== null);
	const retimeBlocker = (): string | null => {
		if (retimed) return null;
		if (c.speed.reverse) return `${label} plays in reverse`;
		if (c.kind === 'nest-video' && c.timeRemap)
			return `nested sequence clip "${c.name}" is time-remapped (nested stacks play linearly on the native path)`;
		if (c.timeRemap) return `${label} is time-remapped and no retime stage is available`;
		if (c.retime?.interpolation === 'optical-flow' || c.retime?.interpolation === 'frame-blending')
			return `${label} uses ${c.retime.interpolation === 'optical-flow' ? 'Optical Flow' : 'Frame Blending'} and no retime stage is available`;
		if (c.retime?.vfr) return `${label} has variable-frame-rate media and no retime stage is available`;
		return null;
	};
	if (exts.some((e) => e.claimsLayer?.(c))) {
		const r = retimeBlocker();
		if (r) out.push(r);
		return out;
	}
	if (!NATIVE_VISUAL_KINDS.has(c.kind) && !extKind) {
		out.push(
			c.kind === 'text'
				? `text layer "${c.name}" requires graphics rendering`
				: `${label} requires graphics rendering (not a native-capable layer)`,
		);
		return out;
	}
	// M2 (S11:LBK-002): anime templates are Remotion graphics (baked by the layer-bake extension, which claims them
	// above); the fframes checks apply to fframes templates only.
	if (c.kind === 'motion-graphic' && isAnimeTemplate(c)) {
		out.push(`${label} requires graphics rendering (anime template)`);
		return out;
	}
	if (c.kind === 'motion-graphic' && !(caps.fframes === 'ready' && caps.mgMasters)) {
		out.push(`motion graphic "${c.name}" needs the fframes renderer, which is unavailable`);
	}
	// The fframes master holds exactly the clip's frames: no content for transition handles.
	if (c.kind === 'motion-graphic' && ((c.headHandle ?? 0) > 0 || (c.tailHandle ?? 0) > 0))
		out.push(`motion graphic "${c.name}" is part of a transition that needs handles`);
	// wp masks: Opacity masks of kernel-drawn kinds are native (stream/plan.ts); other masks need the layer bake.
	if (maskExportRoute(c) === 'bake')
		out.push(
			hasEffectMasks(c)
				? `${label} has effect masks, which need the composition to render the layer (no layer bake available)`
				: `${label} has masks the native kernel does not draw on this layer (no layer bake available)`,
		);
	// Keyframed Motion and Opacity are native: the builder samples them per frame (S03:ENG-032, keyframed.ts).
	// keyframes-blend: blend modes are native in the sequence's own stack (the blend pipeline, native.ts);
	// `nestBlockers` refuses them inside nested sequences.
	const rb = retimeBlocker();
	if (rb) out.push(rb);
	for (const fx of c.effects) {
		if (!fx.enabled) continue;
		// Built-in effects (crop, flips) render with keyframes too (crop edges per frame, `layerSourceChain`).
		if (BUILTIN_NATIVE_EFFECTS.has(fx.effectId)) continue;
		const animated = Object.values(fx.params).some((p) => isAnimated(p));
		const spec = effects.get(fx.effectId, fx.effectVersion);
		let support: false | 'static' | 'animated' = false;
		for (const ext of exts) {
			const s = ext.effectSupport?.(fx.effectId, spec) ?? false;
			if (s === 'animated' || (s === 'static' && support === false)) support = s;
		}
		if (support === false)
			out.push(`${label} uses effect ${fx.effectId}, which the native path cannot render`);
		else if (support === 'static' && animated) out.push(`${label} has an animated ${fx.effectId}`);
	}
	return out;
}

// ---------------------------------------------------------------- edit-structure: nested sequences

/** Visual clips of a snapshot and of every nested snapshot drawn in it. */
export function allVisualClips(snap: RenderSnapshot): RenderVisualClip[] {
	const out: RenderVisualClip[] = [];
	for (const t of snap.videoTracks)
		for (const c of t.clips) {
			out.push(c);
			if ('nest' in c.source) out.push(...allVisualClips(c.source.nest.snapshot));
		}
	return out;
}

/** Video tracks of a snapshot and of every nested snapshot drawn in it. */
export function allVideoTracks(snap: RenderSnapshot): RenderSnapshot['videoTracks'] {
	const out: RenderSnapshot['videoTracks'] = [];
	for (const t of snap.videoTracks) {
		out.push(t);
		for (const c of t.clips) if ('nest' in c.source) out.push(...allVideoTracks(c.source.nest.snapshot));
	}
	return out;
}

/**
 * Native limits of nests: a nest clip drawn sub-pixel (animated Motion) is decoded in a separate process, where the
 * layers of its nested sequence cannot be sub-pixel streams themselves.
 */
function nestBlockers(snap: RenderSnapshot): { clipId: string; reason: string }[] {
	const out: { clipId: string; reason: string }[] = [];
	const subpixel = (c: RenderVisualClip) => {
		const props = resolveLayerProps(c, clipContentTime(c, c.start, snap.settings.fps));
		return needsSubpixel(c, props, {
			bw: Math.max(1, Math.round(c.intrinsicBox.width)),
			bh: Math.max(1, Math.round(c.intrinsicBox.height)),
		});
	};
	for (const t of snap.videoTracks)
		for (const c of t.clips) {
			if (!('nest' in c.source)) continue;
			const sub = c.source.nest.snapshot;
			const ownProcess =
				subpixel(c) || c.effects.some((e) => e.enabled && e.effectId === 'jasper.corner-pin');
			if (ownProcess && allVisualClips(sub).some((x) => !('nest' in x.source) && subpixelIn(sub, x)))
				out.push({
					clipId: c.clipId,
					reason: `nested sequence clip "${c.name}" has animated, sub-pixel or corner-pinned Motion and contains sub-pixel or masked layers`,
				});
			// keyframes-blend: a nested stack is drawn inside one process, where a blend layer cannot reach the blend
			// kernel (the nest clip itself may have any blend mode).
			for (const x of sub.videoTracks.flatMap((t) => t.clips))
				if ((x.blendMode ?? 'normal') !== 'normal')
					out.push({
						clipId: x.clipId,
						reason: `${x.kind} clip "${x.name}" inside nested sequence clip "${c.name}" uses blend mode "${blendModeInfo(x.blendMode)?.label ?? x.blendMode}" (native blend modes apply to the sequence's own layers)`,
					});
			out.push(...nestBlockers(sub));
		}
	return out;
}

function subpixelIn(snap: RenderSnapshot, c: RenderVisualClip): boolean {
	// wp masks: layers with Opacity masks are kernel streams too.
	if (maskExportRoute(c) === 'stream') return true;
	const props = resolveLayerProps(c, clipContentTime(c, c.start, snap.settings.fps));
	return needsSubpixel(c, props, {
		bw: Math.max(1, Math.round(c.intrinsicBox.width)),
		bh: Math.max(1, Math.round(c.intrinsicBox.height)),
	});
}
