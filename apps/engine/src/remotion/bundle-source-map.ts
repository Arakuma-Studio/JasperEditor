// Source maps of the bundles Remotion renders (the compositions bundle, stored mg bundles), kept beside `bundle.js`
// but unreferenced (wp-note export-performance §15).
//
// Remotion 4.0.499 runs `getSourceMapFromLocalFile(<serveDir>/bundle.js)` in `prepareServer` (renderer
// `src/prepare-server.ts`, `src/symbolicate-stacktrace.ts`) for every `selectComposition`, `renderMedia`,
// `renderFrames` and `renderStill`: it reads `bundle.js` with `readFileSync`, takes the last line matching
// `//[#@] ?sourceMappingURL=…` and, when there is one, reads and parses that map on the calling (main) thread. Its
// only use is the location tag of browser console lines. With the 12.6 MB bundle and its 17.8 MB map that was a
// 1.7–3.7 s block of the engine's event loop per render under load. The bundles renders use therefore name no map:
// `hideSourceMapReferences` neutralizes every line Remotion's lookup would follow (webpack's own last line and the
// `sourceMappingURL` comments left in bundled modules, e.g. immer's — removing only the last one would make Remotion
// read a map that does not exist and fail every render), and a failed render is symbolicated here, from the side-car
// `bundle.js.map`, only when it fails (`withRenderErrorSource`).
import { readFile, stat } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';
import { JobError } from '../jobs/types.ts';
import { atomicWriteFile } from '../tools/fs.ts';

/** Remotion's `extractSourceMapUrl` pattern (the lines its local source-map lookup follows). */
const REMOTION_MAP_REFERENCE = /\/\/[#@] ?sourceMappingURL=([^\s'"]+)\s*$/gm;
/** Maps larger than this are not loaded for a failure's location (ours is ≈ 18 MB). */
const MAX_MAP_BYTES = 256 * 1024 * 1024;
/** Source lines named in a failure. */
const MAX_FRAMES = 5;

/**
 * Turns every `//# sourceMappingURL=` (or `//@`) line of `<dir>/bundle.js` that Remotion's lookup would follow into a
 * plain comment (`// sourceMappingURL=`: same length, so line and column positions and the map stay valid) and
 * replaces the file atomically. Returns how many were changed (0: nothing to do, or no `bundle.js`).
 */
export async function hideSourceMapReferences(dir: string): Promise<number> {
	const file = join(dir, 'bundle.js');
	let bytes: Buffer;
	try {
		bytes = await readFile(file);
	} catch {
		return 0;
	}
	// latin1: one character per byte, so a match's index is its byte offset.
	const text = bytes.toString('latin1');
	let changed = 0;
	for (const m of text.matchAll(REMOTION_MAP_REFERENCE)) {
		bytes[m.index + 2] = 0x20;
		changed++;
	}
	if (changed > 0) await atomicWriteFile(file, bytes);
	return changed;
}

const MapPayload = z.object({
	version: z.literal(3),
	sources: z.array(z.string()),
	names: z.array(z.string()).default([]),
	mappings: z.string(),
	file: z.string().optional(),
	sourceRoot: z.string().optional(),
});

/** Maps being loaded or used by failures that overlap: a burst of failed bakes parses each map once. */
const loading = new Map<string, { users: number; map: Promise<SourceMap | null> }>();

async function loadSourceMap(file: string): Promise<SourceMap | null> {
	try {
		if ((await stat(file)).size > MAX_MAP_BYTES) return null;
		const parsed = MapPayload.safeParse(JSON.parse(await readFile(file, 'utf8')));
		if (!parsed.success) return null;
		const p = parsed.data;
		// sourcesContent is not needed for a location (and is most of the map's memory).
		return new SourceMap({
			version: 3,
			file: p.file ?? '',
			sources: p.sources,
			sourcesContent: [],
			names: p.names,
			mappings: p.mappings,
			sourceRoot: p.sourceRoot ?? '',
		});
	} catch {
		return null;
	}
}

async function withSourceMap<T>(file: string, use: (map: SourceMap | null) => T): Promise<T> {
	let entry = loading.get(file);
	if (!entry) {
		entry = { users: 0, map: loadSourceMap(file) };
		loading.set(file, entry);
	}
	entry.users++;
	try {
		return use(await entry.map);
	} finally {
		if (--entry.users === 0) loading.delete(file);
	}
}

type BundleFrame = { fn: string | null; file: string; line: number; column: number };

/**
 * `at fn (http://localhost:3000/bundle.js:12:34)` lines of a browser stack (V8 format: 1-based line and column): a
 * file of the bundle served by Remotion, or by the engine's render bundle server under its random prefix
 * (`http://127.0.0.1:<port>/<32 hex>/bundle.js:12:34`, `RemotionService.renderServeUrl`).
 */
const BUNDLE_FRAME =
	/^\s*at (?:(.+?) \()?https?:\/\/[^/\s]+\/(?:[0-9a-f]{32}\/)?([\w.-]+\.js):(\d+):(\d+)\)?\s*$/;

function bundleFrames(err: unknown): BundleFrame[] {
	const texts: string[] = [];
	for (let e: unknown = err, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) {
		if (typeof e.stack === 'string') texts.push(e.stack);
		texts.push(e.message);
	}
	const seen = new Set<string>();
	const frames: BundleFrame[] = [];
	for (const line of texts.join('\n').split('\n')) {
		const m = BUNDLE_FRAME.exec(line);
		if (!m || seen.has(line.trim())) continue;
		seen.add(line.trim());
		frames.push({ fn: m[1] ?? null, file: m[2]!, line: Number(m[3]), column: Number(m[4]) });
	}
	return frames;
}

/**
 * The original source lines (`fn (src/…/file.tsx:12)`) of the bundle frames in a failed render's error (its stack,
 * its message and its causes), from the side-car maps in `serveDir` (`bundle.js.map`, a chunk's `<n>.bundle.js.map`).
 * First-party sources come first; node_modules frames are named only when there is no other. Empty when the error
 * has no bundle frames or there is no map. Loads each map only here, on failure.
 */
async function renderErrorSource(err: unknown, serveDir: string): Promise<string[]> {
	const frames = bundleFrames(err);
	const byFile = new Map<string, BundleFrame[]>();
	for (const f of frames) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
	const resolved = new Map<BundleFrame, { source: string; line: number }>();
	for (const [file, list] of byFile)
		await withSourceMap(join(serveDir, `${file}.map`), (map) => {
			if (!map) return;
			for (const f of list) {
				const e = map.findEntry(f.line - 1, f.column - 1);
				if (!('originalSource' in e) || e.generatedLine !== f.line - 1) continue;
				resolved.set(f, { source: e.originalSource, line: e.originalLine + 1 });
			}
		});
	const all = frames
		.filter((f) => resolved.has(f))
		.map((f) => {
			const r = resolved.get(f)!;
			return {
				text: `${f.fn ? `${f.fn} ` : ''}(${r.source}:${r.line})`,
				own: !r.source.includes('node_modules/'),
			};
		});
	const own = all.filter((f) => f.own);
	return (own.length > 0 ? own : all).slice(0, MAX_FRAMES).map((f) => f.text);
}

/**
 * `err` with the original source lines of `cause`'s browser stack (`renderErrorSource`) appended to its message
 * (`    at fn (src/…:12)`) and listed in `detail.source`; `err` itself when there are none.
 */
export async function withRenderErrorSource(
	err: JobError,
	cause: unknown,
	serveDir: string,
): Promise<JobError> {
	const source = await renderErrorSource(cause, serveDir).catch(() => []);
	if (source.length === 0) return err;
	const detail = err.detail && typeof err.detail === 'object' ? err.detail : {};
	return new JobError(
		err.code,
		`${err.message}\n${source.map((s) => `    at ${s}`).join('\n')}`,
		err.retryable,
		{
			...detail,
			source,
		},
	);
}
