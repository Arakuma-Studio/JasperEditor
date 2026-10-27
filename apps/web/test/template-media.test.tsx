// Template media params in the editor (avatars, docs/wp-notes/social-comments.md "Template media params"): Properties
// shows the media picker for `mediaParam()` params (None = null, drag from the Project panel), edits are undoable
// param commands, and deleting a medium a motion graphic shows says that the picture is cleared (the clip stays).
import { createMgRegistry, MG_CATALOG } from '@jasper/mg-templates';
import {
	type Clip,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AVATAR_TEST_TEMPLATE } from '../../../packages/mg-templates/test/fixtures/avatar-test-template.ts';
import { EffectControlsPanel } from '../src/panels/effectControls/EffectControlsPanel.tsx';
import { deleteItems } from '../src/panels/project/actions.ts';
import { projectDialogs } from '../src/panels/project/dialogs.tsx';
import { PropertiesPanel } from '../src/panels/properties/PropertiesPanel.tsx';
import { PROJECT_ITEMS_MIME } from '../src/state/services.ts';
import { renderWithSession } from './inspector-helpers.tsx';

afterEach(() => {
	cleanup();
	projectDialogs.close();
});

const asset = (kind: MediaAsset['kind'], name: string, n: number): Omit<MediaAsset, 'id'> => ({
	kind,
	fingerprint: `q1:${String(n).repeat(64).slice(0, 64)}`,
	originalName: name,
	sizeBytes: 100,
	container: kind === 'audio' ? 'wav' : 'png_pipe',
	probe: {
		durationFlicks: kind === 'audio' ? 705_600_000 : null,
		startTimecode: null,
		streams:
			kind === 'audio'
				? [
						{
							index: 0,
							type: 'audio',
							codec: 'pcm_s16le',
							sampleRate: 48000,
							channels: 2,
							channelLayout: 'stereo',
						},
					]
				: [],
		rotationDegrees: 0,
		hasAlpha: false,
		variableFrameRate: false,
	},
	locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${n}` }],
	derivation: null,
	importedAt: '2026-10-25T00:00:00.000Z',
});

function setup() {
	const ids = createCounterIdSource(3);
	const document = createEmptyProject({ ids, name: 'Avatars', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: document.projectId,
		document,
		ctx: {
			ids,
			now: () => '2026-10-25T00:00:00.000Z',
			registries: defaultRegistries(createMgRegistry([...MG_CATALOG, AVATAR_TEST_TEMPLATE])),
		},
		coalesceWindowMs: 0,
	});
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{ type: 'media.register', asset: asset('image', 'ada.png', 1) },
			{ type: 'media.register', asset: asset('audio', 'hit.wav', 2) },
			{
				type: 'clip.addMotionGraphic',
				at: 0,
				duration: 60,
				track: 'V1',
				template: { id: 'avatar-test', version: 1 },
				ref: '$c',
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const [img, audio] = r.results as { mediaId: string; itemId: string }[];
	const clipId = r.refs.$c!;
	act(() => session.select('timeline', [clipId]));
	return { session, img: img!, audio: audio!, clipId };
}

const avatarOf = (s: EditorSession, clipId: string) =>
	(Object.values(s.getCommitted().sequences)[0]!.clips[clipId] as Extract<Clip, { kind: 'motion-graphic' }>)
		.params.avatar;

const drag = (itemIds: string[]) => ({
	dataTransfer: {
		types: [PROJECT_ITEMS_MIME],
		getData: (t: string) => (t === PROJECT_ITEMS_MIME ? JSON.stringify({ itemIds }) : ''),
		dropEffect: 'none',
	},
});

describe('template media params in Properties', () => {
	it('picks an image (only images are offered), None writes null, and each edit is one undo step', () => {
		const { session, img, clipId } = setup();
		renderWithSession(session, <PropertiesPanel instanceId="p-media" visible />);
		const picker = screen.getByTestId('prop-params.avatar') as HTMLSelectElement;
		expect([...picker.options].map((o) => o.textContent)).toEqual(['None', 'ada.png']);
		expect(picker.value).toBe('');
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.change(picker, { target: { value: img.mediaId } });
		});
		expect(avatarOf(session, clipId)).toEqual({ mediaId: img.mediaId });
		expect(session.getState().history.entries.length).toBe(entries + 1);
		act(() => {
			fireEvent.change(screen.getByTestId('prop-params.avatar'), { target: { value: '' } });
		});
		expect(avatarOf(session, clipId)).toBeNull();
		act(() => {
			session.undo();
		});
		expect(avatarOf(session, clipId)).toEqual({ mediaId: img.mediaId });
	});

	it('takes an image item dropped from the Project panel; refuses other items with a hint', () => {
		const { session, img, audio, clipId } = setup();
		renderWithSession(session, <PropertiesPanel instanceId="p-media" visible />);
		const picker = screen.getByTestId('prop-params.avatar');
		act(() => {
			fireEvent.dragOver(picker, drag([audio.itemId]));
			fireEvent.drop(picker, drag([audio.itemId]));
		});
		expect(avatarOf(session, clipId)).toBeNull();
		expect(screen.getByText('Drop an image item from the Project panel')).toBeTruthy();
		act(() => {
			fireEvent.dragOver(picker, drag([audio.itemId, img.itemId]));
			fireEvent.drop(picker, drag([audio.itemId, img.itemId]));
		});
		expect(avatarOf(session, clipId)).toEqual({ mediaId: img.mediaId });
	});
});

describe('template media params in Effect Controls', () => {
	it('edits a static image reference from Effect Controls', () => {
		const { session, img, clipId } = setup();
		renderWithSession(session, <EffectControlsPanel instanceId="ec-media" visible />);
		const picker = screen.getByTestId('prop-params.avatar') as HTMLSelectElement;
		act(() => fireEvent.change(picker, { target: { value: img.mediaId } }));
		expect(avatarOf(session, clipId)).toEqual({ mediaId: img.mediaId });
		act(() => session.undo());
		expect(avatarOf(session, clipId)).toBeNull();
		expect(screen.queryByTestId('stopwatch-params.avatar')).toBeNull();
	});
});

describe('deleting a medium a motion graphic shows', () => {
	it('asks first, says the picture is cleared, and keeps the clip', () => {
		const { session, img, clipId } = setup();
		session.apply({
			label: 'avatar',
			origin: 'user',
			commands: [
				{ type: 'param.set', target: ['clip', clipId, 'params', 'avatar'], value: { mediaId: img.mediaId } },
			],
		});
		deleteItems(session, [img.itemId]);
		const d = projectDialogs.get() as { kind: string; message: string; onConfirm(): void };
		expect(d.kind).toBe('confirm');
		expect(d.message).toContain('clears it from those motion graphics (the clips stay)');
		act(() => d.onConfirm());
		expect(avatarOf(session, clipId)).toBeNull();
		expect(session.getCommitted().media[img.mediaId]).toBeUndefined();
		expect(Object.values(session.getCommitted().sequences)[0]!.clips[clipId]).toBeDefined();
	});
});
