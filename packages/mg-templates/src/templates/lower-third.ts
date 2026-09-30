// lower-third@1 — TS twin of native/mg/crates/jasper-mg-templates/src/lower_third.rs.
// Keep the params schema, constants and timings identical to the Rust module.
import { z } from 'zod';
import {
	CANVASES,
	easeInCubic,
	easeOutCubic,
	escapeXml,
	estimateTextWidth,
	FONT_FAMILY,
	type FrameTime,
	fill,
	fitCanvas,
	fitGroupOpen,
	framesToSeconds,
	frameTime,
	num,
	progress,
	type Rgba,
	spring,
	svgOpen,
} from '../core.ts';
import type { MgTemplateDefinition } from '../types.ts';

const PANEL_H = 150;
const BAR_W = 10;
const TEXT_X = 40;
const NAME_SIZE = 60;
const TITLE_SIZE = 34;
const OUTRO_SECONDS = 0.5;

const channel = z.number().min(0).max(1);
const rgba = (d: Rgba) =>
	z
		.array(channel)
		.length(4)
		.default(d as number[]);

export const lowerThirdParams = z.strictObject({
	name: z.string().max(120).default('Alex Morgan'),
	title: z.string().max(160).default('Producer, JasperEditor'),
	accentColor: rgba([0.22, 0.53, 1, 1]),
	textColor: rgba([1, 1, 1, 1]),
	backgroundColor: rgba([0.04, 0.06, 0.12, 0.78]),
	position: z.array(z.number().min(-4000).max(4000)).length(2).default([120, 800]),
	holdUntilFrames: z.number().int().min(0).max(432000).default(0),
});
export type LowerThirdParams = z.output<typeof lowerThirdParams>;

export function lowerThirdPanelWidth(p: LowerThirdParams): number {
	const text = Math.max(
		estimateTextWidth(p.name, NAME_SIZE, 700),
		estimateTextWidth(p.title, TITLE_SIZE, 400),
	);
	return Math.max(text + TEXT_X + 48, 320);
}

export function renderLowerThird(
	p: LowerThirdParams,
	ft: FrameTime,
	out: { width: number; height: number },
	idPrefix = 'mg',
): string {
	const fit = fitCanvas(out.width, out.height);
	const t = ft.t;
	const outroStart =
		p.holdUntilFrames > 0 ? framesToSeconds(ft, p.holdUntilFrames) : Math.max(ft.total - OUTRO_SECONDS, 0);
	const o = easeInCubic(progress(t, outroStart, OUTRO_SECONDS));
	const groupOpacity = 1 - o;
	const outX = -40 * o;

	const barH = PANEL_H * easeOutCubic(progress(t, 0, 0.35));
	const barY = (PANEL_H - barH) / 2;
	const fullW = lowerThirdPanelWidth(p);
	const panelW = fullW * easeOutCubic(progress(t, 0.12, 0.55));
	const nameX = -60 * (1 - spring(t - 0.25, 180, 20, 1));
	const nameO = easeOutCubic(progress(t, 0.25, 0.3));
	const titleX = -40 * (1 - spring(t - 0.4, 180, 20, 1));
	const titleO = easeOutCubic(progress(t, 0.4, 0.3));
	const clipId = `${idPrefix}-lt-clip`;
	const accent = p.accentColor as Rgba;

	return (
		svgOpen(fit) +
		`<defs><clipPath id="${clipId}"><rect x="0" y="0" width="${num(panelW)}" height="${num(PANEL_H)}"/></clipPath></defs>` +
		fitGroupOpen(fit) +
		`<g transform="translate(${num(p.position[0]! + outX)} ${num(p.position[1]!)})" opacity="${num(groupOpacity)}">` +
		`<rect x="0" y="0" width="${num(panelW)}" height="${num(PANEL_H)}" ${fill(p.backgroundColor as Rgba)}/>` +
		`<rect x="0" y="${num(barY)}" width="${num(BAR_W)}" height="${num(barH)}" ${fill(accent)}/>` +
		`<g clip-path="url(#${clipId})">` +
		`<g transform="translate(${num(nameX)} 0)" opacity="${num(nameO)}"><text x="${num(TEXT_X)}" y="74" font-family="${FONT_FAMILY}" font-size="${num(NAME_SIZE)}" font-weight="700" ${fill(p.textColor as Rgba)}>${escapeXml(p.name)}</text></g>` +
		`<g transform="translate(${num(titleX)} 0)" opacity="${num(titleO)}"><text x="${num(TEXT_X)}" y="124" font-family="${FONT_FAMILY}" font-size="${num(TITLE_SIZE)}" font-weight="400" ${fill(accent)}>${escapeXml(p.title)}</text></g>` +
		'</g></g></g></svg>'
	);
}

export const lowerThird: MgTemplateDefinition<LowerThirdParams> = {
	id: 'lower-third',
	version: 1,
	name: 'Lower Third',
	category: 'Lower Thirds',
	description: 'Name and title on a translucent panel with an accent bar; spring slide-in.',
	paramsSchema: lowerThirdParams,
	defaults: lowerThirdParams.parse({}),
	introFrames: 30,
	outroFrames: 15,
	defaultDurationSeconds: 5,
	canvases: [...CANVASES],
	renderSvg(params, frame, fps, canvas, options = {}) {
		const duration = options.durationFrames ?? Math.round(5 * fps);
		const ft = frameTime(frame, fps, duration, options.sourceInFrames ?? 0);
		return renderLowerThird(params, ft, canvas, options.idPrefix);
	},
};
