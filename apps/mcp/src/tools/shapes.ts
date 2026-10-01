// M2 MCP tools for shapes (S11:SHP-008, ARCHITECTURE §20.7): add_shape (type, size, fill, stroke, radius,
// position, at, duration, track) over clip.addShape — one transaction, one "Agent: …" History entry. Edits and
// keyframes go through apply_commands (clip.update {shape}, param.set / keyframe.* on shape.* keys), described
// in SHAPES_GUIDE. Owner: wp-m2-shapes.
import { TrackRefSchema } from '@jasper/project';
import { z } from 'zod';
import { defineTool, EDIT, type ToolContext } from '../context.ts';
import { applyHelper, hexToRgba, timeArg } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const SHAPES_GUIDE = `Shapes (rectangles and ellipses):
- add_shape adds one on a video track (default 400×400 white, centred, 5 s). Size is in layer pixels; position is where its centre lands in the sequence (0,0 = top left). Strokes keep their visible width whatever the position: inside (within the outline), center or outside.
- Change a shape with apply_commands: {"type": "clip.update", "clipId": id, "patch": {"shape": {"fill": null | [r,g,b,a], "stroke": null | {"color", "width", "position"}, "size": [w, h], "cornerRadius": n}}} (colours are RGBA floats 0..1; a missing stroke is created with defaults; cornerRadius only for rectangles), or param.set on ["clip", id, "shape", "size" | "fill" | "cornerRadius"] and ["clip", id, "shape", "stroke", "color" | "width" | "position"].
- Size, fill, stroke colour/width and corner radius are keyframable like Motion: param.setAnimated {animated: true, at} then param.set with "at", or keyframe.add. A fill or stroke that is none must get a value first (param.set, or keyframe.add with "value"); param.setAnimated on it fails. A shape stays centred on its anchor point when its size changes.
- Shapes render in the preview and export through Remotion (natively baked when available); get_timeline shows their geometry.`;

const ColorArg = z.string().describe('Colour "#RRGGBB" or "#RRGGBBAA"');

export function registerShapeTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'add_shape',
		{
			title: 'Add shape',
			description:
				'Adds a rectangle or ellipse clip (clip.addShape) on a video track. Defaults: 400×400, white fill, no stroke, corner radius 0, centred in the frame, 5 s.',
			input: {
				projectId: ProjectIdArg,
				type: z.enum(['rect', 'ellipse']).describe('rect = rectangle, ellipse = ellipse/circle'),
				at: timeArg('Start time'),
				duration: timeArg('Length (default 5 s)').optional(),
				track: TrackRefSchema.optional().describe('Video track (default V2)'),
				size: z
					.tuple([z.number().min(0).max(32768), z.number().min(0).max(32768)])
					.optional()
					.describe('[width, height] in pixels'),
				fill: ColorArg.nullable()
					.optional()
					.describe('Fill colour "#RRGGBB(AA)"; null = no fill (default white)'),
				stroke: z
					.object({
						color: ColorArg,
						width: z.number().min(0).max(4096).describe('Visible width in pixels'),
						position: z.enum(['inside', 'center', 'outside']).optional().describe('Default center'),
					})
					.optional()
					.describe('Outline (default none)'),
				cornerRadius: z.number().min(0).optional().describe('Rounded corners in pixels (rectangles only)'),
				position: z
					.tuple([z.number(), z.number()])
					.optional()
					.describe('[x, y] of the shape centre in sequence pixels (default: frame centre)'),
				name: z.string().max(200).optional().describe('Clip name (default Rectangle / Ellipse)'),
				sequenceId: z
					.string()
					.optional()
					.describe('Sequence id ("seq_…"); default: the project\'s first sequence'),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				a.type === 'rect' ? 'Rectangle' : 'Ellipse',
				[
					{
						type: 'clip.addShape',
						at: a.at,
						track: a.track ?? 'V2',
						...(a.duration !== undefined ? { duration: a.duration } : {}),
						shape: {
							type: a.type,
							...(a.size ? { size: a.size } : {}),
							...(a.fill !== undefined ? { fill: a.fill === null ? null : hexToRgba(a.fill) } : {}),
							...(a.stroke
								? {
										stroke: {
											color: hexToRgba(a.stroke.color),
											width: a.stroke.width,
											...(a.stroke.position ? { position: a.stroke.position } : {}),
										},
									}
								: {}),
							...(a.cornerRadius !== undefined ? { cornerRadius: a.cornerRadius } : {}),
						},
						...(a.position ? { transform: { position: a.position } } : {}),
						...(a.name ? { name: a.name } : {}),
						...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
					},
				],
				extra,
			),
	);
}
