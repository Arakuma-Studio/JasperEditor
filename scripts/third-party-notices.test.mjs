import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
	collectNotices,
	collectPlatformAssets,
	collectPorted,
	packagesInSourcemaps,
	portedLicenseTexts,
	renderNotices,
} from './third-party-notices.mjs';

const tempDir = (prefix) => {
	const root = mkdtempSync(join(tmpdir(), prefix));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	return root;
};

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
		const dir = tempDir('jasper-maps-');
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
		const root = tempDir('jasper-notices-');
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

describe('ported source records (licenses/ported, AGENTS.md §3.4)', () => {
	const RECORD = [
		'# Blur kernels',
		'',
		'- **Upstream:** https://github.com/storytold/effectcraft (commit abc)',
		'- **Licence:** MIT OR Apache-2.0',
		'- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors',
		'',
		'| Upstream path | Our path | What |',
		'|---|---|---|',
		'| `crates/a.rs` | `packages/b.ts` | box blur |',
	].join('\n');
	function tree(records) {
		const root = tempDir('jasper-ported-');
		mkdirSync(join(root, 'licenses', 'ported'), { recursive: true });
		mkdirSync(join(root, 'licenses', 'texts'), { recursive: true });
		writeFileSync(
			join(root, 'licenses', 'texts', 'MIT.txt'),
			'MIT License\n\nCopyright (c) <year> <copyright holders>\n',
		);
		writeFileSync(join(root, 'licenses', 'texts', 'Apache-2.0.txt'), 'Apache License\nVersion 2.0\n');
		writeFileSync(join(root, 'licenses', 'ported', 'README.md'), '# How to write a record\n');
		for (const [name, text] of Object.entries(records))
			writeFileSync(join(root, 'licenses', 'ported', name), text);
		return root;
	}

	it('reads every record except the README, and renders them with the licence texts', () => {
		const root = tree({ 'blur.md': RECORD });
		const records = collectPorted(root);
		expect(records.map((r) => [r.file, r.title, r.upstream, r.license, r.licenseIds, r.copyright])).toEqual([
			[
				'licenses/ported/blur.md',
				'Blur kernels',
				'https://github.com/storytold/effectcraft',
				'MIT OR Apache-2.0',
				['MIT', 'Apache-2.0'],
				'Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors',
			],
		]);
		const text = renderNotices([], records, portedLicenseTexts(root, records));
		const section = text.slice(
			text.indexOf('<!-- ported-source:start -->'),
			text.indexOf('<!-- ported-source:end -->'),
		);
		for (const required of [
			'https://github.com/storytold/effectcraft',
			'crates/a.rs',
			'packages/b.ts',
			'MIT License',
			'Apache License',
		])
			expect(section).toContain(required);
		expect(text).not.toContain('How to write a record');
	});

	it('accepts the plain forms other records use', () => {
		const root = tree({
			'x.md':
				'# X\n\nUpstream repo: https://github.com/storytold/filmcraft\nLicense: MIT\n\nCopyright (c) 2026 ArtCraft Team and the FilmCraft contributors\n',
		});
		const [r] = collectPorted(root);
		expect([r.upstream, r.license, r.copyright]).toEqual([
			'https://github.com/storytold/filmcraft',
			'MIT',
			'Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors',
		]);
	});

	it('reads a licence line with extra words and emphasis', () => {
		const root = tree({
			'm.md':
				'# M\n\nLicence of the ported code: **MIT OR Apache-2.0** (we use it under MIT).\n\n## EffectCraft — https://github.com/storytold/effectcraft\n\nCopyright (c) 2026 ArtCraft Team and the EffectCraft contributors\n',
		});
		const [r] = collectPorted(root);
		expect([r.license, r.upstream]).toEqual([
			'MIT OR Apache-2.0',
			'https://github.com/storytold/effectcraft',
		]);
	});

	it('refuses an incomplete record or a licence without its text, naming the file and the fix', () => {
		expect(() => collectPorted(tree({ 'bad.md': '# Bad\n\nsome notes\n' }))).toThrow(
			/licenses\/ported\/bad\.md: missing an upstream URL.*a licence.*a copyright line/,
		);
		expect(() =>
			collectPorted(tree({ 'bsd.md': RECORD.replace('MIT OR Apache-2.0', 'BSD-3-Clause') })),
		).toThrow(/add licenses\/texts\/BSD-3-Clause\.txt/);
	});

	it('names each copyright line once, with the records it covers (wp fixups)', () => {
		const ec = 'Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors';
		const fc = 'Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors';
		const root = tree({
			'a.md': RECORD.replace('# Blur kernels', '# A'),
			'b.md': RECORD.replace('# Blur kernels', '# B').replace(ec, `${fc}; ${ec}.`),
			'c.md': RECORD.replace('# Blur kernels', '# C').replace(ec, `${ec}; ${fc}`),
		});
		const records = collectPorted(root);
		expect(records.map((r) => [...r.copyrights].sort())).toEqual([[ec], [ec, fc], [ec, fc]]);
		const text = renderNotices([], records, portedLicenseTexts(root, records));
		const section = text.slice(
			text.indexOf('<!-- ported-source:start -->'),
			text.indexOf('<!-- ported-source:end -->'),
		);
		expect(section).toContain(ec);
		expect(section).toContain(fc);
		for (const license of portedLicenseTexts(root, records))
			expect([...license.copyrights].sort()).toEqual([ec, fc]);
	});
});

describe('platform-asset record (licenses/platform-assets.md, AGENTS.md §3 items 1 and 5)', () => {
	function tree(text) {
		const root = tempDir('jasper-platform-assets-');
		mkdirSync(join(root, 'licenses'), { recursive: true });
		if (text !== undefined) writeFileSync(join(root, 'licenses', 'platform-assets.md'), text);
		return root;
	}

	it('copies the record last, between its markers, after the ported-source part', () => {
		const record = collectPlatformAssets(
			tree(
				'# Platform assets\r\n\n- Twemoji graphics, CC-BY 4.0\n\n| Export | Method |\n|---|---|\n| `like` | live-dom |\n',
			),
		);
		expect(record).toEqual({
			file: 'licenses/platform-assets.md',
			title: 'Platform assets',
			body: '- Twemoji graphics, CC-BY 4.0\n\n| Export | Method |\n|---|---|\n| `like` | live-dom |',
		});
		const text = renderNotices([], [], [], record);
		const start = text.indexOf('<!-- platform-assets:start -->');
		expect(start).toBeGreaterThan(0);
		const section = text.slice(start, text.indexOf('<!-- platform-assets:end -->'));
		expect(section).toContain('# Platform assets');
		expect(section).toContain('Twemoji graphics, CC-BY 4.0');
		expect(section).toContain('| `like` | live-dom |');
		expect(text.trimEnd().endsWith('<!-- platform-assets:end -->')).toBe(true);
		expect(text.indexOf('licenses/platform-assets.md')).toBeLessThan(start);
	});

	it('is optional, and refuses a record without a title', () => {
		expect(collectPlatformAssets(tree(undefined))).toBeNull();
		expect(renderNotices([], [], [], null)).not.toContain('<!-- platform-assets:start -->');
		expect(() => collectPlatformAssets(tree('no title\n'))).toThrow(
			/platform-assets\.md: missing its "# Title" line/,
		);
	});

	it('is present in this repository and covers the Twemoji attribution', () => {
		const record = collectPlatformAssets(repo);
		expect(record?.body).toContain('licensed under CC-BY 4.0');
	});
});
