// Custom OCIO configs as media (workstream color-mgmt): importing a `.ocio` file makes a self-contained bundle — the
// config text plus the text of every file its FileTransforms reference (found on the config's `search_path`, relative
// to its folder) — written as `<name>.jocio` (JSON) and registered as a `color-config` asset. The preview (browser) and
// every export path read the same bundle, so a config resolves identically everywhere, and the project keeps working
// when the original LUT folder moves. Files that are not found are listed (`missing`); spaces that use them are refused.
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import {
	type ColorConfigInfo,
	EMPTY_PROBE,
	isOcioBundle,
	type OcioBundle,
	OcioConfig,
	OcioError,
	parseYaml,
	type Yaml,
	yGet,
	ySeq,
	yStr,
	yTag,
} from '@jasper/project';
import { JobError } from '../jobs/types.ts';
import type { AssetProber, ProbeResult } from '../media/probe.ts';

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/** Every FileTransform `src` of a parsed config. */
function fileSources(y: Yaml, out: Set<string>, depth = 0): void {
	if (depth > 200) return;
	if (yTag(y) === 'FileTransform') {
		const src = yStr(yGet(y, 'src'));
		if (src) out.add(src);
	}
	const body = y.t === 'tag' ? y.v : y;
	if (body.t === 'map') for (const [, v] of body.v) fileSources(v, out, depth + 1);
	else if (body.t === 'seq') for (const v of body.v) fileSources(v, out, depth + 1);
}

/** Reads a `.ocio` config and the files it references into a bundle. Throws `JobError('INVALID_COLOR_CONFIG')`. */
export async function buildOcioBundle(configPath: string): Promise<OcioBundle> {
	const st = await stat(configPath);
	if (st.size > MAX_CONFIG_BYTES)
		throw new JobError('INVALID_COLOR_CONFIG', `OCIO config too large (${st.size} bytes)`, false);
	const text = await readFile(configPath, 'utf8');
	let y: Yaml;
	try {
		y = parseYaml(text);
		OcioConfig.parse(text, {}); // structure check (spaces present)
	} catch (e) {
		throw new JobError(
			'INVALID_COLOR_CONFIG',
			`Not a readable OCIO config: ${e instanceof OcioError || e instanceof RangeError ? e.message : String(e)}`,
			false,
		);
	}
	const dir = dirname(configPath);
	const sp = yGet(y, 'search_path');
	const search: string[] =
		sp?.t === 'seq'
			? ySeq(sp)
					.map(yStr)
					.filter((s): s is string => !!s)
			: (yStr(sp) ?? '')
					.split(':')
					.map((s) => s.trim())
					.filter(Boolean);
	const srcs = new Set<string>();
	fileSources(y, srcs);
	const files: Record<string, string> = {};
	const missing: string[] = [];
	let total = text.length;
	for (const src of srcs) {
		if (src.includes('$')) {
			missing.push(src);
			continue;
		}
		const candidates = isAbsolute(src)
			? [src]
			: [...search.filter((s) => !s.includes('$')).map((s) => resolve(dir, s, src)), resolve(dir, src)];
		let found: string | null = null;
		for (const c of candidates) {
			const cs = await stat(c).catch(() => null);
			if (cs?.isFile() && cs.size <= MAX_FILE_BYTES) {
				found = c;
				break;
			}
		}
		if (!found) {
			missing.push(src);
			continue;
		}
		const body = await readFile(found, 'utf8');
		total += body.length;
		if (total > MAX_BUNDLE_BYTES)
			throw new JobError('INVALID_COLOR_CONFIG', 'The files of this OCIO config exceed 256 MB', false);
		files[src] = body;
	}
	const name = yStr(yGet(y, 'name')) || basename(configPath).replace(/\.ocio$/i, '');
	return { jasperOcioBundle: 1, name, config: text, files, missing: missing.sort() };
}

/** The asset header of a bundle (spaces, roles, displays, what cannot be applied). */
export function colorConfigInfo(b: OcioBundle): ColorConfigInfo {
	const c = OcioConfig.fromBundle(b);
	return {
		format: 'ocio',
		name: b.name,
		version: c.version,
		spaces: c.spaces.map((s) => ({ name: s.name, family: s.family, reference: s.reference })),
		roles: c.roles,
		displays: c.displays.map((d) => ({ name: d.name, views: d.views.map((v) => v.name) })),
		unsupported: c.unsupported(),
		missing: b.missing,
	};
}

/** `.jocio` bundles register as kind `color-config`. */
export const ocioBundleProber: AssetProber = {
	id: 'color-mgmt.ocio-bundle',
	matches: (file) => /\.jocio$/i.test(file),
	async probe(file): Promise<ProbeResult> {
		const st = await stat(file);
		if (st.size > MAX_BUNDLE_BYTES + MAX_CONFIG_BYTES)
			throw new JobError('INVALID_COLOR_CONFIG', 'OCIO bundle too large', false);
		let json: unknown;
		try {
			json = JSON.parse(await readFile(file, 'utf8'));
		} catch {
			throw new JobError('INVALID_COLOR_CONFIG', 'Not a JasperEditor OCIO bundle (invalid JSON)', false);
		}
		if (!isOcioBundle(json))
			throw new JobError('INVALID_COLOR_CONFIG', 'Not a JasperEditor OCIO bundle', false);
		let info: ColorConfigInfo;
		try {
			info = colorConfigInfo(json);
		} catch (e) {
			throw new JobError('INVALID_COLOR_CONFIG', (e as Error).message, false);
		}
		return {
			kind: 'color-config',
			container: 'ocio',
			probe: { ...EMPTY_PROBE, streams: [] },
			browserPlayable: 'no',
			durationSec: null,
			frameCount: null,
			interlaced: false,
			hasVideo: false,
			hasAudio: false,
			display: null,
			colorConfig: info,
		};
	},
};

/** Where an imported `.ocio` becomes its bundle (`<dir>/<name>.jocio`). */
export function bundleFileName(configPath: string): string {
	return `${basename(configPath).replace(/\.ocio$/i, '') || 'config'}.jocio`;
}
