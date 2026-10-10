// Processing settings (S07:PRM-001, ARCHITECTURE §19.4): stored in `<appdir>/engine/engine.json` → `processing`.
// The file may hold other sections (unknown keys are preserved); writes are atomic.
import { existsSync } from 'node:fs';
import { type ProcessingSettings, ProcessingSettingsSchema, type RemoteProbeResult } from '@jasper/api';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';

export type StoredProbe = RemoteProbeResult & {
	at: string;
	host: string;
	cpus?: number | null;
	ffmpegPath?: string | null;
};

type EngineJson = Record<string, unknown> & {
	processing?: unknown;
	processingState?: { lastProbe?: StoredProbe | null };
};

const DEFAULT_SETTINGS: ProcessingSettings = { remote: null };

export class SettingsError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** PRM-009: validates user-provided remote settings (paths are never interpreted by a shell). */
function validateSettings(s: ProcessingSettings): void {
	const r = s.remote;
	if (!r) return;
	// (A leading `-` would make `user@host` an ssh option: security review SSH-1.)
	if (!/^[A-Za-z0-9._-]+$/.test(r.user) || r.user.startsWith('-'))
		throw new SettingsError('INVALID_SETTINGS', 'Invalid SSH user name');
	if (!/^[A-Za-z0-9.:_-]+$/.test(r.host) || r.host.startsWith('-'))
		throw new SettingsError('INVALID_SETTINGS', 'Invalid SSH host');
	if (!r.remoteDir.startsWith('/') || /[\s'"`$\\;&|<>*?]/.test(r.remoteDir) || r.remoteDir.includes('..'))
		throw new SettingsError(
			'INVALID_SETTINGS',
			'The remote directory must be an absolute path without spaces or shell characters',
		);
	if (r.identityFile !== null) {
		if (!r.identityFile.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(r.identityFile))
			throw new SettingsError('INVALID_SETTINGS', 'The identity file must be an absolute path');
		if (!existsSync(r.identityFile))
			throw new SettingsError('INVALID_SETTINGS', `The identity file ${r.identityFile} does not exist`);
	}
}

export class ProcessingSettingsStore {
	private readonly mutex = new KeyedMutex();
	constructor(private readonly file: string) {}

	private async readAll(): Promise<EngineJson> {
		return (await readJsonOrNull<EngineJson>(this.file)) ?? {};
	}

	async get(): Promise<ProcessingSettings> {
		const all = await this.readAll();
		const parsed = ProcessingSettingsSchema.safeParse(all.processing ?? DEFAULT_SETTINGS);
		return parsed.success ? parsed.data : DEFAULT_SETTINGS;
	}

	async put(next: ProcessingSettings): Promise<ProcessingSettings> {
		const value = ProcessingSettingsSchema.parse(next);
		validateSettings(value);
		return this.mutex.run('engine.json', async () => {
			const all = await this.readAll();
			const prev = ProcessingSettingsSchema.safeParse(all.processing ?? DEFAULT_SETTINGS);
			all.processing = value;
			// A different host invalidates the last probe.
			const prevRemote = prev.success ? prev.data.remote : null;
			if (
				!value.remote ||
				!prevRemote ||
				prevRemote.host !== value.remote.host ||
				prevRemote.port !== value.remote.port ||
				prevRemote.user !== value.remote.user
			)
				all.processingState = { ...(all.processingState ?? {}), lastProbe: null };
			await atomicWriteJson(this.file, all);
			return value;
		});
	}

	async lastProbe(): Promise<StoredProbe | null> {
		return (await this.readAll()).processingState?.lastProbe ?? null;
	}

	async setLastProbe(p: StoredProbe): Promise<void> {
		await this.mutex.run('engine.json', async () => {
			const all = await this.readAll();
			all.processingState = { ...(all.processingState ?? {}), lastProbe: p };
			await atomicWriteJson(this.file, all);
		});
	}
}
