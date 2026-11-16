/**
 * For entries whose stdout is machine-read (jasper-mcp: JSON-RPC; `jasper --json` / `call`: JSON lines): anything a
 * dependency prints with console.log/info/debug would corrupt it, so those go to stderr for the life of the process.
 */
export function keepStdoutClean(): void {
	for (const level of ['log', 'info', 'debug'] as const)
		console[level] = (...args: unknown[]) => console.error(...args);
}
