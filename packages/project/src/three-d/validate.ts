// Spec 19 §9: what a 3D layer's physically based surfaces, bevel bands, inflate and backplates must be. The fields are
// read leniently (`z.custom`) so a bad value never stops a project opening: INV-012 reports through `threeDProblem`,
// and `sanitizeThreeD` runs before anything walks the document, as `sanitizeAppearances` does, and repairs conservatively.
import { z } from 'zod';
import { AnimNumberSchema, AnimRGBASchema } from '../schema/common.ts';
import {
	BEVEL_PROFILES,
	type Layer3D,
	MAX_BACKPLATES,
	MAX_BEVEL_BANDS,
	MAX_BEVEL_SEGMENTS,
	PLATE_SHAPES,
	SURFACE_BASES,
	SURFACE_RELIEFS,
} from '../schema/three-d.ts';
import { newSurface, SURFACE_NUMBERS } from './surfaces.ts';

/** Stops of a surface's tint ramp. */
export const MAX_RAMP_STOPS = 16;
export const MAX_INFLATE_POINTS = 16;

const unit = z.number().min(0).max(1);
const SurfaceRampSchema = z.looseObject({
	angle: z.number().finite(),
	stops: z
		.array(z.looseObject({ at: unit, color: z.tuple([unit, unit, unit, unit]) }))
		.min(2)
		.max(MAX_RAMP_STOPS),
});

export const SurfaceMaterialSchema = z.looseObject({
	base: z.enum(SURFACE_BASES),
	baseColor: AnimRGBASchema,
	ramp: SurfaceRampSchema.optional(),
	metalness: AnimNumberSchema,
	roughness: AnimNumberSchema,
	reflectivity: AnimNumberSchema,
	specularBoost: AnimNumberSchema,
	clearcoat: AnimNumberSchema,
	clearcoatRoughness: AnimNumberSchema,
	flakes: AnimNumberSchema,
	flakeScale: AnimNumberSchema,
	relief: z.enum(SURFACE_RELIEFS),
	reliefAmount: AnimNumberSchema,
	reliefScale: AnimNumberSchema,
	reliefSeed: z.number().int(),
	iridescence: AnimNumberSchema,
	iridescenceThickness: AnimNumberSchema,
	transmission: AnimNumberSchema,
	ior: AnimNumberSchema,
	thickness: AnimNumberSchema,
	dispersion: AnimNumberSchema,
	attenuationColor: AnimRGBASchema,
	emissive: AnimRGBASchema,
	emissiveIntensity: AnimNumberSchema,
});

const BandSchema = z.looseObject({
	id: z.string().min(1),
	width: AnimNumberSchema,
	depth: AnimNumberSchema,
	profile: z.enum(BEVEL_PROFILES),
	curve: AnimNumberSchema,
	segments: z.number().int().min(1).max(MAX_BEVEL_SEGMENTS),
	material: SurfaceMaterialSchema.optional(),
});

const InflateSchema = z.looseObject({
	height: AnimNumberSchema,
	curve: z
		.array(z.looseObject({ x: unit, y: unit, corner: z.boolean().optional() }))
		.min(2)
		.max(MAX_INFLATE_POINTS),
	smoothness: AnimNumberSchema,
	detail: z.number().min(1).max(4),
});

const BackplateSchema = z.looseObject({
	id: z.string().min(1),
	enabled: z.boolean(),
	shape: z.enum(PLATE_SHAPES),
	grow: AnimNumberSchema,
	depth: AnimNumberSchema,
	gap: AnimNumberSchema,
	corner: AnimNumberSchema,
	fillCounters: z.boolean(),
	bevelWidth: AnimNumberSchema,
	bevelDepth: AnimNumberSchema,
	bevelProfile: z.enum(BEVEL_PROFILES),
	face: SurfaceMaterialSchema.optional(),
	side: SurfaceMaterialSchema.optional(),
});

const SurfacesSchema = z.looseObject({
	face: SurfaceMaterialSchema.optional(),
	side: SurfaceMaterialSchema.optional(),
	back: SurfaceMaterialSchema.optional(),
});

const issue = (e: z.ZodError) => {
	const i = e.issues[0]!;
	return `${i.path.join('.') || 'value'}: ${i.message}`;
};

/** Why the §9 fields of a 3D layer are invalid, or null. */
export function threeDProblem(td: unknown): string | null {
	if (!td || typeof td !== 'object') return null;
	const t = td as Partial<Layer3D>;
	if (t.material?.pbr !== undefined) {
		const r = SurfaceMaterialSchema.safeParse(t.material.pbr);
		if (!r.success) return `material.pbr ${issue(r.error)}`;
	}
	const g = t.geometry;
	if (!g) return null;
	if (g.surfaces !== undefined) {
		const r = SurfacesSchema.safeParse(g.surfaces);
		if (!r.success) return `geometry.surfaces ${issue(r.error)}`;
	}
	if (g.bands !== undefined) {
		const r = z.array(BandSchema).max(MAX_BEVEL_BANDS).safeParse(g.bands);
		if (!r.success) return `geometry.bands ${issue(r.error)}`;
		if (new Set(r.data.map((b) => b.id)).size !== r.data.length) return 'geometry.bands: repeated band id';
	}
	if (g.inflate !== undefined) {
		const r = InflateSchema.safeParse(g.inflate);
		if (!r.success) return `geometry.inflate ${issue(r.error)}`;
	}
	if (g.backplates !== undefined) {
		const r = z.array(BackplateSchema).max(MAX_BACKPLATES).safeParse(g.backplates);
		if (!r.success) return `geometry.backplates ${issue(r.error)}`;
		if (new Set(r.data.map((b) => b.id)).size !== r.data.length) return 'geometry.backplates: repeated plate id';
	}
	return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A surface with its unreadable fields back at their defaults, or null when it is not one at all. */
function repairSurface(v: unknown): unknown | null {
	if (!isObj(v)) return null;
	if (SurfaceMaterialSchema.safeParse(v).success) return v;
	const def = newSurface() as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = { ...def };
	const fields = SurfaceMaterialSchema.shape as Record<string, z.ZodType>;
	for (const [k, schema] of Object.entries(fields))
		if (v[k] !== undefined && schema.safeParse(v[k]).success) out[k] = v[k];
	return out;
}

type Note = (code: string, target: string, message: string) => void;

/** Repairs the §9 fields of one layer in place. Idempotent; reports each change. */
export function repairThreeD(td: Record<string, unknown>, target: string, note: Note): void {
	const m = td.material;
	if (isObj(m) && m.pbr !== undefined) {
		const s = repairSurface(m.pbr);
		if (s === null) {
			delete m.pbr;
			note('drop-3d-surface', target, 'unreadable surface removed');
		} else if (s !== m.pbr) {
			m.pbr = s;
			note('repair-3d-surface', target, 'unreadable surface values reset');
		}
	}
	const g = td.geometry;
	if (!isObj(g)) return;
	if (g.surfaces !== undefined) {
		if (!isObj(g.surfaces)) {
			delete g.surfaces;
			note('drop-3d-surface', target, 'unreadable surfaces removed');
		} else
			for (const k of ['face', 'side', 'back'] as const) {
				if (g.surfaces[k] === undefined) continue;
				const s = repairSurface(g.surfaces[k]);
				if (s === null) {
					delete g.surfaces[k];
					note('drop-3d-surface', target, `unreadable ${k} surface removed`);
				} else if (s !== g.surfaces[k]) {
					g.surfaces[k] = s;
					note('repair-3d-surface', target, `unreadable ${k} surface values reset`);
				}
			}
	}
	if (g.bands !== undefined) {
		const list = Array.isArray(g.bands) ? g.bands : [];
		const seen = new Set<string>();
		const kept: unknown[] = [];
		for (const b of list) {
			const r = isObj(b) ? { ...b, ...(b.material === undefined ? {} : { material: repairSurface(b.material) }) } : b;
			if (isObj(r) && r.material === null) delete r.material;
			const ok = BandSchema.safeParse(r);
			if (!ok.success || seen.has(ok.data.id) || kept.length >= MAX_BEVEL_BANDS) continue;
			seen.add(ok.data.id);
			kept.push(r);
		}
		if (!Array.isArray(g.bands) || kept.length !== g.bands.length) {
			note('drop-3d-band', target, `${list.length - kept.length} unreadable or excess bevel bands removed`);
			g.bands = kept;
		} else if (kept.some((b, i) => JSON.stringify(b) !== JSON.stringify((g.bands as unknown[])[i]))) {
			note('repair-3d-surface', target, 'unreadable band surface repaired');
			g.bands = kept;
		}
	}
	if (g.inflate !== undefined && !InflateSchema.safeParse(g.inflate).success) {
		delete g.inflate;
		if (g.mode === 'inflate') delete g.mode;
		note('drop-3d-inflate', target, 'unreadable inflate options removed: back to extrusion');
	}
	if (g.backplates !== undefined) {
		const list = Array.isArray(g.backplates) ? g.backplates : [];
		const seen = new Set<string>();
		const kept: unknown[] = [];
		for (const p of list) {
			if (!isObj(p)) continue;
			const r: Record<string, unknown> = { ...p };
			for (const k of ['face', 'side'] as const) {
				if (r[k] === undefined) continue;
				const s = repairSurface(r[k]);
				if (s === null) delete r[k];
				else r[k] = s;
			}
			const ok = BackplateSchema.safeParse(r);
			if (!ok.success || seen.has(ok.data.id) || kept.length >= MAX_BACKPLATES) continue;
			seen.add(ok.data.id);
			kept.push(r);
		}
		if (!Array.isArray(g.backplates) || kept.length !== g.backplates.length) {
			note('drop-3d-plate', target, `${list.length - kept.length} unreadable or excess backplates removed`);
			g.backplates = kept;
		} else if (kept.some((b, i) => JSON.stringify(b) !== JSON.stringify((g.backplates as unknown[])[i]))) {
			note('repair-3d-surface', target, 'unreadable plate surface repaired');
			g.backplates = kept;
		}
	}
}

/** `repairThreeD` over a document that has not been validated yet (it runs before anything walks it). */
export function sanitizeThreeD(doc: unknown, note: Note): void {
	if (!isObj(doc) || !isObj(doc.sequences)) return;
	for (const seq of Object.values(doc.sequences)) {
		if (!isObj(seq) || !isObj(seq.clips)) continue;
		for (const [id, c] of Object.entries(seq.clips))
			if (isObj(c) && isObj(c.threeD) && threeDProblem(c.threeD)) repairThreeD(c.threeD, id, note);
	}
}

/** Numeric ranges every surface field is clamped to at evaluation, by key. */
export const SURFACE_RANGES = Object.fromEntries(SURFACE_NUMBERS.map((s) => [s.key, { min: s.min, max: s.max }]));
