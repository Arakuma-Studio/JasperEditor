import '../src/color-mgmt/interpret-section.tsx';
import type { RegisteredMedia } from '@jasper/api';
import { DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SequenceColorDialog } from '../src/color-mgmt/dialogs.tsx';
import { colorPatchOf } from '../src/color-mgmt/model.ts';
import { registerAllCommands } from '../src/commands/index.ts';
import { buildExportSettings } from '../src/export/settings.ts';
import { buildMediaAsset } from '../src/import/assets.ts';
import { InterpretFootageDialog } from '../src/imports/interpret-dialog.tsx';
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
	it('commits colour and Loop edits from the dialog in one undo step', async () => {
		const { session } = makeSession();
		const id = addMedia(session, registered('log.mov', { key: 'mk_LOGCLIP01', seconds: 10 }));
		render(<InterpretFootageDialog session={session} mediaIds={[id]} close={() => {}} />);
		fireEvent.change(screen.getByLabelText('Loop count'), { target: { value: '2' } });
		await act(async () => {
			fireEvent.keyDown(screen.getByRole('combobox', { name: 'Color Space' }), { key: 'Enter' });
		});
		await act(async () => {
			fireEvent.keyDown(await screen.findByRole('option', { name: /S-Log3.*S-Gamut3.Cine/ }), {
				key: 'Enter',
			});
		});
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'OK' }));
		});
		expect(session.getCommitted().media[id]!.interpretation).toEqual({
			loop: 2,
			color: { space: 'slog3-sgamut3cine' },
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
		session.undo();
		expect(session.getCommitted().sequences[seqId]!.settings.color).toBeUndefined();
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
		const color = { colorSpace: 'working' as const, bitDepth: 10 as const, maxCll: 800, maxFall: 0 };
		const s = buildExportSettings(seq, { range: 'entire', engine: 'auto', color });
		expect(s.video).toMatchObject({ bitDepth: 10, hdrMetadata: { maxCll: 800 } });
		expect(s.video?.colorSpace).toBeUndefined();
	});
});
