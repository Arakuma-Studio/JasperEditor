// sim-warp MCP tools: Puppet pins (place, move, record), Liquify brush strokes and Mesh Warp vertices. The simulation
// and warp effects themselves (Particle World, Shatter, Card Dance, Caustics, Wave World, Foam, Rainfall…, Displacement
// Map, Polar Coordinates, Bezier Warp…) are ordinary effects: apply_commands effect.add / param.set
// (describe_commands lists their params). docs/wp-notes/sim-warp.md.
import {
	type Animatable,
	alphaOutline,
	type Clip,
	contentTimeAt,
	type EffectInstance,
	evaluate,
	LIQUIFY_TOOLS,
	type ProjectDocument,
	PUPPET_PIN_KINDS,
	PUPPET_PIN_PROPS,
	RECONSTRUCTION_MODES,
	type Sequence,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, TIME_FORMATS, timeArg } from '../arguments.ts';
import { DESTRUCTIVE, defineTool, EDIT, frameOf, loadDoc, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { decodePng } from '../png.ts';
import { applyHelper } from './editing.ts';

export const SIM_WARP_GUIDE = `Simulations and warps: Particle World, Particle Systems II, Particle Playground, Mercury, Shatter, Card Dance, Card Wipe, Pixel Polly, Ball Action, Scatterize, Hair, Foam, Wave World, Caustics, Rainfall, Snowfall, Bubbles, Drizzle and Star Burst (category Simulation), and Bezier Warp, Mesh Warp, Liquify, Puppet, Reshape, Smear, Displacement Map, Optics Compensation and Polar Coordinates (Distort) are effects: apply_commands effect.add {clipId, effectId: "jasper.particle-world"…} then param.set (describe_commands lists every param, choice and range). Simulations are deterministic: the same frame always renders the same picture (seek = play), Random Seed varies them; check with render_frame. Maps (Displacement Map, Shatter's custom map, Wave World's ground, Particle Playground's layer maps) take an image media id param. Puppet: add_puppet_pins places pins (the first pin on a clip makes a mesh from the clip's alpha outline or its box; Position pins move, Starch stiffens, Overlap brings a part in front, Advanced / Bend pins also scale and rotate); move_puppet_pins moves them at a time (a key when the pin is animated: set animated with record_puppet_pins or param.setAnimated ["puppetPin", pinId, "position"]); record_puppet_pins writes a motion (keys) for a pin; get_puppet lists meshes and pins with their values at a time. Pin properties are animatable properties ["puppetPin", pinId, prop] (param.set, keyframe.*, expressions as puppet.<pinId>.<prop>). Liquify: liquify_stroke paints one brush stroke of a tool (warp, turbulence, twirlClockwise, twirlCounterclockwise, pucker, bloat, shiftPixels, reflection, clone, reconstruction) on its Distortion Mesh (keyframable: a stroke at a time with the mesh animated writes a key). Mesh Warp: set_mesh_warp_vertex moves a vertex and its Bézier tangents of the Distortion Mesh (Rows × Columns params). Per-effect masks limit any of them.`;

const EffectIdArg = z
	.string()
	.min(1)
	.describe('Effect instance id ("fx_…") from get_timeline / get_clip_properties');
const PinIdArg = z.string().min(1).describe('Puppet pin id ("ppn_…") from add_puppet_pins / get_puppet');
const NormPt = z.tuple([z.number(), z.number()]);

function findEffect(
	doc: ProjectDocument,
	effectInstanceId: string,
	effectId: string,
): { seq: Sequence; clip: Clip; fx: EffectInstance } {
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips)) {
			const fx = ((clip as { effects?: EffectInstance[] }).effects ?? []).find(
				(e) => e.id === effectInstanceId,
			);
			if (!fx) continue;
			if (fx.effectId !== effectId)
				throw new ToolError(
					'E_INVALID_PARAM',
					`Effect ${effectInstanceId} is ${fx.effectId}, not ${effectId}`,
					`Add one with apply_commands effect.add {effectId: "${effectId}"}.`,
				);
			return { seq, clip, fx };
		}
	throw new ToolError(
		'E_NOT_FOUND',
		`Effect instance not found: ${effectInstanceId}`,
		'Clip effects are listed by get_clip_properties / get_timeline.',
	);
}

function seqOfPin(doc: ProjectDocument, pinId: string): Sequence {
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips))
			for (const fx of (clip as { effects?: EffectInstance[] }).effects ?? [])
				if (fx.puppet?.pins.some((p) => p.id === pinId)) return seq;
	throw new ToolError(
		'E_NOT_FOUND',
		`Puppet pin not found: ${pinId}`,
		'get_puppet lists the pins of a Puppet effect.',
	);
}

/** A tool time argument → the commands' `at` ({sequenceFrame}). */
const atOf = (seq: Sequence, at: unknown) =>
	at === undefined ? {} : { at: { sequenceFrame: frameOf(seq, at, TIME_FORMATS) } };

/** The alpha outline of a PNG still clip's image under `seed` (layer-normalised), else null (alphaOutline). */
async function stillAlphaOutline(
	ctx: ToolContext,
	doc: ProjectDocument,
	clip: Clip,
	seed: [number, number],
): Promise<[number, number][] | null> {
	const mediaId = (clip as { mediaId?: string }).mediaId;
	const asset = mediaId ? doc.media[mediaId] : undefined;
	const key = asset?.locators.find((l) => l.type === 'engine-store')?.key;
	if (asset?.kind !== 'image' || !key) return null;
	try {
		const { bytes } = await ctx.engine((c) => c.fetchBytes(c.mediaUrl(key)));
		const img = decodePng(bytes);
		return alphaOutline(img.data, img.width, img.height, seed);
	} catch {
		return null; // not a PNG (no alpha to trace) or unreadable: the box mesh
	}
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function registerSimWarpTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_puppet',
		{
			title: 'Get Puppet meshes and pins',
			description:
				"A Puppet effect's meshes (outline points, density, expansion, triangles) and pins (id, name, kind, mesh, rest point, and each property's value at `at` — Position in layer-normalised coordinates (0–1 across the clip's layer box), Scale %, Rotation °, Starch Amount / Extent, Overlap In Front / Extent — with whether it is animated and how many keys it has).",
			input: {
				projectId: ProjectIdArg,
				effectInstanceId: EffectIdArg,
				at: timeArg('Sequence time the pin values are read at (default: the clip start)').optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, effectInstanceId, at }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq, clip, fx } = findEffect(doc, effectInstanceId, 'jasper.puppet');
			const frame = at === undefined ? clip.start : frameOf(seq, at, TIME_FORMATS);
			const t = contentTimeAt(clip, frame, seq.settings.frameRate);
			const p = fx.puppet ?? { meshes: [], pins: [] };
			return jsonResult({
				effectInstanceId,
				frame,
				meshes: p.meshes.map((m) => ({
					meshId: m.id,
					name: m.name,
					seed: m.seed,
					outlinePoints: m.outline?.length ?? 0,
					density: m.density,
					expansion: m.expansion,
					triangles: m.triangles,
				})),
				pins: p.pins.map((pin) => {
					const props: Record<string, unknown> = {};
					for (const k of PUPPET_PIN_PROPS) {
						const a = pin[k] as Animatable<unknown>;
						const v = evaluate(a, t);
						props[k] = {
							value: Array.isArray(v) ? v.map((x) => r4(x as number)) : r4(v as number),
							animated: a.keyframes.length > 0,
							keys: a.keyframes.length,
						};
					}
					return {
						pinId: pin.id,
						name: pin.name,
						kind: pin.kind,
						meshId: pin.meshId,
						rest: pin.rest,
						...props,
					};
				}),
			});
		},
	);

	defineTool(
		ctx,
		'add_puppet_pins',
		{
			title: 'Add Puppet pins',
			description:
				"Places pins on a Puppet effect (After Effects' Puppet Position / Starch / Bend / Advanced / Overlap Pin tools), one undoable step. Points are layer-normalised ([0, 0] = the layer's top-left, [1, 1] its bottom-right). A pin outside every mesh first makes a mesh: by default from the opaque region of a PNG still with transparency under the first pin (After Effects' behaviour), else the clip's whole box; `outline` gives a polygon (layer-normalised, e.g. the subject's silhouette) or forces \"box\". Returns the pin ids (results[i].pinId). The picture changes once pins move (move_puppet_pins / record_puppet_pins).",
			input: {
				projectId: ProjectIdArg,
				effectInstanceId: EffectIdArg,
				pins: z
					.array(
						z.object({
							position: NormPt.describe('Layer-normalised [x, y]'),
							kind: z.enum(PUPPET_PIN_KINDS).optional().describe('Default position'),
							name: z.string().min(1).optional(),
						}),
					)
					.min(1)
					.max(256),
				outline: z
					.union([z.array(NormPt).min(3).max(4096), z.enum(['alpha', 'box'])])
					.optional()
					.describe(
						'Mesh made for the first pin outside every mesh: a layer-normalised polygon, "alpha" (default: the opaque region of a PNG still under the pin, as After Effects meshes a layer with transparency; else the box) or "box" (the whole layer)',
					),
			},
			annotations: EDIT,
		},
		async ({ projectId, effectInstanceId, pins, outline: outlineArg }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { clip, fx } = findEffect(doc, effectInstanceId, 'jasper.puppet');
			let outline = Array.isArray(outlineArg) ? outlineArg : undefined;
			if (outlineArg !== 'box' && !outline && !fx.puppet?.meshes.length)
				outline = (await stillAlphaOutline(ctx, doc, clip, pins[0]!.position)) ?? undefined;
			return applyHelper(
				ctx,
				projectId,
				'Add Puppet Pins',
				pins.map((p, i) => ({
					type: 'puppet.addPin',
					effectInstanceId,
					position: p.position,
					...(p.kind ? { kind: p.kind } : {}),
					...(p.name ? { name: p.name } : {}),
					...(outline && i === 0 ? { outline } : {}),
				})),
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'move_puppet_pins',
		{
			title: 'Move Puppet pins',
			description:
				'Moves Position / Advanced pins to layer-normalised positions at a sequence time — a drag in the Program monitor: a key at `at` when the pin Position is animated, else the static position. One undoable step.',
			input: {
				projectId: ProjectIdArg,
				moves: z
					.array(z.object({ pinId: PinIdArg, position: NormPt.describe('Layer-normalised [x, y]') }))
					.min(1)
					.max(1024),
				at: timeArg('Sequence time of the move (keys of animated pins)').optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, moves, at }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = seqOfPin(doc, moves[0]!.pinId);
			return applyHelper(
				ctx,
				projectId,
				'Move Puppet Pins',
				[{ type: 'puppet.movePins', moves, ...atOf(seq, at) }],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'record_puppet_pins',
		{
			title: 'Record Puppet pin motion',
			description:
				"Writes keys of a pin property (default Position, layer-normalised [x, y]; Scale / Rotation / Amount / Extent / In Front take numbers) — the Puppet Sketch tool's recorded motion. The property becomes animated. clearSpan removes the property's other keys between the first and last new key first. One undoable step per call.",
			input: {
				projectId: ProjectIdArg,
				pinId: PinIdArg,
				prop: z.enum(PUPPET_PIN_PROPS).optional().describe('Default position'),
				keys: z
					.array(
						z.object({
							at: timeArg('Sequence time of the key'),
							value: z.union([NormPt, z.number()]).describe('[x, y] for position, a number otherwise'),
						}),
					)
					.min(1)
					.max(10000),
				clearSpan: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, pinId, prop, keys, clearSpan }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = seqOfPin(doc, pinId);
			return applyHelper(
				ctx,
				projectId,
				'Record Puppet Pins',
				[
					{
						type: 'puppet.setPinKeys',
						pinId,
						...(prop ? { prop } : {}),
						keys: keys.map((k) => ({ value: k.value, ...atOf(seq, k.at) })),
						...(clearSpan !== undefined ? { clearSpan } : {}),
					},
				],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'remove_puppet_pins',
		{
			title: 'Remove Puppet pins',
			description:
				'Deletes pins (and, with removeEmptyMeshes, meshes left without pins) from Puppet effects. One undoable step.',
			input: {
				projectId: ProjectIdArg,
				pinIds: z.array(PinIdArg).min(1),
				removeEmptyMeshes: z.boolean().optional(),
			},
			annotations: DESTRUCTIVE,
		},
		async ({ projectId, pinIds, removeEmptyMeshes }, extra) => {
			const commands: unknown[] = [{ type: 'puppet.removePins', pinIds }];
			if (removeEmptyMeshes) {
				const { doc } = await loadDoc(ctx, projectId);
				const gone = new Set(pinIds);
				for (const seq of Object.values(doc.sequences))
					for (const clip of Object.values(seq.clips))
						for (const fx of (clip as { effects?: EffectInstance[] }).effects ?? []) {
							const p = fx.puppet;
							if (!p) continue;
							for (const m of p.meshes)
								if (
									p.pins.some((x) => x.meshId === m.id && gone.has(x.id)) &&
									p.pins.every((x) => x.meshId !== m.id || gone.has(x.id))
								)
									commands.push({ type: 'puppet.removeMesh', meshId: m.id });
						}
			}
			return applyHelper(ctx, projectId, 'Remove Puppet Pins', commands, extra);
		},
	);

	defineTool(
		ctx,
		'liquify_stroke',
		{
			title: 'Liquify brush stroke',
			description:
				"Paints one brush stroke on a Liquify effect's Distortion Mesh (After Effects' Liquify tools): points are the brush path in layer pixels (one point = a dab); tool defaults to the effect's Tool param (warp, turbulence, twirlClockwise, twirlCounterclockwise, pucker, bloat, shiftPixels, reflection, clone, reconstruction); size = brush diameter (layer px) and pressure 1–100 default to the effect's Brush Size / Pressure. At `at` with the Distortion Mesh animated the stroke writes a key there. reset: true clears the mesh instead. One undoable step.",
			input: {
				projectId: ProjectIdArg,
				effectInstanceId: EffectIdArg,
				points: z
					.array(z.tuple([z.number(), z.number()]))
					.min(1)
					.max(10000)
					.optional()
					.describe('Brush path, layer px'),
				tool: z.enum(LIQUIFY_TOOLS).optional(),
				size: z.number().min(1).max(4000).optional(),
				pressure: z.number().min(1).max(100).optional(),
				jitter: z.number().min(1).max(100).optional().describe('Turbulence jitter'),
				cloneOffset: z.tuple([z.number(), z.number()]).optional().describe('Clone source offset, layer px'),
				reconstruction: z.enum(RECONSTRUCTION_MODES).optional(),
				reset: z.boolean().optional(),
				at: timeArg('Sequence time of the stroke').optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, effectInstanceId, points, reset, at, ...rest }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq } = findEffect(doc, effectInstanceId, 'jasper.liquify');
			if (!reset && !points)
				throw new ToolError('E_INVALID_PARAM', 'Give points (the brush path) or reset: true');
			const atArg = atOf(seq, at);
			const opts = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
			return applyHelper(
				ctx,
				projectId,
				reset ? 'Reset Liquify' : 'Liquify',
				reset
					? [{ type: 'liquify.reset', effectInstanceId, ...atArg }]
					: [{ type: 'liquify.stroke', effectInstanceId, points, ...opts, ...atArg }],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'set_mesh_warp_vertex',
		{
			title: 'Set Mesh Warp vertex',
			description:
				"Moves a vertex of a Mesh Warp effect's Distortion Mesh (column 0…Columns, row 0…Rows; position layer-normalised) and/or its Bézier tangents (left / right / up / down offsets, layer-normalised), at `at` (a key when the mesh is animated). reset: true restores the undistorted grid. One undoable step.",
			input: {
				projectId: ProjectIdArg,
				effectInstanceId: EffectIdArg,
				column: z.number().int().min(0).max(31).optional(),
				row: z.number().int().min(0).max(31).optional(),
				position: NormPt.optional(),
				tangents: z
					.object({
						left: NormPt.optional(),
						right: NormPt.optional(),
						up: NormPt.optional(),
						down: NormPt.optional(),
					})
					.optional(),
				reset: z.boolean().optional(),
				at: timeArg('Sequence time of the edit').optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, effectInstanceId, column, row, position, tangents, reset, at }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq } = findEffect(doc, effectInstanceId, 'jasper.mesh-warp');
			const atArg = atOf(seq, at);
			if (reset)
				return applyHelper(
					ctx,
					projectId,
					'Reset Mesh Warp',
					[{ type: 'meshWarp.reset', effectInstanceId, ...atArg }],
					extra,
				);
			if (column === undefined || row === undefined || (!position && !tangents))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give column, row and position and/or tangents (or reset: true)',
				);
			return applyHelper(
				ctx,
				projectId,
				'Edit Distortion Mesh',
				[
					{
						type: 'meshWarp.setVertex',
						effectInstanceId,
						column,
						row,
						...(position ? { position } : {}),
						...(tangents ? { tangents } : {}),
						...atArg,
					},
				],
				extra,
			);
		},
	);
}
