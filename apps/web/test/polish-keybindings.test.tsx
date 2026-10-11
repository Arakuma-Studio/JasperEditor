import type { MediaAsset, MediaItem } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCommandContext, getCommand, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { buildMediaAsset } from '../src/import/assets.ts';
import { registerCustomBins } from '../src/panels/effects/presets/custom-bins.ts';
import { MEDIA_PROPERTIES_DIALOG, mediaFacts } from '../src/panels/project/MediaPropertiesDialog.tsx';
import { clearPosterHover, posterHover, setPosterHover } from '../src/panels/project/poster-frame.ts';
import { memorySession, registered, ScriptedEngine } from './wp2e/helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => {
	const h = posterHover();
	if (h) clearPosterHover(h.itemId);
});

function importMedia(session: EditorSession, name: string) {
	const reg = registered(name, { key: `mk_${name.replace(/\W/g, '').toUpperCase()}`, seconds: 10 });
	const r = session.apply({
		label: 'Import 1 file',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				asset: buildMediaAsset(reg, { id: session.ctx.ids.next('med'), now: 't' }),
				name,
			},
		],
	});
	if (!r.ok) throw new Error(r.errors[0]!.message);
	return r.results[0] as { mediaId: string; itemId: string };
}
const poster = (session: EditorSession, itemId: string) =>
	(session.getCommitted().items[itemId] as MediaItem).poster;

describe('Get Properties for Selection', () => {
	it('lists what the media record says, in order', async () => {
		const { session } = await memorySession();
		const { mediaId } = importMedia(session, 'clip-a.mp4');
		const facts = mediaFacts(session.getCommitted().media[mediaId] as MediaAsset, '/footage/clip-a.mp4');
		const get = (label: string) => facts.find((f) => f.label === label)?.value;
		expect(facts[0]).toEqual({ label: 'File Path', value: '/footage/clip-a.mp4' });
		expect(get('Image Size')).toBe('1920 × 1080');
		expect(get('Frame Rate')).toBe('30 fps');
		expect(get('Pixel Aspect Ratio')).toBe('1');
		expect(get('Video Codec')).toBe('h264');
		expect(get('Audio')).toBe('48000 Hz · stereo (stereo) · aac');
		expect(get('Total Duration')).toBe('00:00:10.000');
		expect(get('File Size')).toContain('1,000 bytes');
		expect(mediaFacts(session.getCommitted().media[mediaId] as MediaAsset, null)[0]).toEqual({
			label: 'File Path',
			value: 'Offline',
		});
		expect(mediaFacts(session.getCommitted().media[mediaId] as MediaAsset, undefined)[0]!.label).toBe('Type');
	});

	it('needs a selection and opens the dialog for the selected media', async () => {
		const { session } = await memorySession();
		const { mediaId, itemId } = importMedia(session, 'clip-a.mp4');
		const opened: { kind: string; props?: Record<string, unknown> }[] = [];
		const ctx = createCommandContext({
			engine: new ScriptedEngine().client(),
			session,
			openDialog: (kind, props) => void opened.push({ kind, props }),
		});
		const cmd = getCommand('project.mediaProperties')!;
		expect(cmd.when?.(ctx)).toBe(false);
		expect(cmd.disabledReason?.(ctx)).toMatch(/Select media/);
		session.select('project', [itemId], 'replace', { primary: itemId });
		expect(cmd.when?.(ctx)).toBe(true);
		await runCommand('project.mediaProperties', ctx);
		expect(opened[0]?.kind).toBe(MEDIA_PROPERTIES_DIALOG);
		expect(opened[0]?.props?.mediaIds).toEqual([mediaId]);
	});
});

describe('Set / Clear Poster Frame', () => {
	it('takes the frame under the pointer of a hover-scrubbed thumbnail; one undo step each', async () => {
		const { session } = await memorySession();
		const { itemId } = importMedia(session, 'clip-a.mp4');
		const toast = vi.fn();
		const ctx = createCommandContext({ engine: new ScriptedEngine().client(), session, toast });

		await runCommand('project.setPosterFrame', ctx);
		expect(toast).toHaveBeenCalledTimes(1);
		expect(poster(session, itemId)).toBeUndefined();
		expect(getCommand('project.clearPosterFrame')!.when?.(ctx)).toBe(false);

		setPosterHover(itemId, 2.5);
		const steps = session.getState().history.entries.length;
		await runCommand('project.setPosterFrame', ctx);
		expect(poster(session, itemId)?.flicks).toBe(Math.round(2.5 * 705_600_000));
		expect(session.getState().history.entries.length).toBe(steps + 1);
		expect(session.getState().history.entries.at(-1)?.label).toBe('Set Poster Frame');

		expect(getCommand('project.clearPosterFrame')!.when?.(ctx)).toBe(true);
		await runCommand('project.clearPosterFrame', ctx);
		expect(poster(session, itemId)).toBeUndefined();
		session.undo();
		expect(poster(session, itemId)?.flicks).toBe(Math.round(2.5 * 705_600_000));
		session.undo();
		expect(poster(session, itemId)).toBeUndefined();

		session.redo();
		clearPosterHover(itemId);
		expect(getCommand('project.clearPosterFrame')!.when?.(ctx)).toBe(false);
		session.select('project', [itemId], 'replace', { primary: itemId });
		await runCommand('project.clearPosterFrame', ctx);
		expect(poster(session, itemId)).toBeUndefined();
	});

	it('is refused on a read-only project', async () => {
		const { session } = await memorySession();
		const { itemId } = importMedia(session, 'clip-a.mp4');
		setPosterHover(itemId, 1);
		session.store.setState({ readOnly: true });
		const ctx = createCommandContext({ engine: new ScriptedEngine().client(), session });
		expect(getCommand('project.setPosterFrame')!.when?.(ctx)).toBe(false);
	});
});

describe('Effects panel custom bins', () => {
	it('New Custom Bin and Delete Custom Item drive the Presets bin', async () => {
		const ctx = createCommandContext({ engine: new ScriptedEngine().client() });
		const newBin = getCommand('effects.newCustomBin')!;
		const del = getCommand('effects.deleteCustomItem')!;
		expect(newBin.when?.(ctx)).toBe(false);
		expect(del.when?.(ctx)).toBe(false);

		let picked: { kind: 'bin' | 'preset'; name: string } | null = null;
		const handle = {
			newBin: vi.fn(() => true),
			focusedCustomItem: () => picked,
			deleteFocused: vi.fn(() => true),
		};
		const off = registerCustomBins(handle);
		expect(newBin.when?.(ctx)).toBe(true);
		await runCommand('effects.newCustomBin', ctx);
		expect(handle.newBin).toHaveBeenCalledTimes(1);
		expect(del.when?.(ctx)).toBe(false);
		expect(del.labelFor?.(ctx)).toBe('Delete Custom Item');
		picked = { kind: 'bin', name: 'Looks' };
		expect(del.when?.(ctx)).toBe(true);
		expect(del.labelFor?.(ctx)).toBe('Delete Custom Bin');
		picked = { kind: 'preset', name: 'Soft' };
		expect(del.labelFor?.(ctx)).toBe('Delete Custom Preset');
		await runCommand('effects.deleteCustomItem', ctx);
		expect(handle.deleteFocused).toHaveBeenCalledTimes(1);
		off();
		expect(newBin.when?.(ctx)).toBe(false);
	});
});
