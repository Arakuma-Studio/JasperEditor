// Project stores re-stamp motion-graphic template renderers from the registry on load (S11:ATP-002): a clip stamped
// `renderer: 'anime'` whose template is an fframes template (or the reverse) is repaired when the store knows the
// registry, so the timeline badge and the engines never see a stale stamp.
import {
	createCounterIdSource,
	createEmptyProject,
	createStaticMgRegistry,
	defaultRegistries,
	type MgTemplateInfo,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../../src/index.ts';

// A minimal params schema (the session package does not depend on zod): accepts objects as they are.
const schema = {
	safeParse: (v: unknown) => ({ success: true as const, data: v }),
	parse: (v: unknown) => v,
} as unknown as MgTemplateInfo['paramsSchema'];
const info = (id: string, renderer?: 'anime'): MgTemplateInfo => ({
	id,
	version: 1,
	name: id,
	category: 'Titles',
	paramsSchema: schema,
	defaults: { title: 'Title' },
	introFrames: 10,
	outroFrames: 10,
	canvasDefault: 'sequence',
	...(renderer ? { renderer } : {}),
});
const registry = createStaticMgRegistry([info('svg-title'), info('anime-title', 'anime')]);

type Mg = { template: { id: string; renderer?: string } };
const clipsOf = (doc: ProjectDocument) =>
	Object.values(Object.values(doc.sequences)[0]!.clips) as unknown as Mg[];

async function storedWithContradictions(withRegistry: boolean) {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	const seed = new MemoryProjectStore({ ids, now: () => 't' });
	seed.put(doc);
	const session = await EditorSession.open({
		store: seed,
		projectId: doc.projectId,
		ctx: { ids, now: () => 't', registries: defaultRegistries(registry) },
		sessionId: 's1',
	});
	const added = session.apply({
		label: 'Add templates',
		origin: 'user',
		commands: [
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 30,
				track: 'V1',
				template: { id: 'svg-title', version: 1 },
			},
			{
				type: 'clip.addMotionGraphic',
				at: 40,
				duration: 30,
				track: 'V1',
				template: { id: 'anime-title', version: 1 },
			},
		],
	} as never);
	if (!added.ok) throw new Error(JSON.stringify(added));
	// Contradict both stamps as an older or foreign build could have saved them.
	const broken = JSON.parse(JSON.stringify(session.getCommitted())) as ProjectDocument;
	for (const c of clipsOf(broken)) {
		if (c.template.id === 'svg-title') c.template.renderer = 'anime';
		else delete c.template.renderer;
	}
	const store = new MemoryProjectStore(withRegistry ? { ids, mgTemplates: registry } : { ids });
	store.put(broken);
	return { store, projectId: broken.projectId };
}

describe('template renderer stamps on load (S11:ATP-002)', () => {
	it('a store given the template registry repairs contradicting stamps when it opens the project', async () => {
		const { store, projectId } = await storedWithContradictions(true);
		const opened = await store.open(projectId);
		const byId = Object.fromEntries(clipsOf(opened.document).map((c) => [c.template.id, c.template]));
		expect(byId['svg-title']).toEqual({ id: 'svg-title', version: 1 });
		expect(byId['anime-title']).toEqual({ id: 'anime-title', version: 1, renderer: 'anime' });
		expect(opened.repairs.filter((r) => r.action === 'restamp-renderer')).toHaveLength(2);
	});

	it('without the registry the stamps are left as stored', async () => {
		const { store, projectId } = await storedWithContradictions(false);
		const opened = await store.open(projectId);
		const byId = Object.fromEntries(clipsOf(opened.document).map((c) => [c.template.id, c.template]));
		expect(byId['svg-title']?.renderer).toBe('anime');
		expect(byId['anime-title']?.renderer).toBeUndefined();
	});
});
