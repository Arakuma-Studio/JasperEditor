// Sound Check panel model, Phase 6 findings (spec 12 §4 P6-E1…E3, P6-E13; wp-note "Phase 6 → WP-E1"): the Edges and
// Tone groups in their order, the new findings and fixes translated (English and Spanish, cue kinds as labels), and
// every new template present in the model strings and the Spanish catalogue.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SoundCheckIssue } from '@jasper/api';
import { SOUND_CHECK_CATEGORY, SOUND_CHECK_MESSAGES, soundCheckMessage } from '@jasper/project';
import { afterEach, describe, expect, it } from 'vitest';
import { __setCatalogForTests } from '../src/i18n/runtime.ts';
import { CATEGORY_LABELS, CATEGORY_ORDER, groupIssues, messageText } from '../src/sound/check-model.ts';

const root = join(__dirname, '../../..');
const ES = JSON.parse(readFileSync(join(root, 'apps/web/src/i18n/es.json'), 'utf8')) as Record<
	string,
	string
>;
const NAMES = JSON.parse(
	readFileSync(join(root, 'apps/web/src/i18n/model-strings.json'), 'utf8'),
) as string[];
afterEach(() => __setCatalogForTests('en', null));

const issue = (
	code: SoundCheckIssue['code'],
	frame: number,
	severity: SoundCheckIssue['severity'],
): SoundCheckIssue => ({
	id: `${code}:${frame}`,
	code,
	severity,
	category: SOUND_CHECK_CATEGORY[code],
	frame,
	message: soundCheckMessage('clickStart', 'Tone', '00:00:04:00', '24.0'),
});

describe('Phase 6 findings in the Sound Check panel', () => {
	it('groups: Sync, Edges, Loudness, Mix, Tone, Cues, Licence, Reference — every category has a label', () => {
		// Reference (P6-E8, WP-E4): the comparison with a reference profile, a style rather than a defect: last
		expect(CATEGORY_ORDER).toEqual([
			'sync',
			'edges',
			'loudness',
			'mix',
			'tonal',
			'cues',
			'licence',
			'reference',
		]);
		for (const c of CATEGORY_ORDER) expect(CATEGORY_LABELS[c]).toBeTruthy();
		const groups = groupIssues([
			issue('HARSH', 30, 'warning'),
			issue('ARC', 90, 'info'),
			issue('CLICK', 120, 'error'),
			issue('COVERAGE', 63, 'warning'),
			issue('EDGE', 60, 'warning'),
			issue('OUT_OF_SYNC', 30, 'error'),
			issue('LAYER_INAUDIBLE', 210, 'info'),
		]);
		expect(groups.map((g) => [g.category, g.issues.map((i) => i.code)])).toEqual([
			['sync', ['OUT_OF_SYNC']],
			['edges', ['CLICK', 'EDGE']],
			['loudness', ['ARC']],
			['mix', ['LAYER_INAUDIBLE']],
			['tonal', ['HARSH']],
			['cues', ['COVERAGE']],
		]);
	});

	it('the new findings and fixes read in Spanish; cue kinds become labels', () => {
		__setCatalogForTests('es', ES, NAMES);
		expect(messageText(soundCheckMessage('clickStart', 'Tono', '00:00:04:00', '24.0'))).toBe(
			'Clic en un corte: el inicio de Tono en 00:00:04:00 (24.0 dB por encima de su entorno por encima de 14 kHz)',
		);
		const cov = messageText(soundCheckMessage('coverage', 3, 4, 'appear', 1, '00:00:02:03'));
		expect(cov).toMatch(/^3 de 4 señales de .+ como estas tienen sonido; 1 no: 00:00:02:03$/);
		expect(cov).not.toContain('appear');
		const end = messageText(soundCheckMessage('syncEndEarly', 'Riser', 120, 'cut', '00:00:04:00'));
		expect(end).not.toContain(' cut ');
		expect(end).toMatch(/^Riser termina 120 ms antes de tiempo/);
		expect(messageText(soundCheckMessage('fixFadeIn', 1))).toBe(
			'Fundido de entrada con una transición de potencia constante de 1 fotogramas',
		);
		expect(messageText(soundCheckMessage('licenseShareAlike', 'Riser', 'CC-BY-SA-4.0'))).toMatch(
			/CompartirIgual/,
		);
	});

	it('every Phase 6 template is a model string with a Spanish translation', () => {
		const keys = Object.keys(SOUND_CHECK_MESSAGES).filter((k) =>
			/^(click|edge|harsh|bright|layer|coverage|ending|head|arc|syncEnd|licenseShareAlike|fixFade|fixLengthen|fixCrossfade|fixExtend|fixHarsh|fixLayer|fixRemoveLayer|fixFill|fixMute|fixEnding|fixHead|whyExtend|whyHarsh|whyLayer|whyCoverage|whyEnding)/.test(
				k,
			),
		) as (keyof typeof SOUND_CHECK_MESSAGES)[];
		expect(keys.length).toBeGreaterThanOrEqual(40);
		for (const k of keys) {
			const t = SOUND_CHECK_MESSAGES[k];
			expect(NAMES, k).toContain(t);
			expect(ES[t], k).toBeTruthy();
		}
	});
});
