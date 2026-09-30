// Jobs panel (S05:JOB-001…005) — WP-2E.
import type { PanelDefinition } from '../types.ts';
import { JobsPanel } from './JobsPanel.tsx';

export { useAllJobs, useJobsSummary } from './JobsPanel.tsx';
export { summarizeJobs } from './model.ts';

const jobs: PanelDefinition = {
	kind: 'jobs',
	title: () => 'Jobs',
	icon: 'panel.jobs',
	instance: 'single',
	minSize: { w: 240, h: 120 },
	keymapScope: 'jobs',
	touch: 'sheet',
	requires: ['engine'],
	agentDescription: 'Engine jobs: imports, derivatives, exports and renders with progress.',
	component: JobsPanel,
};

export default jobs;
