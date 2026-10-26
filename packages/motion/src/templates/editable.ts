// Program-monitor text editing (WP7b canvas-edit): the attributes that make a template element editable in place.
// Spread them on the element whose box is the drawn text of a string param — a block or inline-block box wrapping
// exactly that text (no other params' text inside it):
//   <div {...editableParamProps('text', { marks: true })} style={…}>{…}</div>
// Contract: docs/wp-notes/social-comments.md "Program monitor editing".
import { templateParamNameSchema } from '@jasper/mg-templates';

/** The attribute names are `TEMPLATE_PARAM_ATTR` / `TEMPLATE_MARKS_ATTR` of @jasper/mg-templates (tested). */
export type EditableParamProps = {
	'data-template-param': string;
	'data-template-marks'?: 'true';
};

/**
 * `data-template-param` (+ `data-template-marks="true"` with `marks`) for the element drawing param `name`. Throws on a
 * name that is not an identifier (a template bug, caught by its tests).
 */
export function editableParamProps(name: string, opts: { marks?: boolean } = {}): EditableParamProps {
	const param = templateParamNameSchema.parse(name);
	return opts.marks
		? { 'data-template-param': param, 'data-template-marks': 'true' }
		: { 'data-template-param': param };
}
