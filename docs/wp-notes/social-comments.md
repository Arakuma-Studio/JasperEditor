# Social-comment templates — work notes

Design: `docs/superpowers/specs/2026-10-25-social-comment-templates-design.md`. Each work package adds its own
section below.

## Presets & UI hints

WP3a (`sc/presets-ui`), contract C3 of the design (§7.2, §7.9 gallery and Properties). Generic motion-graphic
template features; the social-comment template uses them, any other template may.

### Template definition (`@jasper/mg-templates`, types in `@jasper/project` `registry/mg.ts`)

- `presets?: { id, name, description?, params }[]` — `params` holds only what the preset changes. Ids match
  `[a-z0-9][a-z0-9-]*` (≤ 64), unique per template.
- `ui?: { groups?: { id, label, params[] }[]; params?: Record<name, { label?, description?, multiline?,
  visibleWhen?: { param, in[] }, control? }> }`.
- `createMgRegistry` validates both and throws on the first problem (like invalid defaults): presets need a name,
  plain-object params naming only params of the template, and `{...defaults, ...params}` must pass `paramsSchema`;
  groups need unique ids and labels and may only list existing params, each param in at most one group; `ui.params`
  may only name existing params; `label` / `description` / `control` are non-empty strings, `multiline` a boolean;
  `visibleWhen` names another param and lists at least one value, each a valid value of that param (checked with
  the schema, so a misspelt variant fails at start-up / in tests, not silently in the UI).
- `templatePresetParams(def, presetId)` = defaults ⊕ preset params (undefined for an unknown preset).
- `MgTemplateInfo` (what `registry.get` returns) carries `presets` and `ui`; the catalogue JSON
  (`catalogJson()`, `GET /api/motion-graphics/templates`, `@jasper/api` `MgTemplateCatalogEntrySchema.presets` /
  `.ui`) carries JSON copies. Entries without them keep their old shape (the fframes `schemas/catalog.json` mirror of
  the Rust catalogue is unchanged). When jasper-mg is ready, its native entries get the presets and hints of their
  TS twin.

### Template references

`parseMgTemplateRef` (`@jasper/project`): `"<id>"`, `"<id>@<version>"`, `"<id>:<preset>"`,
`"<id>@<version>:<preset>"` → `{ id, version?, preset? }`; null for anything else (empty id, version ≤ 0 or not an
integer, a preset id with other characters, more than one `@` / `:`, over 256 characters). Fuzzed with fast-check
(round trip of every well-formed ref; arbitrary strings never throw).

MCP (`apps/mcp/src/tools/templates.ts` `resolveTemplateRef`): `add_motion_graphic` and
`render_motion_graphic_preview` accept the four forms. Params = template defaults ⊕ preset params ⊕ the call's
`params`. A malformed ref is `E_INVALID_PARAM`; an unknown template, version or preset is `E_NOT_FOUND` with the
existing refs (or "has no presets") as hint. `list_motion_templates` adds per template `presets: [{ref, id, name,
description?, params}]` and per param `label`, `group` and `visibleWhen` from the hints (the `description` prefers the
hint over the schema's `.describe()`). `TEMPLATES_GUIDE` documents the ref syntax. Batching and placement of
`add_motion_graphic` are WP3b's.

### Gallery (Motion Templates ▸ Templates)

- A template with presets shows one card per preset (title = preset name, second line = the template name,
  `data-preset` on the card, accessible name "Preset · Template (Category)") and no card for the bare template.
  Templates without presets are unchanged.
- The poster (anime: `<Thumbnail>`; fframes: the SVG twin) and the hover preview get `params` = the preset's params
  (`MgTemplatePreview` merges them over the defaults).
- Search matches the preset name and id as well as the template name, id, category, description and engine; the
  category filter uses the template's category.
- Double-click / Enter / drag insert the preset: `clip.addMotionGraphic` with defaults ⊕ preset params, History label
  "Add <preset name>" (one undo step). The drag payload (`application/x-jasper-mg-template`) has an optional `preset`
  (zod-validated; `text/plain` = `id@v:preset`); Timeline and Program drops pass it through unchanged. The
  agent-exposed UI command `mg.insert` takes an optional `preset`. An unknown preset is refused with a message, never
  inserted with plain defaults.

### Properties and Effect Controls

- `paramsPropertySpecs(template)` applies the hints after building the specs from the schema (one
  `applyTemplateUi` step, so other param kinds slot in before it unchanged): `label`, `description` (tooltip),
  `ui.multiline` (string params only), `ui.customControl`, `visibleWhen`, and the order: params in no group first
  (schema order), then each group's params in the group's order, tagged `section: {id, label}`. Keyframability is
  unchanged (numeric and colour params of anime templates keep their stopwatches inside groups).
- `templateParamVisible(spec, params)` — compares the param's static value (`clip.params`) with `in` (by value, also
  for arrays). `templateParamSections(specs)` splits the ordered specs into runs per section.
- Properties ▸ Parameters: rows in no group first, then one collapsible sub-section per group (open state persisted
  per template and group id, `properties.template.<templateId>.<groupId>`). With several clips selected (same
  template) a row is shown when it applies to at least one of them; edits apply to all, as before.
- Effect Controls ▸ Template: the same order under collapsible group sub-headers (with a keyframe summary lane);
  hidden rows are left out of the section (so "Reset Template" and the summary lane skip params that do not apply).
- Hidden params stay valid params: agents (`set_motion_graphic_params`) and HTTP clients can still set them, and
  their values are kept when the controlling param changes back (switching variant keeps content).

### Custom controls (`apps/web/src/extensions/index.ts`)

```ts
registerTemplateParamControl(name: string, component: ComponentType<TemplateParamControlProps>): () => void
type TemplateParamControlProps = {
  clipId: string; paramName: string; value: unknown; params: Readonly<Record<string, unknown>>;
  onChange(next: unknown, opts?: { coalesce?: boolean }): void; disabled: boolean;
};
```

- Rendered by `PropertyRow` (both panels) in place of the default editor for rows whose template names the control;
  label, stopwatch, keyframe navigator and reset stay. An unregistered name falls back to the default editor, so a
  template never shows a blank row.
- `onChange` goes through `planSet` → `param.set` (a keyframe at the playhead when the param is animated), one
  undoable transaction; `coalesce: true` adds the coalesce key `template-param:<row>:<clips>`, merging repeated edits
  within the session window (750 ms) into one History entry (drags, typing). Multi-selection: the control sees the
  first clip (`clipId`, `value`, `params`), writes go to every selected clip.
- `disabled` is true while the project is read-only.
- A control that throws while rendering is replaced by a one-line error in its row (`template-param-control-error`);
  the panel keeps working; selecting another clip or param retries.

### Strings (i18n)

`apps/web/i18n/model-strings.ts` (run by `pnpm i18n`) collects, for every template of `mgRegistry`: name, category,
description, preset names and descriptions, group labels, and every param label and tooltip as `paramsPropertySpecs`
produces them (hints, schema titles, `.describe()` texts, humanized names). The runtime translates them where the UI
shows them (card titles, section and group headers, row labels, `title` tooltips, accessible names).

A template author adding or changing a template runs `pnpm i18n`, adds the new keys to
`apps/web/src/i18n/es.json` and checks with `pnpm i18n:check` (fails while a key lacks Spanish). Param values
(enum options, text content) are data and are not translated.

### Counter

`counter@1` now has three presets (Subscribers = the defaults, Percentage, Money Raised) and four groups (Number,
Label, Style, Animation); Decimal Separator shows only when Decimals > 0; Size and Count Seconds read "Number Size"
and "Count Duration". Pixels, params and `renderVersion` are unchanged (metadata only).

### Tests

`packages/mg-templates/test/registry.test.ts` (validation, catalogue JSON, preset params),
`packages/project/test/template-ui.test.ts` (specs: labels, multi-line, custom control, order, sections, visibility;
ref parser + fast-check), `apps/engine/test/mg-presets.test.ts` (catalogue on both engine paths, fake jasper-mg),
`apps/mcp/test/templates.test.ts` (list, preset refs in add and preview, refusals),
`apps/web/test/template-presets-ui.test.tsx` (Properties groups/labels/tooltips/visibility, Effect Controls groups,
stopwatch, collapse, custom control props, undo/redo, coalescing, crash isolation, fallback, read-only),
`apps/web/test/motion-templates-presets.test.tsx` (cards, poster/preview params, search/category, insert by
double-click/Enter/drag/`mg.insert`, refusals).

### Limitations

- `visibleWhen` reads the static value of the controlling param; a keyframed controlling param (numbers, colours)
  is compared by its static value, not its value at the playhead.
- Groups are one level deep; a param belongs to at most one group.
