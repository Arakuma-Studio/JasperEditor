// The bundled starter kit and installed packs (spec 12 §2.1 sources 1 and 2; wp-note "WP1.2").
//
// The starter kit is `apps/engine/sounds/starter/` in a checkout and `sounds/starter/` next to the engine bundle
// (`apps/engine/scripts/build.mjs` copies it to `dist/sounds/starter`, the desktop packager ships `dist/sounds`);
// `JASPER_SOUND_STARTER_DIR` overrides it. Its `manifest.json` (`SoundManifestSchema`):
//
//   { "version": 1,
//     "packs":  [{ "id", "title", "url", "sha256", "license", "licenseUrl"?, "author" }],
//     "sounds": [{ "file", "title", "types"?, "tags"?, "author", "license", "licenseUrl"?, "sourceUrl"?, "packId"?,
//                  "attribution"? }] }
//
// `file` is relative to the manifest's folder (forward slashes, no `..`). An installed pack is
// `<appdir>/sounds/packs/<packId>/pack.json` in the same format with exactly one entry in `packs`.
//
// Loading never throws: an absent manifest is an empty kit (`absent`), an unreadable one an empty kit with the reason
// (`invalid`); entries that do not validate, name a missing pack, a file outside the folder or a non-audio file are
// skipped and reported.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	SOUND_FILE_EXTENSIONS,
	type SoundManifestPack,
	SoundManifestPackSchema,
	SoundManifestSchema,
	type SoundManifestSound,
	SoundManifestSoundSchema,
} from '@jasper/api';

export const STARTER_DIR_ENV = 'JASPER_SOUND_STARTER_DIR';
export const MANIFEST_FILE = 'manifest.json';
export const PACK_MANIFEST_FILE = 'pack.json';
/** Manifests larger than this are refused (a kit of 20 000 entries is far below it). */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** Directory of the bundled starter kit: env override, `sounds/starter` next to the bundle, or the checkout's. */
export function starterDir(env: Record<string, string | undefined> = process.env): string {
	if (env[STARTER_DIR_ENV]) return resolve(env[STARTER_DIR_ENV] as string);
	const here = dirname(fileURLToPath(import.meta.url));
	// Bundled: dist/engine.mjs → dist/sounds/starter. Source: src/sounds/starter.ts → apps/engine/sounds/starter.
	const candidates = [join(here, 'sounds', 'starter'), join(here, '..', '..', 'sounds', 'starter')];
	return candidates.find((d) => existsSync(d)) ?? candidates[candidates.length - 1]!;
}

export type LoadedManifest = {
	status: 'ok' | 'absent' | 'invalid';
	dir: string;
	packs: SoundManifestPack[];
	sounds: SoundManifestSound[];
	errors: string[];
	/** sha256 of the manifest bytes ('' when absent): a change asks for a re-index. */
	hash: string;
};

const AUDIO_EXT = new RegExp(`\\.(${SOUND_FILE_EXTENSIONS.join('|')})$`, 'i');

export function isSoundFileName(name: string): boolean {
	return AUDIO_EXT.test(name);
}

/** Reads and validates a manifest; never throws. */
export async function loadManifest(dir: string, fileName = MANIFEST_FILE): Promise<LoadedManifest> {
	const out: LoadedManifest = { status: 'ok', dir, packs: [], sounds: [], errors: [], hash: '' };
	let bytes: Buffer;
	try {
		bytes = await readFile(join(dir, fileName));
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return { ...out, status: 'absent' };
		return { ...out, status: 'invalid', errors: [`${fileName} cannot be read (${code ?? 'error'})`] };
	}
	out.hash = createHash('sha256').update(bytes).digest('hex');
	if (bytes.length > MAX_MANIFEST_BYTES)
		return { ...out, status: 'invalid', errors: [`${fileName} is larger than 16 MB`] };
	let raw: unknown;
	try {
		raw = JSON.parse(bytes.toString('utf8'));
	} catch {
		return { ...out, status: 'invalid', errors: [`${fileName} is not valid JSON`] };
	}
	const top = SoundManifestSchema.safeParse(raw);
	if (!top.success) {
		const i = top.error.issues[0];
		return {
			...out,
			status: 'invalid',
			errors: [`${fileName}: ${i ? `${i.path.join('.') || 'manifest'}: ${i.message}` : 'invalid'}`],
		};
	}
	const packIds = new Set<string>();
	for (const p of top.data.packs) {
		if (packIds.has(p.id)) out.errors.push(`pack "${p.id}" is listed twice`);
		else {
			packIds.add(p.id);
			out.packs.push(p);
		}
	}
	const files = new Set<string>();
	top.data.sounds.forEach((s, i) => {
		const r = SoundManifestSoundSchema.safeParse(s);
		if (!r.success) {
			const issue = r.error.issues[0];
			out.errors.push(`sounds[${i}]: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`);
			return;
		}
		const snd = r.data;
		if (!isSoundFileName(snd.file)) return void out.errors.push(`sounds[${i}]: "${snd.file}" is not an audio file`);
		if (snd.packId !== undefined && !packIds.has(snd.packId))
			return void out.errors.push(`sounds[${i}]: unknown pack "${snd.packId}"`);
		if (files.has(snd.file)) return void out.errors.push(`sounds[${i}]: "${snd.file}" is listed twice`);
		files.add(snd.file);
		out.sounds.push(snd);
	});
	return out;
}

/** An installed pack's manifest: exactly one pack, every sound in it. */
export async function loadPackManifest(dir: string, packId: string): Promise<LoadedManifest> {
	const m = await loadManifest(dir, PACK_MANIFEST_FILE);
	if (m.status !== 'ok') return m;
	const pack = m.packs.length === 1 ? SoundManifestPackSchema.safeParse(m.packs[0]) : null;
	if (!pack?.success || pack.data.id !== packId)
		return {
			...m,
			status: 'invalid',
			packs: [],
			sounds: [],
			errors: [...m.errors, `${PACK_MANIFEST_FILE} must describe exactly the pack "${packId}"`],
		};
	return { ...m, sounds: m.sounds.map((s) => ({ ...s, packId })) };
}
