// imports workstream UI (docs/wp-notes/imports.md): the Interpret Footage dialog (sections, one undoable transaction,
// extensible for later sections), the import prompts (image sequence, layered file, PDF pages), the import flow's
// expansion of PDF pages and PSD layers, interpreted pictures in the media runtime, Lottie export, menus.
import type { LayeredExtractResult, LottieExportResult, RegisteredMedia } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import type { MediaAsset } from '@jasper/project';
import { DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { getCommand } from '../src/commands/registry.ts';
import { buildMediaAsset } from '../src/import/assets.ts';
import { createMediaRuntimeSync } from '../src/import/media-runtime.ts';
import {
	ImageSequenceDialog,
	LayeredImportDialog,
	LottieExportDialog,
	PdfPagesDialog,
} from '../src/imports/dialogs.tsx';
import { expandImports } from '../src/imports/import-flow.ts';
import {
	InterpretFootageDialog,
	interpretCommands,
	parseFps,
	registerInterpretSection,
} from '../src/imports/interpret-dialog.tsx';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { makeSession } from './timeline-helpers.ts';
import { registered, ScriptedEngine } from './wp2e/helpers.ts';

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

describe('Interpret Footage dialog', () => {
	it('applies frame rate, pixel aspect, alpha and loop in one undoable step', async () => {
		const { session } = makeSession();
		const id = addMedia(
			session,
			registered('interlaced.mov', { key: 'mk_INTER0001', fps: { num: 30, den: 1 }, seconds: 10 }),
		);
		render(<DialogHost />);
		let closed: unknown = null;
		render(<InterpretFootageDialog session={session} mediaIds={[id]} close={(r) => (closed = r)} />);
		const dialog = await screen.findByTestId('interpret-footage-dialog');
		expect([...dialog.querySelectorAll('section')].map((s) => s.getAttribute('data-section'))).toEqual([
			'frameRate',
			'pixelAspect',
			'fieldOrder',
			'alpha',
			'loop',
		]);
		fireEvent.click(screen.getByTestId('interpret-fr-assume'));
		fireEvent.change(screen.getByTestId('interpret-fr-value'), { target: { value: '23.976' } });
		fireEvent.click(screen.getByLabelText('Ignore Alpha Channel'));
		fireEvent.change(screen.getByTestId('interpret-loop-value'), { target: { value: '3' } });
		expect(screen.getByTestId('interpret-frame-rate').textContent).toMatch(/Duration: 12\.51\d s/);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'OK' }));
		});
		await waitFor(() => expect(closed).not.toBeNull());
		expect(session.getCommitted().media[id]!.interpretation).toEqual({
			frameRate: { num: 24000, den: 1001 },
			alpha: { mode: 'ignore', invert: false },
			loop: 3,
		});
		session.undo();
		expect(session.getCommitted().media[id]!.interpretation).toBeUndefined();
	});

	it('shows only the sections that apply, and later sections plug in with their own commands', () => {
		const { session } = makeSession();
		const still = addMedia(session, registered('still.png', { kind: 'image', key: 'mk_STILL0001' }));
		render(<InterpretFootageDialog session={session} mediaIds={[still]} close={() => {}} />);
		const sections = [...screen.getByTestId('interpret-footage-dialog').querySelectorAll('section')].map(
			(s) => s.getAttribute('data-section'),
		);
		expect(sections).toEqual(['pixelAspect', 'alpha']);
		// A later workstream (colour management) adds a section with its own commands.
		registerInterpretSection({
			id: 'test-colour',
			title: 'Colour',
			order: 60,
			applies: (a) => a.every((x) => x.kind === 'image'),
			component: () => <p>colour</p>,
			commands: (assets) => [{ type: 'item.rename', itemId: assets[0]!.id, name: 'x' } as never],
		});
		const asset = session.getCommitted().media[still] as MediaAsset;
		const cmds = interpretCommands([asset], { patch: { loop: null }, sections: {} });
		expect(cmds.map((c) => c.type)).toEqual(['media.interpret', 'item.rename']);
	});

	it('parses typed frame rates', () => {
		expect(parseFps('29,97')).toEqual({ num: 30000, den: 1001 });
		expect(parseFps('25')).toEqual({ num: 25, den: 1 });
		expect(parseFps('abc')).toBeNull();
	});

	it('is in the Clip ▸ Modify menu and needs footage selected', () => {
		const clip = MENUBAR.find((m) => m.id === 'clip')!;
		const json = JSON.stringify(clip);
		expect(json).toContain('media.interpretFootage');
		const file = JSON.stringify(MENUBAR.find((m) => m.id === 'file')!);
		expect(file).toContain('export.lottie');
		expect(file).toContain('project.importSvgAsShape');
		expect(getCommand('media.interpretFootage')).toBeTruthy();
	});
});

describe('import prompts', () => {
	it('Image Sequence returns the frame rate typed', async () => {
		let out: unknown = null;
		render(
			<ImageSequenceDialog
				groups={[{ label: 'shot_[0001-0012].png', frames: 12, missing: 1 }]}
				defaultRate={{ num: 30, den: 1 }}
				close={(r) => (out = r)}
			/>,
		);
		expect(screen.getByTestId('image-sequence-groups').textContent).toContain('1 missing (held)');
		fireEvent.change(screen.getByTestId('image-sequence-rate'), { target: { value: '23.976' } });
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Import' }));
		});
		expect(out).toEqual({ asSequence: true, frameRate: { num: 24000, den: 1001 } });
	});

	it('Import Layered File lists layers top first and returns the chosen ones', async () => {
		const layer = (index: number, name: string, extra = {}) => ({
			index,
			name,
			kind: 'pixel' as const,
			visible: true,
			opacity: 1,
			blendMode: 'normal' as const,
			clipping: false,
			left: 0,
			top: 0,
			width: 10,
			height: 10,
			media: registered(`${name}.png`, { kind: 'image' }),
			...extra,
		});
		const result: LayeredExtractResult = {
			mediaKey: 'mk_PSD000001',
			info: { format: 'psd', width: 100, height: 100, layerCount: 3 },
			layers: [layer(0, 'Back'), layer(1, 'Front'), layer(2, 'Hidden', { visible: false })],
			warnings: ['Adjustment layer "Curves" is not carried'],
		};
		let out: unknown = null;
		render(<LayeredImportDialog name="doc.psd" result={result} close={(r) => (out = r)} />);
		const items = [...screen.getByTestId('layered-layers').querySelectorAll('li')].map(
			(li) => li.textContent,
		);
		expect(items[0]).toContain('Hidden');
		expect(items[2]).toContain('Back');
		expect(screen.getByText(/Curves/)).toBeTruthy();
		fireEvent.click(screen.getByLabelText('Front'));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'OK' }));
		});
		expect(out).toEqual({ mode: 'sequence', selected: [0] });
	});

	it('PDF pages returns the ticked pages in order', async () => {
		let out: unknown = null;
		render(
			<PdfPagesDialog
				name="doc.pdf"
				pages={[
					{ page: 1, width: 612, height: 792 },
					{ page: 2, width: 792, height: 612 },
				]}
				close={(r) => (out = r)}
			/>,
		);
		fireEvent.click(screen.getByLabelText(/Page 2/));
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Import' }));
		});
		expect(out).toEqual([1, 2]);
	});
});

describe('import flow and media runtime', () => {
	it('expands PDF pages and PSD layers into one transaction', async () => {
		const { session } = makeSession();
		const engine = new ScriptedEngine();
		const pdf = {
			...registered('doc.pdf', { kind: 'image', key: 'mk_PDF000001', width: 612, height: 792 }),
			vector: {
				format: 'pdf' as const,
				width: 612,
				height: 792,
				page: 1,
				pageCount: 2,
				source: 'pdf' as const,
			},
		};
		const psd = {
			...registered('doc.psd', { kind: 'image', key: 'mk_PSD000001', width: 100, height: 80 }),
			layered: { format: 'psd' as const, width: 100, height: 80, layerCount: 2 },
		};
		const job = (result: unknown) => ({
			id: 'job_l',
			kind: 'layers',
			state: 'succeeded',
			title: 'Layers',
			priority: 'interactive',
			cpuSlots: 1,
			progress: 1,
			stage: 'Done',
			createdAt: '2026-10-07T00:00:00.000Z',
			origin: { type: 'user' },
			result,
		});
		engine.on((r) => {
			if (r.path === '/api/imports/vector/mk_PDF000001')
				return {
					body: {
						mediaKey: 'mk_PDF000001',
						vector: pdf.vector,
						pages: [
							{ page: 1, width: 612, height: 792 },
							{ page: 2, width: 792, height: 612 },
						],
					},
				};
			if (r.path === '/api/imports/layers')
				return {
					status: 202,
					body: job({
						mediaKey: 'mk_PSD000001',
						info: psd.layered,
						layers: [0, 1].map((i) => ({
							index: i,
							name: `L${i}`,
							kind: 'pixel',
							visible: true,
							opacity: 1,
							blendMode: i ? 'screen' : 'normal',
							clipping: false,
							left: 0,
							top: 0,
							width: 100,
							height: 80,
							media: registered(`L${i}.png`, { kind: 'image', key: `mk_LAYER000${i}` }),
						})),
						warnings: [],
					}),
				};
			return undefined;
		});
		const prompts = {
			pdfPages: async () => [2],
			layered: async () => ({ mode: 'sequence' as const, selected: [0, 1] }),
		};
		const out = await expandImports(
			{ engine: engine.client(), session, prompts: prompts as never },
			[
				{ reg: pdf, name: 'doc.pdf', path: null },
				{ reg: psd, name: 'doc.psd', path: null },
			],
			null,
		);
		expect(out.failed).toEqual([]);
		expect(out.acquired).toHaveLength(1);
		expect(out.acquired[0]!.name).toBe('doc.pdf (page 2)');
		expect(out.acquired[0]!.reg.vector).toMatchObject({ page: 2, width: 792, height: 612 });
		const types = out.commands.map((c) => c.type);
		expect(types.filter((t) => t === 'media.register')).toHaveLength(2);
		expect(types).toContain('sequence.create');
		const r = session.apply({ label: 'Import', origin: 'user', commands: out.commands });
		expect(r.ok).toBe(true);
	});

	it('requests the interpreted picture of a media and follows it to ready', async () => {
		const { session } = makeSession();
		const engine = new ScriptedEngine();
		engine.on((r) =>
			r.path.startsWith('/api/media/mk_INTER0002/variants')
				? { body: { state: 'queued', jobId: 'job_v' } }
				: r.path === '/api/media/mk_INTER0002'
					? { body: { mediaKey: 'mk_INTER0002', status: 'online', derivatives: {} } }
					: undefined,
		);
		const listeners = new Set<(e: unknown) => void>();
		const sync = createMediaRuntimeSync(session, engine.client(), (l) => {
			listeners.add(l as never);
			return () => listeners.delete(l as never);
		});
		const id = addMedia(session, registered('inter.mov', { key: 'mk_INTER0002' }));
		session.apply({
			label: 'Interpret Footage',
			origin: 'user',
			commands: [
				{ type: 'media.interpret', mediaIds: [id], interpretation: { fieldOrder: 'upper' } } as never,
			],
		});
		await waitFor(() =>
			expect(session.getState().media[id]?.variant).toMatchObject({ key: 'proxy:fo=upper', state: 'queued' }),
		);
		const req = engine.requests.find((q) => q.path.endsWith('/variants'))!;
		expect(req.body).toEqual({ kind: 'proxy', variant: 'fo=upper' });
		for (const l of listeners)
			l({
				id: 2,
				type: 'media.variant.ready',
				createdAt: 't',
				payload: {
					mediaKey: 'mk_INTER0002',
					kind: 'proxy',
					variant: 'fo=upper',
					url: '/media/mk_INTER0002/variant/proxy?v=fo%3Dupper',
				},
			});
		expect(session.getState().media[id]!.variant).toMatchObject({ state: 'ready' });
		sync.dispose();
	});
});

describe('Lottie export dialog', () => {
	it('exports and lists what was not carried', async () => {
		const { session, seqId } = makeSession();
		const calls: { url: string; body: unknown }[] = [];
		const result: LottieExportResult = {
			warnings: ['Clip "clip.mp4": video is not part of Lottie'],
			layers: 2,
			bytes: 2048,
			contentBase64: btoa('{"v":"5.12.0"}'),
			fileName: 'Sequence_01.json',
		};
		const engine = new EngineClient({
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
				return new Response(JSON.stringify(result), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}) as typeof fetch,
		});
		render(<LottieExportDialog session={session} engine={engine} sequenceId={seqId} close={() => {}} />);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Export' }));
		});
		expect(await screen.findByTestId('lottie-export-result')).toBeTruthy();
		expect(screen.getByTestId('lottie-export-warnings').textContent).toContain('video is not part of Lottie');
		expect(screen.getByTestId('lottie-export-download').getAttribute('download')).toBe('Sequence_01.json');
		const body = calls.find((c) => c.url.endsWith('/api/imports/lottie/export'))!.body as {
			sequenceId: string;
			format: string;
		};
		expect(body).toMatchObject({ sequenceId: seqId, format: 'json' });
	});
});
