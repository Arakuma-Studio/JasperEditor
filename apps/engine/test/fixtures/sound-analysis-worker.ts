// Real Worker protocol fixture: hold replies until the test releases them, crash or withhold one request.
// Successful replies run the production analysis; the test observes actual signal bytes, not arranged results.
import { existsSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort } from 'node:worker_threads';
import type { WorkerRequest, WorkerResponse } from '../../src/sounds/analysis.ts';
import { runAnalysis } from '../../src/sounds/analysis-core.ts';

const port = parentPort!;
const directory = dirname(fileURLToPath(import.meta.url));
const release = join(directory, 'release');

port.on('message', (m: WorkerRequest) => {
	writeFileSync(join(directory, m.job.soundId), 'received');
	if (m.job.soundId === 'snd_0000000000000003') throw new Error('intentional worker crash');
	if (m.job.soundId === 'snd_0000000000000004') return;
	const answer = () => {
		const result = runAnalysis(m.job);
		writeFileSync(join(directory, `${m.job.soundId}.computed`), 'analysed');
		port.postMessage({ id: m.id, ok: true, result } satisfies WorkerResponse);
	};
	if (existsSync(release)) return answer();
	let answered = false;
	const watcher = watch(directory, () => {
		if (answered || !existsSync(release)) return;
		answered = true;
		watcher.close();
		answer();
	});
	// The release may have been created between the first check and installing the watcher.
	if (existsSync(release)) {
		answered = true;
		watcher.close();
		answer();
	}
});
port.postMessage({ id: 0, ready: true } satisfies WorkerResponse);
