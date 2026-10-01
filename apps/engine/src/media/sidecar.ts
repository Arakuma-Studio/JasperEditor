// Source-range sidecars next to files registered by path (M3, S07:PRC-019): `<name>.json` or `<stem>.json`
// describing which source frames a rendered file holds (the trailer grade pipeline's `first_src_frame`,
// jasper-proc's own sidecar, or the generic shape documented in `parseSourceSidecar`). The result is returned
// with the registration (`RegisteredMedia.sourceHint`); the engine does not store it.
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseSourceSidecar, type SourceSidecarInfo, sidecarCandidates } from '@jasper/project';

/** Sidecars larger than this are not source-range sidecars (they are read whole). */
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;

export async function readSourceSidecar(videoPath: string): Promise<SourceSidecarInfo | null> {
	for (const name of sidecarCandidates(videoPath)) {
		const file = join(dirname(videoPath), name);
		const st = await stat(file).catch(() => null);
		if (!st?.isFile() || st.size > MAX_SIDECAR_BYTES) continue;
		try {
			const info = parseSourceSidecar(JSON.parse(await readFile(file, 'utf8')), name);
			if (info) return info;
		} catch {
			// not JSON: not a sidecar
		}
	}
	return null;
}
