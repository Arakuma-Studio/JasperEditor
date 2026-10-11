// title-card@1 — TS twin of native/mg/crates/jasper-mg-templates/src/title_card.rs.
// Keep the params schema, constants and timings identical to the Rust module.
import { z } from 'zod';
import {
	CANVASES,
	easeInOutCubic,
	easeOutCubic,
	escapeXml,
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
	svgOpen,
} from '../core.ts';
import { rgbaParam } from '../params.ts';
import type { MgSvgTemplateDefinition } from '../types.ts';

const TITLE_SIZE = 96;
const SUBTITLE_SIZE = 44;
const UNDERLINE_W = 160;

export const titleCardParams = z.strictObject({
	title: z.string().max(160).default('Your Title Here'),
	subtitle: z.string().max(240).default('A JasperEditor production'),
	background: rgbaParam([0.02, 0.03, 0.06, 0.85]),
	textColor: rgbaParam([1, 1, 1, 1]),
	accentColor: rgbaParam([0.22, 0.53, 1, 1]),
	alignment: z.enum(['left', 'center', 'right']).default('center'),
	fadeInFrames: z.number().int().min(0).max(600).default(15),
	fadeOutFrames: z.number().int().min(0).max(600).default(15),
});
export type TitleCardParams = z.output<typeof titleCardParams>;

function renderTitleCard(p: TitleCardParams, ft: FrameTime, out: { width: number; height: number }): string {
	const fit = fitCanvas(out.width, out.height);
	const t = ft.t;
	const fadeIn = framesToSeconds(ft, p.fadeInFrames);
	const fadeOut = framesToSeconds(ft, p.fadeOutFrames);
	const fin = p.fadeInFrames > 0 ? easeInOutCubic(progress(t, 0, fadeIn)) : 1;
	const fout = p.fadeOutFrames > 0 ? easeInOutCubic(progress(t, ft.total - fadeOut, fadeOut)) : 0;
	const opacity = Math.min(fin, 1 - fout);

	const w = fit.designW;
	const h = fit.designH;
	const [ax, anchor] =
		p.alignment === 'left'
			? [w * 0.1, 'start']
			: p.alignment === 'right'
				? [w * 0.9, 'end']
				: [w / 2, 'middle'];
	const hasSub = p.subtitle.length > 0;
	const titleY = hasSub ? h / 2 - 8 : h / 2 + 34;
	const underlineY = hasSub ? h / 2 + 22 : h / 2 + 62;
	const subY = h / 2 + 92;
	const titleDy = 36 * (1 - easeOutCubic(progress(t, 0, 0.7)));
	const subDy = 36 * (1 - easeOutCubic(progress(t, 0.12, 0.7)));
	const subO = easeOutCubic(progress(t, 0.12, 0.5));
	const uw = UNDERLINE_W * easeOutCubic(progress(t, 0.15, 0.6));
	const ux = p.alignment === 'left' ? ax : p.alignment === 'right' ? ax - uw : ax - uw / 2;
	const text = p.textColor as Rgba;

	let s =
		svgOpen(fit) +
		`<g opacity="${num(opacity)}">` +
		`<rect x="0" y="0" width="${num(fit.outW)}" height="${num(fit.outH)}" ${fill(p.background as Rgba)}/>` +
		fitGroupOpen(fit) +
		`<g transform="translate(0 ${num(titleDy)})"><text x="${num(ax)}" y="${num(titleY)}" text-anchor="${anchor}" font-family="${FONT_FAMILY}" font-size="${num(TITLE_SIZE)}" font-weight="700" ${fill(text)}>${escapeXml(p.title)}</text></g>` +
		`<rect x="${num(ux)}" y="${num(underlineY)}" width="${num(uw)}" height="4" ${fill(p.accentColor as Rgba)}/>`;
	if (hasSub) {
		s += `<g transform="translate(0 ${num(subDy)})" opacity="${num(subO * 0.85)}"><text x="${num(ax)}" y="${num(subY)}" text-anchor="${anchor}" font-family="${FONT_FAMILY}" font-size="${num(SUBTITLE_SIZE)}" font-weight="400" ${fill(text)}>${escapeXml(p.subtitle)}</text></g>`;
	}
	return `${s}</g></g></svg>`;
}

export const titleCard: MgSvgTemplateDefinition<TitleCardParams> = {
	id: 'title-card',
	version: 1,
	name: 'Title Card',
	category: 'Titles',
	description: 'Full-frame title and subtitle over a (translucent) background with fades.',
	paramsSchema: titleCardParams,
	defaults: titleCardParams.parse({}),
	introFrames: 15,
	outroFrames: 15,
	defaultDurationSeconds: 4,
	canvases: [...CANVASES],
	renderSvg(params, frame, fps, canvas, options = {}) {
		const duration = options.durationFrames ?? Math.round(4 * fps);
		const ft = frameTime(frame, fps, duration, options.sourceInFrames ?? 0);
		return renderTitleCard(params, ft, canvas);
	},
};
