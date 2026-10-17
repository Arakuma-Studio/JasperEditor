// Stored workspace state v1 → v2 (S05:SH-020, spec 12 §2.7 WP3.3b): the Sound Design workspace's stored layouts
// (current and saved) gain the Review panel as a background tab next to Markers / History / Jobs, once, without
// touching anything else; custom workspaces, null (factory) layouts and layouts that already have Review stay as they
// are; corrupt, unknown and newer data are still reset.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { listPanels } from '../src/panels/registry.ts';
import type { PanelKind } from '../src/panels/types.ts';
import type { LayoutNode, WorkspaceDefinition } from '../src/shell/workspaces/definitions.ts';
import { buildLayout, instanceIdFor, panelState, sanitizeLayout } from '../src/shell/workspaces/layout.ts';
import {
	addReviewPanel,
	addSoundCheckPanel,
	migrateWorkspacesState,
	REVIEW_PANEL_STATE,
	SOUND_CHECK_PANEL_STATE,
} from '../src/shell/workspaces/migrations.ts';
import { WORKSPACES_KEY, WORKSPACES_VERSION, WorkspaceStore } from '../src/shell/workspaces/store.ts';
import { memoryStorage } from './shell-storage.ts';

const panelMap = new Map(listPanels().map((d) => [d.kind, d]));

// The Sound Design workspace as builds before WP3.3b defined it (8a0484fc…14b30952^): one left group.
const g = (group: PanelKind[], active?: PanelKind): LayoutNode => ({ group, active });
const OLD_SOUND_DESIGN: WorkspaceDefinition = {
	id: 'sound-design',
	name: 'Sound Design',
	layout: {
		split: 'row',
		children: [
			{
				size: 0.24,
				node: g(['soundLibrary', 'project', 'mediaBrowser', 'markers', 'history', 'jobs'], 'soundLibrary'),
			},
			{
				size: 'fill',
				node: {
					split: 'column',
					children: [
						{ size: 0.55, node: g(['program']) },
						{
							size: 'fill',
							node: {
								split: 'row',
								children: [
									{ size: { px: 40 }, node: g(['tools']) },
									{ size: 'fill', node: g(['timeline']) },
									{ size: { px: 52 }, node: g(['audioMeters']) },
								],
							},
						},
					],
				},
			},
			{
				size: 0.24,
				node: g(
					['essentialSound', 'properties', 'audioTrackMixer', 'audioClipMixer', 'effectControls'],
					'essentialSound',
				),
			},
		],
	},
};

const oldLayout = () => buildLayout(OLD_SOUND_DESIGN, { width: 1600, height: 900 }, panelMap, undefined, 3);

type Leaf = { type: 'leaf'; data: { views: string[]; activeView?: string; id: string } };
function leaves(layout: unknown): Leaf[] {
	const out: Leaf[] = [];
	const walk = (n: { type: string; data: unknown }) => {
		if (n.type === 'leaf') out.push(n as Leaf);
		else for (const c of n.data as never[]) walk(c);
	};
	walk((layout as { grid: { root: never } }).grid.root);
	for (const f of (layout as { floatingGroups?: Leaf[] }).floatingGroups ?? []) out.push(f);
	return out;
}
const groupOf = (layout: unknown, view: string) => leaves(layout).find((l) => l.data.views.includes(view));
const reviewCount = (layout: unknown) =>
	Object.values((layout as { panels: Record<string, { params?: { kind?: string } }> }).panels).filter(
		(p) => p.params?.kind === 'review',
	).length;

/** What a build before this migration stored: the whole state at version 1. */
function storedV1(workspaces: Record<string, unknown>, activeId = 'sound-design') {
	return JSON.stringify({
		version: 1,
		data: {
			activeId,
			order: [
				'editing',
				'assembly',
				'effects',
				'motion',
				'essentials',
				'color',
				'audio',
				'captions',
				'sound-design',
			],
			workspaces,
		},
	});
}
const record = (id: string, name: string, current: unknown, saved: unknown, builtIn = true) => ({
	id,
	name,
	builtIn,
	showInBar: true,
	current,
	saved,
});

describe('workspace state v1 → v2: the Sound Design workspace gains the Review panel', () => {
	it('adds Review as a background tab before Markers in the stored current and saved layouts; nothing else changes', () => {
		const current = oldLayout();
		// the user's saved layout: Markers and History moved into their own group below Program's column
		const saved = structuredClone(current) as unknown as {
			grid: { root: { data: { type: string; data: unknown; size: number }[] } };
		};
		const left = groupOf(saved, 'markers-1')!;
		left.data.views = left.data.views.filter((v) => v !== 'markers-1' && v !== 'history-1');
		saved.grid.root.data.push({
			type: 'leaf',
			data: { views: ['history-1', 'markers-1'], activeView: 'history-1', id: 'mine-1' },
			size: 200,
		});
		const custom = structuredClone(current);
		const audio = buildLayout(
			{ id: 'audio', name: 'Audio', layout: g(['markers', 'history', 'project'], 'project') },
			{ width: 1600, height: 900 },
			panelMap,
		);
		const storage = memoryStorage({
			[WORKSPACES_KEY]: storedV1({
				'sound-design': record('sound-design', 'Sound Design', current, saved),
				audio: record('audio', 'Audio', audio, null),
				'custom:mine': record('custom:mine', 'Mine', custom, custom, false),
			}),
		});
		const store = new WorkspaceStore(storage);
		expect(store.resetReason).toBeNull();
		expect(store.getState().activeId).toBe('sound-design');
		const sd = store.get('sound-design')!;

		// current: the old left group, Review right before Markers (and Sound Check, v3, right after it), the Sound
		// Library still the visible tab
		const host = groupOf(sd.current, 'review-1')!;
		expect(host.data.views).toEqual([
			'soundLibrary-1',
			'project-1',
			'mediaBrowser-1',
			'review-1',
			'soundCheck-1',
			'markers-1',
			'history-1',
			'jobs-1',
		]);
		expect(host.data.activeView).toBe('soundLibrary-1');
		// the panel state is the one buildLayout writes for the registered Review panel
		const reviewDef = panelMap.get('review')!;
		expect(sd.current!.panels['review-1']).toEqual(panelState(reviewDef, 'Review', instanceIdFor('review')));
		expect(REVIEW_PANEL_STATE).toEqual(panelState(reviewDef, 'Review'));
		// apart from the tab and its panel, the layout is the stored one (sizes, groups, other panels)
		const without = structuredClone(sd.current!) as unknown as typeof current;
		delete (without.panels as Record<string, unknown>)['review-1'];
		delete (without.panels as Record<string, unknown>)['soundCheck-1'];
		groupOf(without, 'markers-1')!.data.views = host.data.views.filter(
			(v) => v !== 'review-1' && v !== 'soundCheck-1',
		);
		expect(without).toEqual(current);
		// it survives the dock's sanitizer (a known kind, referenced by a group)
		expect(sanitizeLayout(sd.current)?.panels['review-1']).toBeDefined();

		// saved: Review joins the user's Markers group (first, as in the factory group), the History tab stays active
		const savedHost = groupOf(sd.saved, 'review-1')!;
		expect(savedHost.data.id).toBe('mine-1');
		expect(savedHost.data.views).toEqual(['review-1', 'soundCheck-1', 'history-1', 'markers-1']);
		expect(savedHost.data.activeView).toBe('history-1');
		expect(reviewCount(sd.saved)).toBe(1);

		// other built-ins and custom workspaces are not touched
		expect(store.get('audio')!.current).toEqual(audio);
		expect(store.get('custom:mine')!.current).toEqual(custom);
		expect(store.get('custom:mine')!.saved).toEqual(custom);

		// written back at the new version; loading it again changes nothing
		store.flush();
		const raw = JSON.parse(storage.getItem(WORKSPACES_KEY)!);
		expect(raw.version).toBe(WORKSPACES_VERSION);
		expect(WORKSPACES_VERSION).toBe(3);
		const again = new WorkspaceStore(storage);
		expect(again.resetReason).toBeNull();
		expect(again.getState()).toEqual(store.getState());
	});

	it('is idempotent and never duplicates the panel (Review already open, docked or floating)', () => {
		const once = addReviewPanel(oldLayout());
		expect(addReviewPanel(once)).toBe(once);
		expect(migrateWorkspacesState(migrateWorkspacesState(storedData(once), 1, 2), 1, 2)).toEqual(
			storedData(once),
		);

		// the user opened Window ▸ Review in the old layout: it floats; nothing is added
		const floating = oldLayout() as unknown as Record<string, unknown> & { panels: Record<string, unknown> };
		floating.panels['review-1'] = { ...REVIEW_PANEL_STATE };
		floating.floatingGroups = [
			{
				data: { views: ['review-1'], activeView: 'review-1', id: 'float-1' },
				position: { left: 10, top: 10 },
			},
		];
		expect(addReviewPanel(floating)).toBe(floating);
		const store = new WorkspaceStore(
			memoryStorage({
				[WORKSPACES_KEY]: storedV1({
					'sound-design': record('sound-design', 'Sound Design', floating, once),
				}),
			}),
		);
		expect(reviewCount(store.get('sound-design')!.current)).toBe(1);
		expect(reviewCount(store.get('sound-design')!.saved)).toBe(1);
		// (v3 puts Sound Check next to that Review, where Window ▸ Sound Check would open it)
		expect(store.get('sound-design')!.current).toEqual(addSoundCheckPanel(floating));

		// a Review panel under another instance id counts too
		const other = oldLayout() as unknown as { panels: Record<string, unknown> };
		other.panels['review-7'] = { ...REVIEW_PANEL_STATE, id: 'review-7' };
		groupOf(other, 'jobs-1')!.data.views.push('review-7');
		expect(addReviewPanel(other)).toBe(other);
	});

	it('leaves factory (null) layouts and layouts without a host group alone', () => {
		const store = new WorkspaceStore(
			memoryStorage({
				[WORKSPACES_KEY]: storedV1({ 'sound-design': record('sound-design', 'Sound Design', null, null) }),
			}),
		);
		expect(store.resetReason).toBeNull();
		expect(store.get('sound-design')!.current).toBeNull();
		expect(store.get('sound-design')!.saved).toBeNull();

		// the user closed the whole left group: Window ▸ Review opens the panel later, the migration adds none
		const bare = buildLayout(
			{ id: 'sound-design', name: 'Sound Design', layout: g(['program', 'timeline'], 'program') },
			{ width: 1600, height: 900 },
			panelMap,
		);
		expect(addReviewPanel(bare)).toBe(bare);
		// the Sound Library alone still hosts it (appended: nothing to go before)
		const lib = buildLayout(
			{ id: 'sound-design', name: 'Sound Design', layout: g(['soundLibrary', 'program'], 'program') },
			{ width: 1600, height: 900 },
			panelMap,
		);
		const withLib = addReviewPanel(lib);
		expect(groupOf(withLib, 'review-1')!.data.views).toEqual(['soundLibrary-1', 'program-1', 'review-1']);
		expect(groupOf(withLib, 'review-1')!.data.activeView).toBe('program-1');
		// the input is never mutated
		expect(groupOf(lib, 'soundLibrary-1')!.data.views).toEqual(['soundLibrary-1', 'program-1']);
	});

	it('corrupt, unknown and newer stored data are still reset (SH-021)', () => {
		const load = (raw: string) => {
			const storage = memoryStorage({ [WORKSPACES_KEY]: raw });
			const store = new WorkspaceStore(storage);
			return { store, storage };
		};
		expect(load('{not json').store.resetReason).toBe('corrupt');
		expect(load(JSON.stringify({ data: {} })).store.resetReason).toBe('corrupt');
		const newer = load(JSON.stringify({ version: WORKSPACES_VERSION + 1, data: { activeId: 'x' } }));
		expect(newer.store.resetReason).toBe('newer');
		expect(newer.storage.getItem(WORKSPACES_KEY)).toBeNull();
		expect(load(JSON.stringify({ version: Number.NaN, data: {} })).store.resetReason).toBe('corrupt');
		for (const version of [0, -1e9, 1.5])
			expect(load(JSON.stringify({ version, data: {} })).store.resetReason).toBe('invalid');
		// a v1 payload the parser cannot read stays unreadable after the migration
		const broken = load(
			storedV1({ 'sound-design': record('sound-design', 'Sound Design', 'not a layout', null) }),
		);
		expect(broken.store.resetReason).toBe('invalid');
		expect(broken.store.getState().activeId).toBe('editing');
		expect(load(JSON.stringify({ version: 1, data: null })).store.resetReason).toBe('invalid');
		// a layout object of the wrong shape passes through the migration untouched (the dock's sanitizer decides)
		const odd = { grid: { root: 'x' }, panels: { 'markers-1': 3 } };
		expect(addReviewPanel(odd)).toBe(odd);
	});

	it('never throws on hostile stored data, and adds at most one Review panel (property)', () => {
		const layoutish = fc.record({
			grid: fc.record({
				root: fc.anything(),
				width: fc.integer(),
				height: fc.integer(),
				orientation: fc.constantFrom('HORIZONTAL', 'VERTICAL', 7),
			}),
			panels: fc.dictionary(
				fc.constantFrom('markers-1', 'history-1', 'review-1', '__proto__', 'jobs-1', 'x'),
				fc.oneof(
					fc.anything(),
					fc.record({
						id: fc.string(),
						params: fc.record({ kind: fc.constantFrom('markers', 'review', 'jobs') }),
					}),
				),
			),
			floatingGroups: fc.anything(),
		});
		fc.assert(
			fc.property(fc.oneof(fc.anything(), layoutish, fc.constant(oldLayout())), (layout) => {
				const out = addReviewPanel(layout);
				// (Object.is: fc.anything() draws NaN, which is never `===` itself)
				if (!Object.is(out, layout)) expect(reviewCount(out)).toBe(1);
				const data = migrateWorkspacesState(
					{
						activeId: 'sound-design',
						order: [],
						workspaces: { 'sound-design': { current: layout, saved: layout } },
					},
					1,
					WORKSPACES_VERSION,
				);
				expect(data).toBeDefined();
				expect(() => migrateWorkspacesState(layout, 1, WORKSPACES_VERSION)).not.toThrow();
			}),
			{ numRuns: 300 },
		);
	});
});

function storedData(layout: unknown) {
	return {
		activeId: 'sound-design',
		order: [],
		workspaces: { 'sound-design': record('sound-design', 'Sound Design', layout, layout) },
	};
}

describe('workspace state v2 → v3: the Sound Design workspace gains the Sound Check panel', () => {
	const storedV2 = (workspaces: Record<string, unknown>) =>
		JSON.stringify({
			version: 2,
			data: {
				activeId: 'sound-design',
				order: ['editing', 'sound-design'],
				workspaces,
			},
		});

	it('adds Sound Check right after Review in the stored layouts; nothing else changes', () => {
		const v2 = addReviewPanel(oldLayout()) as ReturnType<typeof oldLayout>;
		// the user's saved layout: Review on its own in a group of its own, its tab active
		const saved = structuredClone(v2);
		const left = groupOf(saved, 'review-1')!;
		left.data.views = left.data.views.filter((v) => v !== 'review-1');
		(saved as unknown as { grid: { root: { data: unknown[] } } }).grid.root.data.push({
			type: 'leaf',
			data: { views: ['review-1'], activeView: 'review-1', id: 'mine-2' },
			size: 200,
		});
		const custom = structuredClone(v2);
		const storage = memoryStorage({
			[WORKSPACES_KEY]: storedV2({
				'sound-design': record('sound-design', 'Sound Design', v2, saved),
				'custom:mine': record('custom:mine', 'Mine', custom, custom, false),
			}),
		});
		const store = new WorkspaceStore(storage);
		expect(store.resetReason).toBeNull();
		const sd = store.get('sound-design')!;
		const host = groupOf(sd.current, 'soundCheck-1')!;
		expect(host.data.views).toEqual([
			'soundLibrary-1',
			'project-1',
			'mediaBrowser-1',
			'review-1',
			'soundCheck-1',
			'markers-1',
			'history-1',
			'jobs-1',
		]);
		expect(host.data.activeView).toBe('soundLibrary-1');
		const def = panelMap.get('soundCheck')!;
		expect(SOUND_CHECK_PANEL_STATE).toEqual(panelState(def, 'Sound Check'));
		expect(sd.current!.panels['soundCheck-1']).toEqual(
			panelState(def, 'Sound Check', instanceIdFor('soundCheck')),
		);
		expect(sanitizeLayout(sd.current)?.panels['soundCheck-1']).toBeDefined();
		// saved: next to Review in the user's own group, Review still the visible tab
		const savedHost = groupOf(sd.saved, 'soundCheck-1')!;
		expect(savedHost.data.id).toBe('mine-2');
		expect(savedHost.data.views).toEqual(['review-1', 'soundCheck-1']);
		expect(savedHost.data.activeView).toBe('review-1');
		// custom workspaces untouched; idempotent
		expect(store.get('custom:mine')!.current).toEqual(custom);
		const once = addSoundCheckPanel(v2);
		expect(addSoundCheckPanel(once)).toBe(once);
		store.flush();
		const again = new WorkspaceStore(storage);
		expect(again.resetReason).toBeNull();
		expect(again.getState()).toEqual(store.getState());
	});

	it('without Review it goes where Review went (before Markers); the factory layout has it already', () => {
		const out = addSoundCheckPanel(oldLayout());
		expect(groupOf(out, 'soundCheck-1')!.data.views).toEqual([
			'soundLibrary-1',
			'project-1',
			'mediaBrowser-1',
			'soundCheck-1',
			'markers-1',
			'history-1',
			'jobs-1',
		]);
		const bare = buildLayout(
			{ id: 'sound-design', name: 'Sound Design', layout: g(['program', 'timeline'], 'program') },
			{ width: 1600, height: 900 },
			panelMap,
		);
		expect(addSoundCheckPanel(bare)).toBe(bare);
		// mutation check: the factory Sound Design layout lists the panel next to Review
		const factory = buildLayout(
			{
				id: 'sound-design',
				name: 'Sound Design',
				layout: g(['review', 'soundCheck', 'markers'], 'review'),
			},
			{ width: 1600, height: 900 },
			panelMap,
		);
		expect(addSoundCheckPanel(factory)).toBe(factory);
	});

	it('never throws on hostile stored data and adds at most one Sound Check panel (property)', () => {
		const count = (layout: unknown) =>
			Object.values((layout as { panels: Record<string, { params?: { kind?: string } }> }).panels).filter(
				(p) => p.params?.kind === 'soundCheck',
			).length;
		fc.assert(
			fc.property(
				fc.oneof(fc.anything(), fc.constant(oldLayout()), fc.constant(addReviewPanel(oldLayout()))),
				(layout) => {
					const out = addSoundCheckPanel(layout);
					if (!Object.is(out, layout)) expect(count(out)).toBe(1);
					expect(() => migrateWorkspacesState(layout, 2, WORKSPACES_VERSION)).not.toThrow();
				},
			),
			{ numRuns: 300 },
		);
	});
});
