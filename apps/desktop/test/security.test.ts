// Desktop window guards and helpers (ARCHITECTURE §12, R-OMS §8.5): pure functions, no Electron needed.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	isExternalUrlAllowed,
	isRevealablePath,
	isSameOrigin,
	isWindowAction,
	MEDIA_EXTENSIONS,
	makeToken,
} from '../src/security.ts';

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

	it('makes 32-byte base64url tokens and validates IPC arguments', () => {
		const t = makeToken((n) => randomBytes(n));
		expect(Buffer.from(t, 'base64url')).toHaveLength(32);
		expect(t).not.toBe(makeToken((n) => randomBytes(n)));
		expect(isRevealablePath('/home/u/out.mp4')).toBe(true);
		expect(isRevealablePath('C:\\Users\\u\\out.mp4')).toBe(true);
		expect(isRevealablePath('relative/x')).toBe(false);
		expect(isRevealablePath('/x\0y')).toBe(false);
		expect(isWindowAction('close')).toBe(true);
		expect(isWindowAction('rm -rf')).toBe(false);
		expect(MEDIA_EXTENSIONS).toContain('mov');
	});
});

describe('desktop package config (R-OMS §8.5)', () => {
	const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
	it('builds an ESM main and a CJS preload and ships an electron-builder config', () => {
		expect(pkg.main).toBe('dist-electron/main.mjs');
		expect(pkg.scripts['start:packaged-like']).toContain('packaged-like');
		expect(pkg.build.appId).toBe('com.jasper.editor');
		expect(pkg.build.extraResources.map((r: { to: string }) => r.to)).toEqual(['web', 'engine', 'bin']);
		expect(pkg.build.fileAssociations[0].ext).toBe('jasper');
		expect(pkg.dependencies ?? {}).toEqual({});
	});

	it('the preload exposes only the documented bridge', () => {
		const src = readFileSync(join(__dirname, '../src/preload.cts'), 'utf8');
		expect(src).toContain("exposeInMainWorld('jasperDesktop'");
		for (const k of ['runtime:', 'pickMedia:', 'revealInFolder:', 'windowControls:', 'onMenuCommand:'])
			expect(src).toContain(k);
		expect(src).not.toMatch(/require\(['"](?!electron)/);
	});
});
