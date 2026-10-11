import '../src/color-mgmt/interpret-section.tsx';
// color-mgmt UI: the Colour section of Interpret Footage (after Loop, one transaction with the other sections), the
// Sequence Settings ▸ Colour dialog, the Clip Colour Space command and menus, the export colour settings.
import type { RegisteredMedia } from '@jasper/api';
import { DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SequenceColorDialog } from '../src/color-mgmt/dialogs.tsx';
import { colorPatchOf } from '../src/color-mgmt/model.ts';
import { registerAllCommands } from '../src/commands/index.ts';
import { getCommand } from '../src/commands/registry.ts';
import { buildExportSettings, exportColorSpaceOptions, hdrOutput } from '../src/export/settings.ts';
import { buildMediaAsset } from '../src/import/assets.ts';
import {
	InterpretFootageDialog,
	interpretCommands,
	interpretSections,
} from '../src/imports/interpret-dialog.tsx';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { makeSession } from './timeline-helpers.ts';
import { registered } from './wp2e/helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(cleanup);

function addMedia(session: ReturnType<typeof makeSession>['session'], reg: RegisteredMedia): string {
	const r = session.apply({
		label: 'Import',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				asset: buildMediaAsset(reg, { id: session.ctx.ids.next('med'), now: 't' }),
			} as never,
		],
	});
	if (!r.ok) throw new Error(r.errors[0]!.message);
	return (r.results[0] as { mediaId: string }).mediaId;
}

describe('Interpret Footage ▸ Colour', () => {
	it('is the section after Loop and joins the dialog transaction', async () => {
		const { session } = makeSession();
		const id = addMedia(session, registered('log.mov', { key: 'mk_LOGCLIP01', seconds: 10 }));
		const sections = interpretSections().map((s) => s.id);
		expect(sections.indexOf('color')).toBe(sections.indexOf('loop') + 1);
		render(<DialogHost />);
		render(<InterpretFootageDialog session={session} mediaIds={[id]} close={() => {}} />);
		const dialog = await screen.findByTestId('interpret-footage-dialog');
		expect(
			dialog.querySelector('[data-section="color"] [data-testid="color-interpretation"]'),
		).not.toBeNull();
		expect(dialog.textContent).toMatch(/Automatic \(Rec\. 709\)/);
		// The section's commands: one media.interpretColor patch next to the media.interpret patch.
		const asset = session.getCommitted().media[id]!;
		const cmds = interpretCommands([asset], {
			patch: { loop: 2 },
			sections: { color: { space: 'slog3-sgamut3cine', range: 'pc' } },
		});
		expect(cmds.map((c) => c.type)).toEqual(['media.interpret', 'media.interpretColor']);
		const r = session.apply({ label: 'Interpret Footage', origin: 'user', commands: cmds });
		expect(r.ok).toBe(true);
		expect(session.getCommitted().media[id]!.interpretation).toEqual({
			loop: 2,
			color: { space: 'slog3-sgamut3cine', range: 'pc' },
		});
		session.undo();
		expect(session.getCommitted().media[id]!.interpretation).toBeUndefined();
	});

	it('patches only changed fields and resets with null', () => {
		expect(colorPatchOf({ space: 'rec709', range: 'tv' }, { space: 'vlog-vgamut', range: 'tv' })).toEqual({
			space: 'vlog-vgamut',
		});
		expect(colorPatchOf({ space: 'rec709' }, {})).toEqual({ space: null });
	});
});

describe('Sequence Settings ▸ Colour', () => {
	it('turns on Blend Using 1.0 Gamma and Auto Tone Map off in one undo step', async () => {
		const { session, seqId } = makeSession();
		render(<DialogHost />);
		let closed: unknown = null;
		render(<SequenceColorDialog session={session} sequenceId={seqId} close={(r) => (closed = r)} />);
		await screen.findByTestId('sequence-color-dialog');
		fireEvent.click(screen.getByLabelText('Blend Using 1.0 Gamma'));
		fireEvent.click(screen.getByLabelText('Auto Tone Map Media (HDR and log media in an SDR working space)'));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'OK' }));
		});
		await waitFor(() => expect(closed, document.body.textContent ?? '').toBe(true));
		expect(session.getCommitted().sequences[seqId]!.settings.color).toEqual({
			blendLinear: true,
			autoToneMap: false,
		});
	});

	it('the commands and menus are wired', () => {
		const { session } = makeSession();
		expect(getCommand('sequence.settings')).toBeTruthy();
		expect(getCommand('sequence.colorSettings')).toBeTruthy();
		expect(getCommand('clip.colorSpace')).toBeTruthy();
		const ids = JSON.stringify(MENUBAR);
		expect(ids).toContain('sequence.settings');
		expect(ids).toContain('clip.colorSpace');
		void session;
	});
});

describe('export colour settings', () => {
	it('carries the colour space, bit depth and HDR metadata', () => {
		const { session, seqId } = makeSession();
		session.apply({
			label: 'x',
			origin: 'user',
			commands: [{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq' } } as never],
		});
		const seq = session.getCommitted().sequences[seqId]!;
		expect(exportColorSpaceOptions(seq)[0]!.label).toBe('Working (Rec. 2100 PQ)');
		const color = { colorSpace: 'working' as const, bitDepth: 10 as const, maxCll: 800, maxFall: 0 };
		expect(hdrOutput(seq, color)).toBe(true);
		const s = buildExportSettings(seq, { range: 'entire', engine: 'auto', color });
		expect(s.video).toMatchObject({ bitDepth: 10, hdrMetadata: { maxCll: 800 } });
		expect(s.video?.colorSpace).toBeUndefined();
	});
});
