import { defineProject } from 'vitest/config';

// The BS.1770 / Tech 3341–3342 cases measure minutes of 48 kHz audio: 1–3 s each on an idle core, past vitest's
// default 5 s on a loaded CI runner (verify workstream: "Tech 3342 loudness range" timed out in a clean-clone CI run
// at load ≈ 15). Same budget as the sibling DSP packages (audio-fx 120 s, project 60 s).
export default defineProject({
	test: { include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 60_000 },
});
