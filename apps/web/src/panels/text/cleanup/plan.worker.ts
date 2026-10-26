// Clean Up review planner worker (spec 14 TC-042, TC-060): keeps the analysed document and the voice analyses of one
// review (`init`) and answers each `plan` request with `analyzeSequenceCleanup` (`planner.ts` `runPlan`), off the
// editor's main thread.
import { type PlanBase, runPlan, type WorkerIn, type WorkerOut } from './planner.ts';

let base: PlanBase | null = null;

self.onmessage = (e: MessageEvent<WorkerIn>) => {
	const msg = e.data;
	if (msg.type === 'init') {
		base = msg.base;
		return;
	}
	const result: WorkerOut['result'] = base
		? runPlan(base, msg.req)
		: { ok: false, code: 'E_INTERNAL', message: 'The planner has no analysis' };
	(self as unknown as Worker).postMessage({ id: msg.id, result } satisfies WorkerOut);
};
