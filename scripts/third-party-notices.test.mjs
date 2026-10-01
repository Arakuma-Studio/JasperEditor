// scripts/third-party-notices.mjs (S11:FIX-010): the closure, the rendered file and `--check`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectNotices, packagesInSourcemaps } from './third-party-notices.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('THIRD_PARTY_NOTICES.md (S11:FIX-010)', () => {
	it('is current (pnpm notices --check)', () => {
		const r = spawnSync(process.execPath, [join(repo, 'scripts', 'third-party-notices.mjs'), '--check'], {
			encoding: 'utf8',
		});
		expect(r.status, r.stderr).toBe(0);
	});
	it('identifies the licence of every shipped JavaScript package', () => {
		for (const notice of collectNotices(repo))
			expect(notice.license !== 'UNKNOWN' || notice.texts.length > 0, notice.name).toBe(true);
	});
});

describe('packagesInSourcemaps (pnpm notices --audit)', () => {
	it('reads name@version of node_modules sources from Vite and webpack sourcemaps', () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-maps-'));
		mkdirSync(join(dir, 'assets'));
		writeFileSync(
			join(dir, 'assets', 'a.js.map'),
			JSON.stringify({
				sources: [
					'../../../../node_modules/.pnpm/react@19.3.0/node_modules/react/index.js',
					'../../src/main.tsx',
					'../../../../node_modules/.pnpm/@floating-ui+dom@1.8.0/node_modules/@floating-ui/dom/dist/x.mjs',
				],
			}),
		);
		writeFileSync(
			join(dir, 'b.js.map'),
			JSON.stringify({
				sources: [
					'webpack://@jasper/compositions/../../node_modules/.pnpm/webpack@5.105.0_esbuild@0.28.1/node_modules/webpack/x.js',
					'webpack://@jasper/compositions/webpack/runtime/global',
					'webpack://x/../../node_modules/.pnpm/@remotion+bundler@4.0.499_react@19.3.0/node_modules/@remotion/bundler/react-shim.js',
				],
			}),
		);
		expect(packagesInSourcemaps([dir])).toEqual([
			'@floating-ui/dom@1.8.0',
			'@remotion/bundler@4.0.499',
			'react@19.3.0',
			'webpack@5.105.0',
		]);
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
		pkg(nm('devtool'), {
			name: 'devtool',
			version: '1.0.0',
			license: 'MIT',
			dependencies: { 'devtool-runtime': '1', 'devtool-cli': '1' },
		});
		pkg(nm('devtool-runtime'), { name: 'devtool-runtime', version: '1.1.0', license: 'MIT' });
		pkg(nm('devtool-cli'), { name: 'devtool-cli', version: '1.2.0', license: 'MIT' });
		pkg(nm('native-bin'), { name: 'native-bin', version: '1.0.0', license: 'GPL-3.0' });
		pkg(nm('optpeer'), { name: 'optpeer', version: '1.0.0', license: 'MIT' });
		return root;
	}
	it('follows dependencies and required peers through workspace packages', () => {
		const root = tree();
		const notices = collectNotices(root, ['apps/web'], []);
		expect(notices.map((n) => [n.name, n.version, n.license, n.texts.map((t) => t.file)])).toEqual([
			['alpha', '1.0.0', 'MIT', ['LICENSE']],
			['beta', '2.0.0', 'BSD-2-Clause', ['LICENSE.md', 'NOTICE.txt']],
			['gamma', '3.0.0', 'ISC', []],
		]);
		expect(notices[0].texts[0].text).toBe('MIT alpha');
	});
	it('adds shipped build output without its dependencies, resolved from a directory or an earlier entry', () => {
		const root = tree();
		const build = [
			{ name: 'devtool', from: 'apps/web' },
			{ name: 'devtool-runtime', from: 'devtool' },
		];
		expect(collectNotices(root, ['apps/web'], build).map((n) => `${n.name}@${n.version}`)).toEqual([
			'alpha@1.0.0',
			'beta@2.0.0',
			'devtool@1.0.0',
			'devtool-runtime@1.1.0',
			'gamma@3.0.0',
		]);
		expect(() => collectNotices(root, ['apps/web'], [{ name: 'missing', from: 'apps/web' }])).toThrow(
			/cannot resolve missing \(shipped build output\) from apps\/web/,
		);
	});
});
