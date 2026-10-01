// scripts/third-party-notices.mjs (S11:FIX-010): the closure, the rendered file and `--check`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectNotices, licenseOf, OUTPUT, renderNotices } from './third-party-notices.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('THIRD_PARTY_NOTICES.md (S11:FIX-010)', () => {
	const notices = collectNotices(repo);
	const names = notices.map((n) => n.name);
	it('is current (pnpm notices --check)', () => {
		expect(readFileSync(join(repo, OUTPUT), 'utf8')).toBe(renderNotices(notices));
		const r = spawnSync(process.execPath, [join(repo, 'scripts', 'third-party-notices.mjs'), '--check'], {
			encoding: 'utf8',
		});
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toMatch(/current \(\d+ packages\)/);
	});
	it('lists the shipped closure of the web app and the Remotion bundle with licence texts', () => {
		const anime = notices.find((n) => n.name === 'animejs');
		expect(anime).toMatchObject({ version: '4.5.0', license: 'MIT' });
		expect(anime.texts[0].text).toMatch(/MIT License[\s\S]*Julian Garnier/);
		for (const n of ['react', 'react-dom', 'remotion', '@remotion/player', 'zod', 'immer', 'dockview-react'])
			expect(names, n).toContain(n);
		expect(notices.find((n) => n.name === 'remotion').texts.map((t) => t.file)).toContain('LICENSE.md');
		// every entry has a licence identifier or text
		for (const n of notices) expect(n.license !== 'UNKNOWN' || n.texts.length > 0, n.name).toBe(true);
	});
	it('excludes our workspace packages, dev-only tools and platform binaries', () => {
		expect(names.some((n) => n.startsWith('@jasper/'))).toBe(false);
		for (const n of ['vite', 'vitest', '@remotion/bundler', '@remotion/renderer', 'typescript', 'esbuild'])
			expect(names, n).not.toContain(n);
		expect(names.some((n) => n.startsWith('@remotion/compositor-'))).toBe(false);
		expect(renderNotices(notices)).not.toContain(repo);
	});
});

describe('collectNotices over a miniature workspace', () => {
	function tree() {
		const root = mkdtempSync(join(tmpdir(), 'jasper-notices-'));
		const pkg = (dir, json, files = {}) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
			for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
		};
		const nm = (name) => join(root, 'node_modules', name);
		pkg(join(root, 'apps', 'web'), {
			name: '@jasper/web',
			dependencies: { '@jasper/lib': 'workspace:*', alpha: '1' },
			devDependencies: { devtool: '1' },
			optionalDependencies: { 'native-bin': '1' },
		});
		pkg(join(root, 'packages', 'lib'), {
			name: '@jasper/lib',
			dependencies: { beta: '1' },
			peerDependencies: { gamma: '*', optpeer: '*' },
			peerDependenciesMeta: { optpeer: { optional: true } },
		});
		mkdirSync(join(root, 'apps', 'web', 'node_modules', '@jasper'), { recursive: true });
		symlinkSync(
			join(root, 'packages', 'lib'),
			join(root, 'apps', 'web', 'node_modules', '@jasper', 'lib'),
			'dir',
		);
		pkg(
			nm('alpha'),
			{ name: 'alpha', version: '1.0.0', license: 'MIT', dependencies: { beta: '1' } },
			{
				LICENSE: 'MIT alpha\r\n',
			},
		);
		pkg(
			nm('beta'),
			{ name: 'beta', version: '2.0.0', licenses: [{ type: 'BSD-2-Clause' }] },
			{
				'LICENSE.md': 'BSD beta',
				'NOTICE.txt': 'beta notice',
				'README.md': 'not a licence',
			},
		);
		pkg(nm('gamma'), { name: 'gamma', version: '3.0.0', license: { type: 'ISC' } });
		pkg(nm('devtool'), { name: 'devtool', version: '1.0.0', license: 'MIT' });
		pkg(nm('native-bin'), { name: 'native-bin', version: '1.0.0', license: 'GPL-3.0' });
		pkg(nm('optpeer'), { name: 'optpeer', version: '1.0.0', license: 'MIT' });
		return root;
	}
	it('follows dependencies and required peers through workspace packages; renders deterministically', () => {
		const root = tree();
		const notices = collectNotices(root, ['apps/web']);
		expect(notices.map((n) => [n.name, n.version, n.license, n.texts.map((t) => t.file)])).toEqual([
			['alpha', '1.0.0', 'MIT', ['LICENSE']],
			['beta', '2.0.0', 'BSD-2-Clause', ['LICENSE.md', 'NOTICE.txt']],
			['gamma', '3.0.0', 'ISC', []],
		]);
		expect(notices[0].texts[0].text).toBe('MIT alpha');
		const md = renderNotices(notices);
		expect(md).toBe(renderNotices(collectNotices(root, ['apps/web'])));
		expect(md).toContain('| beta | 2.0.0 | BSD-2-Clause |');
		expect(md).toContain('### NOTICE.txt\n\n```text\nbeta notice\n```');
		expect(md).toContain('(The package ships no licence file');
	});
	it('licenseOf reads license, license.type and legacy licenses', () => {
		expect(licenseOf({ license: 'MIT' })).toBe('MIT');
		expect(licenseOf({ license: { type: 'ISC' } })).toBe('ISC');
		expect(licenseOf({ licenses: ['MIT', { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0');
		expect(licenseOf({})).toBe('UNKNOWN');
	});
});
