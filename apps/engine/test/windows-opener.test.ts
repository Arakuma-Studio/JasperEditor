// The Windows "Edit Original" opener (security review ENG-5), which the review could only test by construction:
// what reaches powershell.exe and explorer.exe for adversarial file names, under the three parsers involved —
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
import { openerFor, WINDOWS_OPEN_COMMAND } from '../src/routes/gaps.ts';
import { tempAppdir } from './helpers.ts';

// ---------------------------------------------------------------- the parsers, as documented

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

/** The command line Node hands to CreateProcess for a spawn (program name included). */
function windowsCommandLine(cmd: string, args: readonly string[], verbatim = false): string {
	return [cmd, ...args].map((a) => (verbatim ? a : libuvQuote(a))).join(' ');
}

/**
 * CommandLineToArgvW / the Microsoft C runtime: how a program such as powershell.exe splits its command line.
 * 2n backslashes + quote → n backslashes, quote toggles; 2n+1 backslashes + quote → n backslashes and a literal
 * quote; backslashes elsewhere are literal; unquoted spaces and tabs separate.
 */
function crtParse(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let inQuotes = false;
	let started = false;
	for (let i = 0; i < line.length; ) {
		const ch = line[i]!;
		if (ch === '\\') {
			let n = 0;
			while (line[i] === '\\') {
				n++;
				i++;
			}
			if (line[i] === '"') {
				cur += '\\'.repeat(Math.floor(n / 2));
				if (n % 2 === 1) {
					cur += '"';
					i++;
				}
			} else cur += '\\'.repeat(n);
			started = true;
			continue;
		}
		if (ch === '"') {
			inQuotes = !inQuotes;
			started = true;
			i++;
			continue;
		}
		if (!inQuotes && (ch === ' ' || ch === '\t')) {
			if (started) out.push(cur);
			cur = '';
			started = false;
			i++;
			continue;
		}
		cur += ch;
		started = true;
		i++;
	}
	if (started) out.push(cur);
	return out;
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

// ---------------------------------------------------------------- adversarial names

/** File names (legal on Windows unless noted) that have broken openers: one per parser's metacharacters. */
const HOSTILE_NAMES = [
	// cmd.exe: command separators, redirection, escapes, variable expansion (also delayed), grouping
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
	// PowerShell: subexpressions, variables, backtick escapes, statement separators, quotes, splatting, stop-parsing
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
	// explorer.exe: commas, spaces, option look-alikes
	'a,b.mp4',
	'a, /select, c.mp4',
	',.mp4',
	'/e,/root,x.mp4',
	'shell colon.mp4',
	// C runtime quoting: spaces, tabs are not legal on Windows but backslash runs before a quote position matter
	'a b  c.mp4',
	' leading and trailing .mp4',
	'trailing backslash dir\\a.mp4',
	// Unicode, right-to-left override, emoji, combining marks
	'vidéo ｆｕｌｌｗｉｄｔｈ.mp4',
	'gpj.\u202e4pm.exe',
	'🎬 clip.mp4',
	'a\u0301\u0327.mp4',
];
const dirs = [
	'C:\\media',
	'C:\\My Videos\\a, b & c',
	'\\\\server\\share\\dir with spaces',
	'D:\\100%\\(x86)',
];
const hostilePaths = dirs.flatMap((d) => HOSTILE_NAMES.map((n) => `${d}\\${n}`));

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

// ---------------------------------------------------------------- open: powershell.exe

describe('Windows open: powershell.exe receives a constant command line', () => {
	const FIXED = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_OPEN_COMMAND];

	it('the command is a constant that names the path only through the environment', () => {
		expect(WINDOWS_OPEN_COMMAND).toBe('Invoke-Item -LiteralPath $env:JASPER_OPEN_PATH');
		// Nothing in it needs quoting inside PowerShell, and nothing lets a value become code: no quote characters,
		// no expression or pipeline syntax; -LiteralPath (not -Path) so wildcard characters are file name characters.
		expect(WINDOWS_OPEN_COMMAND).not.toMatch(/["'`;|&(){}<>]/);
		expect(WINDOWS_OPEN_COMMAND).not.toMatch(
			/Invoke-Expression|\biex\b|Start-Process|cmd(\.exe)?\b|-Path\b/i,
		);
	});

	it.each(hostilePaths)('%s', (path) => {
		const o = openerFor('open', path, 'win32');
		expect(o.verbatim).toBeUndefined();
		expect([o.cmd, ...o.args]).toEqual(FIXED);
		expect(o.env).toEqual({ JASPER_OPEN_PATH: path });
		// What Node builds and what powershell.exe's runtime splits it into: the same constant, for every path.
		const line = windowsCommandLine(o.cmd, o.args);
		expect(line).toBe(
			'powershell.exe -NoProfile -NonInteractive -Command "Invoke-Item -LiteralPath $env:JASPER_OPEN_PATH"',
		);
		expect(crtParse(line)).toEqual(FIXED);
	});

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

// ---------------------------------------------------------------- reveal: explorer.exe

describe('Windows reveal: explorer.exe selects exactly the file', () => {
	it.each(hostilePaths)('%s', (path) => {
		const o = openerFor('reveal', path, 'win32');
		expect(o).toEqual({ cmd: 'explorer.exe', args: [`/select,"${path}"`], verbatim: true });
		const line = windowsCommandLine(o.cmd, o.args, true);
		expect(line).toBe(`explorer.exe /select,"${path}"`);
		// explorer's parser: one option and one object — the whole path, commas, spaces and all.
		expect(explorerParse(line.slice('explorer.exe '.length))).toEqual(['/select', path.trim()]);
	});

	it('the quoting Node would apply by itself mis-parses commas and spaces: that is why the line is verbatim', () => {
		const path = 'C:\\My Videos\\a, b.mp4';
		// Node quotes the whole argument (it has a space): explorer then sees one quoted item, not /select + path.
		const nodeQuoted = windowsCommandLine('explorer.exe', [`/select,${path}`]);
		expect(nodeQuoted).toBe('explorer.exe "/select,C:\\My Videos\\a, b.mp4"');
		expect(explorerParse(nodeQuoted.slice('explorer.exe '.length))).not.toEqual(['/select', path]);
		// Without any quoting a comma in the path separates.
		expect(explorerParse('/select,C:\\dir\\a,b.mp4')).toEqual(['/select', 'C:\\dir\\a', 'b.mp4']);
	});

	it('any path without a double quote parses back to itself (property)', () => {
		fc.assert(
			fc.property(anyPath, (path) => {
				const o = openerFor('reveal', path, 'win32');
				const parsed = explorerParse(windowsCommandLine(o.cmd, o.args, true).slice('explorer.exe '.length));
				return parsed.length === 2 && parsed[0] === '/select' && parsed[1] === path.trim();
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

describe('the parser models used above', () => {
	it('libuv quoting and the C runtime parser are inverse for any argument list (property)', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc
						.array(fc.constantFrom('a', ' ', '\t', '"', '\\', '\\\\', '\\"', '&', '%x%', ''), {
							maxLength: 8,
						})
						.map((p) => p.join('')),
					{ minLength: 1, maxLength: 5 },
				),
				(args) => {
					const parsed = crtParse(windowsCommandLine('prog.exe', args));
					return JSON.stringify(parsed) === JSON.stringify(['prog.exe', ...args]);
				},
			),
			{ numRuns: 1000 },
		);
	});

	it('known values (Microsoft’s documented examples)', () => {
		expect(crtParse('"a b c" d e')).toEqual(['a b c', 'd', 'e']);
		expect(crtParse('"ab\\"c" "\\\\" d')).toEqual(['ab"c', '\\', 'd']);
		expect(crtParse('a\\\\\\b d"e f"g h')).toEqual(['a\\\\\\b', 'de fg', 'h']);
		expect(crtParse('a\\\\\\"b c d')).toEqual(['a\\"b', 'c', 'd']);
		expect(crtParse('a\\\\\\\\"b c" d e')).toEqual(['a\\\\b c', 'd', 'e']);
		expect(libuvQuote('hello"world')).toBe('"hello\\"world"');
		expect(libuvQuote('hello\\"world')).toBe('"hello\\\\\\"world"');
		expect(libuvQuote('hello world\\')).toBe('"hello world\\\\"');
		expect(libuvQuote('c:\\path\\to\\node.exe')).toBe('c:\\path\\to\\node.exe');
	});
});

// ---------------------------------------------------------------- for real, through PowerShell

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
		/** A stand-in for the platform opener `Invoke-Item` runs: it records its arguments and does nothing else. */
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
			// The opener got exactly one argument: the path, byte for byte.
			expect(readFileSync(log, 'utf8').split('\0').slice(0, -1)).toEqual(['1', file]);
			// Nothing the name spelled was run.
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
