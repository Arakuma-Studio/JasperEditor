// Loads the remote-asset manifest: the shipped `manifest.json` merged with the appdir override (entries replace by
// id). An invalid or oversized override is ignored and reported, never fatal (AGENTS §0): the shipped entries stay.
import { readFileSync, statSync } from 'node:fs';
import shipped from './manifest.json' with { type: 'json' };
import { MAX_MANIFEST_BYTES, type RemoteManifest, RemoteManifestSchema } from './schema.ts';

export type OverrideStatus = { status: 'absent' | 'loaded' | 'invalid'; message?: string };
export type LoadedManifest = { manifest: RemoteManifest; override: OverrideStatus };

/** First issues of a zod error as one line (`fonts.0.sha256: …`). */
function issuesText(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
	return e.issues
		.slice(0, 5)
		.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
		.join('; ');
}

/** The shipped manifest, validated (a broken one is a build error caught by the tests; here: empty, reported). */
export function shippedManifest(raw: unknown = shipped): LoadedManifest['manifest'] {
	const r = RemoteManifestSchema.safeParse(raw);
	return r.success ? r.data : { version: 1, fonts: [], emojiPacks: [] };
}

/** `base` with `override`'s entries replacing those of the same id (new ids are added after the base entries). */
export function mergeManifests(base: RemoteManifest, override: RemoteManifest): RemoteManifest {
	const fontIds = new Set(override.fonts.map((f) => f.id));
	const packIds = new Set(override.emojiPacks.map((p) => p.id));
	return {
		version: 1,
		fonts: [...base.fonts.filter((f) => !fontIds.has(f.id)), ...override.fonts],
		emojiPacks: [...base.emojiPacks.filter((p) => !packIds.has(p.id)), ...override.emojiPacks],
	};
}

/** Parses an override file's text: the manifest, or why it is ignored. */
export function parseOverride(text: string): { manifest: RemoteManifest } | { error: string } {
	if (text.length > MAX_MANIFEST_BYTES) return { error: `larger than ${MAX_MANIFEST_BYTES} bytes` };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { error: `not JSON (${(e as Error).message})` };
	}
	const r = RemoteManifestSchema.safeParse(raw);
	return r.success ? { manifest: r.data } : { error: issuesText(r.error) };
}

/**
 * Reads the shipped manifest and the override file. Synchronous (the files are small and bounded): the font catalogue
 * is synchronous and must see the same entries as the downloads.
 */
export function loadManifest(base: RemoteManifest, overridePath: string): LoadedManifest {
	let size: number;
	try {
		size = statSync(overridePath).size;
	} catch {
		return { manifest: base, override: { status: 'absent' } };
	}
	if (size > MAX_MANIFEST_BYTES)
		return {
			manifest: base,
			override: { status: 'invalid', message: `larger than ${MAX_MANIFEST_BYTES} bytes` },
		};
	let text: string;
	try {
		text = readFileSync(overridePath, 'utf8');
	} catch (e) {
		return { manifest: base, override: { status: 'invalid', message: (e as Error).message } };
	}
	const r = parseOverride(text);
	if ('error' in r) return { manifest: base, override: { status: 'invalid', message: r.error } };
	return { manifest: mergeManifests(base, r.manifest), override: { status: 'loaded' } };
}

/** Change stamp of the override file (size + mtime), to reload it when it changes. */
export function overrideStamp(overridePath: string): string {
	try {
		const st = statSync(overridePath);
		return `${st.size}:${st.mtimeMs}`;
	} catch {
		return 'absent';
	}
}
