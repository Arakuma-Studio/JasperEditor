// Blend modes and roving keyframes for agents (keyframes-blend): list the clip blend modes (Premiere's 27 + After
// Effects' utility modes), set a clip's blend mode by id or label, and turn Rove Across Time on or off for keys.
import { BLEND_MODE_GROUP_LABELS, BLEND_MODE_INFO, parseBlendMode } from '@jasper/project';
import { z } from 'zod';
import { defineTool, EDIT, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { applyHelper } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const KEYFRAMES_BLEND_GUIDE = `Blend modes and keyframe timing:
- Every visual clip has a blend mode (Effect Controls ▸ Opacity ▸ Blend Mode): Premiere Pro's 27 — normal, dissolve | darken, multiply, color-burn, linear-burn, darker-color | lighten, screen, color-dodge, add (Linear Dodge), lighter-color | overlay, soft-light, hard-light, vivid-light, linear-light, pin-light, hard-mix | difference, exclusion, subtract, divide | hue, saturation, color, luminosity — plus After Effects' stencil-alpha, stencil-luma, silhouette-alpha, silhouette-luma (they mask everything below instead of drawing) and alpha-add. list_blend_modes describes them; set_blend_mode {clipIds, mode} accepts ids or menu labels ("Linear Dodge (Add)"). A layer blends with everything below it (lower tracks and the sequence background); Dissolve's grain is deterministic per clip and frame. Preview and every export path draw every mode identically (the native export blends in its own kernel; modes inside nested sequences export through Remotion).
- Keyframe eases are After Effects' speed + influence: influences above 100 % in total are not normalised. Roving keys (set_roving {keyframeIds, roving}) have no time of their own: the run between two fixed keys moves at one smooth speed (the ends' eases shape the whole run) and the roving keys' times follow; the first and last keys never rove.`;

export function registerKeyframesBlendTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_blend_modes',
		{
			title: 'List blend modes',
			description:
				'The clip blend modes in menu order with their menu label, group (Normal, Subtractive, Additive, Complex, Difference, HSL, Utility), what they do, and how the preview draws them (CSS or the GL compositor; both equal the export).',
			input: {},
			annotations: READ_ONLY,
		},
		async () =>
			jsonResult({
				modes: BLEND_MODE_INFO.map((m) => ({
					id: m.id,
					label: m.label,
					group: BLEND_MODE_GROUP_LABELS[m.group],
					preview: m.id === 'normal' || m.css ? 'css' : 'gl-compositor',
					description: m.description,
				})),
			}),
	);

	defineTool(
		ctx,
		'set_blend_mode',
		{
			title: 'Set blend mode',
			description:
				'Sets the blend mode of visual clips (one undoable edit). `mode` is an id ("linear-burn") or a menu label ("Linear Burn", "Linear Dodge (Add)"); see list_blend_modes.',
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1).describe('Clip ids ("clp_…")'),
				mode: z.string().min(1).describe('Blend mode id or label'),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipIds, mode }, extra) => {
			const id = parseBlendMode(mode);
			if (!id)
				throw new ToolError(
					'E_INVALID_PARAM',
					`Unknown blend mode "${mode}"`,
					'Call list_blend_modes for the ids.',
				);
			return applyHelper(
				ctx,
				projectId,
				'Blend Mode',
				[{ type: 'clip.update', clipIds, patch: { blendMode: id } }],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'set_roving',
		{
			title: 'Rove across time',
			description:
				"Turns After Effects' Rove Across Time on or off for keyframes (one undoable edit). Roving keys lose their own time: the run between two fixed keys moves as one segment (constant speed with linear ends; the ends' eases shape the whole run) and the roving keys' times follow. The first and last keys of a property and hold keys cannot rove (skipped with a warning). Turning it off keeps the key where it is, with Continuous Bezier eases carrying the speed. Moving a roving key in time also turns roving off.",
			input: {
				projectId: ProjectIdArg,
				keyframeIds: z.array(z.string().min(1)).min(1).describe('Keyframe ids ("kf_…")'),
				roving: z.boolean().describe('true = rove across time, false = fixed time'),
			},
			annotations: EDIT,
		},
		async ({ projectId, keyframeIds, roving }, extra) =>
			applyHelper(
				ctx,
				projectId,
				'Rove Across Time',
				[{ type: 'keyframe.setRoving', keyframeIds, roving }],
				extra,
			),
	);
}
