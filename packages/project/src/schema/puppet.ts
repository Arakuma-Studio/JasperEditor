// Puppet (sim-warp workstream): After Effects' Puppet effect data on an effect instance (`EffectInstance.puppet`).
// Meshes are outlines (layer-box-normalised polygons; none = the layer box) triangulated with Density / Expansion /
// Triangles; pins sit on a mesh at a rest point and carry animatable properties — Position (Position and Advanced
// pins), Scale and Rotation (Advanced and Bend pins), Amount and Extent (Starch), In Front and Extent (Overlap).
// Optional field of the instance (no schema-version bump): absent = no meshes.
import { z } from 'zod';
import type { DeepStrip } from './common.ts';
import { AnimNumberSchema, AnimVec2Schema, Vec2Schema } from './common.ts';

export const PUPPET_PIN_KINDS = ['position', 'advanced', 'bend', 'starch', 'overlap'] as const;
export type PuppetPinKind = (typeof PUPPET_PIN_KINDS)[number];
/** Animatable pin properties (ParamPath `["puppetPin", pinId, prop]`). */
export const PUPPET_PIN_PROPS = ['position', 'scale', 'rotation', 'amount', 'extent', 'inFront'] as const;
export type PuppetPinProp = (typeof PUPPET_PIN_PROPS)[number];
/** Display labels of the pin properties (Effect Controls, agent schema). */
export const PUPPET_PIN_LABELS: Record<PuppetPinProp, string> = {
	position: 'Position',
	scale: 'Scale',
	rotation: 'Rotation',
	amount: 'Amount',
	extent: 'Extent',
	inFront: 'In Front',
};

export const PuppetMeshSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	/** Outline polygon (layer-box-normalised), absent = the layer box. */
	outline: z.array(Vec2Schema).max(4096).optional(),
	/** Where the mesh was created (layer-box-normalised): picks the region of the outline. */
	seed: Vec2Schema,
	/** 0–100 (50 = the Triangles target; every 25 doubles or halves it). */
	density: z.number().min(0).max(100),
	/** Outline growth in layer px. */
	expansion: z.number().min(-100).max(200),
	/** Target triangle count. */
	triangles: z.number().min(10).max(10000),
});
export type PuppetMesh = DeepStrip<z.infer<typeof PuppetMeshSchema>>;

export const PuppetPinSchema = z.looseObject({
	id: z.string(),
	name: z.string(),
	kind: z.enum(PUPPET_PIN_KINDS),
	meshId: z.string(),
	/** Rest point on the mesh (layer-box-normalised). */
	rest: Vec2Schema,
	/** Layer-box-normalised. */
	position: AnimVec2Schema,
	/** Percent. */
	scale: AnimNumberSchema,
	/** Degrees. */
	rotation: AnimNumberSchema,
	/** Starch Amount 0–100. */
	amount: AnimNumberSchema,
	/** Starch / Overlap Extent, layer px. */
	extent: AnimNumberSchema,
	/** Overlap In Front −100…100. */
	inFront: AnimNumberSchema,
});
export type PuppetPin = DeepStrip<z.infer<typeof PuppetPinSchema>>;

export const PuppetSchema = z.looseObject({
	meshes: z.array(PuppetMeshSchema).max(64),
	pins: z.array(PuppetPinSchema).max(1024),
});
export type Puppet = DeepStrip<z.infer<typeof PuppetSchema>>;
