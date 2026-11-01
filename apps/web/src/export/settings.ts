// Export settings for Export mode (S05 §15, S04 §10.2 M1 subset): the "Match Sequence – H.264" preset,
// ranges, per-sequence remembered choices (S05:EX-014), plan-path names (S04:EX-005) and size estimates
// (S05:EX-023).
import {
	type EncoderChoice,
	type EncodingCapabilities,
	type ExportSettings,
	GIF_DITHERS,
	GIF_LIMITS,
	GIF_PALETTES,
	type RenderPlan,
	type SoundCheckExportAudio,
	type VideoCodec,
} from '@jasper/api';
import {
	captionGroupsOf,
	colorSpace,
	type DeliveryTargetId,
	deliveryExportFormat,
	deliveryTarget,
	fpsOf,
	isDeliveryTargetId,
	makeEnvelope,
	OUTPUT_SPACE_IDS,
	type ProjectDocument,
	type Sequence,
	sequenceColorInfo,
	sequenceDuration,
} from '@jasper/project';

export const MATCH_SEQUENCE_PRESET = { id: 'match-sequence-h264', label: 'Match Sequence – H.264' } as const;
const DEFAULT_CRF = 18;
const AUDIO_KBPS = 256;

export type ExportEngineChoice = ExportSettings['engine'];
export type ExportRangeChoice = 'entire' | 'in-out';

/** spec 18 AF-EXP: what the export writes — a video file, an animated GIF, or the mix as WAV / FLAC / M4A. */
export type ExportFormatChoice = 'video' | 'gif' | 'wav' | 'flac' | 'm4a';
export const FORMAT_OPTIONS: { value: ExportFormatChoice; label: string }[] = [
	{ value: 'video', label: 'Video' },
	{ value: 'gif', label: 'Animated GIF (no sound)' },
	{ value: 'wav', label: 'Audio Only – WAV' },
	{ value: 'flac', label: 'Audio Only – FLAC' },
	{ value: 'm4a', label: 'Audio Only – M4A (AAC)' },
];
const isFormatChoice = (v: unknown): v is ExportFormatChoice =>
	v === 'video' || v === 'gif' || v === 'wav' || v === 'flac' || v === 'm4a';
export const isAudioOnlyFormat = (f: ExportFormatChoice): f is 'wav' | 'flac' | 'm4a' =>
	f === 'wav' || f === 'flac' || f === 'm4a';

/** spec 18 AF-EXP-001: the GIF's rate, width (`auto` = the sequence width capped at 1080), plays, dither, palette. */
export type GifChoice = {
	fps: number;
	width: 'auto' | number;
	/** 0 = forever, 1 = once, n = n times. */
	loop: number;
	dither: (typeof GIF_DITHERS)[number];
	palette: (typeof GIF_PALETTES)[number];
};
export const DEFAULT_GIF_CHOICE: GifChoice = {
	fps: GIF_LIMITS.defaultFps,
	width: 'auto',
	loop: 0,
	dither: 'sierra2_4a',
	palette: 'full',
};
export const GIF_DITHER_OPTIONS: { value: GifChoice['dither']; label: string }[] = [
	{ value: 'sierra2_4a', label: 'Sierra 2-4A (smooth, default)' },
	{ value: 'sierra2', label: 'Sierra 2 (smoother, slower)' },
	{ value: 'floyd_steinberg', label: 'Floyd–Steinberg' },
	{ value: 'bayer', label: 'Bayer (ordered pattern, smaller files)' },
	{ value: 'none', label: 'None (banding, smallest files)' },
];
export const GIF_PALETTE_OPTIONS: { value: GifChoice['palette']; label: string }[] = [
	{ value: 'full', label: 'One palette for the whole GIF' },
	{ value: 'diff', label: 'One palette, weighted to what moves' },
	{ value: 'single', label: 'A palette per frame (larger files)' },
];

/** The GIF's width: the chosen one, else the sequence width capped at 1080 (even, as the engine writes it). */
export function gifWidthOf(seq: Pick<Sequence, 'settings'>, c: GifChoice): number {
	const w = c.width === 'auto' ? Math.min(seq.settings.width, GIF_LIMITS.defaultMaxWidth) : c.width;
	return Math.max(2, Math.round(w / 2) * 2);
}

/** spec 18 AF-EXP-002: WAV / FLAC bits per sample and the M4A (AAC) bit rate. */
export type AudioFileChoice = { bitDepth: 16 | 24; bitrateKbps: number };
export const DEFAULT_AUDIO_FILE_CHOICE: AudioFileChoice = { bitDepth: 24, bitrateKbps: 256 };
export const AAC_BITRATES = [128, 192, 256, 320] as const;

export const ENGINE_OPTIONS: { value: ExportEngineChoice; label: string; hint: string }[] = [
	{ value: 'auto', label: 'Auto', hint: 'Fastest path that can render everything' },
	{ value: 'native', label: 'Native (ffmpeg)', hint: 'Media-only sequences; fastest' },
	{ value: 'remotion', label: 'Remotion', hint: 'Renders the whole composition in headless Chrome' },
];

export function hasInOut(seq: Pick<Sequence, 'inPoint' | 'outPoint'>): boolean {
	return seq.inPoint !== null && seq.outPoint !== null && seq.outPoint > seq.inPoint;
}

/** Frame range [start, end) the export covers. */
export function exportRange(
	seq: Pick<Sequence, 'clips' | 'inPoint' | 'outPoint'>,
	range: ExportRangeChoice,
): { start: number; end: number } {
	if (range === 'in-out' && hasInOut(seq)) return { start: seq.inPoint!, end: seq.outPoint! };
	return { start: 0, end: sequenceDuration(seq) };
}

export function buildExportSettings(
	seq: Sequence,
	choice: {
		range: ExportRangeChoice;
		engine: ExportEngineChoice;
		crf?: number;
		/** Preferred codec (default H.264); the engine substitutes when unavailable (ARCHITECTURE D-13). */
		codec?: VideoCodec;
		/** Explicit ffmpeg encoder; absent = the engine's best choice. */
		encoder?: string | null;
		/** audio-mix: delivered audio (defaults: the Mix's channels, the sequence rate, the sequence loudness). */
		audio?: ExportAudioChoice;
		/** wp captions: caption output (burn-in, embedded streams, sidecars). */
		captions?: CaptionExportChoice;
		/** color-mgmt: written colour space, bit depth and HDR metadata. */
		color?: ExportColorChoice;
		/** previews: take the frames of rendered segments from their preview files (Use Previews). */
		usePreviews?: boolean;
		/** previews: stream-copy untouched stretches of H.264 sources (ProRes copies automatically). */
		smartRender?: boolean;
		/** gaps (PRJ-8): Use Proxies — render attached proxies (a draft; never the default). */
		useProxies?: boolean;
		/** spec 12 §2.11: the sound credits sidecar (absent / 'off' = none). */
		credits?: CreditsChoice;
		/** The engine's ffmpeg has an Opus encoder (VP9 goes into WebM with Opus; default true). */
		opus?: boolean;
		/**
		 * ProRes only: a transparent background — straight-alpha ProRes 4444 in MOV, no audio (overlays such as social
		 * comments to place over footage in another editor; the engine renders it on the Remotion path).
		 */
		alpha?: boolean;
		/** spec 18 AF-EXP: a video file (default), an animated GIF, or an audio-only file. */
		format?: ExportFormatChoice;
		gif?: GifChoice;
		audioFile?: AudioFileChoice;
	},
): ExportSettings {
	const col = choice.color ?? DEFAULT_COLOR_CHOICE;
	const s = seq.settings;
	const a = choice.audio ?? {};
	const channels = a.channels && a.channels !== 'auto' ? a.channels : s.masterLayout === '5.1' ? 6 : 2;
	const rate =
		a.sampleRate && a.sampleRate !== 'sequence' ? a.sampleRate : (s.audioSampleRate as 44100 | 48000 | 96000);
	const format = choice.format ?? 'video';
	const range: ExportSettings['range'] =
		choice.range === 'in-out' && hasInOut(seq) ? { type: 'in-out' } : { type: 'entire' };
	const normalize =
		a.loudness === 'off'
			? { normalize: null }
			: typeof a.loudness === 'number'
				? { normalize: { targetLufs: a.loudness, truePeakDb: a.truePeakDb ?? -1 } }
				: {};
	const hasCaptions = seq.captionTracks.length > 0 || Object.keys(captionGroupsOf(seq)).length > 0;
	if (format === 'gif') {
		// the picture as a GIF: burned-in captions and sidecars, no caption streams, no sound (and no credits file)
		const g = choice.gif ?? DEFAULT_GIF_CHOICE;
		const gifCaptions =
			hasCaptions && choice.captions ? captionSettings({ ...choice.captions, embed: false }, seq) : null;
		return {
			sequenceId: seq.id,
			range,
			presetId: 'animated-gif',
			container: 'gif',
			gif: {
				fps: g.fps,
				...(g.width !== 'auto' ? { width: g.width } : {}),
				loop: g.loop,
				dither: g.dither,
				palette: g.palette,
			},
			engine: choice.engine,
			destination: { type: 'download' },
			...(gifCaptions ? { captions: gifCaptions } : {}),
			...(choice.usePreviews ? { usePreviews: true } : {}),
			...(choice.useProxies ? { draftUseProxies: true } : {}),
		};
	}
	if (isAudioOnlyFormat(format)) {
		// the mix alone: caption sidecars may go with it (nothing to burn in or embed)
		const f = choice.audioFile ?? DEFAULT_AUDIO_FILE_CHOICE;
		const sidecars =
			hasCaptions && choice.captions && choice.captions.sidecar !== 'none'
				? captionSettings({ ...choice.captions, burnIn: false, embed: false }, seq)
				: null;
		return {
			sequenceId: seq.id,
			range,
			presetId: `audio-${format}`,
			container: format,
			audio: {
				codec: format === 'wav' ? 'pcm' : format === 'flac' ? 'flac' : 'aac',
				sampleRate: rate ?? 48000,
				channels,
				...(format === 'm4a'
					? { bitrateKbps: channels === 6 ? Math.max(384, f.bitrateKbps) : f.bitrateKbps }
					: { bitDepth: f.bitDepth }),
				...normalize,
			},
			engine: 'auto',
			destination: { type: 'download' },
			...(sidecars ? { captions: sidecars } : {}),
			...(choice.credits && choice.credits !== 'off' ? { credits: { sidecar: choice.credits } } : {}),
		};
	}
	const video = exportFormatOf(choice.codec ?? 'h264', choice.opus ?? true);
	const alpha = choice.alpha === true && choice.codec === 'prores';
	return {
		sequenceId: seq.id,
		range,
		presetId: MATCH_SEQUENCE_PRESET.id,
		container: video.container,
		video: {
			codec: choice.codec ?? 'h264',
			...(choice.encoder ? { encoder: choice.encoder } : {}),
			// H.264 needs even dimensions; sequences are created even (S05:EX-022 never changes them silently).
			width: s.width,
			height: s.height,
			frameRate: { num: s.frameRate.num, den: s.frameRate.den },
			scaling: 'fit',
			quality: { mode: 'crf', value: choice.crf ?? DEFAULT_CRF },
			encoderSpeed: 'balanced',
			// color-mgmt
			...(col.colorSpace !== 'working' ? { colorSpace: col.colorSpace } : {}),
			...(col.bitDepth !== 'auto' ? { bitDepth: col.bitDepth } : {}),
			...(col.maxCll || col.maxFall
				? {
						hdrMetadata: {
							...(col.maxCll ? { maxCll: col.maxCll } : {}),
							...(col.maxFall ? { maxFall: col.maxFall } : {}),
						},
					}
				: {}),
			...(alpha ? { proresProfile: '4444' as const, alpha: true } : {}),
		},
		audio: {
			codec: video.audio,
			sampleRate: rate ?? 48000,
			channels,
			bitrateKbps: channels === 6 ? 384 : AUDIO_KBPS,
			...normalize,
		},
		engine: choice.engine,
		destination: { type: 'download' },
		...(hasCaptions && choice.captions ? { captions: captionSettings(choice.captions, seq) } : {}),
		...(choice.usePreviews ? { usePreviews: true } : {}),
		...(choice.smartRender ? { smartRender: true } : {}),
		...(choice.useProxies ? { draftUseProxies: true } : {}),
		...(choice.credits && choice.credits !== 'off' ? { credits: { sidecar: choice.credits } } : {}),
		...(alpha ? { videoOnly: true } : {}),
	};
}

/**
 * The container and audio codec the dialog asks for with a codec: its own format (ProRes masters: MOV with 24-bit PCM;
 * VP9: WebM with Opus when the engine has Opus; the others MP4 with AAC). The engine writes what it is asked where the
 * codec fits and names any change in the plan's warnings (OUTPUT_CONTAINER_CHANGED / AUDIO_CODEC_CHANGED, WP6.5a).
 */
function exportFormatOf(
	codec: VideoCodec,
	opus: boolean,
): { container: 'mp4' | 'webm' | 'mov'; audio: 'aac' | 'opus' | 'pcm' } {
	if (codec === 'prores') return { container: 'mov', audio: 'pcm' };
	if (codec === 'vp9' && opus) return { container: 'webm', audio: 'opus' };
	return { container: 'mp4', audio: 'aac' };
}

/** The Export dialog's sound credits choice (spec 12 §2.11): no file, or `<name>.credits.<txt|md|csv>`. */
export type CreditsChoice = 'off' | 'txt' | 'md' | 'csv';
export const CREDITS_OPTIONS: { value: CreditsChoice; label: string }[] = [
	{ value: 'off', label: 'Off' },
	{ value: 'txt', label: 'Text (.txt)' },
	{ value: 'md', label: 'Markdown (.md)' },
	{ value: 'csv', label: 'CSV (.csv)' },
];
const isCreditsChoice = (v: unknown): v is CreditsChoice =>
	v === 'off' || v === 'txt' || v === 'md' || v === 'csv';

export type CaptionExportChoice = {
	/** Burn the visible caption tracks into the picture. */
	burnIn: boolean;
	/** Embed every caption track as a subtitle stream (mov_text in MP4/MOV, WebVTT in WebM). */
	embed: boolean;
	/** Sidecar file format, or none. */
	sidecar: 'none' | 'srt' | 'vtt' | 'scc' | 'mcc' | 'stl' | 'ttml' | 'dfxp';
	/** `active` / `all` caption sources, or one subtitle group of text clips by id (spec 13 AS-005). */
	sidecarTracks: 'active' | 'all' | `cgp_${string}`;
};

export const DEFAULT_CAPTION_CHOICE: CaptionExportChoice = {
	burnIn: true,
	embed: false,
	sidecar: 'none',
	sidecarTracks: 'active',
};

export function captionSettings(
	c: CaptionExportChoice,
	seq?: Sequence,
): NonNullable<ExportSettings['captions']> {
	// a remembered group that is not in this sequence falls back to the active caption source
	const group = c.sidecarTracks.startsWith('cgp_') ? c.sidecarTracks : null;
	const tracks = group ? (seq && captionGroupsOf(seq)[group] ? [group] : 'active') : c.sidecarTracks;
	return {
		burnIn: c.burnIn,
		embed: c.embed,
		...(c.sidecar !== 'none'
			? { sidecar: [c.sidecar], sidecarTracks: tracks as 'active' | 'all' | string[] }
			: {}),
	};
}

/** Blocking validation errors shown above the footer (S05:EX-022). */
export function validateExport(
	seq: Sequence,
	range: { start: number; end: number },
	format: ExportFormatChoice = 'video',
	/** spec 18 AF-VER-004: a platform preset writes its own (even) frame size, or refuses the shape itself. */
	platform?: DeliveryTargetId | '',
): string[] {
	const errors: string[] = [];
	if (range.end <= range.start) errors.push('The sequence is empty: there is nothing to export.');
	// GIF sizes are made even by the engine; audio-only files have no picture; a platform preset rescales the picture
	if (format === 'video' && !platform && (seq.settings.width % 2 || seq.settings.height % 2))
		errors.push(
			`H.264 requires an even width and height (${seq.settings.width} × ${seq.settings.height}); change the sequence frame size.`,
		);
	return errors;
}

/** The committed document as the inline envelope the planner and export routes take (ARCHITECTURE §9.5). */
export function exportEnvelope(doc: ProjectDocument, revision: number, platform = 'web') {
	return makeEnvelope(doc, { revision, savedAt: new Date().toISOString(), platform });
}

const PATH_NAMES: Record<string, string> = {
	audio: 'Audio mixdown (no picture)',
	copy: 'Smart render (lossless copy)',
	native: 'Native (ffmpeg)',
	hybrid: 'Hybrid (native + graphics)',
	remotion: 'Remotion',
	browser: 'In browser',
};

function planPathName(path: RenderPlan['path']): string {
	if (path.startsWith('cloud:')) return `Cloud (${path.slice(6)})`;
	return PATH_NAMES[path] ?? path;
}

/** "Auto → Remotion: 1 text layer…" style summary of why the planner chose its path (S05:EX-021). */
export function planChoiceSummary(plan: RenderPlan, engine: ExportEngineChoice): string {
	const name = planPathName(plan.path);
	if (engine !== 'auto') return name;
	const reasons = [...new Set(plan.blockers.map((b) => b.reason))];
	if (reasons.length) return `Auto → ${name}: ${reasons.slice(0, 2).join('; ')}`;
	// Hybrid (wave1c): graphics layers, GPU-effect layers and GPU transition spans are pre-rendered by Remotion; the
	// rest of the export stays native.
	const baked = plan.segments
		.flatMap((s) => s.graphicsGroups)
		.filter((g) => g.engine === 'remotion')
		.reduce((n, g) => n + g.itemIds.length, 0);
	return plan.path === 'hybrid' && baked > 0
		? `Auto → ${name}: ${baked} ${baked === 1 ? 'layer or transition' : 'layers or transitions'} pre-rendered by Remotion, the rest native`
		: `Auto → ${name}`;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = bytes;
	let i = 0;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '—';
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	return h ? `${h}h ${m}m` : m ? `${m}m ${r}s` : `${r}s`;
}

/** EX-023: CRF has no fixed bitrate → "Size depends on content" plus the planner's estimate if any. */
export function sizeEstimateText(plan: RenderPlan | null): string {
	if (!plan || plan.estimate.bytes <= 0) return 'Size depends on content';
	return `Size depends on content (~${formatBytes(plan.estimate.bytes)})`;
}

export function outputDescription(
	seq: Sequence,
	frames: number,
	encoder?: EncoderChoice | null,
	alpha = false,
	deliverable?: { settings: ExportSettings; plan?: RenderPlan['deliverable'] },
): string {
	const fps = fpsOf(seq.settings.frameRate);
	const fpsText = Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
	const duration = formatDuration(frames / fps);
	const st = deliverable?.settings;
	if (st?.container === 'gif') {
		const p = deliverable?.plan?.kind === 'gif' ? deliverable.plan : null;
		const g = st.gif ?? {};
		const w = p?.width ?? g.width ?? Math.min(seq.settings.width, GIF_LIMITS.defaultMaxWidth);
		const h = p?.height ?? Math.max(2, Math.round((w * seq.settings.height) / seq.settings.width / 2) * 2);
		const gfps = p?.fps ?? g.fps ?? GIF_LIMITS.defaultFps;
		const loop = p?.loop ?? g.loop ?? 0;
		const plays = loop === 0 ? 'loops forever' : loop === 1 ? 'plays once' : `plays ${loop} times`;
		return `${w}×${h} · ${gfps} fps · GIF${p ? ` · ${p.frames} frames` : ''} · ${plays} · no audio · ${duration}`;
	}
	if (st && (st.container === 'wav' || st.container === 'flac' || st.container === 'm4a')) {
		const a = st.audio;
		const ch = a?.channels === 1 ? 'mono' : a?.channels === 6 ? '5.1' : 'stereo';
		const rate = `${(a?.sampleRate ?? 48000) / 1000} kHz`;
		const what =
			st.container === 'm4a'
				? `M4A · AAC ${a?.bitrateKbps ?? 192} kb/s`
				: `${st.container.toUpperCase()} · ${st.container === 'wav' ? 'PCM' : 'FLAC'} ${a?.bitDepth ?? 24}-bit`;
		return `${what} · ${rate} ${ch} · no picture · ${duration}`;
	}
	if (alpha && encoder?.codec === 'prores')
		return `${seq.settings.width}×${seq.settings.height} · ${fpsText} fps · ${PRORES_ALPHA_LABEL} · no audio · ${duration}`;
	const video = encoder ? CODEC_LABELS[encoder.codec] : 'H.264';
	const audio =
		encoder?.audioEncoder === 'libopus' ? 'Opus' : encoder?.audioEncoder === 'pcm_s16le' ? 'PCM' : 'AAC';
	return `${seq.settings.width}×${seq.settings.height} · ${fpsText} fps · ${video} · ${audio} 48 kHz stereo · ${duration}`;
}

/** The ProRes export with a transparent background (`buildExportSettings` `alpha`). */
export const PRORES_ALPHA_LABEL = 'ProRes 4444 with alpha';

export const CODEC_LABELS: Record<VideoCodec, string> = {
	h264: 'H.264',
	vp9: 'VP9',
	av1: 'AV1',
	prores: 'ProRes 422 HQ',
	hevc: 'HEVC (H.265)',
};

/** Encoders the engine may pick per codec, in its preference order (mirrors the engine selector). */
const CODEC_ENCODERS: Record<VideoCodec, string[]> = {
	h264: ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'libopenh264', 'libx264'],
	vp9: ['libvpx-vp9'],
	av1: ['libsvtav1', 'libaom-av1'],
	prores: ['prores_ks'],
	hevc: ['hevc_videotoolbox', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_vaapi', 'libkvazaar'],
};
const ENCODER_NAMES: Record<string, string> = {
	h264_videotoolbox: 'Apple VideoToolbox (hardware)',
	h264_nvenc: 'NVIDIA NVENC (hardware)',
	h264_qsv: 'Intel Quick Sync (hardware)',
	h264_amf: 'AMD AMF (hardware)',
	h264_vaapi: 'VA-API (hardware)',
	libopenh264: 'OpenH264',
	libx264: 'x264 (GPL, dev builds only)',
	'libvpx-vp9': 'libvpx',
	libsvtav1: 'SVT-AV1',
	'libaom-av1': 'libaom',
	prores_ks: 'prores_ks',
	hevc_videotoolbox: 'Apple VideoToolbox (hardware, Main10)',
	hevc_nvenc: 'NVIDIA NVENC (hardware, Main10)',
	hevc_qsv: 'Intel Quick Sync (hardware, Main10)',
	hevc_amf: 'AMD AMF (hardware, Main10)',
	hevc_vaapi: 'VA-API (hardware, Main10)',
	libkvazaar: 'Kvazaar (8-bit Main)',
};
const GPL = new Set(['libx264', 'libx264rgb', 'libx265']);

type ChoiceOption<T extends string> = { value: T; label: string; available: boolean; reason?: string };

/** Codec choices; unavailable ones stay listed but disabled (S05:EX-012). */
export function codecOptions(enc: EncodingCapabilities | undefined): ChoiceOption<VideoCodec>[] {
	return (['h264', 'hevc', 'av1', 'vp9', 'prores'] as const).map((c) => {
		const available = !enc || (enc.codecs[c]?.length ?? 0) > 0;
		const container = c === 'prores' ? 'MOV' : c === 'vp9' && enc?.audio.opus ? 'WebM' : 'MP4';
		return {
			value: c,
			label: `${CODEC_LABELS[c]} (${container})`,
			available,
			...(available ? {} : { reason: `No usable ${CODEC_LABELS[c]} encoder in this engine's ffmpeg` }),
		};
	});
}

/**
 * Encoder choices for a codec: "Auto" plus every encoder the build lists; hardware encoders whose test
 * encode failed and GPL encoders in LGPL-only mode are disabled with the reason.
 */
export function encoderOptions(
	enc: EncodingCapabilities | undefined,
	buildEncoders: readonly string[],
	codec: VideoCodec,
): ChoiceOption<string>[] {
	const out: ChoiceOption<string>[] = [{ value: '', label: 'Auto (best available)', available: true }];
	if (!enc) return out;
	const usable = new Set(enc.codecs[codec] ?? []);
	for (const e of CODEC_ENCODERS[codec]) {
		if (!buildEncoders.includes(e)) continue;
		const hw = enc.hardware.find((h) => h.encoder === e);
		const reason = usable.has(e)
			? undefined
			: hw && !hw.usable
				? `Test encode failed${hw.reason ? `: ${hw.reason}` : ''}`
				: enc.lgplOnly && GPL.has(e)
					? 'GPL encoder, ignored in LGPL-only mode'
					: 'Not usable';
		out.push({
			value: e,
			label: ENCODER_NAMES[e] ?? e,
			available: usable.has(e),
			...(reason ? { reason } : {}),
		});
	}
	return out;
}

/** "H.264 · NVIDIA NVENC (hardware) → MP4" for the plan's (or the default) encoder. */
export function encoderSummary(encoder: EncoderChoice | null | undefined): string {
	if (!encoder) return 'No usable video encoder';
	return `${encoder.label} → ${encoder.container.toUpperCase()}`;
}

/**
 * File extension of the export (the engine may write WebM for VP9). A GIF or audio-only export's file is its own
 * container (its plan's encoder is the GIF's picture intermediate).
 */
export function exportExtension(
	encoder: EncoderChoice | null | undefined,
	container?: ExportSettings['container'],
): string {
	if (container === 'gif' || container === 'wav' || container === 'flac' || container === 'm4a')
		return container;
	return encoder?.container === 'webm' ? 'webm' : encoder?.container === 'mov' ? 'mov' : 'mp4';
}

/** audio-mix: Export ▸ Audio choices. `loudness`: 'sequence' = the Mix's normalisation setting, 'off', or a target. */
export type ExportAudioChoice = {
	channels?: 'auto' | 1 | 2 | 6;
	sampleRate?: 'sequence' | 44100 | 48000 | 96000;
	loudness?: 'sequence' | 'off' | number;
	truePeakDb?: number;
};

export type ExportColorChoice = {
	/** `working` = the sequence's working space; else an output space id. */
	colorSpace: 'working' | (typeof OUTPUT_SPACE_IDS)[number];
	bitDepth: 'auto' | 8 | 10 | 12;
	/** CTA-861.3 MaxCLL / MaxFALL (cd/m²) of PQ/HLG outputs; 0 = not written. */
	maxCll: number;
	maxFall: number;
};

export const DEFAULT_COLOR_CHOICE: ExportColorChoice = {
	colorSpace: 'working',
	bitDepth: 'auto',
	maxCll: 0,
	maxFall: 0,
};

/** Colour space choices of the Export settings: Working (its name) and every output space. */
export function exportColorSpaceOptions(seq: Sequence | null): { value: string; label: string }[] {
	const w = colorSpace(sequenceColorInfo(seq?.settings).space)?.label ?? 'Rec. 709';
	return [
		{ value: 'working', label: `Working (${w})` },
		...OUTPUT_SPACE_IDS.map((id) => ({ value: id, label: colorSpace(id)!.label })),
	];
}

/** Whether the chosen output is PQ / HLG (MaxCLL / MaxFALL apply). */
export function hdrOutput(seq: Sequence | null, c: ExportColorChoice): boolean {
	const id = c.colorSpace === 'working' ? sequenceColorInfo(seq?.settings).space : c.colorSpace;
	return id === 'rec2100-pq' || id === 'rec2100-hlg';
}

function sanitizeColorChoice(c: Partial<ExportColorChoice>): ExportColorChoice {
	const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10000 ? v : 0);
	return {
		colorSpace:
			c.colorSpace &&
			(c.colorSpace === 'working' || (OUTPUT_SPACE_IDS as readonly string[]).includes(c.colorSpace))
				? c.colorSpace
				: 'working',
		bitDepth: c.bitDepth === 8 || c.bitDepth === 10 || c.bitDepth === 12 ? c.bitDepth : 'auto',
		maxCll: n(c.maxCll),
		maxFall: n(c.maxFall),
	};
}

type Remembered = {
	/** color-mgmt */
	color?: ExportColorChoice;
	audio?: ExportAudioChoice;
	/** wp captions */
	captions?: CaptionExportChoice;
	range: ExportRangeChoice;
	engine: ExportEngineChoice;
	fileName?: string;
	codec?: VideoCodec;
	encoder?: string;
	/** previews */
	usePreviews?: boolean;
	smartRender?: boolean;
	/** gaps: Use Proxies (draft exports) */
	useProxies?: boolean;
	/** spec 12 §2.11: the sound credits choice last exported with */
	credits?: CreditsChoice;
	/** ProRes with a transparent background (4444 + alpha) */
	alpha?: boolean;
	/** spec 18 AF-EXP: video, GIF or audio only, and their options */
	format?: ExportFormatChoice;
	gif?: GifChoice;
	audioFile?: AudioFileChoice;
	/** spec 18 AF-VER-004: the platform delivery preset (absent = Match Sequence) */
	platform?: DeliveryTargetId;
};
const keyOf = (projectId: string, sequenceId: string) => `jasper.export.${projectId}.${sequenceId}`;

/**
 * The audio encoding the sequence's last export settings write (the Export dialog's remembered choice: its codec's
 * audio — ProRes PCM, VP9 Opus, else AAC — at the dialog's bit rate and the chosen rate), as Sound Check's "Check for"
 * names it: `audio` null for PCM at the sequence rate (the master). Null when the sequence was never exported here.
 */
export function lastExportAudio(
	projectId: string,
	seq: Sequence,
	opus = true,
): { audio: SoundCheckExportAudio | null } | null {
	const r = loadExportChoice(projectId, seq.id);
	if (!r) return null;
	// spec 18 AF-EXP: a GIF has no sound to check; WAV / FLAC are lossless (as the master), M4A is AAC
	if (r.format === 'gif') return null;
	const a = r.audio ?? {};
	const channels =
		a.channels && a.channels !== 'auto' ? a.channels : seq.settings.masterLayout === '5.1' ? 6 : 2;
	const rate = typeof a.sampleRate === 'number' ? a.sampleRate : undefined;
	const format =
		r.format === 'wav' || r.format === 'flac'
			? { audio: 'pcm' as const }
			: r.format === 'm4a'
				? { audio: 'aac' as const }
				: exportFormatOf(r.codec ?? 'h264', opus);
	const kbps =
		r.format === 'm4a'
			? channels === 6
				? Math.max(384, r.audioFile?.bitrateKbps ?? 0)
				: (r.audioFile?.bitrateKbps ?? DEFAULT_AUDIO_FILE_CHOICE.bitrateKbps)
			: channels === 6
				? 384
				: AUDIO_KBPS;
	if (format.audio === 'pcm')
		return {
			audio: rate && rate !== seq.settings.audioSampleRate ? { codec: 'pcm', sampleRate: rate } : null,
		};
	return {
		audio: {
			codec: format.audio,
			bitrateKbps: kbps,
			...(rate && format.audio === 'aac' ? { sampleRate: rate } : {}),
		},
	};
}

export function loadExportChoice(projectId: string, sequenceId: string): Remembered | null {
	try {
		const raw = globalThis.localStorage?.getItem(keyOf(projectId, sequenceId));
		if (!raw) return null;
		const v = JSON.parse(raw) as Partial<Remembered>;
		const range = v.range === 'in-out' ? 'in-out' : 'entire';
		const engine = v.engine === 'native' || v.engine === 'remotion' ? v.engine : 'auto';
		const codec =
			v.codec === 'av1' ||
			v.codec === 'vp9' ||
			v.codec === 'h264' ||
			v.codec === 'prores' ||
			v.codec === 'hevc'
				? v.codec
				: undefined;
		const c = v.captions as Partial<CaptionExportChoice> | undefined;
		const sidecars = ['none', 'srt', 'vtt', 'scc', 'mcc', 'stl', 'ttml', 'dfxp'] as const;
		const captions: CaptionExportChoice | undefined =
			c && typeof c === 'object'
				? {
						burnIn: c.burnIn !== false,
						embed: c.embed === true,
						sidecar: sidecars.includes(c.sidecar as never)
							? (c.sidecar as CaptionExportChoice['sidecar'])
							: 'none',
						sidecarTracks:
							c.sidecarTracks === 'all'
								? 'all'
								: typeof c.sidecarTracks === 'string' && /^cgp_[0-9A-Z]{16}$/.test(c.sidecarTracks)
									? c.sidecarTracks
									: 'active',
					}
				: undefined;
		return {
			range,
			engine,
			...(captions ? { captions } : {}),
			...(typeof v.fileName === 'string' ? { fileName: v.fileName } : {}),
			...(codec ? { codec } : {}),
			...(typeof v.encoder === 'string' && v.encoder ? { encoder: v.encoder } : {}),
			...(v.audio && typeof v.audio === 'object' ? { audio: sanitizeAudioChoice(v.audio) } : {}),
			...(v.color && typeof v.color === 'object' ? { color: sanitizeColorChoice(v.color) } : {}),
			...(v.usePreviews === true ? { usePreviews: true } : {}),
			...(v.smartRender === true ? { smartRender: true } : {}),
			...(v.useProxies === true ? { useProxies: true } : {}),
			...(isCreditsChoice(v.credits) ? { credits: v.credits } : {}),
			...(v.alpha === true ? { alpha: true } : {}),
			...(isFormatChoice(v.format) ? { format: v.format } : {}),
			...(v.gif && typeof v.gif === 'object' ? { gif: sanitizeGifChoice(v.gif) } : {}),
			...(v.audioFile && typeof v.audioFile === 'object'
				? { audioFile: sanitizeAudioFileChoice(v.audioFile) }
				: {}),
			...(isDeliveryTargetId(v.platform) ? { platform: v.platform } : {}),
		};
	} catch {
		return null;
	}
}

function sanitizeGifChoice(g: Partial<GifChoice>): GifChoice {
	const d = DEFAULT_GIF_CHOICE;
	const int = (v: unknown, min: number, max: number) =>
		typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
	return {
		fps:
			typeof g.fps === 'number' &&
			Number.isFinite(g.fps) &&
			g.fps >= GIF_LIMITS.minFps &&
			g.fps <= GIF_LIMITS.maxFps
				? g.fps
				: d.fps,
		width: int(g.width, GIF_LIMITS.minWidth, GIF_LIMITS.maxWidth) ?? 'auto',
		loop: int(g.loop, 0, GIF_LIMITS.maxPlays) ?? d.loop,
		dither: (GIF_DITHERS as readonly string[]).includes(g.dither as string)
			? (g.dither as GifChoice['dither'])
			: d.dither,
		palette: (GIF_PALETTES as readonly string[]).includes(g.palette as string)
			? (g.palette as GifChoice['palette'])
			: d.palette,
	};
}

function sanitizeAudioFileChoice(f: Partial<AudioFileChoice>): AudioFileChoice {
	return {
		bitDepth: f.bitDepth === 16 ? 16 : 24,
		bitrateKbps: (AAC_BITRATES as readonly number[]).includes(f.bitrateKbps as number)
			? (f.bitrateKbps as number)
			: DEFAULT_AUDIO_FILE_CHOICE.bitrateKbps,
	};
}

function sanitizeAudioChoice(a: ExportAudioChoice): ExportAudioChoice {
	return {
		channels: a.channels === 1 || a.channels === 2 || a.channels === 6 ? a.channels : 'auto',
		sampleRate:
			a.sampleRate === 44100 || a.sampleRate === 48000 || a.sampleRate === 96000 ? a.sampleRate : 'sequence',
		loudness:
			a.loudness === 'off' || (typeof a.loudness === 'number' && a.loudness >= -60 && a.loudness <= 0)
				? a.loudness
				: 'sequence',
		truePeakDb:
			typeof a.truePeakDb === 'number' && a.truePeakDb >= -20 && a.truePeakDb <= 0 ? a.truePeakDb : -1,
	};
}

export function saveExportChoice(projectId: string, sequenceId: string, v: Remembered): void {
	try {
		globalThis.localStorage?.setItem(keyOf(projectId, sequenceId), JSON.stringify(v));
	} catch {
		// storage unavailable (private mode): not remembered
	}
}

/** File names must not contain characters that are illegal on common file systems (S05:EX-012). */
export function sanitizeFileName(name: string, ext?: string): string {
	let cleaned = name
		.replace(/[<>:"/\\|?*]/g, '_')
		.split('')
		.filter((ch) => ch.charCodeAt(0) >= 32)
		.join('')
		.trim()
		// The container extension is added by the export (users often type "name.mp4").
		.replace(/\.mp4$/i, '')
		.trim();
	// …and the extension of the file being written ("loop.gif" for a GIF is "loop")
	if (ext && /^[a-z0-9]+$/i.test(ext) && cleaned.toLowerCase().endsWith(`.${ext.toLowerCase()}`))
		cleaned = cleaned.slice(0, -(ext.length + 1)).trim();
	return cleaned || 'Export';
}

/**
 * spec 18 AF-VER-004: a platform delivery preset over the dialog's settings — H.264 + AAC 48 kHz in MP4 (the engine's
 * LGPL encoder selector picks or substitutes the H.264 encoder), the platform's frame size, rate and loudness
 * normalisation (`deliveryExportFormat`). A sequence of another shape (a horizontal sequence for a vertical platform)
 * is refused with the reason: the dialog never crops; Sequence ▸ Auto Reframe Sequence makes a copy of the right shape.
 */
export function applyDeliveryPreset(
	settings: ExportSettings,
	seq: Sequence,
	targetId: DeliveryTargetId,
): { ok: true; settings: ExportSettings } | { ok: false; message: string } {
	const t = deliveryTarget(targetId);
	const f = deliveryExportFormat(t, seq.settings);
	if (!f.ok)
		return {
			ok: false,
			message: `${t.name} takes ${t.aspect} pictures and this sequence is ${seq.settings.width} × ${seq.settings.height}: it would have to be cropped. Make a ${t.aspect} copy with Sequence ▸ Auto Reframe Sequence… and export that.`,
		};
	const p = f.format;
	const {
		codec: _codec,
		encoder: _encoder,
		bitDepth: _depth,
		hdrMetadata: _hdr,
		alpha: _alpha,
		proresProfile: _prores,
		...video
	} = settings.video ?? ({} as NonNullable<ExportSettings['video']>);
	const { videoOnly: _videoOnly, ...rest } = settings;
	return {
		ok: true,
		settings: {
			...rest,
			presetId: p.presetId,
			container: p.container,
			video: {
				...video,
				codec: p.videoCodec,
				width: p.width,
				height: p.height,
				frameRate: p.frameRate,
				scaling: 'fit',
				quality: { mode: 'crf', value: p.crf },
				encoderSpeed: video.encoderSpeed ?? 'balanced',
			},
			audio: {
				codec: p.audio.codec,
				sampleRate: p.audio.sampleRate,
				channels: 2,
				bitrateKbps: p.audio.bitrateKbps,
				normalize: p.normalize,
			},
		},
	};
}
