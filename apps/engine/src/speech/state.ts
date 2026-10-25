// Speech-to-text state of this computer (spec 16): the Transcription preferences (Processor, Accuracy, Enable
// NVIDIA GPU), the cached provider probe with its decoder calibrations (SG-001/SG-002) and the last measured speed
// per model and device (SG-030). One file, `<appdir>/engine/speech.json`, validated with zod when read (a bad or
// foreign section falls back to its default) and written atomically under a mutex.
import {
	type SpeechCalibration,
	SpeechCalibrationSchema,
	type SpeechProviderStatus,
	SpeechProviderStatusSchema,
	type SpeechSettings,
	SpeechSettingsSchema,
} from '@jasper/api';
import { z } from 'zod';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';

/** What the probe found (machine facts + provider statuses); re-probed when its key changes. */
export const StoredProbeSchema = z.object({
	/** ORT version, platform, arch, CUDA provider state and NVIDIA setting: a change invalidates the probe. */
	key: z.string(),
	providers: z.array(SpeechProviderStatusSchema),
	gpu: z
		.object({ name: z.string(), provider: SpeechProviderStatusSchema.shape.id, vramMb: z.number().nullable() })
		.nullable(),
	probedAt: z.string(),
	error: z.string().optional(),
});
export type StoredProbe = z.infer<typeof StoredProbeSchema>;

export const MeasurementSchema = z.object({
	modelId: z.string(),
	encoder: SpeechProviderStatusSchema.shape.id,
	decoder: SpeechProviderStatusSchema.shape.id,
	accuracy: z.enum(['standard', 'best']),
	/** Recognition time / audio time. */
	rtf: z.number().min(0).max(1000),
	audioSec: z.number().min(0),
	at: z.string(),
});
export type Measurement = z.infer<typeof MeasurementSchema>;

const MAX_MEASUREMENTS = 64;
const MAX_CALIBRATIONS = 32;

type FileShape = {
	settings?: unknown;
	probe?: unknown;
	calibrations?: unknown;
	measurements?: unknown;
};

export class SpeechStateStore {
	private readonly mutex = new KeyedMutex();
	constructor(private readonly file: string) {}

	private async readAll(): Promise<FileShape> {
		const raw = await readJsonOrNull<FileShape>(this.file).catch(() => null);
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
	}

	private async update(fn: (all: FileShape) => void): Promise<void> {
		await this.mutex.run('speech.json', async () => {
			const all = await this.readAll();
			fn(all);
			await atomicWriteJson(this.file, all, true);
		});
	}

	async settings(): Promise<SpeechSettings> {
		const r = SpeechSettingsSchema.safeParse((await this.readAll()).settings ?? {});
		return r.success ? r.data : SpeechSettingsSchema.parse({});
	}

	async setSettings(patch: Partial<SpeechSettings>): Promise<SpeechSettings> {
		let next = SpeechSettingsSchema.parse({});
		await this.update((all) => {
			const cur = SpeechSettingsSchema.safeParse(all.settings ?? {});
			next = SpeechSettingsSchema.parse({ ...(cur.success ? cur.data : {}), ...patch });
			all.settings = next;
		});
		return next;
	}

	async probe(): Promise<StoredProbe | null> {
		const r = StoredProbeSchema.safeParse((await this.readAll()).probe);
		return r.success ? r.data : null;
	}

	async setProbe(p: StoredProbe): Promise<void> {
		await this.update((all) => {
			all.probe = StoredProbeSchema.parse(p);
		});
	}

	async calibrations(): Promise<SpeechCalibration[]> {
		const r = z.array(SpeechCalibrationSchema).safeParse((await this.readAll()).calibrations ?? []);
		return r.success ? r.data : [];
	}

	/** Stores a decoder calibration (one per model and GPU provider; newest wins). */
	async addCalibration(c: SpeechCalibration): Promise<void> {
		await this.update((all) => {
			const cur = z.array(SpeechCalibrationSchema).safeParse(all.calibrations ?? []);
			const list = (cur.success ? cur.data : []).filter((x) => !(x.modelId === c.modelId && x.provider === c.provider));
			all.calibrations = [...list, SpeechCalibrationSchema.parse(c)].slice(-MAX_CALIBRATIONS);
		});
	}

	async clearCalibrations(): Promise<void> {
		await this.update((all) => {
			all.calibrations = [];
		});
	}

	async measurements(): Promise<Measurement[]> {
		const r = z.array(MeasurementSchema).safeParse((await this.readAll()).measurements ?? []);
		return r.success ? r.data : [];
	}

	/** The last run of a model on a device (one entry per model, encoder provider and accuracy). */
	async addMeasurement(m: Measurement): Promise<void> {
		if (!Number.isFinite(m.rtf) || m.audioSec < 5) return; // too short to say anything about speed
		await this.update((all) => {
			const cur = z.array(MeasurementSchema).safeParse(all.measurements ?? []);
			const list = (cur.success ? cur.data : []).filter(
				(x) => !(x.modelId === m.modelId && x.encoder === m.encoder && x.accuracy === m.accuracy),
			);
			all.measurements = [...list, MeasurementSchema.parse({ ...m, rtf: Math.min(1000, m.rtf) })].slice(
				-MAX_MEASUREMENTS,
			);
		});
	}
}

export type { SpeechProviderStatus };
