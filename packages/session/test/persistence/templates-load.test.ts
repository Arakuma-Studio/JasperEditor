import {
	createCounterIdSource,
	createEmptyProject,
	createStaticMgRegistry,
	defaultRegistries,
	MotionGraphicClipSchema,
} from '@jasper/project';
import { expect, it } from 'vitest';
import { EditorSession, MemoryProjectStore } from '../../src/index.ts';

it('passes its template registry to the loader to repair stale renderer stamps (S11:ATP-002)', async () => {
	const ids = createCounterIdSource(1);
	const document = createEmptyProject({ ids, name: 'Templates' });
	const mgTemplates = createStaticMgRegistry([
		{
			id: 'title',
			version: 1,
			name: 'Title',
			category: 'Titles',
			paramsSchema: MotionGraphicClipSchema.shape.params,
			defaults: {},
			introFrames: 0,
			outroFrames: 0,
			canvasDefault: 'sequence',
			renderer: 'anime',
		},
	]);
	const session = new EditorSession({
		projectId: document.projectId,
		document,
		ctx: { ids, now: () => 't', registries: defaultRegistries(mgTemplates) },
	});
	const result = session.apply({
		label: 'Add title',
		origin: 'user',
		commands: [
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 30,
				track: 'V1',
				template: { id: 'title', version: 1 },
			},
		],
	});
	expect(result.ok).toBe(true);
	const stale = structuredClone(session.getCommitted());
	const sequence = Object.values(stale.sequences)[0]!;
	const clip = Object.values(sequence.clips)[0]!;
	if (clip.kind !== 'motion-graphic') throw new Error('Expected the title clip');
	delete clip.template.renderer;
	const store = new MemoryProjectStore({ ids, mgTemplates });
	store.put(stale);

	const opened = await store.open(stale.projectId);
	expect(opened.document.sequences[sequence.id]!.clips[clip.id]).toMatchObject({
		template: { id: 'title', version: 1, renderer: 'anime' },
	});
	expect(opened.repairs.map((repair) => repair.action)).toContain('restamp-renderer');
});
