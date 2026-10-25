// Program-monitor editing contract (WP7b canvas-edit): `editableParamProps` writes the attributes the web app's editor
// reads (`readEditableParam`), and every shipped anime template marks the elements that draw its text params.
import {
	ANIME_CATALOG,
	animeTemplateTiming,
	readEditableParam,
	TEMPLATE_MARKS_ATTR,
	TEMPLATE_PARAM_ATTR,
} from '@jasper/mg-templates';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ANIME_TEMPLATE_IMPLS, editableParamProps } from '../src/templates/index.ts';

describe('editableParamProps', () => {
	it('writes the contract attributes, marks only when asked', () => {
		expect(editableParamProps('text', { marks: true })).toEqual({
			[TEMPLATE_PARAM_ATTR]: 'text',
			[TEMPLATE_MARKS_ATTR]: 'true',
		});
		expect(editableParamProps('displayName')).toEqual({ [TEMPLATE_PARAM_ATTR]: 'displayName' });
		const view = render(<div {...editableParamProps('text', { marks: true })}>hi</div>);
		expect(readEditableParam(view.container.firstElementChild!)).toEqual({ param: 'text', marks: true });
		view.unmount();
	});

	it('refuses a name that is not an identifier (a template bug)', () => {
		expect(() => editableParamProps('')).toThrow();
		expect(() => editableParamProps('a b')).toThrow();
		expect(() => editableParamProps('"]{x}')).toThrow();
	});
});

describe('shipped anime templates', () => {
	const canvas = { width: 1920, height: 1080 };
	const fps = 30;
	it('mark each drawn string param once, with its value as the element text', () => {
		const expected: Record<string, string[]> = {
			'title-reveal@1': ['title', 'subtitle'],
			'lower-third-anim@1': ['name', 'role'],
			'callout@1': ['label'],
			'counter@1': ['label'],
		};
		for (const def of ANIME_CATALOG) {
			const key = `${def.id}@${def.version}`;
			const Impl = ANIME_TEMPLATE_IMPLS[key];
			if (!Impl || !(key in expected)) continue;
			const t = animeTemplateTiming(def, { fps, localFrame: 60, durationFrames: 150 });
			const view = render(
				<Impl
					params={def.defaults}
					{...t}
					fps={fps}
					canvas={canvas}
					seed={1}
					isPreview
					mediaUrls={{}}
					emojiUrls={{}}
					imageUrls={{}}
				/>,
			);
			const marked = [...view.container.querySelectorAll(`[${TEMPLATE_PARAM_ATTR}]`)];
			expect(marked.map((el) => readEditableParam(el)!.param).sort(), key).toEqual(
				[...expected[key]!].sort(),
			);
			for (const el of marked) {
				const { param, marks } = readEditableParam(el)!;
				expect(marks).toBe(false);
				expect(el.textContent, `${key} ${param}`).toBe(String(def.defaults[param]));
			}
			view.unmount();
		}
	});
});
