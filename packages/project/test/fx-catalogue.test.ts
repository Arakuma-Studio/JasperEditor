// The fx catalogue (wave 1 scaffolding, wave 2 entries): every family file is wired into the default registry and
// the agent schema export, and every entry follows the framework's rules. Wave-2 families are checked by this test
// as soon as they add entries (no per-family test plumbing needed; family tests add behaviour checks).
import { describe, expect, it } from 'vitest';
import {
	defaultEffectRegistry,
	defaultRegistries,
	effectIsGpu,
	exportAgentSchema,
	FX_EFFECTS,
	FX_FAMILIES,
	SAPPHIRE_BINS,
	validateGpuEffect,
} from '../src/index.ts';

const FAMILY_FILES = [
	'premiere-adjust-color-keying',
	'premiere-stylize-distort-generate',
	'sapphire-glows-lighting',
	'sapphire-paint-kaleido-edges',
	'sapphire-film-grain',
	'sapphire-stylize-other',
	'sapphire-adjust-composite',
	'sapphire-blur-sharpen',
	'sapphire-distort-warp',
	'sapphire-render-textures',
	'sapphire-textures-clouds',
	'sapphire-time-flicker',
	'object-matte',
	'keying-matte',
];

describe('fx catalogue', () => {
	it('has the family files, in Effects-panel order', () => {
		expect(FX_FAMILIES.map((f) => f.file)).toEqual(FAMILY_FILES);
		expect(FX_EFFECTS).toEqual(FX_FAMILIES.flatMap((f) => f.effects));
	});

	it('registers every catalogue effect by default, without shadowing an existing id', () => {
		const ids = defaultEffectRegistry.list().map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const s of FX_EFFECTS) expect(defaultEffectRegistry.get(s.id)).toBe(s);
	});

	it('every entry follows the family id prefix, bins and framework rules', () => {
		const sapphireBins = new Set<string>(Object.values(SAPPHIRE_BINS));
		const problems: string[] = [];
		for (const fam of FX_FAMILIES) {
			const sapphire = fam.file.startsWith('sapphire-');
			for (const s of fam.effects) {
				if (!s.id.startsWith(fam.idPrefix)) problems.push(`${s.id}: id must start with ${fam.idPrefix}`);
				if (!sapphire && s.id.startsWith('jasper.s.'))
					problems.push(`${s.id}: Premiere families use jasper.<name>`);
				if (sapphire && !(s.bin && sapphireBins.has(s.bin)))
					problems.push(`${s.id}: bin must be one of SAPPHIRE_BINS`);
				if (!s.description)
					problems.push(`${s.id}: needs a description (Effects panel tooltip, agent catalogue)`);
				if (s.appliesTo !== 'video') problems.push(`${s.id}: video effects only`);
				if (!s.gpu && !s.preview.css && !s.preview.svgFilter && !s.color)
					problems.push(`${s.id}: no realization (gpu, css, svg or color)`);
				problems.push(...validateGpuEffect(s));
			}
		}
		expect(problems).toEqual([]);
	});

	it('the agent schema export carries bin, description and the GPU flag', () => {
		const schema = exportAgentSchema(defaultRegistries());
		const byId = new Map(schema.effects.map((e) => [e.id, e]));
		for (const s of FX_EFFECTS) {
			const e = byId.get(s.id)!;
			expect(e.bin).toBe(s.bin);
			expect(e.gpu ?? false).toBe(!!s.gpu);
			expect(effectIsGpu(s)).toBe(!!s.gpu);
		}
		// Existing effects keep their shape (no GPU flag).
		expect(byId.get('jasper.crop')!.gpu).toBeUndefined();
	});
});
