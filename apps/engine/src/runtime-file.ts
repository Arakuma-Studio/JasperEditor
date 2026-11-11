// `<appdir>/engine/runtime.json` (0600): lets local tools on the same machine (jasper-mcp, the jasper CLI,
// scripts) find this engine's port and token (docs/wp-notes/wp-mcp.md §Discovery). The appdir is the user's own
// data directory, so the file is as private as the projects next to it. The editor key is never written here:
// what reads this file is an agent, not the editor (security review AGT-2).
//
// Lifecycle: `starting` (pid + heartbeat, rewritten every ENGINE_HEARTBEAT_INTERVAL_MS) as soon as the appdir
// exists, so a tool started in the same second waits instead of reporting "not running"; `ready` (address, token)
// once the engine listens; removed on a clean stop. Every write is atomic (temp file, fsync, rename, directory
// fsync), serialized (a late heartbeat never overwrites `ready`), and never fatal: failures are logged.
import { readFile, rm } from 'node:fs/promises';
import {
	ENGINE_HEARTBEAT_INTERVAL_MS,
	type EngineRuntimeInfo,
	type EngineRuntimeStarting,
	type EngineRuntimeState,
	parseEngineRuntimeState,
} from '@jasper/config';
import { atomicWriteFile } from './tools/fs.ts';

export type RuntimeFile = {
	/** Writes the `ready` record (stops the heartbeat). Resolves with the file, or null when it could not be written. */
	ready(info: Omit<EngineRuntimeInfo, 'state' | 'pid' | 'startedAt' | 'readyAt'>): Promise<string | null>;
	/** Removes the file if it still describes this process (another engine may have replaced it). */
	remove(): Promise<void>;
};

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

async function readState(file: string): Promise<EngineRuntimeState | null> {
	try {
		return parseEngineRuntimeState(JSON.parse(await readFile(file, 'utf8')));
	} catch {
		return null;
	}
}

/**
 * Starts the runtime file of this process in the `starting` state. The starting record is skipped when the file
 * describes another live engine (two engines on one appdir: the one already running stays discoverable until
 * this one listens, as before the lifecycle existed). `remove` only removes a file this writer wrote.
 */
export async function startRuntimeFile(
	file: string,
	base: { host: string; port: number; version: string; appdir: string },
	opts: { now?: () => number; warn?(line: string): void } = {},
): Promise<RuntimeFile> {
	const now = opts.now ?? Date.now;
	const warn = opts.warn ?? ((l: string) => console.warn(l));
	const startedAt = new Date(now()).toISOString();
	let chain: Promise<unknown> = Promise.resolve();
	let failed = false;
	let wrote = false;
	const write = (record: EngineRuntimeState): Promise<boolean> => {
		const next = chain.then(async () => {
			try {
				await atomicWriteFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
				failed = false;
				wrote = true;
				return true;
			} catch (e) {
				// One warning per failure streak: a read-only appdir would otherwise warn every second.
				if (!failed) warn(`[engine] could not write ${file}: ${(e as Error).message}`);
				failed = true;
				return false;
			}
		});
		chain = next;
		return next;
	};

	// Another engine of this process counts as live too (tests run several engines in one process).
	const current = await readState(file);
	const owned = !current || !pidAlive(current.pid);
	let timer: ReturnType<typeof setInterval> | null = null;
	if (owned) {
		const starting = (): EngineRuntimeStarting => ({
			state: 'starting',
			pid: process.pid,
			host: base.host,
			...(base.port > 0 ? { port: base.port } : {}),
			version: base.version,
			appdir: base.appdir,
			startedAt,
			heartbeatAt: now(),
		});
		await write(starting());
		timer = setInterval(() => void write(starting()), ENGINE_HEARTBEAT_INTERVAL_MS);
		timer.unref?.();
	}
	const stopHeartbeat = () => {
		if (timer) clearInterval(timer);
		timer = null;
	};

	return {
		async ready(info) {
			stopHeartbeat();
			const ok = await write({
				state: 'ready',
				...info,
				pid: process.pid,
				startedAt,
				readyAt: now(),
			});
			return ok ? file : null;
		},
		async remove() {
			stopHeartbeat();
			await chain;
			if (!wrote) return;
			const cur = await readState(file);
			if (cur && cur.pid !== process.pid) return;
			await rm(file, { force: true }).catch(() => {});
		},
	};
}
