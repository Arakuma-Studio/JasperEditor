import { z } from 'zod';
import { RGBASchema, Vec3Schema } from '../schema/common.ts';

const index = z.number().int().nonnegative();

const GltfNodeSchema = z.object({
	mesh: index.optional(),
	children: z.array(index).optional(),
	matrix: z.array(z.number()).length(16).optional(),
	translation: Vec3Schema.optional(),
	rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
	scale: Vec3Schema.optional(),
});

const GltfPrimitiveSchema = z.object({
	attributes: z.record(z.string(), index),
	indices: index.optional(),
	material: index.optional(),
	mode: index.optional(),
});

// Only fields consumed by the static model renderer are retained; the imported file is never rewritten.
export const GltfSchema = z.object({
	asset: z.object({ version: z.string() }),
	extensionsRequired: z.array(z.string()).optional(),
	buffers: z.array(z.object({ uri: z.string().optional() })).optional(),
	bufferViews: z
		.array(
			z.object({
				buffer: index,
				byteOffset: index.optional(),
				byteLength: index,
				byteStride: index.optional(),
			}),
		)
		.optional(),
	accessors: z
		.array(
			z.object({
				bufferView: index.optional(),
				byteOffset: index.optional(),
				componentType: z.number().int(),
				count: index,
				type: z.string(),
				normalized: z.boolean().optional(),
			}),
		)
		.optional(),
	textures: z.array(z.object({ source: index.optional() })).optional(),
	images: z
		.array(
			z.object({
				bufferView: index.optional(),
				mimeType: z.string().optional(),
				uri: z.string().optional(),
			}),
		)
		.optional(),
	materials: z
		.array(
			z.object({
				pbrMetallicRoughness: z
					.object({
						baseColorFactor: RGBASchema.optional(),
						baseColorTexture: z.object({ index }).optional(),
						metallicFactor: z.number().optional(),
						roughnessFactor: z.number().optional(),
					})
					.optional(),
				emissiveFactor: Vec3Schema.optional(),
				alphaMode: z.enum(['OPAQUE', 'MASK', 'BLEND']).optional(),
				alphaCutoff: z.number().optional(),
				doubleSided: z.boolean().optional(),
			}),
		)
		.optional(),
	nodes: z.array(GltfNodeSchema).optional(),
	meshes: z.array(z.object({ primitives: z.array(GltfPrimitiveSchema) })).optional(),
	scene: index.optional(),
	scenes: z.array(z.object({ nodes: z.array(index).optional() })).optional(),
});

export type GltfDocument = z.infer<typeof GltfSchema>;
export type GltfNode = z.infer<typeof GltfNodeSchema>;
export type GltfPrimitive = z.infer<typeof GltfPrimitiveSchema>;
