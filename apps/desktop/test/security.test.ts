// Desktop window guards and helpers (ARCHITECTURE §12, R-OMS §8.5): pure functions, no Electron needed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CLIPBOARD_FILE_LIST_TYPE,
	clipboardReadResult,
	ELECTRON_CLIPBOARD_FORMAT,
	isCaptureRect,
	isClipboardWrite,
	isExternalUrlAllowed,
	isPermissionAllowed,
	isRevealablePath,
	isSameOrigin,
	isWindowAction,
	mcpLaunchInfo,
	parseClipboardFileList,
} from '../src/security.ts';

describe('clipboard bridge (wp-clipboard, S01:CLB-002/009)', () => {
	const json = JSON.stringify({ format: 'jasper-clipboard', version: 1, kind: 'clips' });
	it('writes only sane JasperEditor payloads under the custom format', () => {
		expect(ELECTRON_CLIPBOARD_FORMAT).toBe(
			'electron application/osclipboard;format="application/x-jasper-clipboard"',
		);
		expect(isClipboardWrite({ json, html: '<span></span>', text: 'Title' })).toBe(true);
		for (const bad of [
			null,
			'x',
			{ json, html: 1, text: '' },
			{ json: '{"format":"other"}', html: '', text: '' },
			{ json: 'not json', html: '', text: '' },
			{ json: `{"format":"jasper-clipboard","x":"${'a'.repeat(20 * 1024 * 1024)}"}`, html: '', text: '' },
		])
			expect(isClipboardWrite(bad)).toBe(false);
	});
	it('reads back only the format JSON within the cap', () => {
		expect(clipboardReadResult(json)).toBe(json);
		expect(clipboardReadResult('{"format":"x"}')).toBeNull();
		expect(clipboardReadResult(42)).toBeNull();
		expect(clipboardReadResult(' '.repeat(20 * 1024 * 1024 + 1))).toBeNull();
	});
});

describe('external files on the clipboard (wp-clipboard-2, S01:CLB-010)', () => {
	it('parses uri-lists and GNOME copies into local absolute paths only', () => {
		expect(
			parseClipboardFileList(
				'# comment\r\nfile:///home/me/a%20b.mov\r\nhttps://example.com/x.mp4\r\nfile://otherhost/c.png\r\nfile:///home/me/a%20b.mov\r\n',
				'linux',
			),
		).toEqual(['/home/me/a b.mov']);
		expect(
			parseClipboardFileList('copy\nfile:///tmp/one.png\nfile://localhost/tmp/two.wav', 'linux'),
		).toEqual(['/tmp/one.png', '/tmp/two.wav']);
		expect(parseClipboardFileList('file:///C:/Media/clip.mp4', 'win32')).toEqual(['C:\\Media\\clip.mp4']);
		expect(parseClipboardFileList('file:///bad%E0%A4%A', 'linux')).toEqual([]);
		expect(parseClipboardFileList('file:///nul%00x', 'linux')).toEqual([]);
		expect(parseClipboardFileList(42)).toEqual([]);
		const many = Array.from({ length: 505 }, (_, i) => `file:///f/${i}.png`).join('\n');
		expect(parseClipboardFileList(many, 'linux')).toHaveLength(500);
		for (const t of [
			'text/uri-list',
			'public.file-url',
			'electron application/osclipboard;format="text/uri-list"',
		])
			expect(CLIPBOARD_FILE_LIST_TYPE.test(t)).toBe(true);
		expect(CLIPBOARD_FILE_LIST_TYPE.test('text/plain')).toBe(false);
	});
});

describe('desktop security helpers', () => {
	it('only hands http(s)/mailto links to the OS', () => {
		expect(isExternalUrlAllowed('https://example.com')).toBe(true);
		expect(isExternalUrlAllowed('mailto:a@b.c')).toBe(true);
		for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x/y', 'not a url'])
			expect(isExternalUrlAllowed(bad)).toBe(false);
	});

	it('keeps navigation on the app origin', () => {
		expect(isSameOrigin('http://127.0.0.1:5173/project/x', 'http://127.0.0.1:5173')).toBe(true);
		expect(isSameOrigin('http://127.0.0.1:5174/', 'http://127.0.0.1:5173')).toBe(false);
		expect(isSameOrigin('http://localhost:5173/', 'http://127.0.0.1:5173')).toBe(false);
		expect(isSameOrigin('garbage', 'http://127.0.0.1:5173')).toBe(false);
	});

	it('validates IPC arguments', () => {
		expect(isRevealablePath('/home/u/out.mp4')).toBe(true);
		expect(isRevealablePath('C:\\Users\\u\\out.mp4')).toBe(true);
		expect(isRevealablePath('relative/x')).toBe(false);
		expect(isRevealablePath('/x\0y')).toBe(false);
		expect(isWindowAction('close')).toBe(true);
		expect(isWindowAction('focus')).toBe(true);
		expect(isWindowAction('rm -rf')).toBe(false);
	});
});

describe('jasper-mcp launch info (Help ▸ Connect an AI Agent…)', () => {
	it('packaged apps run the bundle with their own binary as Node; checkouts use node', () => {
		expect(
			mcpLaunchInfo({
				packaged: true,
				entry: '/opt/JasperEditor/resources/mcp/jasper-mcp.mjs',
				exists: true,
				execPath: '/opt/JasperEditor/jasper-editor',
			}),
		).toEqual({
			entry: '/opt/JasperEditor/resources/mcp/jasper-mcp.mjs',
			command: '/opt/JasperEditor/jasper-editor',
			env: { ELECTRON_RUN_AS_NODE: '1' },
		});
		expect(
			mcpLaunchInfo({
				packaged: false,
				entry: '/repo/apps/mcp/dist/jasper-mcp.mjs',
				exists: true,
				execPath: '/e',
			}),
		).toEqual({ entry: '/repo/apps/mcp/dist/jasper-mcp.mjs', command: 'node', env: {} });
		// Not built: the dialog falls back to the engine's answer or a placeholder.
		expect(mcpLaunchInfo({ packaged: false, entry: '/x', exists: false, execPath: '/e' }).entry).toBeNull();
	});
});

describe('desktop package config (R-OMS §8.5)', () => {
	const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
	// ARCHITECTURE D-13: the app ships our LGPL FFmpeg directory and never Remotion's compositor packages
	// (they bundle a GPL FFmpeg); the afterPack hook runs the license guard over the packed app.
	it('packages the LGPL FFmpeg directory, excludes the Remotion compositor packages, guards after packing', () => {
		type Res = { from: string; to: string; filter?: string[] };
		const res = pkg.build.extraResources as Res[];
		// electron-builder's ${platform} is the host platform: the target directory is keyed by ${os}-${arch}.
		expect(res.find((r) => r.to === 'ffmpeg-lgpl')!.from).toBe(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder file macros
			'../../vendor/ffmpeg-lgpl/.package/${os}-${arch}',
		);
		expect(res.find((r) => r.to === 'engine/node_modules')!.filter).toEqual(
			expect.arrayContaining(['!@remotion/compositor-*/**', '!**/@remotion/compositor-*/**']),
		);
		expect(pkg.build.files).toContain('!**/node_modules/@remotion/compositor-*/**');
		expect(pkg.build.afterPack).toBe('./scripts/after-pack.cjs');
		expect(existsSync(join(__dirname, '..', pkg.build.afterPack))).toBe(true);
	});
});

describe('capture-page rect (mcp-cli ui_screenshot)', () => {
	it('accepts a finite, positive CSS-pixel rectangle only', () => {
		expect(isCaptureRect({ x: 0, y: 0, width: 800, height: 600 })).toBe(true);
		expect(isCaptureRect({ x: 10.5, y: 4, width: 1, height: 1 })).toBe(true);
		for (const bad of [
			null,
			'rect',
			{ x: 0, y: 0, width: 0, height: 10 },
			{ x: -1, y: 0, width: 10, height: 10 },
			{ x: 0, y: 0, width: Number.NaN, height: 10 },
			{ x: 0, y: 0, width: 99999, height: 10 },
			{ x: 0, y: 0, width: 10 },
		])
			expect(isCaptureRect(bad)).toBe(false);
	});
});

describe('isPermissionAllowed (audio-mix: voice-over microphone)', () => {
	const app = 'http://127.0.0.1:47900';
	it('grants audio-only media requests from the app origin', () => {
		expect(isPermissionAllowed('media', `${app}/project/x`, app, ['audio'])).toBe(true);
		expect(isPermissionAllowed('media', `${app}/`, app, ['audio', 'video'])).toBe(false);
		expect(isPermissionAllowed('media', `${app}/`, app, ['video'])).toBe(false);
		expect(isPermissionAllowed('media', `${app}/`, app, [])).toBe(false);
	});
	it('denies other origins and other permissions', () => {
		expect(isPermissionAllowed('media', 'https://evil.example/', app, ['audio'])).toBe(false);
		expect(isPermissionAllowed('media', `${app}/`, '', ['audio'])).toBe(false);
		expect(isPermissionAllowed('geolocation', `${app}/`, app)).toBe(false);
		expect(isPermissionAllowed('notifications', `${app}/`, app)).toBe(false);
		expect(isPermissionAllowed('fullscreen', `${app}/`, app)).toBe(true);
	});
});

describe('Edit Original (gaps, UI-5)', () => {
	it('opens media paths but never programs or launchers', async () => {
		const { isOpenablePath } = await import('../src/security.ts');
		expect(isOpenablePath('/media/clip.mov')).toBe(true);
		expect(isOpenablePath('C:\\media\\clip.MP4')).toBe(true);
		expect(isOpenablePath('/media/noext')).toBe(true);
		for (const bad of [
			'/tmp/x.sh',
			'C:\\x\\setup.EXE',
			'/a/b.desktop',
			'/a/b.AppImage',
			'relative.mov',
			'',
			7,
			null,
		])
			expect(isOpenablePath(bad)).toBe(false);
	});
});
