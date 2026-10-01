#!/usr/bin/env node
// Design-token lint (S05:DT-002, ARCHITECTURE D-15).
// Fails when UI source files contain color literals (hex, rgb(), hsl()) or raw Tailwind palette
// classes instead of --pr-* tokens. Theme files are the only place where literal colors live:
// anything under a `theme/` directory and files named `*.tokens.ts` are exempt.
// A single line can opt out with the marker `tokens-allow` in a comment (use sparingly, e.g. for
// document content colors that belong to the data layer).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCAN_ROOTS = ['packages/ui/src', 'apps/web/src'];
const EXTENSIONS = /\.(?:[cm]?[jt]sx?|css)$/;
const PALETTES = [
	'neutral',
	'gray',
	'zinc',
	'slate',
	'stone',
	'red',
	'orange',
	'amber',
	'yellow',
	'lime',
	'green',
	'emerald',
	'teal',
	'cyan',
	'sky',
	'blue',
	'indigo',
	'violet',
	'purple',
	'fuchsia',
	'pink',
	'rose',
];
const UTILITIES =
	'(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|from|via|to|divide|placeholder|shadow|decoration|accent|caret)';

const RULES = [
	{ id: 'hex-color', re: /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g },
	{ id: 'color-function', re: /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(/g },
	{
		id: 'tailwind-palette',
		re: new RegExp(`(?<![\\w-])${UTILITIES}-(?:${PALETTES.join('|')})-\\d{2,3}(?![\\w])`, 'g'),
	},
	{ id: 'tailwind-white-black', re: new RegExp(`(?<![\\w-])${UTILITIES}-(?:white|black)(?![\\w-])`, 'g') },
	{ id: 'tailwind-palette-bare', re: /(?<![\w-])(?:neutral|gray|zinc|slate)-\d{2,3}(?![\w])/g },
	{ id: 'tailwind-white-black-opacity', re: /(?<![\w-])(?:white|black)\/\d{1,3}(?![\w])/g },
];

/** Returns true when a path is exempt from the rule (theme dirs and *.tokens.ts files). */
function isExempt(filePath) {
	const parts = filePath.split(/[\\/]/);
	if (parts.includes('theme')) return true;
	return /\.tokens\.tsx?$/.test(filePath);
}

/**
 * Finds token violations in one file's text.
 * @param {string} text
 * @returns {{line: number, column: number, rule: string, match: string}[]}
 */
function findViolations(text) {
	const out = [];
	const lines = text.split('\n');
	lines.forEach((line, i) => {
		if (line.includes('tokens-allow')) return;
		for (const rule of RULES) {
			rule.re.lastIndex = 0;
			for (let m = rule.re.exec(line); m; m = rule.re.exec(line)) {
				out.push({ line: i + 1, column: m.index + 1, rule: rule.id, match: m[0] });
			}
		}
	});
	return out;
}

function walk(dir, files) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return files;
	}
	for (const name of entries) {
		if (name === 'node_modules' || name === 'dist') continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, files);
		else if (EXTENSIONS.test(name) && !/\.test\.[jt]sx?$/.test(name)) files.push(full);
	}
	return files;
}

export function checkRepo(root) {
	const problems = [];
	for (const scanRoot of SCAN_ROOTS) {
		for (const file of walk(join(root, scanRoot), [])) {
			const rel = relative(root, file).split(sep).join('/');
			if (isExempt(rel)) continue;
			for (const v of findViolations(readFileSync(file, 'utf8'))) problems.push({ file: rel, ...v });
		}
	}
	return problems;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..');
	const problems = checkRepo(root);
	if (problems.length > 0) {
		for (const p of problems) {
			console.error(`${p.file}:${p.line}:${p.column}  ${p.rule}  ${p.match}`);
		}
		console.error(
			`\ncheck-tokens: ${problems.length} color literal(s) found. Use --pr-* tokens (S05:DT-002); literal colors belong in theme/ or *.tokens.ts.`,
		);
		process.exit(1);
	}
	console.log('check-tokens: ok');
}
