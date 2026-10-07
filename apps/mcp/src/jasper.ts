// `jasper` bin entry (docs/wp-notes/mcp-cli.md §5): the one-shot CLI. Ctrl+C cancels the running command
// (an export or render is cancelled in the engine and its partial output deleted).
import { runCli } from './jasper-cli.ts';

const ac = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
	if (interrupted) process.exit(130);
	interrupted = true;
	process.stderr.write('[jasper] cancelling… (Ctrl+C again to quit at once)\n');
	ac.abort(new Error('interrupted'));
});

runCli(process.argv.slice(2), {
	stdout: (s) => process.stdout.write(s),
	stderr: (s) => process.stderr.write(s),
	signal: ac.signal,
})
	.then((code) => {
		process.exitCode = interrupted && code === 0 ? 130 : code;
	})
	.catch((e) => {
		process.stderr.write(`jasper: ${(e as Error)?.stack ?? e}\n`);
		process.exitCode = 1;
	});
