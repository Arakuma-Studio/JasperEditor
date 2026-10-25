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
} from '../src/index.ts';

type Rec = Record<string, unknown>;
const fixturePath = (v: number) => join(__dirname, 'fixtures', `schema-v${v}.jasper`);
const fixture = (v: number): Rec => JSON.parse(readFileSync(fixturePath(v), 'utf8'));
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
});
