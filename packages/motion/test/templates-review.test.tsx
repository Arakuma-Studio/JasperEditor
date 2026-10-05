// Regression cases from docs/wp-notes/wp-m2-anime-templates.md, Review fix 8.
import { ANIME_CATALOG, animeTemplateTiming } from '@jasper/mg-templates';
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ANIME_TEMPLATE_IMPLS } from '../src/templates/index.ts';

const fps = 30;
const canvas = { width: 1920, height: 1080 };

function renderTemplate(id: string, frame: number, params?: Record<string, unknown>) {
	const def = ANIME_CATALOG.find((d) => d.id === id)!;
	const Impl = ANIME_TEMPLATE_IMPLS[`${def.id}@${def.version}`]!;
	const at = (f: number) => {
		const t = animeTemplateTiming(def, { fps, localFrame: f, durationFrames: 150 });
		return (
			<Impl params={params ?? def.defaults} {...t} fps={fps} canvas={canvas} seed={7} isPreview={false} />
		);
	};
	const view = render(at(frame));
	return { view, seek: (f: number) => act(() => view.rerender(at(f))) };
}

describe('anime template regressions', () => {
	it('a large counter advances at frame precision and reaches both endpoints', () => {
		const def = ANIME_CATALOG.find((d) => d.id === 'counter')!;
		const { view, seek } = renderTemplate('counter', 0, {
			...def.defaults,
			label: '',
			from: 0,
			to: 25_000_000,
		});
		const shown = () => Number(view.container.textContent!.replace(/,/g, ''));
		expect(shown()).toBe(0);
		const counting: number[] = [];
		for (let frame = 1; frame <= 75; frame++) {
			seek(frame);
			counting.push(shown());
		}
		expect(shown()).toBe(25_000_000);
		expect(counting.filter((v) => v > 0 && v < 25_000_000).some((v) => v % 25 !== 0)).toBe(true);
		view.unmount();
	});
});
