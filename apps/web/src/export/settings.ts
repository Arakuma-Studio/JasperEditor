// Export settings for Export mode (S05 §15, S04 §10.2 M1 subset): the "Match Sequence – H.264" preset,
// ranges, per-sequence remembered choices (S05:EX-014), plan-path names (S04:EX-005) and size estimates
// (S05:EX-023).
import type {
	EncoderChoice,
	EncodingCapabilities,
	ExportSettings,
	RenderPlan,
	VideoCodec,
} from '@jasper/api';
import {
	colorSpace,
	fpsOf,
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
	},
): ExportSettings {
	const col = choice.color ?? DEFAULT_COLOR_CHOICE;
	const s = seq.settings;
	const a = choice.audio ?? {};
	const channels = a.channels && a.channels !== 'auto' ? a.channels : s.masterLayout === '5.1' ? 6 : 2;
	const rate =
		a.sampleRate && a.sampleRate !== 'sequence' ? a.sampleRate : (s.audioSampleRate as 44100 | 48000 | 96000);
	return {
		sequenceId: seq.id,
		range: choice.range === 'in-out' && hasInOut(seq) ? { type: 'in-out' } : { type: 'entire' },
		presetId: MATCH_SEQUENCE_PRESET.id,
		container: 'mp4',
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
		},
		audio: {
			codec: 'aac',
			sampleRate: rate ?? 48000,
			channels,
			bitrateKbps: channels === 6 ? 384 : AUDIO_KBPS,
			...(a.loudness === 'off'
				? { normalize: null }
				: typeof a.loudness === 'number'
					? { normalize: { targetLufs: a.loudness, truePeakDb: a.truePeakDb ?? -1 } }
					: {}),
		},
		engine: choice.engine,
		destination: { type: 'download' },
		...(seq.captionTracks.length && choice.captions ? { captions: captionSettings(choice.captions) } : {}),
		...(choice.usePreviews ? { usePreviews: true } : {}),
		...(choice.smartRender ? { smartRender: true } : {}),
		...(choice.useProxies ? { draftUseProxies: true } : {}),
		...(choice.credits && choice.credits !== 'off' ? { credits: { sidecar: choice.credits } } : {}),
	};
}

/** The Export dialog's sound credits choice (spec 12 §2.11): no file, or `<name>.credits.<txt|md|csv>`. */
export type CreditsChoice = 'off' | 'txt' | 'md' | 'csv';
export const CREDITS_OPTIONS: { value: CreditsChoice; label: string }[] = [
	{ value: 'off', label: 'Off' },
	{ value: 'txt', label: 'Text (.txt)' },
	{ value: 'md', label: 'Markdown (.md)' },
	{ value: 'csv', label: 'CSV (.csv)' },
];
const isCreditsChoice = (v: unknown): v is CreditsChoice => v === 'off' || v === 'txt' || v === 'md' || v === 'csv';

export type CaptionExportChoice = {
	/** Burn the visible caption tracks into the picture. */
	burnIn: boolean;
	/** Embed every caption track as a subtitle stream (mov_text in MP4/MOV, WebVTT in WebM). */
	embed: boolean;
	/** Sidecar file format, or none. */
	sidecar: 'none' | 'srt' | 'vtt' | 'scc' | 'mcc' | 'stl' | 'ttml' | 'dfxp';
	sidecarTracks: 'active' | 'all';
};

export const DEFAULT_CAPTION_CHOICE: CaptionExportChoice = {
	burnIn: true,
	embed: false,
	sidecar: 'none',
	sidecarTracks: 'active',
};

export function captionSettings(c: CaptionExportChoice): NonNullable<ExportSettings['captions']> {
	return {
		burnIn: c.burnIn,
		embed: c.embed,
		...(c.sidecar !== 'none' ? { sidecar: [c.sidecar], sidecarTracks: c.sidecarTracks } : {}),
	};
}

/** Blocking validation errors shown above the footer (S05:EX-022). */
export function validateExport(seq: Sequence, range: { start: number; end: number }): string[] {
	const errors: string[] = [];
	if (range.end <= range.start) errors.push('The sequence is empty: there is nothing to export.');
	if (seq.settings.width % 2 || seq.settings.height % 2)
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

export function outputDescription(seq: Sequence, frames: number, encoder?: EncoderChoice | null): string {
	const fps = fpsOf(seq.settings.frameRate);
	const fpsText = Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
	const video = encoder ? CODEC_LABELS[encoder.codec] : 'H.264';
	const audio =
		encoder?.audioEncoder === 'libopus' ? 'Opus' : encoder?.audioEncoder === 'pcm_s16le' ? 'PCM' : 'AAC';
	return `${seq.settings.width}×${seq.settings.height} · ${fpsText} fps · ${video} · ${audio} 48 kHz stereo · ${formatDuration(frames / fps)}`;
}

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

/** File extension of the export (the engine may write WebM for VP9). */
export function exportExtension(encoder: EncoderChoice | null | undefined): string {
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
};
const keyOf = (projectId: string, sequenceId: string) => `jasper.export.${projectId}.${sequenceId}`;

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
						sidecarTracks: c.sidecarTracks === 'all' ? 'all' : 'active',
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
		};
	} catch {
		return null;
	}
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
export function sanitizeFileName(name: string): string {
	const cleaned = name
		.replace(/[<>:"/\\|?*]/g, '_')
		.split('')
		.filter((ch) => ch.charCodeAt(0) >= 32)
		.join('')
		.trim()
		// The container extension is added by the export (users often type "name.mp4").
		.replace(/\.mp4$/i, '')
		.trim();
	return cleaned || 'Export';
}
