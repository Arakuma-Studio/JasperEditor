// Windows open/reveal paths pass through three different parsers:
//   - Node / libuv, which turns an argument array into one Windows command line (`quote_cmd_arg`);
//   - the C runtime rules (CommandLineToArgvW), by which powershell.exe splits that line again;
//   - explorer.exe's own parser (commas separate, double quotes group), fed a verbatim line;
// and cmd.exe, which must never be involved. Where a PowerShell is installed (`pwsh` on the PATH, or JASPER_PWSH),
// the exact open command also runs for real against a recording opener: PowerShell on Linux and macOS implements
// `Invoke-Item` by running the platform opener with the file as its argument.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { openerFor } from '../src/routes/gaps.ts';
import { tempAppdir } from './temp.ts';

/**
 * libuv `quote_cmd_arg` (src/win/process.c), the rule Node applies to every argument of a non-verbatim spawn:
 * no quotes when the argument has no space, tab or quote; plain quotes when it has no quote or backslash; else
 * backslashes before a quote (and at the end) doubled and quotes escaped.
 */
function libuvQuote(arg: string): string {
	if (arg.length === 0) return '""';
	if (!/[ \t"]/.test(arg)) return arg;
	if (!/["\\]/.test(arg)) return `"${arg}"`;
	let body = '';
	let backslashes = 0;
	for (const ch of arg) {
		if (ch === '\\') {
			backslashes++;
			continue;
		}
		if (ch === '"') body += `${'\\'.repeat(backslashes * 2 + 1)}"`;
		else body += '\\'.repeat(backslashes) + ch;
		backslashes = 0;
	}
	return `"${body}${'\\'.repeat(backslashes * 2)}"`;
}

function windowsCommandLine(cmd: string, args: readonly string[], verbatim = false): string {
	return [cmd, ...args].map((a) => (verbatim ? a : libuvQuote(a))).join(' ');
}

/**
 * explorer.exe: the text after the program name is a list separated by commas; double quotes group (a comma or a
 * space inside them is part of the item) and are removed. `/select` takes the next item as the object to select.
 */
function explorerParse(tail: string): string[] {
	const items: string[] = [];
	let cur = '';
	let inQuotes = false;
	for (const ch of tail) {
		if (ch === '"') inQuotes = !inQuotes;
		else if (ch === ',' && !inQuotes) {
			items.push(cur.trim());
			cur = '';
		} else cur += ch;
	}
	items.push(cur.trim());
	return items;
}

/** Adversarial file names, legal on Windows unless noted, cover each parser's metacharacters. */
const HOSTILE_NAMES = [
	'a&calc.exe&.mp4',
	'a && calc.exe && .mp4',
	'a|calc.exe.mp4',
	'a^&calc^.mp4',
	'%COMSPEC% %PATH%.mp4',
	'!COMSPEC!.mp4',
	'%CD:~0,1%calc.mp4',
	'a (1) & (calc).mp4',
	'a;calc.mp4',
	'@calc.mp4',
	'$(calc).mp4',
	'$env:COMSPEC.mp4',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: a PowerShell variable reference, as a file name
	'${env:TEMP}.mp4',
	'a`ncalc`n.mp4',
	"a';calc;'.mp4",
	"it's mine.mp4",
	'a;Start-Process calc;.mp4',
	'--% calc.mp4',
	'@{a=1}.mp4',
	'a -Verb RunAs.mp4',
	'-LiteralPath x.mp4',
	'-EncodedCommand ZQBjAGgAbwA=.mp4',
	'a{calc}.mp4',
	'a#comment.mp4',
	// PowerShell wildcards (what -LiteralPath is for) and provider syntax
	'[x].mp4',
	'a[0-9].mp4',
	'a`[x`].mp4',
	'~.mp4',
	'a,b.mp4',
	'a, /select, c.mp4',
	',.mp4',
	'/e,/root,x.mp4',
	'shell colon.mp4',
	// C runtime quoting: spaces, tabs are not legal on Windows but backslash runs before a quote position matter
	'a b  c.mp4',
	' leading and trailing .mp4',
	'trailing backslash dir\\a.mp4',
	'vidéo ｆｕｌｌｗｉｄｔｈ.mp4',
	'gpj.\u202e4pm.exe',
	'🎬 clip.mp4',
	'a\u0301\u0327.mp4',
];

/** Any Windows-legal path text: no `<>:"/|?*` in names is not enforced here on purpose (a parser must not care). */
const anyPath = fc
	.array(
		fc.oneof(
			fc.constantFrom(..." ,;&|^%!$`'()[]{}@#~=+-_.\\".split('')),
			fc.constantFrom('\\\\', ' \\', '\\ ', '%PATH%', '$(x)', '`"', '&&', '||', '--%', '/select,', '\t'),
			fc.string({ minLength: 1, maxLength: 6 }),
		),
		{ minLength: 1, maxLength: 12 },
	)
	.map((parts) => `C:\\m\\${parts.join('').replace(/["\0\r\n]/g, '_')}.mp4`);

describe('Windows open: powershell.exe receives a constant command line', () => {
	it('never cmd.exe, never a shell, whatever the path (property)', () => {
		fc.assert(
			fc.property(anyPath, (path) => {
				const o = openerFor('open', path, 'win32');
				const line = windowsCommandLine(o.cmd, o.args);
				return (
					!/cmd(\.exe)?/i.test(line) &&
					line ===
						'powershell.exe -NoProfile -NonInteractive -Command "Invoke-Item -LiteralPath $env:JASPER_OPEN_PATH"' &&
					o.env?.JASPER_OPEN_PATH === path &&
					Object.keys(o.env ?? {}).length === 1
				);
			}),
			{ numRuns: 500 },
		);
	});
});

describe('Windows reveal: explorer.exe selects exactly the file', () => {
	it('any path without a double quote parses back to itself (property)', () => {
		fc.assert(
			fc.property(anyPath, (path) => {
				const o = openerFor('reveal', path, 'win32');
				const parsed = explorerParse(
					windowsCommandLine(o.cmd, o.args, o.verbatim).slice('explorer.exe '.length),
				);
				return (
					o.cmd === 'explorer.exe' &&
					parsed.length === 2 &&
					parsed[0] === '/select' &&
					parsed[1] === path.trim()
				);
			}),
			{ numRuns: 500 },
		);
	});
});

describe('Windows: names no Windows file can have are refused, not quoted around', () => {
	it.each([
		['a double quote', 'C:\\m\\a" /root,C:\\Windows\\System32\\calc.exe ".mp4'],
		['a quote that would end the group', 'C:\\m\\x",calc.exe'],
		['a NUL', 'C:\\m\\a\0.mp4'],
		['a line feed', 'C:\\m\\a\ncalc.mp4'],
		['a carriage return', 'C:\\m\\a\rcalc.mp4'],
	])('%s', (_what, path) => {
		for (const action of ['reveal', 'open'] as const)
			expect(() => openerFor(action, path, 'win32')).toThrow(/cannot be handed to Windows/);
	});
});

function findPwsh(): string | null {
	const explicit = process.env.JASPER_PWSH;
	if (explicit) return existsSync(explicit) ? explicit : null;
	for (const dir of (process.env.PATH ?? '').split(delimiter))
		for (const name of ['pwsh', 'pwsh.exe', 'powershell.exe'])
			if (dir && existsSync(join(dir, name))) return join(dir, name);
	return null;
}
const PWSH = findPwsh();

describe.skipIf(!PWSH || process.platform === 'win32')(
	'the open command run by a real PowerShell (pwsh): one literal argument, nothing executed',
	() => {
		function recorder(): { dir: string; bin: string; log: string } {
			const dir = tempAppdir('jasper-pwsh-');
			const bin = join(dir, 'bin');
			mkdirSync(bin);
			const script = '#!/bin/sh\nprintf \'%s\\0\' "$#" "$@" > "$JASPER_TEST_LOG"\n';
			for (const name of ['xdg-open', 'open']) {
				writeFileSync(join(bin, name), script);
				chmodSync(join(bin, name), 0o755);
			}
			return { dir, bin, log: join(dir, 'opened.log') };
		}

		// Names a POSIX file system can hold (no separators), plus command injection spelled for a POSIX shell and for
		// PowerShell. Each run starts a PowerShell (seconds): a representative dozen by default, every name with FUZZ=1.
		const all = HOSTILE_NAMES.map((n) => n.replace(/[\\/]/g, '_')).concat([
			'$(touch pwned).mp4',
			'`touch pwned`.mp4',
			'a; touch pwned;.mp4',
			'a | touch pwned.mp4',
			'a" ; touch pwned ; ".mp4',
			'$env:PATH = "x"; touch pwned.mp4',
			'a\nb.mp4',
		]);
		const CORE = [
			'a&calc.exe&.mp4',
			'%COMSPEC% %PATH%.mp4',
			'$(calc).mp4',
			"a';calc;'.mp4",
			'--% calc.mp4',
			'-LiteralPath x.mp4',
			'[x].mp4',
			'a,b.mp4',
			' leading and trailing .mp4',
			'$(touch pwned).mp4',
			'`touch pwned`.mp4',
			'a" ; touch pwned ; ".mp4',
			'a\nb.mp4',
		];
		const names = process.env.FUZZ === '1' ? all : all.filter((n) => CORE.includes(n));

		// A PowerShell start takes seconds on a loaded host.
		const PWSH_TIMEOUT_MS = 90_000;

		it.each(names)('%j', { timeout: PWSH_TIMEOUT_MS }, (name) => {
			const { dir, bin, log } = recorder();
			const media = join(dir, 'media dir, with & comma');
			mkdirSync(media);
			const file = join(media, name);
			writeFileSync(file, 'x');
			const o = openerFor('open', 'C:\\placeholder.mp4', 'win32');
			const r = spawnSync(PWSH!, o.args, {
				cwd: dir,
				encoding: 'utf8',
				timeout: 60_000,
				env: {
					...process.env,
					...o.env,
					JASPER_OPEN_PATH: file,
					JASPER_TEST_LOG: log,
					PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
				},
			});
			expect(r.status, r.stderr).toBe(0);
			expect(readFileSync(log, 'utf8').split('\0').slice(0, -1)).toEqual(['1', file]);
			expect(readdirSync(dir).sort()).toEqual(['bin', 'media dir, with & comma', 'opened.log']);
			expect(readdirSync(media)).toEqual([name]);
		});

		it('a missing file is an error from PowerShell, not an open of something else', {
			timeout: 90_000,
		}, () => {
			const { dir, bin, log } = recorder();
			const o = openerFor('open', 'C:\\placeholder.mp4', 'win32');
			const r = spawnSync(PWSH!, o.args, {
				cwd: dir,
				encoding: 'utf8',
				timeout: 60_000,
				env: {
					...process.env,
					JASPER_OPEN_PATH: join(dir, 'no such [file] *.mp4'),
					JASPER_TEST_LOG: log,
					PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
				},
			});
			expect(r.status).not.toBe(0);
			expect(existsSync(log)).toBe(false);
		});
	},
);

afterAll(() => {
	console.info(
		PWSH && process.platform !== 'win32'
			? `[windows-opener] ran the open command through ${PWSH}`
			: '[windows-opener] no PowerShell found (pwsh on PATH or JASPER_PWSH): the real-run block was skipped',
	);
});
