// Program-monitor text editing of anime templates (WP7b canvas-edit, contract in docs/wp-notes/social-comments.md
// "Program monitor editing"). A template marks the element that draws a string param with
// `data-template-param="<paramName>"` (and `data-template-marks="true"` when the param holds word-marks markup,
// `==highlight==` / `||blur||` / `~~remove~~`, see social/marks.ts). The editor in the web app finds those elements in
// the rendered layer, hit-tests them and edits the param in place. Templates attach the attributes with
// `editableParamProps` (@jasper/motion/templates) so the names stay in one place.
import { z } from 'zod';

/** Attribute naming the string param an element draws. */
export const TEMPLATE_PARAM_ATTR = 'data-template-param';
/** Attribute (`"true"`) saying the param's value is word-marks markup. */
export const TEMPLATE_MARKS_ATTR = 'data-template-marks';

/** A param name as templates write it in `data-template-param` (an identifier, at most 64 characters). */
export const templateParamNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z_$][\w$]*$/);

export type EditableTemplateParam = { param: string; marks: boolean };

/**
 * The editable param an element declares (validated: the attribute is data the template wrote), or null when the
 * element declares none or a malformed name.
 */
export function readEditableParam(el: {
	getAttribute(name: string): string | null;
}): EditableTemplateParam | null {
	const raw = el.getAttribute(TEMPLATE_PARAM_ATTR);
	const parsed = templateParamNameSchema.safeParse(raw);
	if (!parsed.success) return null;
	return { param: parsed.data, marks: el.getAttribute(TEMPLATE_MARKS_ATTR) === 'true' };
}
