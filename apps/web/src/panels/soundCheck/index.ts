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
		'Sound Check: measured QA of the active sequence’s mix as it will be delivered. Header: Delivery target (Web −14 / Podcast −16 / EBU R 128 −23 / ATSC A/85 −24 LUFS, or Custom… LUFS + dBTP), "Use as sequence target" (one undo step), Check for (the export encoding the mix is delivered through before loudness and true peak are judged: PCM / master, AAC 128–320 kb/s, Opus 96–160 kb/s; default the last export settings, else the delivery target’s typical one — Web AAC 256, Podcast AAC 128, broadcast PCM), Run (the sound-check job, progress, Cancel). Summary chips: verdict (Pass / Warnings / Fail), integrated LUFS, true peak dBTP, LRA, errors / warnings / info; what it was checked for; a "Stale" line with Re-run when the mix changed since the stored summary or it was checked for another encoding than Check for. Findings grouped by category (Sync, Loudness, Mix, Cues, Licence) — severity icon + word, timecode (jumps the playhead and selects the clip or cue), code and message, Fix (safe) / Fix… (needs judgement); sync rows open a strip of 5 frames above the waveform. "Fix all safe (n)" applies every safe fix as one undo step, then runs again. Listen here: up to 5 moments (worst, biggest hero, loudest, busiest, a passing cue) with ▶ (4 s), Sounds right / Flag + note (the user’s verdict, a comment marker) and Play all. Keys in the findings list: ↑ ↓ Home End, Enter go to, F fix, → / ← strip, Space play. UI commands: sound.runSoundCheck, sound.fixAllSafe, sound.listenToSequence. Tabs: Findings (the above) and Log — Listen (the sound-listen job, progress, Cancel), Detail (Low / Normal / High), Copy log, Spectrogram (the mix of the listened range, ≤ 120 s around the current line), and the transcript lines (sections, every sound with its clip and cue, which cuts and cues have a sound with the chance levels, NO SOUND lines); a line moves the playhead there and selects its clip (↑ ↓ Home End, Enter). Agents: MCP sound_check (the same report; humanVerdicts returns the user’s verdicts) and listen_to_sequence (the same log lines).',
	menu: [
		{ type: 'command', command: 'sound.runSoundCheck', label: 'Run Sound Check' },
		{ type: 'command', command: 'sound.fixAllSafe', label: 'Fix All Safe' },
		{ type: 'command', command: 'sound.listenToSequence', label: 'Listen to Sequence' },
	],
	component: lazyPanel(() => import('./SoundCheckPanel.tsx'), 'SoundCheckPanel'),
};
export default soundCheck;
