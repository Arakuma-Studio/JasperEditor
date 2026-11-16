// Fixtures pin every shipped migration’s output. Add a new step and fixture for schema changes;
// never change a shipped migration to satisfy these expectations (docs/project-files.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CURRENT_SCHEMA_VERSION,
	checkInvariants,
	defaultEffectRegistry,
	loadProject,
	MIGRATIONS,
	makeEnvelope,
} from '../src/index.ts';

type Rec = Record<string, unknown>;
const fixturePath = (v: number | string) => join(__dirname, 'fixtures', `schema-v${v}.jasper`);
const fixture = (v: number | string): Rec => JSON.parse(readFileSync(fixturePath(v), 'utf8'));
const doc = (v: number) => fixture(v).document as Rec;
const VERSIONS = Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, i) => i + 1);

/** Leaf paths that differ between two JSON values, with the new value (`undefined` = removed). */
function diff(a: unknown, b: unknown, path = ''): Record<string, unknown> {
	if (JSON.stringify(a) === JSON.stringify(b)) return {};
	const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
	if (!isObj(a) || !isObj(b)) return { [path]: b };
	const out: Record<string, unknown> = {};
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
		Object.assign(out, diff(a[k], b[k], path ? `${path}.${k}` : k));
	return out;
}

/** What each shipped step changes in the fixture of its `from` version (beyond `schemaVersion`). Never edit an entry. */
const STEP_CHANGES: Record<string, (from: Rec) => Record<string, unknown>> = {
	// v1 → v2: the audio half of a linked A/V clip with the v1 default (Movie, violet) takes the Audio label;
	// the user-chosen "rose" label of the other audio clip and every video clip are kept.
	'1→2': () => ({ 'sequences.seq_000000000000SEQ1.clips.clp_00000000000AC001.label': 'caribbean' }),
	// v2 → v3 and v3 → v4: version bumps only; older builds open the files read-only.
	'2→3': () => ({}),
	'3→4': () => ({}),
	// v4 → v5: a processed version made from the whole source gets the explicit source range it holds.
	'4→5': () => ({
		'media.med_00000000000PR0C1.sourceRange': {
			mediaId: 'med_00000000000V1DE0',
			sourceName: 'interview.mov',
			firstFrame: 0,
			frames: 300,
			frameRate: { num: 30, den: 1 },
			origin: 'process',
		},
	}),
	// v5 → v6: version bump only; v5 builds open the files read-only.
	'5→6': () => ({}),
	// v6 → v7 (sound design): version bump only; v6 builds open the files read-only.
	'6→7': () => ({}),
	// v7 → v8 (Premiere port): Crop effects listed after other effects move to the front (as v7 rendered them);
	// the v7 fixture lists none, so its document is unchanged (migration-v8-crop.test.ts covers the reorder).
	'7→8': () => ({}),
	// v8 → v9 (social comments: template media params): version bump only; v8 builds open the files read-only.
	'8→9': () => ({}),
	// v9 → v10 (workflow automation): version bump only; v9 builds open the files read-only.
	'9→10': () => ({}),
	// v10 → v11 (agent footage editing: sequence brief, agent notes): version bump only; v10 builds open the files
	// read-only.
	'10→11': () => ({}),
	// v11 → v12 (Title Looks, spec 19, with `EffectInstance.patternOrigin`, TL-121): version bump only; v11 builds open
	// the files read-only.
	'11→12': () => ({}),
	// v12 → v13 (introduced on two parallel lines, so a v13 file may hold either: subtitle locks and own-subtitle
	// words, or HTML composition pages `mgBundle.html` / source type `html-page`): version bump only; v12 builds open
	// the files read-only.
	'12→13': () => ({}),
	// v13 → v14 (punch-ins `start: 'caption'` in style recipes): version bump only; v13 builds open the files read-only.
	'13→14': () => ({}),
	// v14 → v15 (HTML composition pages on the v14 line): version bump only; v14 builds open the files read-only.
	'14→15': () => ({}),
	// v15 → v16 (Corner Pin motion blur: shutter params on `jasper.corner-pin`): version bump only; v15 builds open the
	// files read-only.
	'15→16': () => ({}),
};

describe('schema history fixtures (S01:MIG-002)', () => {
	for (const v of VERSIONS)
		it(`schema v${v} loads, migrates to v${CURRENT_SCHEMA_VERSION} and passes the invariants without repairs`, () => {
			const r = loadProject(fixture(v), { effects: defaultEffectRegistry });
			expect(r.readOnly).toBe(false);
			expect(r.migration.fromVersion).toBe(v);
			expect(r.migration.toVersion).toBe(CURRENT_SCHEMA_VERSION);
			expect(r.migration.steps).toEqual(VERSIONS.slice(v - 1, -1).map((from) => `v${from}→v${from + 1}`));
			expect(r.repairs).toEqual([]);
			expect(r.issues).toEqual([]);
			expect(checkInvariants(r.document, { effects: defaultEffectRegistry })).toEqual([]);
			expect(r.document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
			expect(r.document.name).toBe(`Schema v${v} fixture`);
		});

	for (const step of MIGRATIONS)
		it(`step v${step.from}→v${step.to} makes exactly its documented changes (never edit a shipped migration)`, () => {
			const before = doc(step.from);
			const after = step.migrate(structuredClone(before));
			const { schemaVersion: _a, ...b } = before;
			const { schemaVersion: _b, ...c } = after;
			expect(diff(b, c)).toEqual(STEP_CHANGES[`${step.from}→${step.to}`]!(before));
		});

	it('a bare document without an envelope or schemaVersion is read as v1', () => {
		const { schemaVersion: _, ...bare } = doc(1);
		const r = loadProject(bare, { effects: defaultEffectRegistry });
		expect(r.migration.fromVersion).toBe(1);
		expect(r.repairs).toEqual([]);
	});

	it('a newer schema opens read-only and is never migrated down (S01:MIG-003)', () => {
		const env = fixture(CURRENT_SCHEMA_VERSION);
		const future = CURRENT_SCHEMA_VERSION + 1;
		(env.document as Rec).schemaVersion = future;
		(env.document as Rec).futureField = { a: 1 };
		env.schemaVersion = future;
		const r = loadProject(env, { effects: defaultEffectRegistry });
		expect(r.readOnly).toBe(true);
		expect(r.migration).toEqual({ fromVersion: future, toVersion: future, steps: [] });
		expect((r.document as unknown as Rec).futureField).toEqual({ a: 1 });
	});

	// v13 was introduced on two parallel lines (subtitle locks; HTML composition pages), and v15 brings HTML pages to
	// the v14 line. Both v13 variants must load, and a file this build saves must carry both features.
	const HTML_MEDIA = 'med_0000000000HTML01';
	const SUBTITLE = 'clp_00000000000SUB01';
	const features = (d: Rec) => {
		const media = (d.media as Rec)[HTML_MEDIA] as Rec | undefined;
		const seq = (d.sequences as Rec).seq_000000000000SEQ1 as Rec;
		const clip = (seq.clips as Rec)[SUBTITLE] as Rec | undefined;
		const group = (seq.captionGroups as Rec | undefined)?.cgp_000000000000SUBG as Rec | undefined;
		const recipes = (d.styleRecipes as Rec | undefined)?.recipes as Rec | undefined;
		const punchIns = (recipes?.rcp_0000000000000P14 as Rec | undefined)?.passes as Rec | undefined;
		return {
			html: (media?.mgBundle as Rec | undefined)?.html,
			sourceType: ((media?.mgBundle as Rec | undefined)?.source as Rec | undefined)?.type,
			locked: (clip?.caption as Rec | undefined)?.locked,
			ownWords: (group?.rules as Rec | undefined)?.ownWords,
			punchInStart: ((punchIns?.['punch-ins'] as Rec | undefined)?.params as Rec | undefined)?.start,
		};
	};

	it('the v13 fixture with an HTML composition page (the other v13 line) migrates without repairs', () => {
		const r = loadProject(fixture('13-html'), { effects: defaultEffectRegistry });
		expect(r.readOnly).toBe(false);
		expect(r.migration.steps).toEqual(['v13→v14', 'v14→v15', 'v15→v16']);
		expect(r.repairs).toEqual([]);
		expect(r.issues).toEqual([]);
		expect(features(r.document as unknown as Rec)).toMatchObject({
			html: { entry: 'pano.html', query: 's=2' },
			sourceType: 'html-page',
		});
	});

	it('a project with HTML pages and subtitle locks is saved at a version v14 builds open read-only', () => {
		const r = loadProject(fixture(15), { effects: defaultEffectRegistry });
		const saved = JSON.parse(
			JSON.stringify(
				makeEnvelope(r.document, { revision: 3, savedAt: '2026-11-15T13:00:00.000Z', platform: 'web' }),
			),
		);
		expect(saved.schemaVersion).toBeGreaterThan(14);
		const again = loadProject(saved, { effects: defaultEffectRegistry });
		expect(again.repairs).toEqual([]);
		expect(features(again.document as unknown as Rec)).toEqual({
			html: { entry: 'pano.html', query: 's=2' },
			sourceType: 'html-page',
			locked: true,
			ownWords: ['boing'],
			punchInStart: 'caption',
		});
	});

	it("a Corner Pin's shutter params load from v15-shaped data unchanged and survive a v16 save and reload", () => {
		const SHAPE = 'clp_00000000000SH001';
		const pin = (d: Rec) => {
			const clip = ((d.sequences as Rec).seq_000000000000SEQ1 as Rec).clips as Rec;
			const fx = ((clip[SHAPE] as Rec).effects as Rec[]).find((e) => e.effectId === 'jasper.corner-pin');
			const p = fx?.params as Record<string, { value: unknown }> | undefined;
			return p && [p.useCompShutterAngle?.value, p.shutterAngle?.value, p.mbQuality?.value];
		};
		// v15 files hold no corner pin with shutter params: they load without repairs and draw unblurred.
		const old = loadProject(fixture(15), { effects: defaultEffectRegistry });
		expect(old.repairs).toEqual([]);
		expect(pin(old.document as unknown as Rec)).toBeUndefined();
		const r = loadProject(fixture(16), { effects: defaultEffectRegistry });
		expect(r.repairs).toEqual([]);
		expect(pin(r.document as unknown as Rec)).toEqual([false, 180, 'high']);
		const saved = JSON.parse(
			JSON.stringify(
				makeEnvelope(r.document, { revision: 3, savedAt: '2026-11-16T13:00:00.000Z', platform: 'web' }),
			),
		);
		expect(saved.schemaVersion).toBeGreaterThan(15);
		const again = loadProject(saved, { effects: defaultEffectRegistry });
		expect(again.repairs).toEqual([]);
		expect(pin(again.document as unknown as Rec)).toEqual([false, 180, 'high']);
	});
});
