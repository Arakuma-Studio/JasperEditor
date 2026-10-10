// polish: the Media Browser panel, File ▸ Import from Media Browser, Engine ▸ Connect / Status, Edit Parameters and
// Third-Party Notices.
import type { BrowseEntry } from '@jasper/api';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetAgentInputForTests, runAgentInput } from '../src/agent-bridge/agent-input.ts';
import { createCommandContext, getCommand, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { MG_PARAMETERS_SECTION, selectedMotionGraphics } from '../src/commands/polish.ts';
import { readDataTransfer } from '../src/import/service.ts';
import { getMediaBrowser, registerMediaBrowser } from '../src/panels/mediaBrowser/instances.ts';
import {
	formatBytes,
	MediaBrowserPanel,
	visibleEntries,
} from '../src/panels/mediaBrowser/MediaBrowserPanel.tsx';
import {
	ENGINE_DIALOGS,
	featureRows,
	normalizeEngineAddress,
	readEngineSnapshot,
	registerEngineDialogs,
} from '../src/shell/engine-dialogs.tsx';
import { EngineProvider } from '../src/state/engine.tsx';
import { PanelServices } from '../src/state/panel-services.ts';
import { HOST_PATHS_MIME, registerImportService, writeHostPathsDrag } from '../src/state/services.ts';
import { memorySession, ScriptedEngine } from './wp2e/helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => {
	cleanup();
	localStorage.clear();
});

const entry = (
	name: string,
	kind: 'folder' | 'file',
	category: BrowseEntry['category'] = null,
): BrowseEntry => ({
	name,
	path: `/media/${name}`,
	kind,
	size: kind === 'file' ? 1_500_000 : null,
	modifiedAt: '2026-10-01T10:00:00.000Z',
	category,
	hidden: false,
});

const CAPS = {
	engine: { version: '0.1.0', apiVersion: 1, mode: 'local', pathRegistration: true },
	media: {
		ffmpegVersion: '7.1',
		ffprobeVersion: '7.1',
		encoders: [],
		filters: [],
		ffmpegSource: 'vendor',
		encoding: {
			license: 'lgpl',
			lgplOnly: true,
			hwaccels: [],
			hardware: [{ encoder: 'h264_nvenc', usable: false }],
			codecs: { h264: ['libopenh264'], vp9: [], av1: [] },
			audio: { aac: true, opus: true },
			prores: true,
			export: {
				codec: 'h264',
				encoder: 'libopenh264',
				label: 'H.264 · OpenH264',
				hardware: false,
				container: 'mp4',
				audioEncoder: 'aac',
				rateControl: 'bitrate',
				gpl: false,
			},
			proxy: null,
		},
	},
	render: {
		native: true,
		remotionLocal: 'ready',
		fframes: 'unavailable',
		fframesReason: 'jasper-mg not built',
	},
	fonts: { bundledCatalog: true, systemFonts: false, customUpload: true },
	features: { color: { lut3d: true, remotionWebgl: 'ok' } },
	limits: { maxUploadBytes: null, freeDiskBytes: 5e11, cpuCount: 12, maxJsonBodyBytes: 1 },
};

function browseEngine() {
	const engine = new ScriptedEngine();
	const folders: Record<string, BrowseEntry[]> = {
		'/home/u': [
			entry('Footage', 'folder'),
			entry('a.mp4', 'file', 'video'),
			entry('tone.wav', 'file', 'audio'),
		],
		'/media/Footage': [entry('b.mov', 'file', 'video')],
	};
	engine.on((r) => {
		if (r.path === '/api/capabilities') return { body: CAPS };
		if (r.path === '/api/browse/roots')
			return {
				body: {
					sep: '/',
					home: '/home/u',
					roots: [
						{ label: 'Home', path: '/home/u', kind: 'home' },
						{ label: 'File System', path: '/', kind: 'root' },
					],
				},
			};
		if (r.path === '/api/browse/list') {
			const path = r.query.get('path')!;
			const entries = folders[path];
			if (!entries)
				return {
					status: 404,
					body: { code: 'NOT_FOUND', message: 'The folder not found', retryable: false },
				};
			return {
				body: { path, parent: path === '/media/Footage' ? '/home/u' : null, entries, truncated: false },
			};
		}
		if (r.path === '/api/browse/info')
			return {
				body: {
					path: r.query.get('path'),
					name: 'a.mp4',
					size: 1_500_000,
					modifiedAt: '2026-10-01T10:00:00.000Z',
					category: 'video',
					media: {
						durationSec: 10,
						width: 1920,
						height: 1080,
						fps: 29.97,
						videoCodec: 'h264',
						audioCodec: 'aac',
						sampleRate: 48000,
						channels: 2,
						browserPlayable: 'yes',
					},
				},
			};
		return undefined;
	});
	return engine;
}

const row = (name: string) =>
	screen.getAllByTestId('media-browser-entry').find((el) => el.textContent?.includes(name)) as HTMLElement;

async function mountBrowser(session: EditorSession | null, engine = browseEngine()) {
	render(
		<EngineProvider client={engine.client()}>
			<MemoryRouter initialEntries={['/']}>
				{session ? (
					<SessionProvider session={session}>
						<MediaBrowserPanel instanceId="mb" visible />
					</SessionProvider>
				) : (
					<MediaBrowserPanel instanceId="mb" visible />
				)}
			</MemoryRouter>
		</EngineProvider>,
	);
	await waitFor(() => expect(screen.getAllByTestId('media-browser-entry').length).toBe(3));
	return engine;
}

describe('Media Browser helpers', () => {
	it('filters by type and search, keeping folders', () => {
		const list = [
			entry('Footage', 'folder'),
			entry('a.mp4', 'file', 'video'),
			entry('tone.wav', 'file', 'audio'),
		];
		expect(visibleEntries(list, 'supported', '').length).toBe(3);
		expect(visibleEntries(list, 'audio', '').map((e) => e.name)).toEqual(['Footage', 'tone.wav']);
		expect(visibleEntries(list, 'supported', 'TONE').map((e) => e.name)).toEqual(['tone.wav']);
	});
	it('formats sizes', () => {
		expect(formatBytes(999)).toBe('999 B');
		expect(formatBytes(1_500_000)).toBe('1.5 MB');
		expect(formatBytes(25_000_000_000)).toBe('25 GB');
		expect(formatBytes(null)).toBe('');
		expect(formatBytes(Number.NaN)).toBe('');
	});
	it('a Media Browser drag reads as host paths', () => {
		const data = new Map<string, string>();
		const dt = {
			setData: (k: string, v: string) => data.set(k, v),
			getData: (k: string) => data.get(k) ?? '',
			get types() {
				return [...data.keys()];
			},
			files: [],
			effectAllowed: 'none',
		} as unknown as DataTransfer;
		writeHostPathsDrag(dt, ['/media/a.mp4', '/media/b.mov']);
		expect(dt.types).toContain(HOST_PATHS_MIME);
		expect(readDataTransfer(dt)).toEqual({
			type: 'os-files',
			files: [],
			paths: ['/media/a.mp4', '/media/b.mov'],
		});
		data.set(HOST_PATHS_MIME, '{broken');
		expect(readDataTransfer(dt)).toBeNull();
	});
});

describe('Media Browser panel', () => {
	it('lists the start folder, navigates into folders and back up, and previews the selected file', async () => {
		const { session } = await memorySession();
		const engine = await mountBrowser(session);
		expect(screen.getByTestId('media-browser-count').textContent).toBe('3 items');
		expect((screen.getByTestId('media-browser-path') as HTMLInputElement).value).toBe('/home/u');

		fireEvent.click(screen.getByText('a.mp4'));
		await waitFor(() =>
			expect(screen.getByTestId('media-browser-facts').textContent).toContain('1920 × 1080'),
		);
		expect(screen.getByTestId('media-browser-facts').textContent).toContain('29.97 fps');
		const video = screen.getByTestId('media-browser-video') as HTMLVideoElement;
		expect(video.getAttribute('src')).toBe('/api/browse/file?path=%2Fmedia%2Fa.mp4');
		expect(screen.getByTestId('media-browser-count').textContent).toBe('3 items · 1 selected');

		fireEvent.doubleClick(screen.getByText('Footage'));
		await waitFor(() => expect(screen.getByText('b.mov')).toBeTruthy());
		expect(engine.requests.some((r) => r.path === '/api/browse/list')).toBe(true);
		expect((screen.getByTestId('media-browser-path') as HTMLInputElement).value).toBe('/media/Footage');
		fireEvent.click(screen.getByTestId('media-browser-up'));
		await waitFor(() => expect(screen.getByText('tone.wav')).toBeTruthy());
		// the last folder is remembered for the next time the panel opens
		expect(JSON.parse(localStorage.getItem('jasper:media-browser') ?? '{}').path).toBe('/home/u');
	});

	it('imports the selected files in place through the import service (button, command and double-click)', async () => {
		const { session } = await memorySession();
		const importFiles = vi.fn(async () => ({ mediaIds: ['m1'], clipIds: [], failed: [], registered: [] }));
		const off = registerImportService({
			importFiles,
			describe: () => 'Imported 1 file',
			placeItems: async () => ({ clipIds: [] }),
			readDataTransfer: () => null,
		} as never);
		try {
			await mountBrowser(session);
			fireEvent.click(screen.getByText('a.mp4'));
			fireEvent.click(screen.getByText('tone.wav'), { ctrlKey: true });
			expect(screen.getByTestId('media-browser-import').textContent).toBe('Import 2 Files');
			expect(getMediaBrowser()?.selectedFiles()).toEqual(['/media/a.mp4', '/media/tone.wav']);
			await act(async () => {
				fireEvent.click(screen.getByTestId('media-browser-import'));
			});
			expect(importFiles).toHaveBeenLastCalledWith(
				{ paths: ['/media/a.mp4', '/media/tone.wav'] },
				{ kind: 'bin', binId: null },
			);

			// File ▸ Import from Media Browser imports the same selection.
			const ctx = createCommandContext({
				engine: new ScriptedEngine().client(),
				session,
				capabilities: ['engine'],
			});
			await act(async () => {
				await runCommand('project.importFromMediaBrowser', ctx);
			});
			expect(importFiles).toHaveBeenCalledTimes(2);

			// Double-click imports the file under the pointer.
			await act(async () => {
				fireEvent.doubleClick(row('tone.wav'));
			});
			expect(importFiles).toHaveBeenCalledTimes(3);
		} finally {
			off();
		}
	});

	it('says why it cannot browse on a remote engine', async () => {
		const engine = new ScriptedEngine().on((r) =>
			r.path.startsWith('/api/browse/')
				? { status: 403, body: { code: 'LOCAL_MODE_ONLY', message: 'local only', retryable: false } }
				: undefined,
		);
		render(
			<EngineProvider client={engine.client()}>
				<MediaBrowserPanel instanceId="mb" visible />
			</EngineProvider>,
		);
		await waitFor(() => expect(screen.getByText('The Media Browser needs a local engine')).toBeTruthy());
	});
});

describe('polish commands', () => {
	it('Import from Media Browser opens the panel when nothing is selected', async () => {
		const { session } = await memorySession();
		const services = new PanelServices();
		const focusPanel = vi.fn();
		services.register('shell', 'shell', { focusPanel } as never);
		const toast = vi.fn();
		const ctx = createCommandContext({
			engine: new ScriptedEngine().client(),
			session,
			services,
			capabilities: ['engine'],
			toast,
		});
		await runCommand('project.importFromMediaBrowser', ctx);
		expect(focusPanel).toHaveBeenCalledWith('mediaBrowser');
		expect(toast).toHaveBeenCalled();

		const importSelected = vi.fn(async () => 2);
		const off = registerMediaBrowser({
			selectedFiles: () => ['/x/a.mp4'],
			importSelected,
			goUp: vi.fn(),
			refresh: vi.fn(),
			toggleAllFiles: vi.fn(),
			showsAllFiles: () => false,
		});
		await runCommand('project.importFromMediaBrowser', ctx);
		expect(importSelected).toHaveBeenCalledTimes(1);
		expect(focusPanel).toHaveBeenCalledTimes(1);
		off();
	});

	it('Edit Parameters needs a motion-graphic clip and reveals Properties ▸ Parameters', async () => {
		const { session } = await memorySession();
		const services = new PanelServices();
		const focusPanel = vi.fn();
		services.register('shell', 'shell', { focusPanel } as never);
		const ctx = createCommandContext({ engine: new ScriptedEngine().client(), session, services });
		const cmd = getCommand('mg.editParameters')!;
		expect(cmd.when?.(ctx)).toBe(false);
		expect(cmd.disabledReason?.(ctx)).toMatch(/motion-graphic/);

		const seqId = session.getState().activeSequenceId!;
		const r = session.apply({
			label: 'mg',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'clip.addMotionGraphic',
					template: { id: 'lower-third', version: 1 },
					at: 0,
					duration: 90,
					track: 'V1',
				} as never,
			],
		});
		expect(r.ok, JSON.stringify(r)).toBe(true);
		const clipId = Object.keys(session.getCommitted().sequences[seqId]!.clips)[0]!;
		session.select('timeline', [clipId], 'replace', { primary: clipId, linked: false });
		expect(selectedMotionGraphics(ctx)).toEqual([clipId]);
		expect(cmd.when?.(ctx)).toBe(true);
		await runCommand('mg.editParameters', ctx);
		expect(focusPanel).toHaveBeenCalledWith('properties');
		expect(JSON.parse(localStorage.getItem('jasper.inspector.sections') ?? '{}')[MG_PARAMETERS_SECTION]).toBe(
			true,
		);
	});

	it('Engine Status, Connect and Third-Party Notices open their dialogs', async () => {
		const opened: string[] = [];
		const ctx = createCommandContext({
			engine: new ScriptedEngine().client(),
			openDialog: (kind) => void opened.push(kind),
		});
		await runCommand('engine.status', ctx);
		await runCommand('engine.connect', ctx);
		await runCommand('app.notices', ctx);
		expect(opened).toEqual([ENGINE_DIALOGS.status, ENGINE_DIALOGS.connect, ENGINE_DIALOGS.notices]);
	});
});

describe('engine dialogs', () => {
	it('normalises engine addresses', () => {
		expect(normalizeEngineAddress('127.0.0.1:47900')).toBe('http://127.0.0.1:47900');
		expect(normalizeEngineAddress(' https://box.local:8443/project/x?y=1 ')).toBe('https://box.local:8443');
		expect(normalizeEngineAddress('ftp://x')).toBeNull();
		expect(normalizeEngineAddress('javascript:alert(1)')).toBeNull();
		expect(normalizeEngineAddress('http://user:pw@host')).toBeNull();
		expect(normalizeEngineAddress('')).toBeNull();
		expect(normalizeEngineAddress('http://')).toBeNull();
	});

	it('summarises feature blocks', () => {
		expect(
			featureRows({
				speech: { status: 'unavailable', reason: 'model not installed' },
				color: { lut3d: true, remotionWebgl: 'ok' },
				odd: null,
			} as never),
		).toEqual([
			['color', 'lut3d: true, remotionWebgl: ok'],
			['speech', 'unavailable (model not installed)'],
		]);
		expect(featureRows(undefined)).toEqual([]);
	});

	it('reads a snapshot and reports an unreachable engine without throwing', async () => {
		const ok = await readEngineSnapshot(browseEngine().client());
		expect(ok.health?.version).toBe('0.1.0');
		expect(ok.capabilities?.render.native).toBe(true);
		expect(ok.jobs).toEqual({ running: 0, queued: 0 });
		const down = new ScriptedEngine().on(() => ({
			status: 503,
			body: { code: 'UNAVAILABLE', message: 'down', retryable: true },
		}));
		const bad = await readEngineSnapshot(down.client());
		expect(bad.health).toBeNull();
		expect(bad.error).toMatch(/UNAVAILABLE|down/);
	});

	it('Engine Status shows the live engine facts; Connect reconnects to this engine', async () => {
		registerEngineDialogs();
		const engine = browseEngine();
		render(
			<EngineProvider client={engine.client()}>
				<DialogHost />
			</EngineProvider>,
		);
		act(() => void openDialog(ENGINE_DIALOGS.status, { engine: engine.client() }));
		await waitFor(() => expect(screen.getByTestId('engine-status-state').textContent).toBe('Connected'));
		const text = screen.getByTestId('engine-status-dialog').textContent ?? '';
		expect(text).toContain('H.264 · OpenH264');
		expect(text).toContain('LGPL (LGPL only)');
		expect(text).toContain('h264_nvenc (Not usable)');
		expect(text).toContain('Unavailable (jasper-mg not built)');
		expect(text).toContain('12');
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));

		act(() => void openDialog(ENGINE_DIALOGS.connect, { engine: engine.client() }));
		const field = (await screen.findByTestId('engine-connect-address')) as HTMLInputElement;
		expect(field.value).toBe(window.location.origin);
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
		});
		await waitFor(() =>
			expect(screen.getByTestId('engine-connect-result').textContent).toBe('Connected to engine 0.1.0'),
		);
		// an agent's live-UI input may not send the window to another address
		fireEvent.change(field, { target: { value: 'http://127.0.0.1:9' } });
		await runAgentInput(async () => {
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
			});
		});
		expect(screen.getByTestId('engine-connect-result').textContent).toMatch(/Only the user/);
		resetAgentInputForTests();
		fireEvent.change(field, { target: { value: 'not a url ::' } });
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
		});
		expect(screen.getByTestId('engine-connect-result').textContent).toMatch(/Enter an address/);
	});
});
