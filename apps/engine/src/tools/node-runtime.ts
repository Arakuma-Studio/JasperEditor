// The Node.js executable that runs the engine's own worker programs (jasper-speech, jasper-roto, jasper-camtrack,
// jasper-proc, the bundle schema runner): separate processes started with a script path.
//
// In a checkout and in a headless engine that is `process.execPath`: Node itself. In the packaged desktop app the
// engine runs in an Electron utility process and `process.execPath` is the application binary, which runs a script
// only when ELECTRON_RUN_AS_NODE=1 is in the child's environment (measured with Electron 44: without it the child
// starts as a second application instance and never runs the worker) — the engine's CLI sets that variable for
// its children when it finds itself inside Electron (cli.ts). That is why the `runAsNode` fuse of the packaged app
// cannot be switched off yet (docs/security-review.md §8, RUN-1).
//
// The way out is a Node runtime shipped next to the engine: `<resources>/node/node` (`node.exe` on Windows), or any
// executable named by JASPER_NODE. When one is there it is used for every worker, the application binary is never
// run as Node, and the fuse can be disabled by the packaging alone.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const NODE_ENV = 'JASPER_NODE';
const RESOURCES_ENV = 'JASPER_RESOURCES_DIR';

/** The bundled Node runtime of a resources directory, or null. */
function bundledNode(resourcesDir: string | undefined): string | null {
	if (!resourcesDir) return null;
	const file = join(resourcesDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
	return existsSync(file) ? file : null;
}

/** The executable to start a Node program with. */
export function nodeExecPath(env: Record<string, string | undefined> = process.env): string {
	const explicit = env[NODE_ENV];
	if (explicit && existsSync(explicit)) return explicit;
	return bundledNode(env[RESOURCES_ENV]) ?? process.execPath;
}

/** True when this process is Electron (its binary runs scripts only as "run as Node"). */
export function insideElectron(): boolean {
	return typeof process.versions.electron === 'string';
}
