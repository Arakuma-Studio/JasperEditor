// What the audio check of Fix Transcript cost on this machine (spec 17 SC-081 / SC-090 dry-run estimate): the last
// measured per-window encoder time, per-reading decoder time and the once-per-media load, per speech model, kept in
// `<appdir>/engine/transcript-fix-costs.json` (written atomically; an unreadable file is ignored and rewritten). The
// dry run uses it when a previous run of the model recorded one, else the reference figures measured on the build VM
// (docs/wp-notes/script-correction.md "Speech scoring and glossary prompts", SC-037 cost table).
import { z } from 'zod';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';

/** Reference cost (build VM, 16 shared EPYC vCPU, CPU only, whisper-large-v3-turbo fp32; wp-note SC-037 table). */
export const REFERENCE_COST = Object.freeze({
	/** Model load + media decode once per media (5.8 s + 0.6 s). */
	loadSec: 6.4,
	/** One encoder pass per distinct window (5.05 s). */
	windowSec: 5.05,
	/** One decoder reading (1.56 s / 9 readings). */
	readingSec: 0.17,
});

const CostSchema = z.object({
	loadSec: z.number().finite().min(0).max(3600),
	windowSec: z.number().finite().min(0).max(3600),
	readingSec: z.number().finite().min(0).max(3600),
	device: z.string().max(200),
	at: z.string().max(40),
});
export type FixCost = z.infer<typeof CostSchema>;

const FileSchema = z.object({
	format: z.literal('jasper-transcript-fix-costs'),
	version: z.literal(1),
	models: z.record(z.string().max(128), CostSchema),
});

const MAX_MODELS = 64;

export class FixCostStore {
	private cache: Record<string, FixCost> | null = null;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly file: string,
		private readonly log: (m: string) => void = () => undefined,
	) {}

	private async load(): Promise<Record<string, FixCost>> {
		if (this.cache) return this.cache;
		let raw: unknown = null;
		try {
			raw = await readJsonOrNull(this.file);
		} catch (e) {
			this.log(`transcript-fix costs unreadable (${(e as Error).message}); starting afresh`);
		}
		const r = FileSchema.safeParse(raw);
		this.cache = r.success ? { ...r.data.models } : {};
		return this.cache;
	}

	/** The last measured cost of a model on this machine, or null. */
	async get(modelId: string): Promise<FixCost | null> {
		await this.chain;
		return (await this.load())[modelId] ?? null;
	}

	/** Records a measurement (non-finite or empty measurements are ignored; failures to write are logged). */
	record(modelId: string, cost: FixCost): Promise<void> {
		const ok = CostSchema.safeParse(cost);
		if (!ok.success) return Promise.resolve();
		this.chain = this.chain.then(async () => {
			const models = await this.load();
			models[modelId] = ok.data;
			const keys = Object.keys(models);
			if (keys.length > MAX_MODELS) for (const k of keys.slice(0, keys.length - MAX_MODELS)) delete models[k];
			try {
				await atomicWriteJson(this.file, { format: 'jasper-transcript-fix-costs', version: 1, models });
			} catch (e) {
				this.log(`could not write transcript-fix costs: ${(e as Error).message}`);
			}
		});
		return this.chain;
	}
}
