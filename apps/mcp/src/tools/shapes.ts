import {
	type BezierPath,
	contentTimeAt,
	evaluate,
	MaskPathOpSchema,
	type ProjectDocument,
	SHAPE_ITEM_TYPES,
	SHAPE_PRESETS,
	type ShapeItem,
	ShapeItemInputSchema,
	ShapeItemPatchSchema,
	SvgImportError,
	shapeItemsSummary,
	svgToShapeContents,
	TrackRefSchema,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	frameOf,
	loadDoc,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { applyHelper, hexToRgba } from './editing.ts';

export const SHAPES_GUIDE = `Shapes — rectangles / ellipses and vector shapes (After Effects-style shape layers):
- add_shape adds a rectangle or ellipse (default 400×400 white, centred, 5 s). Size is in layer pixels; position is where its centre lands in the sequence (0,0 = top left). Strokes keep their visible width whatever the position: inside, center or outside. Change it with apply_commands clip.update {"shape": {fill, stroke, size, cornerRadius}} or param.set on ["clip", id, "shape", "size" | "fill" | "cornerRadius"] / ["clip", id, "shape", "stroke", "color" | "width" | "position"]; convert_shape_to_vector turns it into a vector shape without changing the picture.
- Vector shapes (add_vector_shape, svg_to_shape, list_shape_presets) hold a tree of items, top of the list drawn on top: groups (contents + transform: anchor, position, scale %, skew, skewAxis, rotation, opacity), paths (rect {size, position, roundness}, ellipse {size, position}, polystar {starType star|polygon, points, position, rotation, innerRadius, outerRadius, innerRoundness, outerRoundness}, path {path: SVG path data or {closed, vertices: [{p, in, out}]}}, each with direction normal|reversed), paints (fill {color, opacity %, fillRule nonzero|evenodd, blendMode, composite below|above}, stroke {color, width, opacity, lineCap butt|round|square, lineJoin miter|round|bevel, miterLimit, dashes [dash, gap, …] (≤ 3 pairs) or {segments, offset}, taper {units percent|pixels, startLength, endLength, startWidth %, endWidth %, startEase %, endEase %}, wave {amount %, units pixels|cycles, wavelength, cycles, phase°}, position center|inside|outside}, gradientFill / gradientStroke {gradientType linear|radial, startPoint, endPoint, highlightLength %, highlightAngle°, colors {colors: [{position 0..1, color [r,g,b], midpoint?}], opacities: [{position, opacity 0..1, midpoint?}]}}) and path operators (trim {start %, end %, offset°, mode simultaneous|individual}, repeater {copies, offset, composite below|above, transform {anchor, position, scale, rotation, startOpacity, endOpacity}}, offsetPaths {amount, lineJoin, miterLimit, copies, copyOffset}, roundCorners {radius}, zigZag {size, ridges, points corner|smooth}, twist {angle, center}, wiggle {size, detail, points, speed (wiggles/s), correlation %, temporalPhase°, spatialPhase°, seed}, puckerBloat {amount −100..100}, mergePaths {mode merge|add|subtract|intersect|exclude}). Operators act on every path above them in their group (nested groups included), paints paint the paths above them as modified by the operators below them, Merge Paths drops the paints above it. Coordinates are layer pixels around the layer centre (the layer is frame-sized; its anchor is the centre).
- Edit with get_shape (item ids, values), add_shape_items {clipId, items | preset, parentId?, index?}, update_shape_item {clipId, itemId, patch}, remove_shape_items, move_shape_item, group_shape_items, duplicate_shape_item, edit_shape_path (vertex ops), or apply_commands shape.* commands. Values given statically replace keyframes; colours are "#RRGGBB(AA)" or RGBA floats 0..1; any field also takes an Animatable {value, keyframes}.
- Animate any item property like Motion: param.setAnimated / param.set with "at" / keyframe.* on ["clip", id, "shape", "items", itemId, field…] (e.g. "end" of a Trim Paths, "transform", "position" of a group, "dashes", "offset"); paths and gradients interpolate; expressions work on them too (set_expression).
- Shapes render in the preview and every export through the same composition (layer bake / Remotion); render_frame shows them.`;

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

const ItemsArg = z
	.array(ShapeItemInputSchema)
	.min(1)
	.max(1000)
	.describe('Shape items (see the guide): {type, …fields}; groups take contents');
const ClipIdArg = z.string().describe('Vector shape clip id ("clp_…")');
const ItemIdArg = z.string().describe('Shape item id ("shp_…", from get_shape)');
const AtArg = timeArg(
	'Sequence time of the edit (a keyframe when the path is animated; default: the playhead / clip start)',
).optional();

function vectorClip(doc: ProjectDocument, clipId: string) {
	for (const seq of Object.values(doc.sequences)) {
		const c = seq.clips[clipId];
		if (!c) continue;
		if (c.kind !== 'shape')
			throw new ToolError(
				'E_INVALID_PARAM',
				`Clip ${clipId} is not a shape`,
				'Use get_timeline for clip ids.',
			);
		return { seq, clip: c };
	}
	throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipId}`, 'Call get_timeline for clip ids.');
}

function pathsOf(
	items: readonly ShapeItem[],
	t: number,
): { itemId: string; name: string; path: BezierPath }[] {
	const out: { itemId: string; name: string; path: BezierPath }[] = [];
	const walk = (list: readonly ShapeItem[]) => {
		for (const it of list) {
			if (it.type === 'path')
				out.push({ itemId: it.id, name: it.name, path: evaluate(it.path, t) as BezierPath });
			if (it.type === 'group') walk(it.contents);
		}
	};
	walk(items);
	return out;
}

async function atFrame(ctx: ToolContext, projectId: string, clipId: string, at: unknown): Promise<number> {
	const { doc } = await loadDoc(ctx, projectId);
	return frameOf(vectorClip(doc, clipId).seq, at);
}

const seqArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');

export function registerVectorShapeTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_shape_presets',
		{
			title: 'List shape presets',
			description:
				'Ready-made vector shapes (id, label, category, description) for add_vector_shape {preset} and add_shape_items {preset}.',
			input: {},
			annotations: READ_ONLY,
		},
		async () =>
			jsonResult({
				presets: SHAPE_PRESETS.map((p) => ({
					id: p.id,
					label: p.label,
					category: p.category,
					description: p.description,
				})),
				itemTypes: SHAPE_ITEM_TYPES,
			}),
	);

	defineTool(
		ctx,
		'add_vector_shape',
		{
			title: 'Add vector shape',
			description:
				'Adds a vector shape clip (After Effects-style shape layer: groups, paths, fills, strokes, gradients, path operators) on a video track — from items or a preset. The layer is frame-sized with its anchor at the centre; item coordinates are pixels around that centre; position moves the whole shape.',
			input: {
				projectId: ProjectIdArg,
				items: ItemsArg.optional(),
				preset: z.string().optional().describe('Preset id (list_shape_presets) instead of items'),
				at: timeArg('Start time'),
				duration: timeArg('Length (default 5 s)').optional(),
				track: TrackRefSchema.optional().describe('Video track (default V2)'),
				position: z
					.tuple([z.number(), z.number()])
					.optional()
					.describe('[x, y] of the shape centre in sequence pixels (default: frame centre)'),
				name: z.string().max(200).optional(),
				sequenceId: seqArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if (!a.items === !a.preset)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give either items or a preset',
					'list_shape_presets lists the presets.',
				);
			return applyHelper(
				ctx,
				a.projectId,
				'Vector Shape',
				[
					{
						type: 'clip.addShape',
						at: a.at,
						track: a.track ?? 'V2',
						...(a.duration !== undefined ? { duration: a.duration } : {}),
						shape: { type: 'vector', ...(a.preset ? { preset: a.preset } : { contents: a.items }) },
						...(a.position ? { transform: { position: a.position } } : {}),
						...(a.name ? { name: a.name } : {}),
						...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
					},
				],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'svg_to_shape',
		{
			title: 'SVG to shape',
			description:
				'Converts an SVG document (or bare SVG path data) into a vector shape clip: paths, rects, circles, ellipses, lines, polylines, polygons, use; fills, strokes (caps, joins, dashes), linear/radial gradients, opacity, CSS classes; transforms become group transforms. Returns the warnings for what shape layers cannot express (text, images, filters, masks…). dryRun: only convert and report.',
			input: {
				projectId: ProjectIdArg,
				svg: z.string().min(1).max(5_000_000).describe('SVG markup, or SVG path data ("M0 0 L10 0 …")'),
				at: timeArg('Start time'),
				duration: timeArg('Length (default 5 s)').optional(),
				track: TrackRefSchema.optional().describe('Video track (default V2)'),
				position: z
					.tuple([z.number(), z.number()])
					.optional()
					.describe('[x, y] of the drawing centre in sequence pixels (default: frame centre)'),
				fill: z.string().optional().describe('Path data only: fill colour "#RRGGBB(AA)" (default white)'),
				name: z.string().max(200).optional(),
				dryRun: z.boolean().optional(),
				sequenceId: seqArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			let items: unknown[];
			let warnings: string[] = [];
			let size: [number, number] | null = null;
			try {
				if (/<svg[\s>]/i.test(a.svg)) {
					const r = svgToShapeContents(a.svg);
					items = r.contents;
					warnings = r.warnings;
					size = [r.width, r.height];
				} else {
					items = [
						{ type: 'path', path: a.svg },
						{ type: 'fill', color: a.fill ? hexToRgba(a.fill) : [1, 1, 1, 1] },
					];
				}
			} catch (e) {
				if (e instanceof SvgImportError || e instanceof Error)
					throw new ToolError(
						'E_INVALID_PARAM',
						`Could not read the SVG: ${e.message}`,
						'Pass SVG markup with an <svg> root or valid path data.',
					);
				throw e;
			}
			if (!items.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					'The SVG has nothing a shape layer can draw',
					warnings.join('; ') || undefined,
				);
			if (a.dryRun) return jsonResult({ items, warnings, size });
			const res = await applyHelper(
				ctx,
				a.projectId,
				'SVG Shape',
				[
					{
						type: 'clip.addShape',
						at: a.at,
						track: a.track ?? 'V2',
						...(a.duration !== undefined ? { duration: a.duration } : {}),
						shape: { type: 'vector', contents: items },
						...(a.position ? { transform: { position: a.position } } : {}),
						name: a.name ?? 'SVG',
						...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
					},
				],
				extra,
			);
			return warnings.length
				? jsonResult({ warnings, result: JSON.parse((res.content[0] as { text: string }).text) })
				: res;
		},
	);

	defineTool(
		ctx,
		'get_shape',
		{
			title: 'Get shape',
			description:
				"A shape clip's contents: rectangles/ellipses their size and paint; vector shapes the item tree (id, type, name, enabled, static values, keyframed fields) and every path's vertices at a time (default: the clip's first frame).",
			input: { projectId: ProjectIdArg, clipId: ClipIdArg, at: AtArg },
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const { seq, clip } = vectorClip(doc, a.clipId);
			if (clip.shape.type !== 'vector') return jsonResult({ clipId: clip.id, shape: clip.shape });
			const frame = a.at !== undefined ? frameOf(seq, a.at) : clip.start;
			const t = contentTimeAt(
				clip,
				Math.max(clip.start, Math.min(clip.start + clip.duration - 1, frame)),
				seq.settings.frameRate,
			);
			return jsonResult({
				clipId: clip.id,
				type: 'vector',
				box: { width: seq.settings.width, height: seq.settings.height },
				contents: shapeItemsSummary(clip.shape.contents),
				paths: pathsOf(clip.shape.contents, t),
			});
		},
	);

	defineTool(
		ctx,
		'add_shape_items',
		{
			title: 'Add shape items',
			description:
				'Adds items (or a preset as a group) to a vector shape: into a group (parentId) or the top level, at index (0 = top of the list; default: the end, where operators and paints apply to everything above).',
			input: {
				projectId: ProjectIdArg,
				clipId: ClipIdArg,
				items: ItemsArg.optional(),
				preset: z.string().optional().describe('Preset id instead of items (added as its items)'),
				parentId: z.string().optional().describe('Group item id (default: the top level)'),
				index: z.number().int().min(0).optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Add Shape Items',
				[
					{
						type: 'shape.addItems',
						clipId: a.clipId,
						...(a.items ? { items: a.items } : {}),
						...(a.preset ? { preset: a.preset } : {}),
						...(a.parentId ? { parentId: a.parentId } : {}),
						...(a.index !== undefined ? { index: a.index } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'update_shape_item',
		{
			title: 'Update shape item',
			description:
				"Changes fields of one item (name, enabled, any property of its type; static values replace that property's keyframes). dashes/taper/wave: null removes them. Use param.set with 'at' to keyframe instead.",
			input: { projectId: ProjectIdArg, clipId: ClipIdArg, itemId: ItemIdArg, patch: ShapeItemPatchSchema },
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Edit Shape Item',
				[{ type: 'shape.updateItem', clipId: a.clipId, itemId: a.itemId, patch: a.patch }],
				extra,
			),
	);

	defineTool(
		ctx,
		'remove_shape_items',
		{
			title: 'Remove shape items',
			description: 'Deletes items (a group with its contents) from a vector shape.',
			input: { projectId: ProjectIdArg, clipId: ClipIdArg, itemIds: z.array(z.string()).min(1) },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Delete Shape Items',
				[{ type: 'shape.removeItems', clipId: a.clipId, itemIds: a.itemIds }],
				extra,
			),
	);

	defineTool(
		ctx,
		'move_shape_item',
		{
			title: 'Move shape item',
			description:
				"Moves an item to index in a group's list (parentId) or the top level: reorders, or moves it into / out of a group.",
			input: {
				projectId: ProjectIdArg,
				clipId: ClipIdArg,
				itemId: ItemIdArg,
				parentId: z.string().nullable().optional().describe('Target group id (null / absent: the top level)'),
				index: z.number().int().min(0),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Move Shape Item',
				[
					{
						type: 'shape.moveItem',
						clipId: a.clipId,
						itemId: a.itemId,
						parentId: a.parentId ?? null,
						index: a.index,
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'group_shape_items',
		{
			title: 'Group shape items',
			description: 'Wraps sibling items in a new group (at the position of the topmost one).',
			input: {
				projectId: ProjectIdArg,
				clipId: ClipIdArg,
				itemIds: z.array(z.string()).min(1),
				name: z.string().max(200).optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Group Shapes',
				[
					{
						type: 'shape.groupItems',
						clipId: a.clipId,
						itemIds: a.itemIds,
						...(a.name ? { name: a.name } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'duplicate_shape_item',
		{
			title: 'Duplicate shape item',
			description: 'Duplicates an item (fresh ids, keyframes kept) just above it.',
			input: { projectId: ProjectIdArg, clipId: ClipIdArg, itemId: ItemIdArg },
			annotations: EDIT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Duplicate Shape Item',
				[{ type: 'shape.duplicateItem', clipId: a.clipId, itemId: a.itemId }],
				extra,
			),
	);

	defineTool(
		ctx,
		'edit_shape_path',
		{
			title: 'Edit shape path',
			description:
				'Vertex edits of a path item (layer pixels around the layer centre, in the space of its group): set, moveVertices, setVertex {vertex, p?, in?, out?, breakHandles?}, transform, convert {vertices, to smooth|corner}, insertVertex {segment, t}, removeVertices, appendVertex, setClosed. Shape edits write at "at" (a keyframe when Path is animated) or every key (allKeyframes); topology edits apply to every key.',
			input: {
				projectId: ProjectIdArg,
				clipId: ClipIdArg,
				itemId: ItemIdArg,
				ops: z.array(MaskPathOpSchema).min(1),
				at: AtArg,
				allKeyframes: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Edit Shape Path',
				[
					{
						type: 'shape.editPath',
						clipId: a.clipId,
						itemId: a.itemId,
						ops: a.ops,
						...(a.at !== undefined
							? { at: { sequenceFrame: await atFrame(ctx, a.projectId, a.clipId, a.at) } }
							: {}),
						...(a.allKeyframes ? { allKeyframes: true } : {}),
					},
				],
				extra,
			),
	);

	defineTool(
		ctx,
		'convert_shape_to_vector',
		{
			title: 'Convert shape to vector',
			description:
				'Turns rectangle / ellipse clips into vector shapes (path, stroke and fill items with the same values and keyframes); the picture does not change.',
			input: { projectId: ProjectIdArg, clipIds: z.array(z.string()).min(1) },
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) =>
			applyHelper(
				ctx,
				a.projectId,
				'Convert to Vector Shape',
				a.clipIds.map((clipId) => ({ type: 'shape.convertToVector', clipId })),
				extra,
			),
	);
}
