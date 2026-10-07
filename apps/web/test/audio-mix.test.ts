// audio-mix (web): fader law, prefs parsing, automation gestures, voice-over helpers, workspaces and commands.
import { describe, expect, it } from 'vitest';
import { Gesture } from '../src/audio/automation.ts';
import { dbToFader, faderToDb } from '../src/audio/components/controls.tsx';
import { meterPos } from '../src/audio/components/LevelMeter.tsx';
import { DEFAULT_AUDIO_PREFS, parseAudioPrefs } from '../src/audio/prefs.ts';
import { cueFrames, nextTakeName, recordTrackOf } from '../src/audio/voiceover.ts';
import { audioCommands } from '../src/commands/audio.ts';
import { DEFAULT_KEYMAP } from '../src/commands/keymap-defaults.ts';
import { listPanels } from '../src/panels/registry.ts';
import { BUILTIN_WORKSPACES, type LayoutNode } from '../src/shell/workspaces/definitions.ts';

function panelsOf(n: LayoutNode): string[] {
	return 'group' in n ? [...n.group] : n.children.flatMap((c) => panelsOf(c.node));
}

describe('audio UI helpers', () => {
	it('fader law round-trips and puts 0 dB at three quarters', () => {
		expect(dbToFader(0)).toBeCloseTo(0.75);
		expect(dbToFader(-96)).toBe(0);
		expect(dbToFader(15)).toBe(1);
		for (const db of [-60, -24, -12, -6, -3, 0, 3, 6, 12])
			expect(Math.abs(faderToDb(dbToFader(db)) - db)).toBeLessThanOrEqual(0.05);
		expect(faderToDb(0)).toBe(-96);
	});

	it('meter scale maps 0 dB to the top and −60 to the bottom', () => {
		expect(meterPos(0)).toBe(1);
		expect(meterPos(-60)).toBe(0);
		expect(meterPos(-30)).toBeCloseTo(0.5);
		expect(meterPos(Number.NEGATIVE_INFINITY)).toBe(0);
	});

	it('audio prefs parse tolerantly', () => {
		expect(parseAudioPrefs(null)).toEqual(DEFAULT_AUDIO_PREFS);
		const p = parseAudioPrefs({ scrub: false, mixdown: 'bogus', voiceOver: { prerollSeconds: 999, name: '  ' } });
		expect(p.scrub).toBe(false);
		expect(p.mixdown).toBe('frontRear');
		expect(p.voiceOver.prerollSeconds).toBe(60);
		expect(p.voiceOver.name).toBe('Voice-over');
	});

	it('a held control records a flat line, not a ramp to the next move', () => {
		const g = new Gesture('trk', 'volume', 'latch', 0, -6);
		g.push(100, -6);
		g.push(200, -6);
		g.push(210, -3);
		g.flush();
		expect(g.points).toEqual([
			[0, -6],
			[200, -6],
			[210, -3],
		]);
	});

	it('voice-over: countdown cues, take names, record track', () => {
		const fps = { num: 30, den: 1 };
		expect(cueFrames(40, 100, fps)).toEqual([40, 70, 100]);
		expect(cueFrames(100, 100, fps)).toEqual([100]);
		expect(nextTakeName('Voice-over', ['Voice-over 1.wav', 'voice-over 2'])).toBe('Voice-over 3.wav');
		const seq = {
			audioTracks: [{ id: 'a1' }, { id: 'a2', mixer: { recordArm: true } }],
		} as never;
		expect(recordTrackOf(seq)).toBe('a2');
		expect(recordTrackOf(seq, 'a1')).toBe('a1');
		expect(recordTrackOf(seq, 'nope')).toBeNull();
	});
});

describe('audio shell integration', () => {
	it('every built-in workspace lists each panel once and only known panels', () => {
		const known = new Set(listPanels().map((p) => p.kind));
		for (const ws of BUILTIN_WORKSPACES) {
			const panels = panelsOf(ws.layout);
			expect(new Set(panels).size, ws.id).toBe(panels.length);
			for (const p of panels) expect(known.has(p as never), `${ws.id}: ${p}`).toBe(true);
		}
		expect(BUILTIN_WORKSPACES.some((w) => w.id === 'audio')).toBe(true);
	});

	it('the mixer panels exist and their Premiere shortcuts are bound', () => {
		const kinds = listPanels().map((p) => p.kind);
		expect(kinds).toContain('audioTrackMixer');
		expect(kinds).toContain('audioClipMixer');
		const key = (c: string) => DEFAULT_KEYMAP.find((b) => b.command === c)?.key;
		expect(key('panel.open.audioTrackMixer')).toBe('Shift+Digit6');
		expect(key('panel.open.audioClipMixer')).toBe('Shift+Digit9');
		expect(key('timeline.audioGain')).toBe('KeyG');
		expect(key('transport.toggleAudioScrub')).toBe('Shift+KeyS');
	});

	it('registers the audio commands', () => {
		const ids = audioCommands.map((c) => c.id);
		for (const id of [
			'timeline.audioGain',
			'transport.toggleAudioScrub',
			'audio.autoDuck',
			'audio.measureLoudness',
			'sequence.loudness',
			'audio.normalizeMedia',
			'audio.voiceoverRecord',
		])
			expect(ids).toContain(id);
	});
});
