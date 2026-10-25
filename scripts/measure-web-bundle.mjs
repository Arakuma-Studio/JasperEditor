#!/usr/bin/env node
// Run after `pnpm --filter @jasper/web build`. Pass a saved dist directory to compare builds.
// Vite emits the entry's recursive static imports as HTML modulepreload links.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const dir = resolve(process.argv[2] ?? 'apps/web/dist');
const html = readFileSync(resolve(dir, 'index.html'), 'utf8');
const initial = new Set();
for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
	const tag = match[0];
	if (!tag.startsWith('<script') && !/rel=["']modulepreload["']/.test(tag)) continue;
	const url = tag.match(/(?:src|href)=["']([^"']+\.js)["']/)?.[1];
	if (url?.startsWith('/')) initial.add(url.slice(1));
}
const measure = (files) => {
	const chunks = [...files].sort().map((file) => {
		const data = readFileSync(resolve(dir, file));
		return {
			file,
			bytes: data.length,
			gzipBytes: gzipSync(data).length,
			brotliBytes: brotliCompressSync(data, {
				params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
			}).length,
		};
	});
	return {
		files: chunks.length,
		bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
		gzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
		brotliBytes: chunks.reduce((sum, chunk) => sum + chunk.brotliBytes, 0),
		chunks,
	};
};
const all = new Set(initial);
for (const file of readdirSync(dir)) {
	if (file.endsWith('.js')) all.add(file);
}
for (const file of readdirSync(resolve(dir, 'assets'))) {
	if (file.endsWith('.js')) all.add(`assets/${file}`);
}
console.log(
	JSON.stringify(
		{
			dir,
			compression: { gzip: 'Node defaults', brotliQuality: 5 },
			initial: measure(initial),
			all: measure(all),
		},
		null,
		2,
	),
);
