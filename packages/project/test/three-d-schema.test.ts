import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ModelParseError, parseModel } from '../src/three-d/gltf.ts';
import { triangleDocument } from './three-d-hostile.ts';

const bytes = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc));

describe('glTF schema validation', () => {
	it.each([
		{ pbrMetallicRoughness: { baseColorFactor: 'red' } },
		{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0] } },
		{ pbrMetallicRoughness: { metallicFactor: 'shiny' } },
		{ pbrMetallicRoughness: { roughnessFactor: null } },
		{ emissiveFactor: [0, 0, 'blue'] },
		{ alphaMode: 'TRANSPARENT' },
		{ alphaCutoff: 'half' },
		{ doubleSided: 'false' },
	])('refuses malformed material fields: %j', (material) => {
		const doc = triangleDocument();
		const malformed = { ...doc, materials: [material] };
		doc.meshes[0].primitives[0].material = 0;
		expect(() => parseModel(bytes(malformed), 'gltf')).toThrow(ModelParseError);
		expect(() => parseModel(bytes(malformed), 'gltf')).toThrow(/malformed at materials.0/);
	});

	it('refuses malformed node matrices instead of discarding the transform', () => {
		const doc = triangleDocument();
		doc.nodes[0].matrix = [1, 0, 0, 1];
		expect(() => parseModel(bytes(doc), 'gltf')).toThrow(/malformed at nodes.0.matrix/);
	});

	it('identifies the nested field that failed validation', () => {
		const doc = triangleDocument();
		const malformed = {
			...doc,
			accessors: [{ ...doc.accessors[0], normalized: 'false' }, ...doc.accessors.slice(1)],
		};
		expect(() => parseModel(bytes(malformed), 'gltf')).toThrow(/malformed at accessors.0.normalized/);
	});

	it('rejects non-object material values for arbitrary JSON scalars', () => {
		fc.assert(
			fc.property(fc.oneof(fc.boolean(), fc.string(), fc.integer(), fc.constant(null)), (material) => {
				const doc = triangleDocument();
				const malformed = { ...doc, materials: [material] };
				doc.meshes[0].primitives[0].material = 0;
				expect(() => parseModel(bytes(malformed), 'gltf')).toThrow(ModelParseError);
			}),
			{ numRuns: 100 },
		);
	});

	it('keeps optional material defaults and ignores unused extension metadata', () => {
		const doc = triangleDocument();
		const extended = {
			...doc,
			materials: [{ extras: { author: 'test' }, extensions: { CUSTOM_metadata: { value: 1 } } }],
		};
		doc.meshes[0].primitives[0].material = 0;
		const model = parseModel(bytes(extended), 'gltf');
		expect(model.primitives[0]!.material).toEqual({
			baseColor: [1, 1, 1, 1],
			texture: null,
			metallic: 1,
			roughness: 1,
			emissive: [0, 0, 0],
			alphaMode: 'OPAQUE',
			alphaCutoff: 0.5,
			doubleSided: false,
		});
	});
});
