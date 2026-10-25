// Template media params (avatars, docs/wp-notes/social-comments.md "Template media params"): setting, clearing and
// deleting the medium are single History entries; undo restores the exact previous document, redo the result.
import {
	createCounterIdSource,
	createEmptyProject,
	createStaticMgRegistry,
	defaultRegistries,
	type MediaAsset,
	type MgTemplateInfo,
	type ProjectDocument,
	TEMPLATE_MEDIA_KIND,
	TEMPLATE_MEDIA_KINDS_KEY,
	TEMPLATE_PARAM_KIND_KEY,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EditorSession, MemoryProjectStore } from '../src/index.ts';

const schema = z.strictObject({
	name: z.string().default('Ada'),
	avatar: z
		.strictObject({ mediaId: z.string().min(1) })
		.nullable()
		.default(null)
		.meta({ [TEMPLATE_PARAM_KIND_KEY]: TEMPLATE_MEDIA_KIND, [TEMPLATE_MEDIA_KINDS_KEY]: ['image'] }),
});
const card: MgTemplateInfo = {
	id: 'avatar-card',
	version: 1,
	name: 'Avatar card',
	category: 'Test',
	paramsSchema: schema,
	defaults: schema.parse({}),
	introFrames: 0,
	outroFrames: 0,
	canvasDefault: 'sequence',
	renderer: 'anime',
};

const image: Omit<MediaAsset, 'id'> = {
	kind: 'image',
	fingerprint: `q1:${'a'.repeat(64)}`,
	originalName: 'avatar.png',
	sizeBytes: 100,
	container: 'png_pipe',
	probe: {
		durationFlicks: null,
		startTimecode: null,
		streams: [],
		rotationDegrees: 0,
		hasAlpha: true,
		variableFrameRate: false,
	},
	locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_avatar' }],
	derivation: null,
	importedAt: '2026-10-25T10:00:00.000Z',
};

async function open() {
	const ids = createCounterIdSource(1);
	const now = () => '2026-10-25T10:00:00.000Z';
	const store = new MemoryProjectStore({ ids, now });
	const doc = createEmptyProject({ ids, name: 'Avatars', preset: 'hd-1080p-30' });
	store.put(doc);
	const s = await EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now, registries: defaultRegistries(createStaticMgRegistry([card])) },
		sessionId: 's1',
	});
	const reg = s.apply({
		label: 'Import',
		origin: 'user',
		commands: [{ type: 'media.register', asset: image }],
	});
	if (!reg.ok) throw new Error('register failed');
	const { mediaId, itemId } = reg.results[0] as { mediaId: string; itemId: string };
	const add = s.apply({
		label: 'Add',
		origin: 'user',
		commands: [
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 60,
				track: 'V1',
				template: { id: 'avatar-card', version: 1 },
				ref: '$c',
			},
		],
	});
	if (!add.ok) throw new Error('add failed');
	return { s, mediaId, itemId, clipId: add.refs.$c! };
}

const avatarOf = (doc: ProjectDocument, clipId: string) =>
	(Object.values(doc.sequences)[0]!.clips[clipId] as { params: { avatar: unknown } }).params.avatar;

describe('template media params in the session history', () => {
	it('param.set of an avatar and of None undo / redo exactly', async () => {
		const { s, mediaId, clipId } = await open();
		const target = ['clip', clipId, 'params', 'avatar'];
		const before = s.getCommitted();
		expect(
			s.apply({
				label: 'Avatar',
				origin: 'user',
				commands: [{ type: 'param.set', target, value: { mediaId } }],
			}).ok,
		).toBe(true);
		const set = s.getCommitted();
		expect(avatarOf(set, clipId)).toEqual({ mediaId });
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted()).toEqual(before);
		expect(s.redo().ok).toBe(true);
		expect(s.getCommitted()).toEqual(set);
		expect(
			s.apply({ label: 'None', origin: 'user', commands: [{ type: 'param.set', target, value: null }] }).ok,
		).toBe(true);
		expect(avatarOf(s.getCommitted(), clipId)).toBeNull();
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted()).toEqual(set);
	});

	it('a refused avatar leaves no History entry; a forced delete of its medium undoes in one step', async () => {
		const { s, mediaId, itemId, clipId } = await open();
		const target = ['clip', clipId, 'params', 'avatar'];
		s.apply({
			label: 'Avatar',
			origin: 'user',
			commands: [{ type: 'param.set', target, value: { mediaId } }],
		});
		const set = s.getCommitted();
		const missing = s.apply({
			label: 'Avatar',
			origin: 'user',
			commands: [{ type: 'param.set', target, value: { mediaId: 'med_nope' } }],
		});
		expect(missing.ok ? null : missing.errors[0]?.code).toBe('E_NOT_FOUND');
		const inUse = s.apply({
			label: 'Delete',
			origin: 'user',
			commands: [{ type: 'item.delete', itemIds: [itemId] }],
		});
		expect(inUse.ok ? null : inUse.errors[0]?.code).toBe('E_IN_USE');
		expect(s.getCommitted()).toBe(set);
		const del = s.apply({
			label: 'Delete',
			origin: 'user',
			commands: [{ type: 'item.delete', itemIds: [itemId], force: true }],
		});
		expect(del.ok).toBe(true);
		expect(avatarOf(s.getCommitted(), clipId)).toBeNull();
		expect(s.getCommitted().media[mediaId]).toBeUndefined();
		expect(s.undo().ok).toBe(true);
		expect(s.getCommitted()).toEqual(set);
		expect(s.redo().ok).toBe(true);
		expect(avatarOf(s.getCommitted(), clipId)).toBeNull();
	});
});
