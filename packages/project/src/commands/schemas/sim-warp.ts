// sim-warp commands: Liquify brush strokes, Mesh Warp vertices, Puppet meshes and pins. Handlers:
// handlers/sim-warp.ts. The distortion meshes are ordinary keyframable params (`["effect", fxId, "distortionMesh"]`)
// and pin properties ordinary animatable properties (`["puppetPin", pinId, "position" | "scale" | "rotation" |
// "amount" | "extent" | "inFront"]`): these commands write them with Effect Controls stopwatch semantics (a key at
// `at` when the property is animated, else the static value).
import { z } from 'zod';
import { Vec2Schema } from '../../schema/common.ts';
import { PUPPET_PIN_KINDS, PUPPET_PIN_PROPS } from '../../schema/puppet.ts';
import { LIQUIFY_TOOLS, RECONSTRUCTION_MODES } from '../../registry/fx/simulation-warp/meshes.ts';
import { cmd, IdRefSchema, ParamAtSchema, RefDeclSchema } from './common.ts';

const Finite = z.number().finite();
const PointPx = z.tuple([Finite, Finite]);

/** One Liquify brush stroke (After Effects' Liquify tools) on the Distortion Mesh at `at`. */
export const LiquifyStrokeCmd = cmd('liquify.stroke', {
	effectInstanceId: IdRefSchema,
	/** Default: the instance's Tool. */
	tool: z.enum(LIQUIFY_TOOLS).optional(),
	/** The brush path in layer pixels (one point = a dab). */
	points: z.array(PointPx).min(1).max(10000),
	/** Brush Size (diameter, layer px) and Pressure (1–100); default: the instance's. */
	size: z.number().min(1).max(4000).optional(),
	pressure: z.number().min(1).max(100).optional(),
	jitter: z.number().min(1).max(100).optional(),
	cloneOffset: PointPx.optional(),
	reconstruction: z.enum(RECONSTRUCTION_MODES).optional(),
	at: ParamAtSchema.optional(),
});
/** Clears the Distortion Mesh at `at` (no distortion). */
export const LiquifyResetCmd = cmd('liquify.reset', { effectInstanceId: IdRefSchema, at: ParamAtSchema.optional() });

const Tangent = Vec2Schema;
/** Moves a vertex (layer-normalised) and/or its tangent handles (offsets) of Mesh Warp's Distortion Mesh at `at`. */
export const MeshWarpSetVertexCmd = cmd('meshWarp.setVertex', {
	effectInstanceId: IdRefSchema,
	column: z.number().int().min(0).max(31),
	row: z.number().int().min(0).max(31),
	position: Vec2Schema.optional(),
	tangents: z
		.strictObject({ left: Tangent.optional(), right: Tangent.optional(), up: Tangent.optional(), down: Tangent.optional() })
		.optional(),
	at: ParamAtSchema.optional(),
});
export const MeshWarpResetCmd = cmd('meshWarp.reset', { effectInstanceId: IdRefSchema, at: ParamAtSchema.optional() });

/** Adds a Puppet mesh: the region of `outline` (layer-normalised polygon; default the layer box) under `seed`. */
export const PuppetAddMeshCmd = cmd('puppet.addMesh', {
	effectInstanceId: IdRefSchema,
	seed: Vec2Schema.optional(),
	outline: z.array(Vec2Schema).min(3).max(4096).optional(),
	density: z.number().min(0).max(100).optional(),
	expansion: z.number().min(-100).max(200).optional(),
	triangles: z.number().min(10).max(10000).optional(),
	name: z.string().min(1).optional(),
	ref: RefDeclSchema.optional(),
});
export const PuppetUpdateMeshCmd = cmd('puppet.updateMesh', {
	meshId: IdRefSchema,
	outline: z.array(Vec2Schema).min(3).max(4096).nullable().optional(),
	density: z.number().min(0).max(100).optional(),
	expansion: z.number().min(-100).max(200).optional(),
	triangles: z.number().min(10).max(10000).optional(),
	name: z.string().min(1).optional(),
});
/** Removes a mesh and its pins. */
export const PuppetRemoveMeshCmd = cmd('puppet.removeMesh', { meshId: IdRefSchema });

/**
 * Places a pin at `position` (layer-normalised). On a mesh that contains the point; outside every mesh a new mesh is
 * made first (from `outline`, default the layer box) — like the first click of After Effects' Puppet Pin tool.
 */
export const PuppetAddPinCmd = cmd('puppet.addPin', {
	effectInstanceId: IdRefSchema,
	position: Vec2Schema,
	kind: z.enum(PUPPET_PIN_KINDS).optional(),
	outline: z.array(Vec2Schema).min(3).max(4096).optional(),
	name: z.string().min(1).optional(),
	ref: RefDeclSchema.optional(),
});
export const PuppetRemovePinsCmd = cmd('puppet.removePins', { pinIds: z.array(IdRefSchema).min(1) });
export const PuppetRenamePinCmd = cmd('puppet.renamePin', { pinId: IdRefSchema, name: z.string().min(1) });
/** Moves pins (layer-normalised positions) at `at` — a drag of one or several selected pins. */
export const PuppetMovePinsCmd = cmd('puppet.movePins', {
	moves: z.array(z.strictObject({ pinId: IdRefSchema, position: Vec2Schema })).min(1).max(1024),
	at: ParamAtSchema.optional(),
});
/** Writes keys of a pin property (the Puppet Sketch tool records Position keys this way). */
export const PuppetSetPinKeysCmd = cmd('puppet.setPinKeys', {
	pinId: IdRefSchema,
	prop: z.enum(PUPPET_PIN_PROPS).optional(),
	keys: z.array(z.strictObject({ at: ParamAtSchema, value: z.union([Vec2Schema, Finite]) })).min(1).max(10000),
	/** Remove the property's other keys between the first and the last new key first. */
	clearSpan: z.boolean().optional(),
});

export const SIM_WARP_COMMANDS = [
	LiquifyStrokeCmd,
	LiquifyResetCmd,
	MeshWarpSetVertexCmd,
	MeshWarpResetCmd,
	PuppetAddMeshCmd,
	PuppetUpdateMeshCmd,
	PuppetRemoveMeshCmd,
	PuppetAddPinCmd,
	PuppetRemovePinsCmd,
	PuppetRenamePinCmd,
	PuppetMovePinsCmd,
	PuppetSetPinKeysCmd,
] as const;
