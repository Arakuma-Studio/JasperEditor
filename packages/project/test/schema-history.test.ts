// Fixtures pin every shipped migration’s output. Add a new step and fixture for schema changes;
// never change a shipped migration to satisfy these expectations (docs/project-files.md).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CURRENT_SCHEMA_VERSION,
	checkInvariants,
	defaultEffectRegistry,
	loadProject,
	MIGRATIONS,
	migrate,
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
};

describe('schema history fixtures (S01:MIG-002)', () => {
	it('has one fixture per schema version, 1 … CURRENT_SCHEMA_VERSION', () => {
		for (const v of VERSIONS) {
			expect(existsSync(fixturePath(v)), `fixtures/schema-v${v}.jasper (add it with the schema bump)`).toBe(
				true,
			);
			expect(fixture(v).schemaVersion).toBe(v);
			expect(doc(v).schemaVersion).toBe(v);
		}
	});

	it('has one contiguous migration step per version, each pinned below', () => {
		expect(MIGRATIONS.map((m) => [m.from, m.to])).toEqual(VERSIONS.slice(0, -1).map((v) => [v, v + 1]));
		expect(Object.keys(STEP_CHANGES)).toEqual(MIGRATIONS.map((m) => `${m.from}→${m.to}`));
	});

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

	it('the older fixtures are the newer ones before their additions (the history is consistent)', () => {
		// v1 migrated is v2; v4 migrated carries the source range v5 records.
		const m1 = migrate(fixture(1)).document as unknown as Rec;
		const m2 = migrate(fixture(2)).document as unknown as Rec;
		expect(diff(m1, { ...m2, projectId: m1.projectId, name: m1.name })).toEqual({});
		const m4 = migrate(fixture(4)).document as unknown as { media: Rec };
		const m5 = migrate(fixture(5)).document as unknown as { media: Rec };
		expect(m4.media.med_00000000000PR0C1).toEqual(m5.media.med_00000000000PR0C1);
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
		env.schemaVersion = future;
		const r = loadProject(env, { effects: defaultEffectRegistry });
		expect(r.readOnly).toBe(true);
		expect(r.migration).toEqual({ fromVersion: future, toVersion: future, steps: [] });
	});
});
