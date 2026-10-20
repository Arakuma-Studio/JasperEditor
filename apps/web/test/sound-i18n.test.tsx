// Sound design in Spanish (Phase 1 limit "the history label and placement refusals from @jasper/project are English in
// the editor"): History labels composed by agents' tools ("Agent: Sound Cues (add 2, …)", "Agent: Place Sound <title>")
// and the model's refusals shown in notices are translated through the model strings (SOUND_MODEL_STRINGS →
// model-strings.json → `translateName`), the web's own labels through `t()` at commit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planSoundInsert, SOUND_LABELS, soundText } from '@jasper/project';
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { transformI18n } from '../i18n/transform.mjs';
import { __t, setLanguage, translateName } from '../src/i18n/runtime.ts';
import { HistoryPanel } from '../src/panels/history/HistoryPanel.tsx';
import { addSolids, makeSession, renderWithSession } from './inspector-helpers.tsx';

const root = join(__dirname, '../../..');
const ES = JSON.parse(readFileSync(join(root, 'apps/web/src/i18n/es.json'), 'utf8')) as Record<
	string,
	string
>;
const spanish = () => setLanguage('es');

afterEach(async () => {
	cleanup();
	await setLanguage('en');
	document.body.innerHTML = '';
});

describe('sound design labels and refusals in Spanish', () => {
	it('agent History labels of the MCP sound tools', async () => {
		const cues = `${SOUND_LABELS.soundCues} (${[
			soundText(SOUND_LABELS.cuesAdd, 2),
			soundText(SOUND_LABELS.cuesEdit, 1),
			soundText(SOUND_LABELS.cuesRemove, 1),
			SOUND_LABELS.cuesResync,
		].join(', ')})`;
		expect(translateName(`Agent: ${cues}`)).toBeNull(); // English: nothing to do
		await spanish();
		expect(translateName(`Agent: ${cues}`)).toBe(
			'Agente: Señales de sonido (añadir 2, editar 1, eliminar 1, resincronizar)',
		);
		const t = (label: string) => translateName(`Agent: ${label}`);
		expect(t(soundText(SOUND_LABELS.placeSound, 'Crunchy impact'))).toBe(
			'Agente: Colocar sonido Crunchy impact',
		);
		// a title with separators keeps its own text
		expect(t(soundText(SOUND_LABELS.placeSound, 'Hit: metal / light'))).toBe(
			'Agente: Colocar sonido Hit: metal / light',
		);
		expect(t(soundText(SOUND_LABELS.placeSounds, 3))).toBe('Agente: Colocar 3 sonidos');
		expect(t(soundText(SOUND_LABELS.swapSound, 'Heavy metal hit'))).toBe(
			'Agente: Cambiar sonido Heavy metal hit',
		);
		expect(t(SOUND_LABELS.alignPeak)).toBe('Agente: Alinear pico de sonido');
		expect(t(soundText(SOUND_LABELS.alignPeaks, 3))).toBe('Agente: Alinear 3 picos de sonido');
		expect(t(soundText(SOUND_LABELS.addSound, 'Low boom'))).toBe('Agente: Añadir sonido Low boom');
	});

	it('the History panel shows agent sound entries in Spanish', async () => {
		const session = makeSession();
		const [id] = addSolids(session, [0], 30);
		act(() => {
			for (const [i, label] of [
				`${SOUND_LABELS.soundCues} (${soundText(SOUND_LABELS.cuesAdd, 17)})`,
				soundText(SOUND_LABELS.placeSound, 'Crunchy impact'),
			].entries())
				session.apply({
					label,
					origin: { agent: 'claude' },
					commands: [{ type: 'param.set', target: ['clip', id, 'opacity'], value: 50 + i }] as never,
				});
		});
		await spanish();
		renderWithSession(session, <HistoryPanel instanceId="h1" visible />);
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(screen.getByTestId('history-row-2').textContent).toContain(
			'Agente: Señales de sonido (añadir 17)',
		);
		expect(screen.getByTestId('history-row-3').textContent).toContain(
			'Agente: Colocar sonido Crunchy impact',
		);
	});

	it('refusals of the sound commands and planners shown in a notice', async () => {
		await spanish();
		const session = makeSession();
		const r = session.apply({
			label: 'x',
			origin: 'user',
			commands: [{ type: 'soundCue.remove', cueIds: ['cue_0000000000000999'] }] as never,
		});
		expect(r.ok).toBe(false);
		const message = r.ok ? '' : r.errors[0]!.message;
		expect(message).toBe('Sound cue not found: cue_0000000000000999');
		const plan = planSoundInsert({
			cueFrame: 10,
			fps: { num: 30, den: 1 } as never,
			align: 'peak',
			timing: { peakSec: 0, onsetSec: 0, headQuietSec: 0, durationSec: 0 },
		});
		expect(plan.ok).toBe(false);
		const late = planSoundInsert({
			cueFrame: 3,
			fps: { num: 30, den: 1 } as never,
			align: 'peak',
			timing: { peakSec: 0.5, onsetSec: 0, headQuietSec: 0, durationSec: 1 },
			clampStart: false,
		});
		// A notice renders the message as text: the document observer translates it.
		const notice = document.createElement('div');
		notice.innerHTML = `<p id="a"></p><p id="b"></p><p id="c"></p>`;
		document.body.appendChild(notice);
		notice.querySelector('#a')!.textContent = message;
		notice.querySelector('#b')!.textContent = plan.ok ? '' : plan.message;
		notice.querySelector('#c')!.textContent = late.ok ? '' : late.message;
		await new Promise((r) => setTimeout(r, 0));
		expect(notice.querySelector('#a')!.textContent).toBe(
			'No se encuentra la señal de sonido: cue_0000000000000999',
		);
		expect(notice.querySelector('#b')!.textContent).toBe('El sonido no tiene duración');
		expect(notice.querySelector('#c')!.textContent).toBe(
			'el punto «peak» del sonido está a 0.500 s de su inicio: alineado en el fotograma 3 empezaría en el fotograma -12, antes de la secuencia',
		);
		expect(translateName('The new sound does not fit on its track between frames 12 and 40')).toBe(
			'El nuevo sonido no cabe en su pista entre los fotogramas 12 y 40',
		);
		expect(translateName('clp_0000000000000004 is not an audio clip')).toBe(
			'clp_0000000000000004 no es un clip de audio',
		);
		// a text that only looks similar stays as it is
		expect(translateName('The new sound does not fit')).toBeNull();
	});

	it("the web's own sound labels are translated when committed (t() and the build transform)", async () => {
		await spanish();
		expect(__t('Fill Cue {0}', 'Crunchy impact')).toBe('Rellenar señal Crunchy impact');
		expect(__t('Swap Sound ×{0}', 4)).toBe(ES['Swap Sound ×{0}']!.replace('{0}', '4'));
		expect(__t('Suggest Cues ({0})', 12)).toBe('Sugerir señales (12)');
		expect(__t('Fill Unfilled Cues ({0})', 3)).toBe('Rellenar señales vacías (3)');
		expect(__t('Add Layer {0}', 'Low boom')).toBe(ES['Add Layer {0}']!.replace('{0}', 'Low boom'));
		// insert.ts writes its label as a template literal: the build wraps it in __t("Add Sound {0}", title).
		const insert = readFileSync(join(root, 'apps/web/src/sound/insert.ts'), 'utf8');
		expect(transformI18n(insert, 'insert.ts', '/rt.ts')).toContain('__t("Add Sound {0}", title)');
		expect(__t('Add Sound {0}', 'Low boom')).toBe('Añadir sonido Low boom');
	});
});
