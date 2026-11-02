// Spec 19 §12 in the UI: the commands and menus are wired, the PSD dialog shows blockers before writing, the style dialog
// shows the report and stores looks undoably, and the gamut overlay marks only the frame it measured.
import type { LayerStyleFile, PsdPlan } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import { titleLooksOf } from '@jasper/project';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getCommand, registerAllCommands } from '../src/commands/index.ts';
import { registerAlphaDialog, ALPHA_DIALOG } from '../src/delivery/AlphaDialog.tsx';
import { gamutOverlay } from '../src/delivery/GamutOverlay.tsx';
import { LAYER_STYLE_DIALOG, registerLayerStyleDialog, saveImportedLooks } from '../src/delivery/LayerStyleDialog.tsx';
import { PSD_DIALOG, registerPsdDialog } from '../src/delivery/PsdDialog.tsx';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { makeSession } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => {
	act(() => closeAllDialogs());
	cleanup();
});

const PLAN: PsdPlan = {
	width: 1920,
	height: 1080,
	frame: 0,
	layers: [
		{ name: 'Background', kind: 'pixels', blend: 'normal', opacity: 1, hidden: false, baked: [] },
		{ name: 'Title', kind: 'pixels', blend: 'normal', opacity: 1, hidden: false, baked: ['text rasterised'] },
	],
	baked: ['Title: text rasterised'],
	blockers: [],
	warnings: [{ code: 'PSD_RASTERISED', message: 'Everything is rasterised at 8 bits per channel.' }],
	estimate: { renders: 3, bytes: 1 },
};

/** An engine answering the routes the dialogs call. */
function engineWith(routes: Record<string, unknown>, calls: string[] = []) {
	return new EngineClient({
		baseUrl: 'http://127.0.0.1:9',
		fetch: async (input) => {
			const url = String(input);
			calls.push(url);
			const hit = Object.keys(routes).find((k) => url.includes(k));
			if (!hit) return new Response('{"code":"NOT_FOUND","message":"no","retryable":false}', { status: 404 });
			return new Response(JSON.stringify(routes[hit]), { headers: { 'content-type': 'application/json' } });
		},
	});
}

const menuIds = (items: readonly unknown[]): string[] =>
	items.flatMap((i) => {
		const it = i as { command?: string; items?: unknown[] };
		return [...(it.command ? [it.command] : []), ...(it.items ? menuIds(it.items) : [])];
	});

describe('wiring (spec 19 §12)', () => {
	it('every command exists and reaches a menu', () => {
		const ids = menuIds(MENUBAR);
		for (const id of [
			'delivery.sendToPhotoshop',
			'delivery.pngSequence',
			'delivery.exportTitle',
			'delivery.importLayerStyles',
			'delivery.splitImage',
			'program.gamutOverlay',
		]) {
			expect(getCommand(id), id).toBeTruthy();
			expect(ids, id).toContain(id);
		}
	});

	it('Split Image needs one still; Export Title needs a title', () => {
		const { session } = makeSession();
		const ctx = { session, services: {} } as never;
		expect(getCommand('delivery.splitImage')!.when!(ctx)).toBe(false);
		expect(getCommand('delivery.exportTitle')!.when!(ctx)).toBe(false);
		expect(getCommand('delivery.splitImage')!.disabledReason!(ctx)).toBeTruthy();
	});

	it('the gamut toggle shows its state', () => {
		gamutOverlay.setState({ enabled: false });
		const c = getCommand('program.gamutOverlay')!;
		void c.run({} as never);
		expect(c.checked!({} as never)).toBe(true);
		void c.run({} as never);
		expect(c.checked!({} as never)).toBe(false);
	});
});

describe('Send to Photoshop (TL-112)', () => {
	const open = (plan: PsdPlan) => {
		const { session, seqId } = makeSession();
		registerPsdDialog();
		const engine = engineWith({ '/api/psd/plan': plan, '/scratch': { local: false, projectMedia: { path: '' } } });
		render(<DialogHost />);
		act(() => {
			void openDialog(PSD_DIALOG, { session, engine, sequenceId: seqId, frame: 0, baseName: 'Seq' });
		});
	};

	it('lists the layers and what is baked before writing', async () => {
		open(PLAN);
		await waitFor(() => expect(screen.getByTestId('psd-baked').textContent).toContain('Title: text rasterised'));
		expect(screen.getByTestId('psd-layers').textContent).toContain('Background');
		expect(screen.getByTestId('psd-warnings').textContent).toContain('rasterised');
		expect((screen.getByRole('button', { name: 'Write PSD' }) as HTMLButtonElement).disabled).toBe(false);
	});

	it('a blocker stops it, with its reason, before anything runs', async () => {
		open({ ...PLAN, layers: [], blockers: [{ code: 'PSD_EMPTY', message: 'Nothing is visible at this frame' }] });
		await waitFor(() => expect(screen.getByTestId('psd-blockers').textContent).toContain('Nothing is visible'));
		expect((screen.getByRole('button', { name: 'Write PSD' }) as HTMLButtonElement).disabled).toBe(true);
	});
});

describe('Export Title (TL-114)', () => {
	it('offers trim and margin, on by default for a title', async () => {
		const { session, seqId } = makeSession();
		registerAlphaDialog();
		render(<DialogHost />);
		act(() => {
			void openDialog(ALPHA_DIALOG, {
				session,
				engine: engineWith({ '/scratch': { local: false, projectMedia: { path: '' } } }),
				sequenceId: seqId,
				clipIds: ['c'],
				baseName: 'Title',
				range: { start: 0, end: 10 },
				playhead: 3,
			});
		});
		await waitFor(() => expect(screen.getByTestId('alpha-margin')).toBeTruthy());
		expect(screen.getByRole('dialog').textContent).toContain('10 transparent PNGs');
	});
});

describe('Import Layer Styles (TL-113)', () => {
	const file: LayerStyleFile = {
		fileName: 'gold.asl',
		skipped: ['Plain: no layer effects (blending options only)'],
		styles: [
			{
				name: 'Gold',
				origin: 'style library',
				refPx: 100,
				refKnown: false,
				refNote: 'unknown size',
				style: {
					effects: {
						stroke: [{ enabled: true, size: { units: 'Pixels', value: 6 }, position: 'center', fillType: 'color' }],
						patternOverlay: { enabled: true, pattern: { name: 'Bricks' } },
					},
					baseColor: null,
					ppi: 72,
					globalAngle: 120,
					globalAltitude: 30,
					fillOpacity: 1,
					knockout: false,
				},
			},
		],
	};

	it('shows the report of each style, and importing is one undo step', async () => {
		const { session } = makeSession();
		registerLayerStyleDialog();
		render(<DialogHost />);
		act(() => {
			void openDialog(LAYER_STYLE_DIALOG, { session, engine: engineWith({}), file });
		});
		await waitFor(() => expect(screen.getByTestId('style-mapped').textContent).toContain('Stroke'));
		expect(screen.getByTestId('style-approximated').textContent).toContain('centre stroke');
		expect(screen.getByTestId('style-unsupported').textContent).toContain('Bricks');
		expect(screen.getByTestId('style-skipped').textContent).toContain('Plain');
		fireEvent.click(screen.getByRole('button', { name: 'Import 1 style' }));
		await waitFor(() => expect(titleLooksOf(session.getCommitted()).map((l) => l.name)).toEqual(['Gold']));
		act(() => session.undo());
		expect(titleLooksOf(session.getCommitted())).toEqual([]);
	});

	it('saving refuses cleanly', () => {
		const { session } = makeSession();
		const spy = vi.spyOn(session, 'apply').mockReturnValue({ ok: false, errors: [{ message: 'read-only' }] } as never);
		const r = saveImportedLooks(session, [{ name: 'x', look: { recipe: { layers: [] }, report: { mapped: [], approximated: [], unsupported: [] } } }]);
		expect(r).toEqual({ ok: false, message: 'read-only' });
		spy.mockRestore();
	});
});

