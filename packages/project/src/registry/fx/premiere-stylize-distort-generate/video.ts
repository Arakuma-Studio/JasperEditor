// Premiere Pro standard effects — Video bin (family "premiere-stylize-distort-generate"): Clip Name,
// Timecode, Simple Text. Text is drawn in GLSL from a 1-bit bitmap font (video-font.ts, bilinear + soft threshold so
// it scales cleanly); the string is composed in TypeScript (`gpu.uniforms`, per frame for Timecode) and passed as
// `u_text` (3 characters per float, 7 bits each — exact in float32) with `u_textLen`.
// Clip context (`ctx.clip`): Clip Name's Display shows the sequence clip name, the project item name or the file
// name (instances made before Display existed have no `display` value and keep showing their Name field, as does
// every choice when the host gives no clip context); Timecode's "Media" source is the source timecode — the
// media's embedded start timecode + the source position (in-point, speed, reverse) at the frame.
// Timecode's Field Symbol (an interlace indicator) is kept for parity but draws nothing (progressive only).
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { fxParam } from '../params.ts';
import { type FxFrameContext, fxSourceSeconds, type GlslChunk } from '../shader.ts';
import { num, str } from './common.ts';
import { GLSL_PSDG_FONT, PSDG_FONT_CELL } from './video-font.ts';

/** Most characters drawn by one text effect. */
export const PSDG_TEXT_MAX = 63;
const TEXT_FLOATS = PSDG_TEXT_MAX / 3;

/** Packs a string into `PSDG_TEXT_MAX / 3` floats (3 × 7-bit codes per float; printable ASCII, others → '?'). */
export function encodeText(s: string): { floats: number[]; length: number } {
	const codes: number[] = [];
	for (const ch of s.slice(0, PSDG_TEXT_MAX)) {
		const c = ch.charCodeAt(0);
		codes.push(c >= 32 && c <= 126 ? c - 31 : 63 - 31);
	}
	const floats = new Array<number>(TEXT_FLOATS).fill(0);
	codes.forEach((c, i) => {
		floats[Math.floor(i / 3)]! += c * 128 ** (i % 3);
	});
	return { floats, length: codes.length };
}

const stringParam = (name: string, label: string, def: string): ParamSpec => ({
	name,
	label,
	type: 'string',
	default: def,
	animatable: false,
});

/**
 * Text drawing: `psdg_text(lp)` = (text coverage, box coverage) at layer px `lp` for the text `u_text`/`u_textLen`,
 * cell height `u_cellH` (layer px), anchored at `u_anchor` (layer px) with `u_align` (0 left, 1 centre, 2 right).
 */
const GLSL_PSDG_TEXT: GlslChunk = {
	name: 'psdg/text',
	deps: [GLSL_PSDG_FONT],
	source: /* glsl */ `
int psdg_charAt(int i) {
  int v = int(u_text[i / 3] + 0.5);
  int k = i - (i / 3) * 3;
  v = (v >> (7 * k)) & 127;
  return v == 0 ? 32 : v + 31;
}
float psdg_glyph(int code, vec2 g) {
  // Bilinear between the 4 nearest font pixels (pixel centres at +0.5).
  vec2 h = g - 0.5;
  ivec2 i = ivec2(floor(h));
  vec2 f = h - vec2(i);
  float a = psdg_glyphBit(code, i.x, i.y), b = psdg_glyphBit(code, i.x + 1, i.y);
  float c = psdg_glyphBit(code, i.x, i.y + 1), d = psdg_glyphBit(code, i.x + 1, i.y + 1);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// x: text coverage, y: background box coverage.
vec2 psdg_text(vec2 lp) {
  float ch = max(u_cellH, 1.0);
  float cw = ch * ${PSDG_FONT_CELL.width}.0 / ${PSDG_FONT_CELL.height}.0;
  float tw = cw * float(u_textLen);
  float pad = ch * 0.18;
  vec2 origin = vec2(u_anchor.x - (u_align == 0 ? 0.0 : u_align == 1 ? tw * 0.5 : tw), u_anchor.y - ch * 0.5);
  vec2 q = lp - origin;
  float px = 1.0 / u_pxScale;
  vec2 bmin = vec2(-pad, -pad * 0.4), bmax = vec2(tw + pad, ch + pad * 0.4);
  vec2 inb = smoothstep(bmin - px * 0.5, bmin + px * 0.5, q) * (1.0 - smoothstep(bmax - px * 0.5, bmax + px * 0.5, q));
  float box = u_textLen > 0 ? inb.x * inb.y : 0.0;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= tw || q.y >= ch) return vec2(0.0, box);
  int i = int(floor(q.x / cw));
  float scale = ${PSDG_FONT_CELL.height}.0 / ch; // font px per layer px
  vec2 g = vec2(q.x - float(i) * cw, q.y) * scale;
  float v = psdg_glyph(psdg_charAt(i), g);
  float w = clamp(0.5 * scale * px, 0.08, 0.5);
  return vec2(smoothstep(0.5 - w, 0.5 + w, v), box);
}
`,
};

/** Shared params: Position, (Alignment), Size (% of the layer height), Opacity (of the box). */
function textLayoutParams(opts: {
	position: [number, number];
	size: number;
	opacity: number;
	align?: boolean;
}) {
	return [
		fxParam.point('position', 'Position', opts.position),
		...(opts.align
			? [
					fxParam.choice(
						'alignment',
						'Alignment',
						['left', 'center', 'right'],
						['Left', 'Center', 'Right'],
						'center',
					),
				]
			: []),
		fxParam.number('size', 'Size', opts.size, { min: 1, max: 100, softMax: 50, step: 0.1 }, { unit: '%' }),
		fxParam.percent('opacity', 'Opacity', opts.opacity),
	];
}

const ALIGN = ['left', 'center', 'right'];
function layoutUniforms(p: EffectParams, ctx: FxFrameContext, text: string, align: string) {
	const pos = Array.isArray(p.position) ? (p.position as number[]) : [0.5, 0.5];
	const enc = encodeText(text);
	return {
		u_text: { floats: enc.floats },
		u_textLen: { int: enc.length },
		u_anchor: [num(pos[0], 0.5) * ctx.width, num(pos[1], 0.5) * ctx.height] as [number, number],
		u_cellH: (Math.max(0, num(p.size, 10)) / 100) * ctx.height * 0.62,
		u_align: { int: Math.max(0, ALIGN.indexOf(align)) },
	};
}

const textFrag = /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec2 t = psdg_text(fx_layerPx());
  vec4 box = vec4(0.0, 0.0, 0.0, 1.0) * t.y * u_opacity / 100.0;
  vec4 text = vec4(1.0) * t.x;
  fragColor = text + (box + src * (1.0 - box.a)) * (1.0 - text.a);
}`;

const CLIP_NAME_DISPLAYS = ['sequenceClipName', 'projectItemName', 'fileName', 'custom'] as const;

/**
 * The text Clip Name shows: Display = Sequence Clip Name / Project Item Name / File Name from the clip context, or
 * the Name field (Display "Custom", instances without a Display value, no clip context, an empty name).
 */
export function clipNameText(p: EffectParams, ctx: Pick<FxFrameContext, 'clip'>): string {
	const typed = str(p.name, 'Clip Name');
	const display = typeof p.display === 'string' ? p.display : 'custom';
	const c = ctx.clip;
	if (!c) return typed;
	const v =
		display === 'sequenceClipName'
			? c.clipName
			: display === 'projectItemName'
				? c.itemName
				: display === 'fileName'
					? c.fileName
					: '';
	return v || typed;
}

export const CLIP_NAME = defineShaderEffect({
	id: 'jasper.clip-name',
	label: 'Clip Name',
	category: 'Video',
	description:
		'Burns a clip name into the picture (white text on a semi-transparent box), e.g. for review copies.',
	keywords: ['burn-in', 'name', 'label', 'overlay', 'review', 'text'],
	params: [
		...textLayoutParams({ position: [0.5, 0.85], size: 8, opacity: 50, align: true }),
		fxParam.choice(
			'display',
			'Display',
			CLIP_NAME_DISPLAYS,
			['Sequence Clip Name', 'Project Item Name', 'File Name', 'Custom (Name)'],
			'sequenceClipName',
		),
		stringParam('name', 'Name', 'Clip Name'),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => layoutUniforms(p, ctx, clipNameText(p, ctx), str(p.alignment, 'center')),
		passes: [{ include: [GLSL_PSDG_TEXT], frag: textFrag }],
	},
});

const TIME_DISPLAYS = ['24', '25', '30df', '30', '50', '60df', '60'] as const;

/** SMPTE / frames / feet+frames text of a frame count at a display rate (pure). */
export function formatTimecode(frames: number, display: string, format: string): string {
	const df = display.endsWith('df');
	const base = Number.parseInt(display, 10) || 30;
	let n = Math.max(0, Math.floor(frames));
	const pad = (v: number, w = 2) => String(v).padStart(w, '0');
	if (format === 'frames') return pad(n, 6);
	if (format === 'feet35' || format === 'feet16') {
		const perFoot = format === 'feet35' ? 16 : 40;
		return `${pad(Math.floor(n / perFoot), 4)}+${pad(n % perFoot)}`;
	}
	if (df) {
		// Drop-frame: skip frame numbers 0 and 1 (2 and 3 at 60) of every minute except each tenth minute.
		const drop = base === 60 ? 4 : 2;
		const perMin = base * 60 - drop;
		const per10 = perMin * 10 + drop;
		const d = Math.floor(n / per10);
		const m = n % per10;
		n += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMin) : 0);
	}
	const ff = n % base;
	const totalSec = Math.floor(n / base);
	const sep = df ? ';' : ':';
	const hh = Math.floor(totalSec / 3600) % 24;
	return `${pad(hh)}:${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}${sep}${pad(ff)}`;
}

/** Frames of a "HH:MM:SS:FF" (or ;FF) string at a display base (invalid → 0). */
export function parseTimecode(s: string, display: string): number {
	const m = /^(\d{1,2})[:;.](\d{1,2})[:;.](\d{1,2})[:;.](\d{1,3})$/.exec(s.trim());
	if (!m) return 0;
	const base = Number.parseInt(display, 10) || 30;
	return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * base + Number(m[4]);
}

/**
 * The text the Timecode effect shows at a clip-local frame (pure). Source "Media" with a clip context: the source
 * timecode (the media's start timecode + the source position at the frame); without one it counts like "Clip".
 */
export function timecodeText(p: EffectParams, ctx: Pick<FxFrameContext, 'frame' | 'fps' | 'clip'>): string {
	const display = str(p.timeDisplay, '30');
	const base = Number.parseInt(display, 10) || 30;
	const fps = ctx.fps > 0 ? ctx.fps : 30;
	const source = str(p.timecodeSource, 'clip');
	const offset = num(p.offset);
	if (source === 'media' && ctx.clip) {
		const secs = fxSourceSeconds(ctx.clip, ctx.frame, fps) + offset / fps;
		const startTc = ctx.clip.sourceStartTimecode ? parseTimecode(ctx.clip.sourceStartTimecode, display) : 0;
		const tc = formatTimecode(
			Math.max(0, Math.floor(secs * base + 1e-6) + startTc),
			display,
			str(p.format, 'smpte'),
		);
		const label = str(p.labelText, 'none');
		return `${label === 'none' || label === 'auto' ? '' : `${label.toUpperCase()} `}${tc}`;
	}
	const local = Math.floor(((ctx.frame + offset) / fps) * base + 1e-6);
	const start = source === 'generate' ? parseTimecode(str(p.startingTimecode, ''), display) : 0;
	const tc = formatTimecode(Math.max(0, local + start), display, str(p.format, 'smpte'));
	const label = str(p.labelText, 'none');
	const prefix = label === 'none' || label === 'auto' ? '' : `${label.toUpperCase()} `;
	return `${prefix}${tc}`;
}

const LABELS = ['none', 'auto', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9'] as const;

export const TIMECODE = defineShaderEffect({
	id: 'jasper.timecode',
	label: 'Timecode',
	category: 'Video',
	description:
		'Burns a running timecode (SMPTE, frames or feet+frames) into the picture, on a semi-transparent box.',
	keywords: ['burn-in', 'tc', 'time', 'counter', 'overlay', 'review'],
	params: [
		...textLayoutParams({ position: [0.5, 0.85], size: 8, opacity: 50 }),
		fxParam.toggle('fieldSymbol', 'Field Symbol', true),
		fxParam.choice(
			'format',
			'Format',
			['smpte', 'frames', 'feet35', 'feet16'],
			['SMPTE', 'Frames', 'Feet + Frames 35mm', 'Feet + Frames 16mm'],
			'smpte',
		),
		fxParam.choice(
			'timecodeSource',
			'Timecode Source',
			['clip', 'media', 'generate'],
			['Clip', 'Media', 'Generate'],
			'clip',
		),
		fxParam.choice(
			'timeDisplay',
			'Time Display',
			TIME_DISPLAYS,
			['24', '25', '30 Drop-Frame', '30 Non-Drop Frame', '50', '60 Drop-Frame', '60 Non-Drop Frame'],
			'30',
		),
		fxParam.number(
			'offset',
			'Offset',
			0,
			{ min: -100000, max: 100000, softMin: -50, softMax: 50, step: 1 },
			{ unit: 'frames', animatable: false },
		),
		fxParam.choice(
			'labelText',
			'Label Text',
			LABELS,
			['None', 'Auto', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'],
			'none',
		),
		stringParam('startingTimecode', 'Starting Timecode', '00:00:00:00'),
	],
	gpu: {
		uniforms: (p, ctx) => layoutUniforms(p, ctx, timecodeText(p, ctx), 'center'),
		passes: [{ include: [GLSL_PSDG_TEXT], frag: textFrag }],
	},
});

export const SIMPLE_TEXT = defineShaderEffect({
	id: 'jasper.simple-text',
	label: 'Simple Text',
	category: 'Video',
	description: 'Draws a line of plain white text over the picture (optionally on a dark box).',
	keywords: ['text', 'caption', 'title', 'label', 'burn-in'],
	params: [
		stringParam('text', 'Text', 'Simple Text'),
		...textLayoutParams({ position: [0.5, 0.5], size: 10, opacity: 0, align: true }),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p, ctx) => layoutUniforms(p, ctx, str(p.text, ''), str(p.alignment, 'center')),
		passes: [{ include: [GLSL_PSDG_TEXT], frag: textFrag }],
	},
});

export const PSDG_VIDEO_EFFECTS: readonly EffectSpec[] = [CLIP_NAME, TIMECODE, SIMPLE_TEXT];
