// Spec 19 TL-052: `title.insertTemplate`. A template is data; this expands it by running the ordinary handlers
// (`clip.addText`, `clip.addShape`, `clip.addGenerator`, `look.apply`, `keyframe.add`) inside one command, like the batch
// commands do, so the rules of each are the ones of the single commands, the result is plain clips, and one undo removes it.
import { nominalFps, type Rational } from '../../time.ts';
import { factoryColorway, factoryLook } from '../../title-looks/factory/index.ts';
import { factoryTemplate } from '../../title-looks/factory/templates/index.ts';
import {
	shapeLookRecipe,
	type TemplateClip,
	type TemplateMotion,
	type TemplateShape,
	type TemplateText,
	type TemplateTiming,
	type TitleTemplate,
} from '../../title-looks/factory/templates/types.ts';
import { DEFAULT_PALETTE } from '../../title-looks/model.ts';
import type { DDoc, DSeq, HandlerContext } from '../context.ts';
import { trackSlotOf } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { clipCoreHandlers } from './clip-core.ts';
import { keyframeHandlers } from './keyframe.ts';
import { paramHandlers } from './param.ts';
import { shapeHandlers } from './shape.ts';
import { structureHandlers } from './structure.ts';
import { titleLookHandlers } from './title-look.ts';
import type { HandlerMap } from './util.ts';

type Run<K extends string, R> = (d: DDoc, c: { type: K } & Record<string, unknown>, h: HandlerContext) => R;

const addText = clipCoreHandlers['clip.addText'] as unknown as Run<'clip.addText', { clipId: string }>;
const addShape = shapeHandlers['clip.addShape'] as unknown as Run<'clip.addShape', { clipId: string }>;
const addGenerator = titleLookHandlers['clip.addGenerator'] as unknown as Run<
	'clip.addGenerator',
	{ clipId: string }
>;
const applyLook = titleLookHandlers['look.apply'] as unknown as Run<'look.apply', unknown>;
const addKey = keyframeHandlers['keyframe.add'] as unknown as Run<'keyframe.add', unknown>;
const setParam = paramHandlers['param.set'] as unknown as Run<'param.set', unknown>;
const group = structureHandlers['clip.group'] as unknown as Run<'clip.group', unknown>;

const SHAPE_MOTION_SECONDS = 0.4;

/** Frames of a clip within the template. */
function spanOf(t: TemplateTiming, at: number, length: number, fps: number) {
	const start = at + Math.round((t.delay ?? 0) * fps);
	const end = at + length - Math.round((t.early ?? 0) * fps);
	return { start, length: end - start };
}

const animator = (a: TemplateText['in'], fps: number) => ({
	preset: a.preset,
	...(a.seconds !== undefined ? { durationFrames: Math.max(1, Math.round(a.seconds * fps)) } : {}),
	...(a.params ? { params: a.params } : {}),
});

function textClip(
	doc: DDoc,
	c: TemplateText,
	cmd: CommandOf<'title.insertTemplate'>,
	ctx: Ctx,
	h: HandlerContext,
): string {
	const { seq, fps, W, H, short } = ctx;
	const { start, length } = spanOf(c, ctx.at, ctx.length, fps);
	const [x, y, w, boxH] = c.rect;
	const { clipId } = addText(
		doc,
		{
			type: 'clip.addText',
			sequenceId: seq.id,
			at: start,
			duration: length,
			track: ctx.track(),
			placement: 'first-free',
			name: c.label,
			content: {
				text: cmd.texts?.[c.slot] ?? c.text,
				style: {
					sizePx: Math.round(c.size * short),
					align: c.align ?? 'left',
					...(c.lineHeight ? { lineHeight: c.lineHeight } : {}),
				},
			},
			box: { width: Math.round(w * W), height: Math.round(boxH * H), autoSize: 'height' },
			transform: { position: [Math.round((x + w / 2) * W), Math.round((y + boxH / 2) * H)] },
			textAnimation: { in: animator(c.in, fps), out: animator(c.out, fps) },
		},
		h,
	);
	ctx.placed(clipId);
	applyLook(
		doc,
		{
			type: 'look.apply',
			clipIds: [clipId],
			lookId: c.look,
			...(cmd.colorwayId ? { colorwayId: cmd.colorwayId } : {}),
			...(cmd.seed !== undefined ? { seed: cmd.seed } : {}),
			...(cmd.availableFonts ? { availableFonts: cmd.availableFonts } : {}),
		},
		h,
	);
	return clipId;
}

/** Keys of how a shape arrives and leaves. A wipe grows the width from one edge; a fade moves opacity. */
function shapeMotion(
	doc: DDoc,
	clipId: string,
	motion: TemplateMotion,
	seconds: number,
	opacity: number,
	seqId: string,
	start: number,
	length: number,
	fps: number,
	h: HandlerContext,
): void {
	const frames = Math.max(1, Math.min(Math.round(seconds * fps), Math.floor(length / 2)));
	const fade = motion === 'fade';
	const target = fade ? ['clip', clipId, 'opacity'] : ['clip', clipId, 'transform', 'scaleWidth'];
	const full = fade ? opacity : 100;
	const key = (frame: number, value: number) =>
		addKey(
			doc,
			{
				type: 'keyframe.add',
				sequenceId: seqId,
				target,
				at: { sequenceFrame: start + frame },
				value,
				interpolation: 'bezier',
			},
			h,
		);
	key(0, 0);
	key(frames, full);
	key(length - 1 - frames, full);
	key(length - 1, 0);
}

function shapeClip(
	doc: DDoc,
	c: TemplateShape,
	cmd: CommandOf<'title.insertTemplate'>,
	ctx: Ctx,
	h: HandlerContext,
): string {
	const { seq, fps, W, H, short } = ctx;
	const { start, length } = spanOf(c, ctx.at, ctx.length, fps);
	const [x, y, w, boxH] = c.rect;
	const size: [number, number] = [Math.max(1, Math.round(w * W)), Math.max(1, Math.round(boxH * H))];
	const wipe = c.motion !== 'fade';
	const left = c.motion === 'wipe-left';
	const { clipId } = addShape(
		doc,
		{
			type: 'clip.addShape',
			sequenceId: seq.id,
			at: start,
			duration: length,
			track: ctx.track(),
			placement: 'first-free',
			name: c.name,
			shape: {
				type: 'rect',
				size,
				fill: [1, 1, 1, 1],
				...(c.corner ? { cornerRadius: Math.round(c.corner * short) } : {}),
			},
			transform: {
				// A wipe grows from the edge it starts at: the anchor sits there.
				...(wipe
					? {
							anchor: [left ? 0 : size[0], size[1] / 2],
							position: [Math.round((left ? x : x + w) * W), Math.round((y + boxH / 2) * H)],
							uniformScale: false,
						}
					: { position: [Math.round((x + w / 2) * W), Math.round((y + boxH / 2) * H)] }),
			},
		},
		h,
	);
	ctx.placed(clipId);
	const opacity = c.opacity ?? 100;
	if (opacity !== 100)
		setParam(
			doc,
			{ type: 'param.set', sequenceId: seq.id, target: ['clip', clipId, 'opacity'], value: opacity },
			h,
		);
	applyLook(
		doc,
		{
			type: 'look.apply',
			clipIds: [clipId],
			look: {
				name: `Template ${c.role}`,
				sourceId: `template-shape.${c.role}`,
				recipe: { ...shapeLookRecipe(c.role), palette: ctx.palette },
			},
			...(cmd.colorwayId ? { colorwayId: cmd.colorwayId } : {}),
		},
		h,
	);
	const seconds = c.seconds ?? SHAPE_MOTION_SECONDS;
	shapeMotion(doc, clipId, c.motion, seconds, opacity, seq.id, start, length, fps, h);
	return clipId;
}

type Ctx = {
	seq: DSeq;
	at: number;
	length: number;
	fps: number;
	W: number;
	H: number;
	short: number;
	palette: Record<string, unknown>;
	/** The lowest track the next clip may take. */
	track(): string;
	placed(clipId: string): void;
};

/** The palette a template's shapes start from: the one of its first text clip's look. */
function firstPalette(t: TitleTemplate): Record<string, unknown> {
	const text = t.clips.find((c): c is TemplateText => c.kind === 'text');
	return (text ? factoryLook(text.look)?.recipe.palette : undefined) ?? {};
}

function clipOf(
	doc: DDoc,
	c: TemplateClip,
	cmd: CommandOf<'title.insertTemplate'>,
	ctx: Ctx,
	h: HandlerContext,
): string {
	if (c.kind === 'text') return textClip(doc, c, cmd, ctx, h);
	if (c.kind === 'shape') return shapeClip(doc, c, cmd, ctx, h);
	const { start, length } = spanOf(c, ctx.at, ctx.length, ctx.fps);
	// A standalone generator has no palette: the colours it takes are the ones a look would show now.
	const way = cmd.colorwayId ? factoryColorway(cmd.colorwayId) : undefined;
	if (cmd.colorwayId && !way) h.fail('E_NOT_FOUND', `Colourway not found: ${cmd.colorwayId}`);
	const palette = (way?.palette ?? ctx.palette) as Record<string, unknown>;
	const roles = Object.fromEntries(
		Object.entries(c.roles ?? {}).map(([param, role]) => [param, palette[role] ?? DEFAULT_PALETTE[role]]),
	);
	const params = { ...(c.params ?? {}), ...roles };
	const { clipId } = addGenerator(
		doc,
		{
			type: 'clip.addGenerator',
			sequenceId: ctx.seq.id,
			effectId: c.effectId,
			at: start,
			duration: length,
			track: ctx.track(),
			name: c.name,
			...(Object.keys(params).length ? { params } : {}),
		},
		h,
	);
	ctx.placed(clipId);
	return clipId;
}

export const titleTemplateHandlers = {
	'title.insertTemplate': (doc, cmd: CommandOf<'title.insertTemplate'>, h: HandlerContext) => {
		const template = factoryTemplate(cmd.templateId);
		if (!template) return h.fail('E_NOT_FOUND', `Title template not found: ${cmd.templateId}`);
		const slots = new Set(template.clips.flatMap((c) => (c.kind === 'text' ? [c.slot] : [])));
		for (const k of Object.keys(cmd.texts ?? {}))
			if (!slots.has(k))
				h.fail(
					'E_INVALID_PARAM',
					`${template.name} has no text slot "${k}" (it has ${[...slots].join(', ')})`,
				);
		const seq = h.sequence(doc, cmd.sequenceId);
		const { width: W, height: H } = seq.settings;
		const fps = nominalFps(seq.settings.frameRate as Rational);
		const at = h.frame(seq, cmd.at);
		if (at < 0) h.fail('E_INVALID_PARAM', 'A template starts at 0 or later');
		const length =
			cmd.duration !== undefined
				? h.durationFrames(seq, cmd.duration)
				: Math.max(1, Math.round(template.seconds * fps));
		const clipIds: string[] = [];
		const slotsOut: Record<string, string> = {};
		let floor = trackSlotOf(seq, cmd.track ?? 'V2', h).index;
		const ctx: Ctx = {
			seq,
			at,
			length,
			fps,
			W,
			H,
			short: Math.min(W, H),
			palette: firstPalette(template),
			track: () => `V${floor + 1}`,
			placed: (id) => {
				clipIds.push(id);
				floor = trackSlotOf(seq, seq.clips[id]!.trackId, h).index + 1;
			},
		};
		for (const c of template.clips) {
			const id = clipOf(doc, c, cmd, ctx, h);
			if (c.kind === 'text') slotsOut[c.slot] = id;
		}
		if (clipIds.length > 1) group(doc, { type: 'clip.group', clipIds }, h);
		h.defineRef(cmd.ref, clipIds[0]!);
		return { templateId: template.id, clipIds, slots: slotsOut };
	},
} satisfies HandlerMap;
