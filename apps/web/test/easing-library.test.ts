import { type EaseCurve, EasePresetSchema } from '@jasper/project';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	addGroup,
	DEFAULT_GROUP_ID,
	deleteGroup,
	deletePreset,
	duplicatePreset,
	EASE_LIBRARY_VERSION,
	type EaseLibraryState,
	easeLibrary,
	emptyLibrary,
	exportLibrary,
	importLibrary,
	MAX_IMPORT_BYTES,
	movePresetToGroup,
	parseLibrary,
	pushRecent,
	renameGroup,
	renamePreset,
	reorderPreset,
	savePreset,
	setPresetColor,
	toggleFavourite,
} from '../src/panels/easing/library.ts';

/** A user preset without its colour label is a valid `EasePreset`. */
const isPreset = ({ color: _color, ...p }: { color?: unknown }) => EasePresetSchema.safeParse(p).success;

const curve: EaseCurve = { kind: 'cubic', x1: 0.3, y1: 0, x2: 0.6, y2: 1 };
const other: EaseCurve = { kind: 'cubic', x1: 0.1, y1: 0.9, x2: 0.2, y2: 1 };

function ok(r: ReturnType<typeof savePreset>): EaseLibraryState & { lastId: string } {
	if (!r.ok) throw new Error(r.error);
	return { ...r.state, lastId: r.id ?? '' };
}

beforeEach(() => {
	globalThis.localStorage?.clear();
	easeLibrary.reload();
});

describe('user library operations', () => {
	it('save, rename, colour, favourite, delete', () => {
		let s = ok(savePreset(emptyLibrary(), { name: 'Soft', curve }));
		const id = s.lastId;
		expect(s.presets[0]).toMatchObject({ id, name: 'Soft', group: DEFAULT_GROUP_ID, curve });
		s = ok(renamePreset(s, id, '  Softer  '));
		expect(s.presets[0]!.name).toBe('Softer');
		expect(renamePreset(s, id, '   ').ok).toBe(false);
		expect(renamePreset(s, 'nope', 'x').ok).toBe(false);
		s = ok(setPresetColor(s, id, 'rose'));
		expect(s.presets[0]!.color).toBe('rose');
		s = { ...toggleFavourite(s, id), lastId: id };
		expect(s.favourites).toEqual([id]);
		s = ok(deletePreset(s, id));
		expect(s.presets).toEqual([]);
		expect(s.favourites).toEqual([]);
	});

	it('refuses an invalid curve', () => {
		const r = savePreset(emptyLibrary(), {
			name: 'Bad',
			curve: { kind: 'cubic', x1: 2, y1: 0, x2: 0.5, y2: 1 },
		});
		expect(r.ok).toBe(false);
	});

	it('groups: add, rename, move to, delete (curves go to the default group)', () => {
		let s = ok(addGroup(emptyLibrary(), 'Bouncy'));
		const g = s.lastId;
		s = ok(savePreset(s, { name: 'A', curve, group: g }));
		const a = s.lastId;
		expect(s.presets[0]!.group).toBe(g);
		s = ok(renameGroup(s, g, 'Springy'));
		expect(s.groups.find((x) => x.id === g)!.name).toBe('Springy');
		s = ok(movePresetToGroup(s, a, DEFAULT_GROUP_ID));
		s = ok(movePresetToGroup(s, a, g));
		expect(movePresetToGroup(s, a, 'missing').ok).toBe(false);
		s = ok(deleteGroup(s, g));
		expect(s.groups.map((x) => x.id)).toEqual([DEFAULT_GROUP_ID]);
		expect(s.presets[0]!.group).toBe(DEFAULT_GROUP_ID);
		expect(deleteGroup(s, DEFAULT_GROUP_ID).ok).toBe(false);
	});

	it('reorders within a group only', () => {
		let s: ReturnType<typeof ok> = { ...emptyLibrary(), lastId: '' };
		const ids: string[] = [];
		for (const n of ['A', 'B', 'C']) {
			s = ok(savePreset(s, { name: n, curve }));
			ids.push(s.lastId);
		}
		s = ok(addGroup(s, 'Other'));
		s = ok(savePreset(s, { name: 'X', curve, group: s.lastId }));
		s = ok(reorderPreset(s, ids[2]!, 0));
		expect(s.presets.filter((p) => p.group === DEFAULT_GROUP_ID).map((p) => p.name)).toEqual(['C', 'A', 'B']);
		s = ok(reorderPreset(s, ids[2]!, 99));
		expect(s.presets.filter((p) => p.group === DEFAULT_GROUP_ID).map((p) => p.name)).toEqual(['A', 'B', 'C']);
		expect(s.presets.at(-1)!.name).toBe('X');
	});

	it('duplicates a built-in into a user group', () => {
		const s = ok(duplicatePreset(emptyLibrary(), { id: 'b1', name: 'Gentle', group: 'basic', curve }));
		expect(s.presets[0]).toMatchObject({ name: 'Gentle copy', group: DEFAULT_GROUP_ID, curve });
	});

	it('remembers recent curves newest first without duplicates', () => {
		let s = pushRecent(emptyLibrary(), curve);
		s = pushRecent(s, other);
		s = pushRecent(s, curve);
		expect(s.recent).toEqual([curve, other]);
		for (let i = 0; i < 20; i++) s = pushRecent(s, { kind: 'cubic', x1: i / 20, y1: 0, x2: 1, y2: 1 });
		expect(s.recent.length).toBeLessThanOrEqual(8);
	});
});

describe('persistence', () => {
	it('stores the library and settings and reads them back', () => {
		expect(easeLibrary.run((s) => savePreset(s, { name: 'Kept', curve }))).toBeNull();
		easeLibrary.settings({ autoApply: true, sections: ['in', 'out'], thumb: 96, columns: 3, curve: other });
		easeLibrary.reload();
		const s = easeLibrary.get();
		expect(s.presets.map((p) => p.name)).toEqual(['Kept']);
		expect(s.settings).toMatchObject({
			autoApply: true,
			sections: ['in', 'out'],
			thumb: 96,
			columns: 3,
			curve: other,
		});
	});

	it('drops damaged entries one by one and keeps the rest', () => {
		const good = { id: 'g1', name: 'Good', group: DEFAULT_GROUP_ID, curve };
		const raw = {
			version: 1,
			groups: [{ id: 'x' }, { id: 'grp', name: 'Mine' }],
			presets: [good, { id: 'b', name: 'Bad', group: 'user', curve: { kind: 'cubic' } }, { ...good }],
			favourites: ['g1', 7],
			recent: [curve, 'nope'],
			settings: { view: 'sideways', thumb: 80, autoApply: 'yes' },
		};
		const { state, dropped } = parseLibrary(raw);
		expect(state.presets.map((p) => p.id)).toEqual(['g1']);
		expect(state.groups.map((g) => g.id)).toEqual([DEFAULT_GROUP_ID, 'grp']);
		expect(state.favourites).toEqual(['g1']);
		expect(state.recent).toEqual([curve]);
		expect(state.settings.view).toBe('both');
		expect(state.settings.thumb).toBe(80);
		expect(dropped).toBe(7);
	});

	it('does not read or overwrite a library written by a newer version', () => {
		const newer = { version: EASE_LIBRARY_VERSION + 1, presets: [{ anything: true }] };
		globalThis.localStorage.setItem('jasper.easing.v1', JSON.stringify(newer));
		easeLibrary.reload();
		expect(easeLibrary.loadReport().newer).toBe(true);
		expect(easeLibrary.get().presets).toEqual([]);
		easeLibrary.settings({ thumb: 100 });
		expect(JSON.parse(globalThis.localStorage.getItem('jasper.easing.v1')!)).toEqual(newer);
	});

	it('never throws on arbitrary stored values (fuzz)', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (raw) => {
				const { state } = parseLibrary(raw);
				for (const p of state.presets) expect(isPreset(p)).toBe(true);
				expect(state.groups.some((g) => g.id === DEFAULT_GROUP_ID)).toBe(true);
			}),
		);
	});
});

describe('export / import', () => {
	it('round-trips a group with new ids on clashes', () => {
		let s = ok(addGroup(emptyLibrary(), 'Mine'));
		const g = s.lastId;
		s = ok(savePreset(s, { name: 'One', curve, group: g }));
		s = ok(setPresetColor(s, s.lastId, 'teal'));
		s = ok(savePreset(s, { name: 'Two', curve: other }));
		const json = exportLibrary(s, [s.presets[0]!.id]);
		const parsed = JSON.parse(json);
		expect(parsed.format).toBe('jasper-ease-presets');
		expect(parsed.presets).toHaveLength(1);
		const { state, report } = importLibrary(s, json);
		expect(report).toEqual({ added: 1, skipped: 0, errors: [] });
		expect(state.presets).toHaveLength(3);
		const imported = state.presets[2]!;
		expect(imported.id).not.toBe(s.presets[0]!.id);
		expect(imported).toMatchObject({ name: 'One', group: g, color: 'teal' });
		// Into an empty library the group is created.
		const fresh = importLibrary(emptyLibrary(), json).state;
		expect(fresh.groups.map((x) => x.name)).toEqual(['My Curves', 'Mine']);
	});

	it.each([
		['not json', 'not valid JSON'],
		['[]', 'not an ease preset file'],
		[JSON.stringify({ format: 'something-else', presets: [] }), 'not an ease preset file'],
		[JSON.stringify({ format: 'jasper-ease-presets', version: 99, presets: [] }), 'newer version'],
		[JSON.stringify({ format: 'jasper-ease-presets', version: 1 }), 'no presets list'],
	])('refuses %s', (text, msg) => {
		const { state, report } = importLibrary(emptyLibrary(), text);
		expect(state.presets).toEqual([]);
		expect(report.errors.join(' ')).toContain(msg);
	});

	it('skips invalid presets with a reason and keeps the valid ones', () => {
		const text = JSON.stringify({
			format: 'jasper-ease-presets',
			version: 1,
			presets: [
				{ id: 'a', name: 'A', group: 'user', curve },
				{ id: 'b', name: '', group: 'user', curve },
				{ id: 'c', name: 'C', group: 'user', curve: { kind: 'multi', points: [] } },
			],
		});
		const { state, report } = importLibrary(emptyLibrary(), text);
		expect(state.presets.map((p) => p.name)).toEqual(['A']);
		expect(report.added).toBe(1);
		expect(report.skipped).toBe(2);
		expect(report.errors[0]).toMatch(/^Preset 2: name/);
		expect(report.errors[1]).toMatch(/^Preset 3: curve/);
	});

	it('caps the file size', () => {
		const { report } = importLibrary(emptyLibrary(), ' '.repeat(MAX_IMPORT_BYTES + 1));
		expect(report.errors[0]).toMatch(/larger than/);
	});

	it('never throws and only adds schema-valid presets (fuzz)', () => {
		const presetish = fc.record(
			{
				id: fc.oneof(fc.string(), fc.constant('a')),
				name: fc.string(),
				group: fc.oneof(fc.constant('user'), fc.string()),
				curve: fc.oneof(
					fc.record({
						kind: fc.constant('cubic'),
						x1: fc.double(),
						y1: fc.double(),
						x2: fc.double(),
						y2: fc.double(),
					}),
					fc.jsonValue(),
				),
				color: fc.oneof(fc.constant('rose'), fc.string(), fc.constant(null)),
			},
			{ requiredKeys: [] },
		);
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string(),
					fc.jsonValue().map((v) => JSON.stringify(v)),
					fc
						.record({ groups: fc.array(fc.jsonValue()), presets: fc.array(presetish, { maxLength: 8 }) })
						.map((o) => JSON.stringify({ format: 'jasper-ease-presets', version: 1, ...o })),
				),
				(text) => {
					const { state, report } = importLibrary(emptyLibrary(), text);
					expect(state.presets).toHaveLength(report.added);
					expect(report.errors.length).toBeLessThanOrEqual(5);
					for (const p of state.presets) expect(isPreset(p)).toBe(true);
					expect(new Set(state.presets.map((p) => p.id)).size).toBe(state.presets.length);
				},
			),
			{ numRuns: 300 },
		);
	});
});
