// Property reads (docs/wp-notes/mcp-cli.md §3): every property of a clip, or one parameter, with the keyframed
// `value` next to the `evaluated` value the renderer draws at that time (agent queries clip.properties and
// param.get; live editor state when the project is open).
import { z } from 'zod';
import { defineTool, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult } from '../errors.ts';
import { timeArg } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

export const INSPECT_GUIDE = `Reading properties: get_clip_properties {clipId, at?, keys?} lists every property of a clip — Motion, opacity, audio, text style, shape, template / composition params, and each effect's params — with value (the keyframed value at that time, as Effect Controls shows it), evaluated (what the renderer draws then; rendered: false + why when it draws nothing: outside the clip, bypassed effect, disabled clip, track output off), its keyframes in sequence frames + timecode, and the param.set target to change it. get_param {target, at?} reads one parameter by that target (clips, effects on tracks or the master, transitions, track volume/pan).`;

export function registerInspectTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_clip_properties',
		{
			title: 'Get clip properties',
			description:
				'Every property of a clip at a time: key, label, group, kind, unit, animatable, value (the keyframed value at that time, as Effect Controls shows it), evaluated (the value the renderer draws at that frame), animated, keyframes [{id, frame, timecode, value, interpolation}] in sequence frames, and the param.set `target` path. rendered: false with why when that frame draws nothing (outside the clip, bypassed effect, disabled clip, track output off). Also lists the clip\'s effects (id, effectId, enabled).',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Clip id (get_timeline)'),
				at: timeArg('Time to read at (default: the playhead when it is on the clip, else the clip start)').optional(),
				keys: z
					.array(z.string().min(1))
					.optional()
					.describe('Only these keys or key prefixes, e.g. ["transform", "opacity", "effects.fx_…"]'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, clipId, at, keys }) => {
			const r = await ctx.engine((c) =>
				c.agentQuery({
					projectId,
					query: 'clip.properties',
					args: { clipId, ...(at !== undefined ? { frame: at } : {}), ...(keys ? { keys } : {}) },
				}),
			);
			return jsonResult({ ...(r.result as object), revision: r.revision, live: r.via === 'session' });
		},
	);

	defineTool(
		ctx,
		'get_param',
		{
			title: 'Get parameter',
			description:
				'One parameter by its param.set target — ["clip", clipId, ...key], ["effect", effectInstanceId, param] (clip, track or master effects), ["transition", transitionId, param] or ["track", "A1", "volumeDb"|"pan"] — with value, evaluated, keyframes and rendered/why at a time.',
			input: {
				projectId: ProjectIdArg,
				target: z.array(z.string().min(1)).min(2).describe('The param.set target path'),
				at: timeArg('Time to read at').optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, target, at }) => {
			const r = await ctx.engine((c) =>
				c.agentQuery({
					projectId,
					query: 'param.get',
					args: { target, ...(at !== undefined ? { frame: at } : {}) },
				}),
			);
			return jsonResult({ ...(r.result as object), revision: r.revision, live: r.via === 'session' });
		},
	);
}
