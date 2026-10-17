import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

// Sound Check (spec 12 §2.6 / §2.7 "Sound Check panel", P5-R3; WP5.2): measured QA of the mix as it will be delivered —
// the findings with their fixes, Fix all safe, the sync strips, the listen-here moments with the user's verdicts.
const soundCheck: PanelDefinition = {
	kind: 'soundCheck',
	title: () => 'Sound Check',
	icon: 'panel.soundCheck',
	instance: 'single',
	minSize: { w: 320, h: 200 },
	keymapScope: 'soundCheck',
	touch: 'sheet',
	requires: ['engine'],
	dockWith: 'review',
	agentDescription:
		'Sound Check: measured QA of the active sequence’s mix as it will be delivered. Header: Delivery target (Web −14 / Podcast −16 / EBU R 128 −23 / ATSC A/85 −24 LUFS, or Custom… LUFS + dBTP), "Use as sequence target" (one undo step), Run (the sound-check job, progress, Cancel). Summary chips: verdict (Pass / Warnings / Fail), integrated LUFS, true peak dBTP, LRA, errors / warnings / info; a "Stale" line with Re-run when the mix changed since the stored summary. Findings grouped by category (Sync, Loudness, Mix, Cues, Licence) — severity icon + word, timecode (jumps the playhead and selects the clip or cue), code and message, Fix (safe) / Fix… (needs judgement); sync rows open a strip of 5 frames above the waveform. "Fix all safe (n)" applies every safe fix as one undo step, then runs again. Listen here: up to 5 moments (worst, biggest hero, loudest, busiest, a passing cue) with ▶ (4 s), Sounds right / Flag + note (the user’s verdict, a comment marker) and Play all. Keys in the findings list: ↑ ↓ Home End, Enter go to, F fix, → / ← strip, Space play. UI commands: sound.runSoundCheck, sound.fixAllSafe. Agents: MCP sound_check (the same report; humanVerdicts returns the user’s verdicts).',
	menu: [
		{ type: 'command', command: 'sound.runSoundCheck', label: 'Run Sound Check' },
		{ type: 'command', command: 'sound.fixAllSafe', label: 'Fix All Safe' },
	],
	component: lazyPanel(() => import('./SoundCheckPanel.tsx'), 'SoundCheckPanel'),
};
export default soundCheck;
