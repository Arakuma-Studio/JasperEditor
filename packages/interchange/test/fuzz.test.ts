import type { TransactionResult } from '@jasper/project';
import { bytesTarget, describeFuzz } from '@jasper/testkit/fuzz';
import { exportTimeline, FORMAT_INFO, type Format, importTimeline } from '../src/index.ts';
import { InterchangeError } from '../src/report.ts';
import { hostileSeeds } from './support/hostile.ts';
import { addCaptions, Harness, richProject } from './support/rich.ts';

function seeds(): Uint8Array[] {
	const { h } = richProject();
	addCaptions(h);
	const out: Uint8Array[] = [];
	for (const f of Object.keys(FORMAT_INFO) as Format[]) {
		if (!FORMAT_INFO[f]?.write) continue;
		for (const file of exportTimeline(h.doc, h.seqId, f).files) out.push(file.bytes);
	}
	// Seed malformed container graphs as well as valid exports to exercise bounded traversal and allocation.
	out.push(...hostileSeeds());
	return out;
}

function importAndApply(bytes: Uint8Array, format: Format | null): void {
	const imp = importTimeline(bytes, { format, now: '2026-10-07T00:00:00.000Z', rate: { num: 30, den: 1 } });
	const target = new Harness({ preset: 'hd-1080p-30', seed: 999 });
	const r: TransactionResult = target.tx([{ type: 'project.importTimeline', fragment: imp }]);
	if (!r.ok) {
		const bad = r.errors.filter((e) => e.code === 'E_INTERNAL' || e.code === 'E_INVARIANT');
		if (bad.length)
			throw new Error(`importTimeline command failed internally: ${JSON.stringify(bad.slice(0, 3))}`);
	}
}

const SEEDS = seeds();
describeFuzz('@jasper/interchange end to end', [
	bytesTarget('any document (sniffed) → project', SEEDS, (b) => importAndApply(b, null), InterchangeError, {
		iterations: 250,
	}),
	...(Object.keys(FORMAT_INFO) as Format[])
		.filter((f) => FORMAT_INFO[f]?.read)
		.map((f) =>
			bytesTarget(`${f} → project`, SEEDS, (b) => importAndApply(b, f), InterchangeError, {
				iterations: 120,
			}),
		),
]);
