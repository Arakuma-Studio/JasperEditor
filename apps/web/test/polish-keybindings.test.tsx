import type { MediaItem } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCommandContext, getCommand, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { buildMediaAsset } from '../src/import/assets.ts';
import { clearPosterHover, posterHover, setPosterHover } from '../src/panels/project/poster-frame.ts';
import { memorySession, registered, ScriptedEngine } from './wp2e/helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => {
	closeAllDialogs();
	cleanup();
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
	it('needs a selection and opens the dialog for the selected media', async () => {
		const { session } = await memorySession();
		const { itemId } = importMedia(session, 'clip-a.mp4');
		importMedia(session, 'clip-b.mp4');
		render(<DialogHost />);
		const ctx = createCommandContext({
			engine: new ScriptedEngine().client(),
			session,
			openDialog: (kind, props) => void openDialog(kind, props),
		});
		const cmd = getCommand('project.mediaProperties')!;
		expect(cmd.when?.(ctx)).toBe(false);
		session.select('project', [itemId], 'replace', { primary: itemId });
		expect(cmd.when?.(ctx)).toBe(true);
		await act(async () => {
			await runCommand('project.mediaProperties', ctx);
		});
		expect(await screen.findByRole('heading', { name: 'clip-a.mp4' })).toBeTruthy();
		expect(screen.queryByRole('heading', { name: 'clip-b.mp4' })).toBeNull();
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
