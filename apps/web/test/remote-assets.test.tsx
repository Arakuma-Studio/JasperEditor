// social-comment §7.8 (editor side): template fonts / emoji resolve through the engine catalogue; the Program monitor's
// warning lists what is not available and retries; Preferences ▸ Privacy & Network; the one-time download notice.
import type { FontCatalog, RemoteAssetsStatus } from '@jasper/api';
import type { RenderDoc } from '@jasper/compositions';
import { toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplateAssetWarning } from '../src/remote-assets/issues.tsx';
import { RemoteAssetsNoticeHost } from '../src/remote-assets/notice.tsx';
import { PrivacyNetworkPage } from '../src/remote-assets/PrivacyNetworkPage.tsx';
import { catalogAssetResolver, catalogTemplateAssets } from '../src/remote-assets/resolve.ts';
import { EngineProvider } from '../src/state/engine.tsx';
import { ScriptedEngine } from './wp2e/helpers.ts';

const GRIN = '\u{1F600}';

afterEach(() => {
	cleanup();
	toasts.dismissAll();
	toasts.clearLog();
});

const catalog: FontCatalog = {
	fonts: [
		{
			family: 'Roboto',
			source: 'bundled',
			weights: [400, 700],
			styles: ['normal'],
			files: [
				{
					weight: 400,
					style: 'normal',
					subset: 'latin-ext',
					url: '/fonts/roboto/roboto-latin-ext-400-normal.woff2',
				},
				{ weight: 400, style: 'normal', subset: 'latin', url: '/fonts/roboto/roboto-latin-400-normal.woff2' },
			],
		},
		{
			family: 'Chirp',
			source: 'remote',
			weights: [700],
			styles: ['normal'],
			files: [{ weight: 700, style: 'normal', url: '/fonts/remote/chirp-700-0123456789abcdef.woff2' }],
		},
	],
	emojiPacks: [
		{ id: 'apple', name: 'Apple', version: '18.4', format: 'png', licence: 'proprietary', attribution: null },
	],
};

describe('catalogue resolution', () => {
	it('resolves exact faces (bundled latin file first, then remote) and pack emoji paths', () => {
		const r = catalogAssetResolver(catalog);
		expect(r.font({ family: 'roboto', weight: 400, style: 'normal' })).toEqual([
			{ url: '/fonts/roboto/roboto-latin-400-normal.woff2' },
		]);
		expect(r.font({ family: 'Chirp', weight: 700, style: 'normal' })).toEqual([
			{ url: '/fonts/remote/chirp-700-0123456789abcdef.woff2' },
		]);
		// subset files with unicode ranges are loaded together
		const ranged = catalogAssetResolver({
			fonts: [
				{
					family: 'TikTok Sans',
					source: 'bundled',
					files: [
						{ weight: 700, style: 'normal', subset: 'latin', unicodeRange: 'U+0000-00FF', url: '/a.woff2' },
						{
							weight: 700,
							style: 'normal',
							subset: 'latin-ext',
							unicodeRange: 'U+0100-02BA',
							url: '/b.woff2',
						},
					],
				},
			],
		});
		expect(ranged.font({ family: 'TikTok Sans', weight: 700, style: 'normal' })).toEqual([
			{ url: '/a.woff2', unicodeRange: 'U+0000-00FF' },
			{ url: '/b.woff2', unicodeRange: 'U+0100-02BA' },
		]);
		// never another weight, style or family
		expect(r.font({ family: 'Chirp', weight: 400, style: 'normal' })).toBeNull();
		expect(r.font({ family: 'Roboto', weight: 400, style: 'italic' })).toBeNull();
		expect(r.font({ family: 'SF Pro', weight: 400, style: 'normal' })).toBeNull();
		expect(r.emoji('apple', GRIN)).toBe('/fonts/emoji/apple/18.4/1f600.png');
		expect(r.emoji('apple', 'a')).toBeNull();
		expect(r.emoji('noto', GRIN)).toBeNull();
		expect(catalogAssetResolver(catalog)).toBe(r);
		expect(catalogAssetResolver(null).font({ family: 'Roboto', weight: 400, style: 'normal' })).toBeNull();
		expect(
			catalogTemplateAssets(catalog).required({ template: { id: 'nope', version: 1 }, params: {} }),
		).toBeNull();
	});
});

function docWith(o: { emoji?: Record<string, string>; warnings?: RenderDoc['warnings'] } = {}): RenderDoc {
	return {
		version: 1,
		sequenceId: 's',
		settings: {
			width: 1080,
			height: 1920,
			fps: { num: 30, den: 1 },
			backgroundColor: [0, 0, 0, 1],
			sampleRate: 48000,
		},
		range: { start: 0, end: 30 },
		durationFrames: 30,
		videoTracks: [
			{
				trackId: 'v1',
				clips: [
					{
						clipId: 'c1',
						name: 'Reply card',
						source: {
							mg: {
								template: { id: 'social-comment', version: 1 },
								params: {},
								canvas: { width: 1080, height: 1920 },
								renderer: 'anime',
								assets: {
									fonts: [{ family: 'Chirp', weight: 700, style: 'normal' }],
									emoji: [{ pack: 'apple', graphemes: [GRIN] }],
								},
							},
						},
					} as never,
				],
			},
		],
		audioClips: [],
		media: {},
		fonts: [],
		...(o.emoji ? { emoji: o.emoji } : {}),
		master: { volumeDb: { value: 0, keyframes: [] } },
		warnings: o.warnings ?? [],
	};
}

describe('Program monitor warning', () => {
	it('is absent when nothing is missing', () => {
		const r = render(
			<TemplateAssetWarning
				doc={docWith()}
				reported={new Map()}
				engine={{ issues: [], retry: async () => null }}
			/>,
		);
		expect(r.container.innerHTML).toBe('');
	});

	it('lists engine failures, unresolved assets and Player reports with their clips; Retry asks the engine again', async () => {
		const retry = vi.fn(async () => ({
			available: 0,
			missing: [
				{
					kind: 'font' as const,
					family: 'Chirp',
					weight: 700,
					style: 'normal' as const,
					error: { code: 'REMOTE_ASSETS_OFF', message: 'off', retryable: false },
				},
			],
		}));
		render(
			<TemplateAssetWarning
				doc={docWith({
					warnings: [{ clipId: 'c1', code: 'TEMPLATE_EMOJI_UNAVAILABLE', message: 'Emoji … not available' }],
				})}
				reported={new Map([['c1', [{ kind: 'font', family: 'Chirp', weight: 700, style: 'normal' }]]])}
				engine={{
					issues: [
						{
							asset: { kind: 'font', family: 'Chirp', weight: 700, style: 'normal' },
							reason:
								'The font "Chirp 700" is not downloaded and "Platform fonts & emoji for social templates" is off',
							code: 'REMOTE_ASSETS_OFF',
						},
					],
					retry,
				}}
			/>,
		);
		const chip = screen.getByTestId('program-template-assets-chip');
		expect(chip.textContent).toContain('2 template assets not available');
		fireEvent.click(chip);
		const list = screen.getByTestId('program-template-assets-list');
		expect(list.textContent).toContain('Font "Chirp" 700');
		expect(list.textContent).toContain('Reply card');
		expect(list.textContent).toContain('is off');
		expect(list.textContent).toContain(`Emoji ${GRIN} (apple)`);
		expect(list.textContent).toContain('Not bundled and not in the remote-asset manifest');
		await act(async () => {
			fireEvent.click(screen.getByTestId('program-template-assets-retry'));
		});
		expect(retry).toHaveBeenCalledTimes(1);
		await waitFor(() =>
			expect(JSON.stringify(toasts.getState())).toContain(
				'Some template fonts or emoji are still not available',
			),
		);
	});
});

function status(o: Partial<RemoteAssetsStatus> = {}): RemoteAssetsStatus {
	return {
		settings: { platformAssets: true },
		manifest: { version: 1, fonts: 1, emojiPacks: 1, images: 1, override: { status: 'absent' } },
		fonts: [
			{
				id: 'chirp-700',
				family: 'Chirp',
				weight: 700,
				style: 'normal',
				cached: true,
				host: 'fonts.example',
				licence: 'x',
			},
		],
		emojiPacks: [
			{
				id: 'apple',
				name: 'Apple',
				version: '1',
				host: 'em.example',
				licence: 'x',
				attribution: null,
				cached: 3,
			},
		],
		images: [{ id: 'x-default-avatar', cached: false, host: 'img.example', licence: 'x' }],
		notice: { pending: false, firstFetchAt: null, items: [] },
		...o,
	};
}

describe('Preferences ▸ Privacy & Network', () => {
	it('shows the platform-assets setting with its status and saves a change to the engine', async () => {
		const engine = new ScriptedEngine();
		let current = status();
		engine.on((r) => {
			if (r.path === '/api/remote-assets') return { body: current };
			if (r.path === '/api/settings/network' && r.method === 'PUT') {
				current = status({ settings: r.body as RemoteAssetsStatus['settings'] });
				return { body: r.body };
			}
			return undefined;
		});
		render(
			<EngineProvider client={engine.client()}>
				<PrivacyNetworkPage />
			</EngineProvider>,
		);
		await waitFor(() =>
			expect(screen.getByTestId('prefs-platform-assets-status').textContent).toContain(
				'1 of 1 fonts, 3 emoji images',
			),
		);
		expect(screen.getByTestId('prefs-platform-assets-status').textContent).toContain(
			'em.example, fonts.example',
		);
		const box = screen.getByRole('checkbox');
		expect(box.getAttribute('data-state')).toBe('checked');
		await act(async () => {
			fireEvent.click(box);
		});
		await waitFor(() =>
			expect(
				engine.requests.find((q) => q.method === 'PUT' && q.path === '/api/settings/network')?.body,
			).toEqual({
				platformAssets: false,
			}),
		);
		await waitFor(() => expect(screen.getByRole('checkbox').getAttribute('data-state')).toBe('unchecked'));
	});
});

describe('first-download notice', () => {
	it('is shown once with what was fetched and from where, then acknowledged', async () => {
		const engine = new ScriptedEngine();
		engine.on((r) => {
			if (r.path === '/api/remote-assets')
				return {
					body: status({
						notice: {
							pending: true,
							firstFetchAt: '2026-10-25T00:00:00.000Z',
							items: [{ kind: 'font', label: 'Chirp 700', host: 'fonts.example', licence: 'x' }],
						},
					}),
				};
			if (r.path === '/api/remote-assets/notice/ack') return { body: status() };
			return undefined;
		});
		render(
			<EngineProvider client={engine.client()}>
				<RemoteAssetsNoticeHost />
				<RemoteAssetsNoticeHost />
			</EngineProvider>,
		);
		await waitFor(() =>
			expect(engine.requests.some((q) => q.path === '/api/remote-assets/notice/ack')).toBe(true),
		);
		const shown = toasts.getState().toasts.filter((t) => t.title.startsWith('Downloaded platform fonts'));
		expect(shown).toHaveLength(1);
		expect(shown[0]!.detail).toContain('Chirp 700 (fonts.example)');
		expect(shown[0]!.detail).toContain('not redistributed');
	});
});
