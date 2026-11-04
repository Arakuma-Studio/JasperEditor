// Spec 19 §14: property tests of Title Looks: loader fuzz, repair idempotence, appearance diff and apply, paint parsing
// and the planner on arbitrary looks.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Appearance,
	activeParamSpecs,
	appearanceFromRecipe,
	appearanceProblem,
	buildTextSpans,
	checkInvariants,
	createCounterIdSource,
	defaultEffectRegistry,
	diffAppearance,
	type EffectInstance,
	type FxPlanContext,
	type FxTextSpans,
	GradientSchema,
	gradientRamp,
	type LookRecipe,
	LookRecipeSchema,
	loadProject,
	lookBodyOf,
	lookReach,
	MAX_APPEARANCE_LAYERS,
	type Paint,
	planGpuEffect,
	planTitleLook,
	type Role,
	rebaseAppearance,
	repairAppearance,
	repairDocument,
	resolveAppearance,
	staticAnim,
	TITLE_FINISHES,
	TITLE_LAYER_TYPES,
	TITLE_LOOK_EFFECT,
	titleLookPadding,
	titleLookProblem,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const RUNS = Number(process.env.JASPER_FUZZ_RUNS ?? 150);

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const color = fc.tuple(unit, unit, unit, unit);
const role = fc.constantFrom<Role>(
	'face',
	'faceAlt',
	'keyline',
	'accent1',
	'accent2',
	'accent3',
	'base',
	'glow',
	'shadow',
);
const stop = fc.record({
	at: unit,
	paint: fc.oneof(fc.record({ role }), fc.record({ color })),
});
const gradient = fc.record({
	type: fc.constantFrom('linear', 'radial', 'sweep', 'shape'),
	span: fc.constantFrom('block', 'line', 'glyph'),
	angle: fc.double({ min: -360, max: 360, noNaN: true }),
	stops: fc.array(stop, { minLength: 2, maxLength: 32 }),
});
const paint: fc.Arbitrary<Paint> = fc.oneof(
	fc.record({ kind: fc.constant('role' as const), role }),
	fc.record({ kind: fc.constant('color' as const), color }),
	fc.record({ kind: fc.constant('gradient' as const), gradient }) as fc.Arbitrary<Paint>,
	fc.constant({ kind: 'source' as const }),
);

/** A valid value for a param of a layer type. */
function arbitraryValue(p: (typeof TITLE_LAYER_TYPES)[number]['params'][number]): fc.Arbitrary<unknown> {
	if (p.type === 'paint') return paint;
	if (p.type === 'number') {
		const min = p.range?.min ?? -3600;
		const max = Math.min(p.range?.max ?? 3600, 400);
		return fc.double({ min, max: Math.max(min, max), noNaN: true });
	}
	if (p.type === 'boolean') return fc.boolean();
	if (p.type === 'enum') return fc.constantFrom(...(p.options ?? ['']));
	// A picture of a look (a reflection's environment, a pattern's tile): bound or None.
	if (p.type === 'media') return fc.constantFrom(null, { mediaId: 'med_look_picture' });
	return fc.constant(p.default);
}

const layer = fc.constantFrom(...TITLE_LAYER_TYPES).chain((t) =>
	fc.record({
		type: fc.constant(t.type),
		params: fc.record(Object.fromEntries(t.params.map((p) => [p.name, arbitraryValue(p)])), {
			requiredKeys: [],
		}),
		enabled: fc.boolean(),
	}),
);
/** A layer with a finish and that finish's params, pictures included (`activeParamSpecs`). */
const finishedLayer = fc
	.tuple(fc.constantFrom(...TITLE_LAYER_TYPES), fc.constantFrom(...TITLE_FINISHES.map((f) => f.id)))
	.chain(([t, finish]) =>
		fc.record({
			type: fc.constant(t.type),
			params: fc
				.record(
					Object.fromEntries(
						activeParamSpecs(t, finish)
							.filter((p) => p.name !== 'finish')
							.map((p) => [p.name, arbitraryValue(p)]),
					),
					{ requiredKeys: [] },
				)
				.map((params) => (t.finish ? { ...params, finish } : params)),
			enabled: fc.boolean(),
		}),
	);

/** A text layer's glyphs (TL-036) with the finishes its runs give letters (TL-093), some unknown, some moved in 3D. */
const textSpans: fc.Arbitrary<FxTextSpans | null> = fc
	.array(
		fc.record(
			{
				box: fc
					.tuple(
						fc.double({ min: -50, max: 1200, noNaN: true }),
						fc.double({ min: -50, max: 600, noNaN: true }),
						fc.double({ min: 0, max: 300, noNaN: true }),
						fc.double({ min: 0, max: 200, noNaN: true }),
					)
					.map(([x, y, w, h]) => [x, y, x + w, y + h] as [number, number, number, number]),
				line: fc.nat(3),
				toDrawn: fc.array(fc.double({ min: -4, max: 4, noNaN: true }), { minLength: 9, maxLength: 9 }),
				finish: fc.constantFrom(...TITLE_FINISHES.map((f) => f.id), 'not-a-finish', ''),
			},
			{ requiredKeys: ['box', 'line'] },
		),
		{ maxLength: 40 },
	)
	.map((glyphs) => buildTextSpans(glyphs));

const recipe: fc.Arbitrary<LookRecipe> = fc.record({
	palette: fc.dictionary(role, color, { maxKeys: 9 }),
	layers: fc.array(layer, { maxLength: MAX_APPEARANCE_LAYERS }),
}) as fc.Arbitrary<LookRecipe>;

const fresh = () => {
	let n = 0;
	return () => `apl_${(++n).toString(36).toUpperCase().padStart(16, '0')}`;
};
const appearance = recipe.map((r) => appearanceFromRecipe(r, fresh(), 5));

/** Arbitrary damage to a JSON value at random paths. */
const damage = (a: Appearance) =>
	fc
		.tuple(
			fc.array(fc.nat(10_000), { minLength: 1, maxLength: 5 }),
			fc.array(fc.jsonValue(), { minLength: 5, maxLength: 5 }),
		)
		.map(([spots, junk]) => {
			const root = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
			const nodes: [Record<string, unknown>, string][] = [];
			const walk = (o: unknown) => {
				if (!o || typeof o !== 'object') return;
				for (const k of Object.keys(o)) {
					nodes.push([o as Record<string, unknown>, k]);
					walk((o as Record<string, unknown>)[k]);
				}
			};
			walk(root);
			spots.forEach((s, i) => {
				const [o, k] = nodes[s % nodes.length]!;
				o[k] = junk[i];
			});
			return root;
		});

const quiet = () => {};

describe('repairAppearance', () => {
	it('any JSON: never throws; the result is null or passes INV-APPEARANCE', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (v) => {
				const r = repairAppearance(v, fresh(), 'x', quiet);
				if (r) expect(appearanceProblem(r)).toBeNull();
			}),
			{ numRuns: RUNS },
		);
	});

	it('a damaged valid appearance: readable, and a second repair changes nothing (idempotent)', () => {
		fc.assert(
			fc.property(appearance.chain(damage), (d) => {
				const once = repairAppearance(d, fresh(), 'x', quiet);
				if (!once) return;
				expect(appearanceProblem(once)).toBeNull();
				const notes: string[] = [];
				const twice = repairAppearance(once, fresh(), 'x', (_a, _b, m) => notes.push(m));
				expect(notes).toEqual([]);
				expect(twice).toEqual(once);
			}),
			{ numRuns: RUNS },
		);
	});

	it('a valid appearance is left exactly as it is', () => {
		fc.assert(
			fc.property(appearance, (a) => {
				const notes: string[] = [];
				expect(repairAppearance(a, fresh(), 'x', (_a, _b, m) => notes.push(m))).toEqual(a);
				expect(notes).toEqual([]);
			}),
			{ numRuns: RUNS },
		);
	});
});

describe('the loader', () => {
	const base = () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'T' }, ref: '$t' },
			{
				type: 'look.apply',
				clipIds: ['$t'],
				look: { name: 'L', recipe: { layers: [{ type: 'rim' }, { type: 'face' }] } },
			},
		]);
		return { doc: JSON.parse(JSON.stringify(h.doc)), t: r.refs.$t! };
	};

	it('opens a project with any damaged look, and what it repairs passes the invariants', () => {
		const { doc, t } = base();
		fc.assert(
			fc.property(fc.oneof(fc.jsonValue(), appearance.chain(damage)), (junk) => {
				const d = JSON.parse(JSON.stringify(doc));
				const seq = Object.values(d.sequences)[0] as { clips: Record<string, { effects: EffectInstance[] }> };
				seq.clips[t]!.effects[0]!.appearance = junk as never;
				const r = loadProject({ format: 'jasper-project', document: d }, { effects: defaultEffectRegistry });
				expect(r.issues).toEqual([]);
			}),
			{ numRuns: RUNS },
		);
	});

	it('opens a project with any damaged look record', () => {
		const { doc } = base();
		fc.assert(
			fc.property(fc.jsonValue(), (junk) => {
				const d = JSON.parse(JSON.stringify(doc));
				const key = Object.keys(d.titleLooks)[0]!;
				d.titleLooks[key] = junk;
				const r = repairDocument(d, createCounterIdSource(77));
				expect(checkInvariants(r.document, { effects: defaultEffectRegistry })).toEqual([]);
				expect(repairDocument(r.document, createCounterIdSource(88)).report).toEqual([]);
			}),
			{ numRuns: RUNS },
		);
	});
});

describe('appearance diff and apply (TL-016)', () => {
	const edit = fc.record({
		i: fc.nat(1000),
		width: fc.double({ min: 0, max: 100, noNaN: true }),
		enabled: fc.boolean(),
		drop: fc.boolean(),
		face: color,
	});
	const edited = (
		base: Appearance,
		e: { i: number; width: number; enabled: boolean; drop: boolean; face: never },
	) => {
		const a = JSON.parse(JSON.stringify(base)) as Appearance;
		a.seed = 99;
		a.palette.face = staticAnim(e.face);
		if (a.layers.length) {
			const l = a.layers[e.i % a.layers.length]!;
			l.enabled = e.enabled;
			if (l.params.width) l.params.width.value = e.width;
			if (e.drop) a.layers.splice((e.i + 1) % a.layers.length, 1);
		}
		return a;
	};

	it("with an unchanged look, re-applying a clip's deviations gives the clip back", () => {
		fc.assert(
			fc.property(appearance, edit, (base, e) => {
				const a = edited(base, e as never);
				const out = rebaseAppearance(base, base, a);
				expect(out.layers).toEqual(a.layers);
				expect(out.palette).toEqual(a.palette);
				expect(out.seed).toBe(99);
			}),
			{ numRuns: RUNS },
		);
	});

	it('no deviations from itself, and the diff against the new look names the same params', () => {
		fc.assert(
			fc.property(appearance, edit, (base, e) => {
				expect(diffAppearance(base, base)).toEqual({});
				const a = edited(base, e as never);
				const before = diffAppearance(base, a);
				const out = rebaseAppearance(base, base, a);
				expect(diffAppearance(base, out)).toEqual(before);
			}),
			{ numRuns: RUNS },
		);
	});

	it('a look body has no keys, no link, and the values at that time', () => {
		fc.assert(
			fc.property(appearance, (a) => {
				const body = lookBodyOf({ ...a, lookId: 'tlk_0000000000000001' }, 0);
				expect(body.lookId).toBeUndefined();
				expect(appearanceProblem(body)).toBeNull();
				for (const l of body.layers) for (const p of Object.values(l.params)) expect(p.keyframes).toEqual([]);
			}),
			{ numRuns: RUNS },
		);
	});
});

describe('paints', () => {
	it('parses nothing it should not: a schema-valid gradient ramps to finite premultiplied colours', () => {
		const palette = resolveAppearance(appearanceFromRecipe({ layers: [] }, fresh()), 0).palette;
		fc.assert(
			fc.property(gradient, (g) => {
				const parsed = GradientSchema.parse(g);
				const ramp = gradientRamp(parsed, palette);
				for (let i = 0; i < ramp.length; i += 4) {
					expect(Number.isFinite(ramp[i]!)).toBe(true);
					expect(ramp[i + 3]!).toBeGreaterThanOrEqual(0);
					expect(ramp[i + 3]!).toBeLessThanOrEqual(1);
					expect(ramp[i]!).toBeLessThanOrEqual(ramp[i + 3]! + 1e-6);
				}
			}),
			{ numRuns: Math.min(RUNS, 60) },
		);
	});
});

describe('the planner on any look', () => {
	// The outputs of the framework, the finishes, plates, spans, Deep Glow and the generators (wp-notes/title-looks.md, "How to
	// extend").
	const LOOK_OUTPUTS = [
		'tlBounds',
		'tlFlood',
		'tlField',
		'tlComp',
		'tlMask',
		'tlBlurH',
		'tlBlur',
		'tlHeightRaw',
		'tlReliefH',
		'tlHeight',
		'tlCoverFlood',
		'tlCover',
		'tlPlateBlocks',
		'tlSupport',
		'tlPlate',
		'tlSpan',
		// TL-093: the letters runs give another finish, summed by their share (only reached with text spans).
		'tlRunFin',
		'tlDgPyr',
		'tlDgAcc',
		'tlDgH',
		'tlDgFar',
		'tlGenA',
		'tlGenB',
		'tlGenC',
		'tlGenD',
	];
	/** `MAX_TEXTURE_IMAGE_UNITS` every WebGL 2 implementation has. */
	const WEBGL2_MIN_TEXTURE_UNITS = 16;
	const ctx = (a: Appearance, unitPx: number | null): FxPlanContext => ({
		width: 1280,
		height: 720,
		pxScale: 1,
		fps: 30,
		structures: {
			titleLook: { appearance: resolveAppearance(a, 0), source: a, unitPx, contentSeconds: 0 },
		},
	});

	it('plans within the framework limits, with finite padding and reach', () => {
		fc.assert(
			fc.property(appearance, fc.constantFrom(96, null), (a, unit) => {
				const c = ctx(a, unit);
				const passes = planTitleLook(c);
				expect(passes.length).toBeGreaterThan(0);
				// A look's limits are not those of a validated effect (`FX_MAX_TEXTURES` outputs per plan): since the finishes,
				// plates and Deep Glow merged, one look can name more. Its outputs come from one closed set of shared names (a
				// type held twice reuses them, so its textures do not grow with its layers), and no pass declares more
				// samplers than WebGL 2 guarantees.
				const names = new Set(passes.slice(0, -1).map((p) => p.output));
				for (const name of names) expect(LOOK_OUTPUTS).toContain(name);
				for (const p of passes.slice(0, -1)) expect(p.output).toBeTruthy();
				const plan = planGpuEffect(
					TITLE_LOOK_EFFECT,
					{ id: 'fx1', params: {} },
					{ ...c, frame: 0, duration: 30, seed: 0.5, progress: 0 },
					{ width: c.width, height: c.height },
				);
				for (const p of plan.passes)
					expect(p.source.match(/^uniform\s+(?:\w+\s+)?sampler\w+\s/gm)?.length ?? 0).toBeLessThanOrEqual(
						WEBGL2_MIN_TEXTURE_UNITS,
					);
				const pad = titleLookPadding(c);
				for (const v of Object.values(pad)) {
					expect(Number.isFinite(v)).toBe(true);
					expect(v).toBeGreaterThanOrEqual(0);
				}
				const r = lookReach(resolveAppearance(a, 0));
				for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true);
			}),
			{ numRuns: RUNS },
		);
	});

	it('plans text spans, per-letter finishes and pictures within the same limits', () => {
		const finished = fc
			.record({
				palette: fc.dictionary(role, color, { maxKeys: 9 }),
				layers: fc.array(finishedLayer, { maxLength: MAX_APPEARANCE_LAYERS }),
			})
			.map((r) => appearanceFromRecipe(r as LookRecipe, fresh(), 5));
		fc.assert(
			fc.property(finished, textSpans, fc.constantFrom(96, null), (a, spans, unit) => {
				const base = ctx(a, unit);
				const c: FxPlanContext = {
					...base,
					structures: { titleLook: { ...base.structures!.titleLook!, textSpans: spans } },
				};
				const passes = planTitleLook(c);
				expect(passes.length).toBeGreaterThan(0);
				for (const name of new Set(passes.slice(0, -1).map((p) => p.output)))
					expect(LOOK_OUTPUTS).toContain(name);
				const plan = planGpuEffect(
					TITLE_LOOK_EFFECT,
					{ id: 'fx1', params: {} },
					{ ...c, frame: 0, duration: 30, seed: 0.5, progress: 0 },
					{ width: c.width, height: c.height },
				);
				for (const p of plan.passes)
					expect(p.source.match(/^uniform\s+(?:\w+\s+)?sampler\w+\s/gm)?.length ?? 0).toBeLessThanOrEqual(
						WEBGL2_MIN_TEXTURE_UNITS,
					);
				// A picture the plan binds is one an enabled layer names (no texture of another layer or of nothing), and the
				// picture's sampler is counted above with every other.
				const pictures = new Set(
					a.layers.flatMap((l) =>
						l.enabled
							? Object.values(l.params).flatMap((v) => {
									const m = (v as { value?: { mediaId?: unknown } } | undefined)?.value?.mediaId;
									return typeof m === 'string' && m ? [m] : [];
								})
							: [],
					),
				);
				for (const t of plan.textures) if (t.mediaId) expect(pictures).toContain(t.mediaId);
				for (const v of Object.values(titleLookPadding(c))) expect(Number.isFinite(v)).toBe(true);
			}),
			{ numRuns: RUNS },
		);
	});

	it('recipes parse or are refused; they never throw from the schema', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (v) => void LookRecipeSchema.safeParse(v)),
			{ numRuns: RUNS },
		);
	});

	it('a stored look record with arbitrary junk is reported, never thrown on', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (v) => void titleLookProblem('tlk_0000000000000001', v)),
			{ numRuns: RUNS },
		);
	});
});
