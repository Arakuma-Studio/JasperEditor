// color-grade: agent tools for grading analysis — scopes_read (Lumetri Scopes as numbers of a rendered frame),
// color_match (grade a clip to look like a reference frame: solved into its Lumetri wheels, levels and saturation),
// auto_tone (Basic Correction ▸ Auto) and list_looks (the built-in creative looks). The engine renders the frames
// with its still renderer and runs the shared maths (POST /api/grading/*); applying a result is one undoable
// transaction ("Agent: Apply Match" / "Agent: Auto Tone").
import {
	type Animatable,
	type Clip,
	CREATIVE_LOOKS,
	type EffectInstance,
	LUMETRI_EFFECT_ID,
	makeEnvelope,
	type ProjectDocument,
	type Sequence,
	sequenceTimecode,
} from '@jasper/project';
import { z } from 'zod';
import {
	defineTool,
	EDIT,
	findClip,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { livePlayhead, requireEligible } from './color.ts';
import { timeArg } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the clip\'s sequence, else the project\'s first sequence');

const envelopeOf = (doc: ProjectDocument, revision: number | undefined) =>
	makeEnvelope(doc, { revision: revision ?? 0, savedAt: new Date().toISOString(), platform: 'mcp' }) as never;

const effectsOf = (clip: Clip): EffectInstance[] => (clip as { effects?: EffectInstance[] }).effects ?? [];

function firstSequence(doc: ProjectDocument, sequenceId?: string): Sequence {
	if (sequenceId) {
		const s = doc.sequences[sequenceId];
		if (!s)
			throw new ToolError(
				'E_NOT_FOUND',
				`Unknown sequence ${sequenceId}`,
				'Sequence ids come from get_project.',
			);
		return s;
	}
	const s = Object.values(doc.sequences)[0];
	if (!s)
		throw new ToolError('E_NOT_FOUND', 'The project has no sequence', 'Create one with create_sequence.');
	return s;
}

/** The frame inside `clip` to analyse: `at`, else the editor playhead on the clip, else the clip's middle. */
async function clipFrame(
	ctx: ToolContext,
	projectId: string,
	seq: Sequence,
	clip: Clip,
	at: unknown,
	live: boolean,
): Promise<number> {
	const end = clip.start + clip.duration;
	if (at !== undefined) {
		const f = frameOf(seq, at);
		if (f < clip.start || f >= end)
			throw new ToolError(
				'E_INVALID_PARAM',
				`Frame ${f} is outside clip ${clip.id} (frames ${clip.start}–${end - 1})`,
				'Pass a time inside the clip.',
			);
		return f;
	}
	const ph = live ? await livePlayhead(ctx, projectId, seq.id) : null;
	if (ph !== null && ph >= clip.start && ph < end) return ph;
	return clip.start + Math.floor(clip.duration / 2);
}

/**
 * Commands that write Lumetri params on a clip: `param.set` on the instance (a keyframe at `frame` for params that
 * are already keyframed), or `effect.add` with the params when the clip has no Lumetri instance.
 */
function lumetriWrites(
	clip: Clip,
	effectId: string | null,
	params: Record<string, unknown>,
	frame: number,
): { commands: unknown[]; keyframed: string[] } {
	const fx = effectId ? effectsOf(clip).find((e) => e.id === effectId) : undefined;
	if (!fx)
		return {
			commands: [
				{
					type: 'effect.add',
					target: { clipId: clip.id },
					effectId: LUMETRI_EFFECT_ID,
					params,
					ref: '$grade',
				},
			],
			keyframed: [],
		};
	const keyframed: string[] = [];
	const commands = Object.entries(params).map(([name, value]) => {
		const animated = !!(fx.params[name] as Animatable<unknown> | undefined)?.keyframes?.length;
		if (animated) keyframed.push(name);
		return {
			type: 'param.set',
			target: ['effect', fx.id, name],
			value,
			...(animated ? { at: { sequenceFrame: frame } } : {}),
		};
	});
	return { commands, keyframed };
}

export function registerGradingTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'scopes_read',
		{
			title: 'Read Lumetri Scopes',
			description:
				'Lumetri Scopes as numbers, so you can check colour without looking: renders the Program frame (or one clip alone with clipId) with the export renderer and returns per-channel levels in % (R, G, B, Y min/max/mean), clipping (% of samples at 0 % and 100 %), mean chroma hue and saturation, waveform and parade levels per column range (left to right), histogram peak bins (and the 256 bins with bins: true), and the densest vectorscope spots with their angle (degrees from +Cb, counter-clockwise; skin tones sit near 123°) and magnitude (% of 0.5; 100 % = a fully saturated primary). Matrix bt709 by default (bt601, bt2020).',
			input: {
				projectId: ProjectIdArg,
				at: timeArg('Frame to measure (default: the editor playhead, else 0)').optional(),
				sequenceId: SequenceIdArg,
				clipId: z
					.string()
					.min(1)
					.optional()
					.describe('Measure this clip alone (its own picture, every effect)'),
				scopes: z
					.array(z.enum(['waveform', 'parade', 'histogram', 'vectorscopeYuv', 'vectorscopeHls']))
					.max(5)
					.optional()
					.describe('Scopes to include (default all)'),
				waveformType: z
					.enum(['rgb', 'luma', 'yc', 'ycNoChroma'])
					.optional()
					.describe('Waveform type (default rgb)'),
				paradeType: z
					.enum(['rgb', 'yuv', 'rgbWhite', 'yuvWhite'])
					.optional()
					.describe('Parade type (default rgb)'),
				matrix: z.enum(['bt601', 'bt709', 'bt2020']).optional().describe('Y′CbCr matrix (default bt709)'),
				clamp: z.boolean().optional().describe('Clamp Signal (default true)'),
				columns: z
					.number()
					.int()
					.min(1)
					.max(64)
					.optional()
					.describe('Column ranges per waveform trace (default 8)'),
				peaks: z.number().int().min(1).max(32).optional().describe('Vectorscope spots (default 6)'),
				bins: z.boolean().optional().describe('Include the 256 histogram bins per channel (default false)'),
			},
			annotations: READ_ONLY,
		},
		async (args) => {
			const { doc, revision, live } = await loadDoc(ctx, args.projectId);
			let seq: Sequence;
			if (args.clipId) {
				const found = findClip(doc, args.clipId);
				seq = found.seq;
				requireEligible(found.clip);
			} else seq = firstSequence(doc, args.sequenceId);
			let frame: number;
			if (args.at !== undefined) frame = frameOf(seq, args.at);
			else if (args.clipId)
				frame = await clipFrame(ctx, args.projectId, seq, findClip(doc, args.clipId).clip, undefined, live);
			else frame = (live ? await livePlayhead(ctx, args.projectId, seq.id) : null) ?? 0;
			const r = await ctx.engine((c) =>
				c.gradingScopes({
					envelope: envelopeOf(doc, revision),
					sequenceId: seq.id,
					frame,
					...(args.clipId ? { clipId: args.clipId } : {}),
					...(args.scopes ? { scopes: args.scopes } : {}),
					...(args.waveformType ? { waveformType: args.waveformType } : {}),
					...(args.paradeType ? { paradeType: args.paradeType } : {}),
					...(args.matrix ? { matrix: args.matrix } : {}),
					...(args.clamp !== undefined ? { clamp: args.clamp } : {}),
					columns: args.columns ?? 8,
					peaks: args.peaks ?? 6,
					bins: args.bins ?? false,
				}),
			);
			return jsonResult({ ...r, timecode: sequenceTimecode(seq, frame) });
		},
	);

	defineTool(
		ctx,
		'color_match',
		{
			title: 'Color match',
			description: `Lumetri Color ▸ Apply Match: grades a clip so its colour matches a reference frame (another time of this or another sequence). The clip's picture before its Lumetri instance and the reference are compared in Oklab per tonal range (shadows, midtones, highlights) and saturation; the match is solved into the instance's colour wheels, their levels and Basic saturation, so the result stays an ordinary, editable grade. Face Detection (default on), as in Premiere: with the face model installed (install_roto_model), faces found in either frame weigh more and, with faces in both, the clip's face colour is matched to the reference's (skin: "faces"; no face found: "none", the whole frame counts equally); without the model, skin-coloured pixels are protected instead and the cast is limited so skin moves at most 8° in hue (skin: "hue"). apply: false only reports the solution. One undoable transaction ("Agent: Apply Match").`,
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Clip to grade ("clp_…")'),
				at: timeArg(
					'Current frame inside the clip (default: the playhead on the clip, else its middle)',
				).optional(),
				reference: z
					.strictObject({
						at: timeArg('Reference frame'),
						sequenceId: z.string().optional().describe("Reference sequence (default: the clip's sequence)"),
					})
					.describe('The reference frame (what the clip should look like)'),
				effectInstanceId: z
					.string()
					.optional()
					.describe(
						"The Lumetri instance to solve (default: the clip's first; one is added when it has none)",
					),
				faceDetection: z.boolean().optional().describe('Protect skin tones (default true)'),
				apply: z.boolean().optional().describe('Write the solved params (default true)'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { doc, revision, live } = await loadDoc(ctx, args.projectId);
			const { seq, clip } = findClip(doc, args.clipId);
			requireEligible(clip);
			const frame = await clipFrame(ctx, args.projectId, seq, clip, args.at, live);
			const refSeq = firstSequence(doc, args.reference.sequenceId ?? seq.id);
			const refFrame = frameOf(refSeq, args.reference.at);
			const r = await ctx.engine((c) =>
				c.gradingMatch({
					envelope: envelopeOf(doc, revision),
					sequenceId: seq.id,
					clipId: clip.id,
					frame,
					reference: { sequenceId: refSeq.id, frame: refFrame },
					...(args.effectInstanceId ? { effectId: args.effectInstanceId } : {}),
					...(args.faceDetection !== undefined ? { faceDetection: args.faceDetection } : {}),
				}),
			);
			const report = {
				clipId: clip.id,
				frame,
				reference: { sequenceId: refSeq.id, frame: refFrame, timecode: sequenceTimecode(refSeq, refFrame) },
				params: r.params,
				statisticsDistance: { before: r.before, after: r.after },
				skin: r.skin,
				skinShare: r.skinShare,
				skinHueShift: r.skinHueShift,
				...(r.faces ? { faces: r.faces } : {}),
				...(r.faceNote ? { faceNote: r.faceNote } : {}),
			};
			if (args.apply === false) return jsonResult({ ...report, applied: false });
			const { commands, keyframed } = lumetriWrites(clip, r.effectId, r.params, frame);
			const res = await transact(ctx, args.projectId, { label: 'Apply Match', commands }, extra);
			const tx = requireOk(res);
			return jsonResult({
				...report,
				applied: true,
				effectInstanceId: r.effectId ?? tx.refs.$grade,
				...(keyframed.length ? { keyframed } : {}),
				revision: tx.revision,
				appliedBy: res.appliedBy,
			});
		},
	);

	defineTool(
		ctx,
		'auto_tone',
		{
			title: 'Auto tone',
			description:
				'Lumetri Color ▸ Basic Correction ▸ Auto: sets Exposure, Contrast, Highlights, Shadows, Whites and Blacks of a clip from its picture (before its Lumetri instance) so the luma spans a well-exposed range (black point ≈ 2 %, white point ≈ 98 %, median ≈ 42 %); saturation is left alone. Returns the luma quantiles (1/10/50/90/99 %) before and after. apply: false only reports. One undoable transaction ("Agent: Auto Tone").',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Clip ("clp_…")'),
				at: timeArg(
					'Frame inside the clip to analyse (default: the playhead on the clip, else its middle)',
				).optional(),
				effectInstanceId: z.string().optional().describe("The Lumetri instance (default: the clip's first)"),
				apply: z.boolean().optional().describe('Write the params (default true)'),
			},
			annotations: EDIT,
		},
		async (args, extra) => {
			const { doc, revision, live } = await loadDoc(ctx, args.projectId);
			const { seq, clip } = findClip(doc, args.clipId);
			requireEligible(clip);
			const frame = await clipFrame(ctx, args.projectId, seq, clip, args.at, live);
			const r = await ctx.engine((c) =>
				c.gradingAutoTone({
					envelope: envelopeOf(doc, revision),
					sequenceId: seq.id,
					clipId: clip.id,
					frame,
					...(args.effectInstanceId ? { effectId: args.effectInstanceId } : {}),
				}),
			);
			const { saturation: _keep, ...tone } = r.params;
			const report = {
				clipId: clip.id,
				frame,
				params: tone,
				lumaQuantiles: { before: r.before, after: r.after },
			};
			if (args.apply === false) return jsonResult({ ...report, applied: false });
			const { commands, keyframed } = lumetriWrites(clip, r.effectId, tone, frame);
			const res = await transact(ctx, args.projectId, { label: 'Auto Tone', commands }, extra);
			const tx = requireOk(res);
			return jsonResult({
				...report,
				applied: true,
				effectInstanceId: r.effectId ?? tx.refs.$grade,
				...(keyframed.length ? { keyframed } : {}),
				revision: tx.revision,
				appliedBy: res.appliedBy,
			});
		},
	);

	defineTool(
		ctx,
		'list_looks',
		{
			title: 'List looks',
			description:
				'The built-in creative looks of Lumetri Color (procedural, no LUT file): id, name, family and description. Apply one with grade_clip creative.builtInLook = id (mixed with creative.intensity); a look LUT (creative.look) takes precedence.',
			input: {},
			annotations: READ_ONLY,
		},
		async () =>
			jsonResult({
				looks: CREATIVE_LOOKS.filter((l) => l.id !== 'none').map((l) => ({
					id: l.id,
					name: l.label,
					family: l.family,
					description: l.description,
				})),
			}),
	);
}
