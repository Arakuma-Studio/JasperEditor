// M3 MCP tools: the engine's media cache (S04:CA-019) — get_cache_usage, clean_cache. Owner: wp-m3-cachegc.
import { CACHE_KINDS, type CacheGcReport, type CacheUsage } from '@jasper/api';
import { z } from 'zod';
import { DESTRUCTIVE, defineTool, READ_ONLY, type ToolContext } from '../context.ts';
import { jsonResult } from '../errors.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const CACHE_GUIDE = `Media cache: the engine keeps regenerable files (waveforms, posters, filmstrips, proxies, baked colour LUTs, warped layers, graphics bakes, motion-graphics renders, export outputs, rendered frames, build caches). get_cache_usage shows the size per kind split into in use (running jobs, open projects, just written), referenced by saved projects, and unused, plus the budgets (Preferences ▸ Media Cache). clean_cache mode "unused" removes what no project references (safe, like Premiere's Delete Unused); mode "all" also removes what saved projects reference but never what is in use — it is regenerated on demand (the next preview or export is slower). Prefer "unused"; use "all" only when the user asks to free disk space.`;

const MB = 1024 * 1024;
const mb = (n: number) => Math.round((n / MB) * 10) / 10;

/** A compact usage summary (MB) for agents. */
function summary(u: CacheUsage) {
	return {
		totalMB: mb(u.totalBytes),
		inUseMB: mb(u.inUseBytes),
		referencedMB: mb(u.referencedBytes),
		unusedMB: mb(u.unusedBytes),
		budgetMB: u.maxTotalBytes === null ? null : mb(u.maxTotalBytes),
		automaticBudget: u.automaticBudget,
		freeDiskMB: u.freeDiskBytes === null ? null : mb(u.freeDiskBytes),
		kinds: u.kinds
			.filter((k) => k.entries > 0)
			.map((k) => ({
				kind: k.kind,
				label: k.label,
				entries: k.entries,
				sizeMB: mb(k.bytes),
				inUseMB: mb(k.inUseBytes),
				referencedMB: mb(k.referencedBytes),
				unusedMB: mb(k.unusedBytes),
				maxAgeDays: k.maxAgeDays,
				...(k.maxBytes !== null ? { budgetMB: mb(k.maxBytes) } : {}),
			})),
		lastCleaned: u.lastGc
			? { at: u.lastGc.at, mode: u.lastGc.mode, removedMB: mb(u.lastGc.removedBytes) }
			: null,
	};
}

export function registerCacheTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_cache_usage',
		{
			title: 'Get media cache usage',
			description:
				'Disk used by the engine caches per kind (MB): in use, referenced by saved projects, unused; the total budget and the last cleaning.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => jsonResult(summary(await ctx.engine((c) => c.call('cacheUsage')))),
	);

	defineTool(
		ctx,
		'clean_cache',
		{
			title: 'Clean media cache',
			description:
				'Removes cache files and answers what was freed. mode "unused": files no saved or open project references (safe). mode "all": also files saved projects reference — never files in use (running exports, open projects); they are regenerated when needed. kinds limits the cleaning (default: every kind).',
			input: {
				mode: z.enum(['unused', 'all']).describe('"unused" (default choice) or "all"'),
				kinds: z
					.array(z.enum(CACHE_KINDS))
					.min(1)
					.optional()
					.describe(`Only these kinds: ${CACHE_KINDS.join(', ')}`),
			},
			annotations: DESTRUCTIVE,
		},
		async ({ mode, kinds }) => {
			const r: CacheGcReport = await ctx.engine((c) =>
				c.call('cacheClean', { body: { mode, ...(kinds ? { kinds } : {}) } }),
			);
			return jsonResult({
				removedEntries: r.removedEntries,
				removedMB: mb(r.removedBytes),
				removedTemporaryFiles: r.removedOrphans,
				keptInUse: r.keptInUse,
				keptReferenced: r.keptReferenced,
				failed: r.failed,
				byKind: Object.fromEntries(
					Object.entries(r.byKind).map(([k, v]) => [k, { entries: v.entries, removedMB: mb(v.bytes) }]),
				),
			});
		},
	);
}
