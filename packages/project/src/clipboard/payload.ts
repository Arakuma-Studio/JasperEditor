// The clipboard payload (S01:CLB-001, CLB-009): a versioned, self-contained JSON document written on copy and
// validated with zod on paste. Every entity the copied content references travels with it (media records with
// fingerprints and locators, synthetics, transcripts, fonts), so a paste into another project resolves.
// Additive fields beyond the S01 sketch: `clips.trackKinds` / `clips.frameRate` / `clips.primaryClipId`,
// `effects.source`, `keyframes.tracks`, `items.rootItems`, `mediaItems` (names of the copied media's items).
import { z } from 'zod';
import type { ClipTiming } from '../color/retime.ts';
import type { Animatable, Keyframe, LabelColor } from '../schema/common.ts';
import {
	AnimNumberSchema,
	keyframeSchema,
	LabelColorSchema,
	nonNegInt,
	RationalSchema,
	type RationalT,
} from '../schema/common.ts';
import { type ProjectItem, ProjectItemSchema } from '../schema/document.ts';
import {
	type FontRef,
	FontRefSchema,
	type MediaAsset,
	MediaAssetSchema,
	type SyntheticSource,
	SyntheticSourceSchema,
	type Transcript,
	TranscriptSchema,
} from '../schema/media.ts';
import {
	BlendModeSchema,
	type Clip,
	ClipSchema,
	type EffectInstance,
	EffectInstanceSchema,
	type Sequence,
	SequenceSchema,
	type TrackKind,
	TrackKindSchema,
	type Transform,
	TransformSchema,
	type Transition,
	TransitionSchema,
} from '../schema/sequence.ts';

export const CLIPBOARD_FORMAT = 'jasper-clipboard';
export const CLIPBOARD_VERSION = 1;
/** CLB-009: payloads larger than this (UTF-8 bytes of the JSON) are refused. */
export const CLIPBOARD_MAX_BYTES = 20 * 1024 * 1024;
export const CLIPBOARD_KINDS = ['clips', 'effects', 'keyframes', 'project-items'] as const;
export type ClipboardKind = (typeof CLIPBOARD_KINDS)[number];

/** The source clip's timing: keyframes are clip content time, so pastes re-time them from this. */
export const ClipTimingSchema = z.looseObject({
	start: nonNegInt(),
	duration: z.number().int().min(1),
	sourceIn: nonNegInt(),
	speed: z.looseObject({ rate: z.number().min(0.01).max(100), reverse: z.boolean() }),
});

const ClipsSectionSchema = z.looseObject({
	clips: z.array(ClipSchema).min(1),
	transitions: z.array(TransitionSchema),
	/** Earliest copied start (sequence frames of the source). */
	originFrame: nonNegInt(),
	/** Source track id → offset above the lowest copied track of its kind. */
	trackOffsets: z.record(z.string(), nonNegInt()),
	/** Source track id → its kind (unknown clip kinds cannot tell). */
	trackKinds: z.record(z.string(), TrackKindSchema),
	/** Frame rate of the source sequence: starts and durations are converted when the target differs. */
	frameRate: RationalSchema,
	/** The clip Paste Attributes takes its attributes from (the primary selection when copied). */
	primaryClipId: z.string().nullable().optional(),
});

const IntrinsicSchema = z.looseObject({
	transform: TransformSchema.optional(),
	opacity: AnimNumberSchema.optional(),
	blendMode: BlendModeSchema.optional(),
	volumeDb: AnimNumberSchema.optional(),
	pan: AnimNumberSchema.optional(),
});

const EffectsSectionSchema = z.looseObject({
	effects: z.array(EffectInstanceSchema),
	intrinsic: IntrinsicSchema.optional(),
	/** Timing and kind of the clip the effects came from. */
	source: z.looseObject({ clipKind: z.string(), timing: ClipTimingSchema, frameRate: RationalSchema }),
});

/** Where a copied keyframe track lives on its clip: a property key, or a param of an applied effect. */
export const KeyframeAddressSchema = z.union([
	z.looseObject({ property: z.string().min(1) }),
	z.looseObject({ effectId: z.string().min(1), occurrence: nonNegInt(), param: z.string().min(1) }),
]);
export type KeyframeAddress = { property: string } | { effectId: string; occurrence: number; param: string };

const KeyframeTrackSchema = z.looseObject({
	address: KeyframeAddressSchema,
	/** Value kind of the parameter (`number`, `vec2`, `color`, …): pastes only go to the same kind. */
	paramType: z.string().min(1),
	keyframes: z.array(keyframeSchema(z.unknown())).min(1),
});

const KeyframesSectionSchema = z.looseObject({
	/** The first track's type and keys (S01 sketch); `tracks` holds every copied property. */
	paramType: z.string().min(1),
	keyframes: z.array(keyframeSchema(z.unknown())).min(1),
	/** Content time of the earliest copied key: pasted keys keep their offsets from it. */
	originFlicks: nonNegInt(),
	tracks: z.array(KeyframeTrackSchema).min(1),
	/** Source clip speed: offsets are converted through sequence time when the target's speed differs. */
	speed: z.looseObject({ rate: z.number().min(0.01).max(100), reverse: z.boolean() }),
});

const ItemsSectionSchema = z.looseObject({
	/** Every copied item (bins with all their descendants). */
	items: z.array(ProjectItemSchema).min(1),
	/** The sequences of the copied sequence items, plus sequences nested in them. */
	sequences: z.array(SequenceSchema),
	/** The copied top-level items, in order (the others are descendants of copied bins). */
	rootItems: z.array(z.string()).min(1),
});

export const ClipboardPayloadSchema = z
	.looseObject({
		format: z.literal(CLIPBOARD_FORMAT),
		version: z.literal(CLIPBOARD_VERSION),
		sourceProjectId: z.string(),
		sourceSequenceId: z.string().nullable(),
		kind: z.enum(CLIPBOARD_KINDS),
		createdAt: z.string().optional(),
		clips: ClipsSectionSchema.optional(),
		effects: EffectsSectionSchema.optional(),
		keyframes: KeyframesSectionSchema.optional(),
		items: ItemsSectionSchema.optional(),
		media: z.array(MediaAssetSchema),
		synthetics: z.array(SyntheticSourceSchema),
		transcripts: z.array(TranscriptSchema),
		fonts: z.array(FontRefSchema),
		/** Name and label of a copied media's project item (used when a paste adds the asset to a project). */
		mediaItems: z.record(z.string(), z.looseObject({ name: z.string(), label: LabelColorSchema })).optional(),
	})
	.superRefine((p, ctx) => {
		const section = { clips: p.clips, effects: p.effects, keyframes: p.keyframes, 'project-items': p.items }[
			p.kind
		];
		if (!section) ctx.addIssue({ code: 'custom', message: `A "${p.kind}" payload needs its section` });
	});

export type ClipsSection = {
	clips: Clip[];
	transitions: Transition[];
	originFrame: number;
	trackOffsets: Record<string, number>;
	trackKinds: Record<string, TrackKind>;
	frameRate: RationalT;
	primaryClipId?: string | null;
};
export type IntrinsicAttributes = {
	transform?: Transform;
	opacity?: Animatable<number>;
	blendMode?: Extract<Clip, { kind: 'video' }>['blendMode'];
	volumeDb?: Animatable<number>;
	pan?: Animatable<number>;
};
export type EffectsSection = {
	effects: EffectInstance[];
	intrinsic?: IntrinsicAttributes;
	source: { clipKind: string; timing: ClipTiming; frameRate: RationalT };
};
export type KeyframeTrack = { address: KeyframeAddress; paramType: string; keyframes: Keyframe<unknown>[] };
export type KeyframesSection = {
	paramType: string;
	keyframes: Keyframe<unknown>[];
	originFlicks: number;
	tracks: KeyframeTrack[];
	speed: { rate: number; reverse: boolean };
};
export type ItemsSection = { items: ProjectItem[]; sequences: Sequence[]; rootItems: string[] };

export type ClipboardPayload = {
	format: typeof CLIPBOARD_FORMAT;
	version: typeof CLIPBOARD_VERSION;
	sourceProjectId: string;
	sourceSequenceId: string | null;
	kind: ClipboardKind;
	createdAt?: string;
	clips?: ClipsSection;
	effects?: EffectsSection;
	keyframes?: KeyframesSection;
	items?: ItemsSection;
	media: MediaAsset[];
	synthetics: SyntheticSource[];
	transcripts: Transcript[];
	fonts: FontRef[];
	mediaItems?: Record<string, { name: string; label: LabelColor }>;
};

export type ParseResult =
	| { ok: true; payload: ClipboardPayload }
	| { ok: false; code: 'E_SCHEMA' | 'E_LIMIT'; message: string };

/** UTF-8 byte length without allocating the encoded string. */
export function utf8Length(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

/**
 * Validates clipboard data (CLB-009): a JSON string or an already parsed value. Nothing is trusted: unknown
 * formats, other versions, oversized payloads and anything the zod schemas reject are refused with a message.
 */
export function parseClipboardPayload(input: unknown): ParseResult {
	let raw = input;
	if (typeof input === 'string') {
		if (utf8Length(input) > CLIPBOARD_MAX_BYTES)
			return { ok: false, code: 'E_LIMIT', message: 'Clipboard data is larger than 20 MB' };
		try {
			raw = JSON.parse(input);
		} catch {
			return { ok: false, code: 'E_SCHEMA', message: 'Clipboard data is not valid JSON' };
		}
	} else if (input !== null && typeof input === 'object') {
		let size: number;
		try {
			size = utf8Length(JSON.stringify(input));
		} catch {
			return { ok: false, code: 'E_SCHEMA', message: 'Clipboard data is not serializable' };
		}
		if (size > CLIPBOARD_MAX_BYTES)
			return { ok: false, code: 'E_LIMIT', message: 'Clipboard data is larger than 20 MB' };
	}
	const head = raw as { format?: unknown; version?: unknown } | null;
	if (!head || typeof head !== 'object' || head.format !== CLIPBOARD_FORMAT)
		return { ok: false, code: 'E_SCHEMA', message: 'The clipboard holds no JasperEditor content' };
	if (head.version !== CLIPBOARD_VERSION)
		return {
			ok: false,
			code: 'E_SCHEMA',
			message:
				typeof head.version === 'number' && head.version > CLIPBOARD_VERSION
					? `Clipboard content from a newer JasperEditor (format version ${head.version}) cannot be pasted; update the app`
					: `Unsupported clipboard format version ${JSON.stringify(head.version)}`,
		};
	const parsed = ClipboardPayloadSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
		return {
			ok: false,
			code: 'E_SCHEMA',
			message: `Invalid clipboard data${where}: ${issue?.message ?? ''}`,
		};
	}
	return { ok: true, payload: parsed.data as unknown as ClipboardPayload };
}

// ---------------------------------------------------------------- system clipboard encoding (CLB-002)

const MARK = 'data-jasper-clipboard';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 encoding (the model is DOM- and Node-free, so no TextEncoder). */
function utf8Bytes(s: string): Uint8Array {
	const out = new Uint8Array(utf8Length(s));
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		let c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const lo = s.charCodeAt(i + 1);
			if (lo >= 0xdc00 && lo <= 0xdfff) {
				c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
				i++;
			}
		}
		if (c < 0x80) out[n++] = c;
		else if (c < 0x800) {
			out[n++] = 0xc0 | (c >> 6);
			out[n++] = 0x80 | (c & 63);
		} else if (c < 0x10000) {
			out[n++] = 0xe0 | (c >> 12);
			out[n++] = 0x80 | ((c >> 6) & 63);
			out[n++] = 0x80 | (c & 63);
		} else {
			out[n++] = 0xf0 | (c >> 18);
			out[n++] = 0x80 | ((c >> 12) & 63);
			out[n++] = 0x80 | ((c >> 6) & 63);
			out[n++] = 0x80 | (c & 63);
		}
	}
	return out.subarray(0, n);
}

/** Strict UTF-8 decoding; null on malformed input. */
function utf8Decode(b: Uint8Array): string | null {
	let out = '';
	for (let i = 0; i < b.length; ) {
		const c = b[i]!;
		let cp: number;
		let extra: number;
		if (c < 0x80) [cp, extra] = [c, 0];
		else if (c >= 0xc2 && c < 0xe0) [cp, extra] = [c & 31, 1];
		else if (c >= 0xe0 && c < 0xf0) [cp, extra] = [c & 15, 2];
		else if (c >= 0xf0 && c < 0xf5) [cp, extra] = [c & 7, 3];
		else return null;
		if (i + extra >= b.length + (extra ? 0 : 1)) return null;
		for (let k = 1; k <= extra; k++) {
			const x = b[i + k];
			if (x === undefined || (x & 0xc0) !== 0x80) return null;
			cp = (cp << 6) | (x & 63);
		}
		if ((extra === 2 && cp < 0x800) || (extra === 3 && (cp < 0x10000 || cp > 0x10ffff))) return null;
		if (cp >= 0xd800 && cp <= 0xdfff) return null;
		out += String.fromCodePoint(cp);
		i += extra + 1;
	}
	return out;
}

function toBase64(s: string): string {
	const b = utf8Bytes(s);
	let out = '';
	let i = 0;
	for (; i + 2 < b.length; i += 3) {
		const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
		out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
	}
	if (i < b.length) {
		const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8);
		out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
		out += i + 1 < b.length ? `${B64[(n >> 6) & 63]!}=` : '==';
	}
	return out;
}

function fromBase64(s: string): string | null {
	const clean = s.replace(/\s+/g, '');
	if (clean.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(clean)) return null;
	const bytes = new Uint8Array((clean.length / 4) * 3);
	let n = 0;
	for (let i = 0; i < clean.length; i += 4) {
		const v = [0, 1, 2, 3].map((k) => (clean[i + k] === '=' ? 0 : B64.indexOf(clean[i + k]!)));
		const x = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!;
		bytes[n++] = (x >> 16) & 255;
		if (clean[i + 2] !== '=') bytes[n++] = (x >> 8) & 255;
		if (clean[i + 3] !== '=') bytes[n++] = x & 255;
	}
	return utf8Decode(bytes.subarray(0, n));
}

const escapeHtml = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `text/html` for the system clipboard (CLB-002): the JSON travels base64-encoded in an attribute of a marked
 * element (attributes survive the HTML sanitizers of browsers and other apps), followed by the readable text.
 */
export function encodeClipboardHtml(json: string, text: string): string {
	return `<meta charset="utf-8"><span ${MARK}="${toBase64(json)}"></span><pre>${escapeHtml(text)}</pre>`;
}

/** The JSON embedded by `encodeClipboardHtml`, or null when the HTML carries none. */
export function decodeClipboardHtml(html: string): string | null {
	if (html.length > Math.ceil((CLIPBOARD_MAX_BYTES * 4) / 3) + 1_000_000) return null;
	const m = new RegExp(`${MARK}="([A-Za-z0-9+/=\\s]*)"`).exec(html);
	if (!m) return null;
	return fromBase64(m[1]!);
}

/** `text/plain` (CLB-002): the text of text and captions clips, else clip, effect or item names. */
export function clipboardText(p: ClipboardPayload): string {
	switch (p.kind) {
		case 'clips': {
			const clips = [...(p.clips?.clips ?? [])].sort((a, b) => a.start - b.start);
			const texts = clips
				.map((c) => (c.kind === 'text' ? (c as { content: { text: string } }).content.text : null))
				.filter((t): t is string => t !== null);
			const captions = clips.flatMap((c) => {
				if (c.kind !== 'captions') return [];
				const t = p.transcripts.find((x) => x.id === (c as { transcriptId: string }).transcriptId);
				return t ? [t.words.map((w) => w.text).join(' ')] : [];
			});
			const all = [...texts, ...captions];
			return all.length ? all.join('\n') : [...new Set(clips.map((c) => c.name || c.kind))].join('\n');
		}
		case 'effects':
			return (p.effects?.effects ?? []).map((e) => e.effectId).join('\n') || 'Effects';
		case 'keyframes':
			return `${p.keyframes?.keyframes.length ?? 0} keyframes`;
		case 'project-items':
			return (p.items?.items ?? [])
				.filter((it) => p.items?.rootItems.includes(it.id))
				.map((it) => it.name)
				.join('\n');
	}
}
