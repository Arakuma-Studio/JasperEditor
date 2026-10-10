// polish: live language switching (lazy module-scope strings, the language epoch) and labels built from the model's
// names ("Gaussian Blur: Radius", "Bypass Gaussian Blur").
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { transformI18n } from '../i18n/transform.mjs';
import { assignLazy, defineLazyLabel } from '../src/i18n/lazy.ts';
import { useLanguageEpoch } from '../src/i18n/react.ts';
import {
	__set,
	__setCatalogForTests,
	__t,
	getLanguage,
	languageEpoch,
	t,
	translateName,
} from '../src/i18n/runtime.ts';

const ES = {
	'Gaussian Blur': 'Desenfoque gaussiano',
	Radius: 'Radio',
	'Video Effects': 'Efectos de vídeo',
	'Blur & Sharpen': 'Desenfoque y enfoque',
	'Bypass {0}': 'Omitir {0}',
	'Delete preset “{0}”?': '¿Eliminar el ajuste «{0}»?',
	'{0}: {1}': '{0}: {1}',
	'Open {0} Panel': 'Abrir el panel {0}',
	Project: 'Proyecto',
	Import: 'Importar',
};
const NAMES = ['Gaussian Blur', 'Radius', 'Video Effects', 'Blur & Sharpen'];

afterEach(() => {
	cleanup();
	__setCatalogForTests('en', null);
});

/** Evaluates transformed source (module scope) with the real runtime. */
function evaluate<T>(code: string): T {
	const out = transformI18n(code, 'x.ts', '/rt.ts');
	if (!out) throw new Error('nothing to transform');
	const body = out.replace(/^import .*;\n/, '').replace(/export const (\w+)/g, 'const $1');
	return new Function('__t', '__set', 'c', `${body}\nreturn X;`)(__t, __set, (id: string, label: string) =>
		defineLazyLabel({ id } as { id: string; label?: string }, 'label', label),
	) as T;
}

describe('lazy module-scope strings', () => {
	it('object properties and label maps answer in the language of the moment they are read', () => {
		const X = evaluate<{ cmd: { id: string; label: string }; MAP: Record<string, string> }>(
			`const TYPE_LABELS = { project: 'Project' };
const cmd = { id: 'file.import', label: 'Import' };
const X = { cmd, MAP: TYPE_LABELS };`,
		);
		expect(X.cmd.label).toBe('Import');
		expect(X.MAP.project).toBe('Project');
		__setCatalogForTests('es', ES, NAMES);
		expect(X.cmd.label).toBe('Importar');
		expect(X.MAP.project).toBe('Proyecto');
		expect(JSON.parse(JSON.stringify(X.cmd))).toEqual({ id: 'file.import', label: 'Importar' });
		expect(Object.keys(X.cmd)).toEqual(['id', 'label']);
		__setCatalogForTests('en', null);
		expect(X.cmd.label).toBe('Import');
	});

	it('a lazy property can be assigned like a plain one', () => {
		const X = evaluate<{ label: string }>(`const X = { label: 'Import' };`);
		X.label = 'Mine';
		expect(X.label).toBe('Mine');
		__setCatalogForTests('es', ES, NAMES);
		expect(X.label).toBe('Mine');
		expect(Object.getOwnPropertyDescriptor(X, 'label')?.writable).toBe(true);
	});

	it('a factory called at load keeps plain labels lazy; expressions inside functions stay eager', () => {
		const out = transformI18n(
			`const make = (id, n) => ({ id, label: 'Import', title: \`Open \${n} Panel\`, hint: this.x ? 'Yes it is' : 'No it is not' });`,
			'x.ts',
			'/rt.ts',
		)!;
		expect(out).toContain('get label() { return __t("Import"); }');
		expect(out).toContain('title: __t("Open {0} Panel", n)');
		expect(out).toContain('hint: this.x ? __t("Yes it is") : __t("No it is not")');
	});

	it('menu helper labels at module scope stay the English source and are translated when read', () => {
		const out = transformI18n(`const X = [c('file.import', 'Import')];`, 'x.ts', '/rt.ts');
		expect(out).toBeNull(); // only recorded for the catalogue
		const item = defineLazyLabel({ id: 'x' } as { id: string; label?: string }, 'label', 'Import');
		expect(item.label).toBe('Import');
		__setCatalogForTests('es', ES, NAMES);
		expect(item.label).toBe('Importar');
		const fn = defineLazyLabel({} as { label?: string }, 'label', () => __t('Open {0} Panel', t('Project')));
		expect(fn.label).toBe('Abrir el panel Proyecto');
		// copies keep the laziness with assignLazy (a spread would freeze the label)
		const copy = assignLazy({} as { id?: string; label?: string }, item, { id: 'alias' });
		const spread = { ...item };
		__setCatalogForTests('en', null);
		expect(copy.label).toBe('Import');
		expect(copy.id).toBe('alias');
		expect(spread.label).toBe('Importar');
	});

	it('JSX expression children and explicit t() calls are externalised', () => {
		const found: string[] = [];
		const out = transformI18n(
			`export const X = () => <b>{busy ? 'Saving now' : 'Save it'}{n} {\`\${n} items here\`}</b>; const y = t('Not usable');`,
			'x.tsx',
			'/rt.ts',
		)!;
		expect(out).toContain('{busy ? __t("Saving now") : __t("Save it")}');
		expect(out).toContain('__t("{0} items here", n)');
		expect(out).toContain("t('Not usable')");
		void found;
	});
});

describe('names from the model', () => {
	it('translates exact names and labels built from them', () => {
		expect(translateName('Gaussian Blur')).toBeNull(); // English: nothing to do
		__setCatalogForTests('es', ES, NAMES);
		expect(translateName('Gaussian Blur')).toBe('Desenfoque gaussiano');
		expect(translateName('Gaussian Blur: Radius')).toBe('Desenfoque gaussiano: Radio');
		expect(translateName('Video Effects ▸ Blur & Sharpen')).toBe('Efectos de vídeo ▸ Desenfoque y enfoque');
		expect(translateName('Gaussian Blur (Video Effects)')).toBe('Desenfoque gaussiano (Efectos de vídeo)');
		expect(translateName('Gaussian Blur · 12 px')).toBe('Desenfoque gaussiano · 12 px');
		expect(translateName('My Gaussian Blur take')).toBeNull();
		expect(translateName('clip-a.mp4')).toBeNull();
		expect(translateName('')).toBeNull();
	});

	it('fills placeholders with translated names, never inside quotes (names the user gave)', () => {
		__setCatalogForTests('es', ES, NAMES);
		expect(__t('Bypass {0}', 'Gaussian Blur')).toBe('Omitir Desenfoque gaussiano');
		expect(__t('{0}: {1}', 'Gaussian Blur', 'Radius')).toBe('Desenfoque gaussiano: Radio');
		expect(__t('Delete preset “{0}”?', 'Gaussian Blur')).toBe('¿Eliminar el ajuste «Gaussian Blur»?');
		expect(__t('Bypass {0}', 'My clip')).toBe('Omitir My clip');
		expect(__t('Bypass {0}', 3)).toBe('Omitir 3');
		expect(__t('Bypass {0}')).toBe('Omitir {0}');
	});

	it('the document observer translates names in the DOM and puts the source back on a language change', async () => {
		document.body.innerHTML =
			'<div id="a" title="Gaussian Blur">Gaussian Blur: Radius</div><div id="b" data-no-i18n="">Gaussian Blur</div>';
		__setCatalogForTests('es', ES, NAMES);
		const a = document.getElementById('a')!;
		expect(a.textContent).toBe('Desenfoque gaussiano: Radio');
		expect(a.getAttribute('title')).toBe('Desenfoque gaussiano');
		expect(document.getElementById('b')!.textContent).toBe('Gaussian Blur'); // a user name
		const added = document.createElement('p');
		added.textContent = 'Radius';
		document.body.appendChild(added);
		await new Promise((r) => setTimeout(r, 0));
		expect(added.textContent).toBe('Radio');
		__setCatalogForTests('en', null);
		expect(a.textContent).toBe('Gaussian Blur: Radius');
		expect(a.getAttribute('title')).toBe('Gaussian Blur');
		expect(added.textContent).toBe('Radius');
		document.body.innerHTML = '';
	});
});

describe('the language epoch', () => {
	it('re-renders subscribers and remounts keyed views when the language changes', () => {
		let mounts = 0;
		function Leaf() {
			if (!Leaf.seen) mounts++;
			Leaf.seen = true;
			return <span data-testid="leaf">{__t('Import')}</span>;
		}
		Leaf.seen = false;
		function View() {
			const epoch = useLanguageEpoch();
			return (
				<div key={epoch} data-testid="view" data-epoch={epoch}>
					<Leaf />
				</div>
			);
		}
		render(<View />);
		expect(screen.getByTestId('leaf').textContent).toBe('Import');
		const before = languageEpoch();
		act(() => __setCatalogForTests('es', ES, NAMES));
		expect(languageEpoch()).toBe(before + 1);
		expect(getLanguage()).toBe('es');
		expect(screen.getByTestId('leaf').textContent).toBe('Importar');
		act(() => __setCatalogForTests('en', null));
		expect(getLanguage()).toBe('en');
		expect(screen.getByTestId('leaf').textContent).toBe('Import');
		expect(mounts).toBe(1);
	});
});
