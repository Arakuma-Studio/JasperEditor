# Keyframe easing

## Easing panel

The Easing panel (`apps/web/src/panels/easing/`, Window ▸ Easing, docked with Effect Controls) shapes an ease curve
and applies it to the selected keyframes, keeps curves in a library, and copies / pastes eases and values between
keys. Its controls run the easing UI commands (`apps/web/src/commands/easing.ts`), which are also in the command
palette, Clip ▸ Keyframe Easing, the panel menu, the Effect Controls key menu and the keymap, so every disabled
control shows the same reason (no keyframe selection, keys on a track, a locked track, a read-only project, or a
document command this build lacks).

### Curve model and the keyframe mapping

A curve is `EaseCurve` (`packages/project/src/ease/curve.ts`): `cubic` = CSS `cubic-bezier(x1, y1, x2, y2)` over one
segment, `multi` = points from (0, 0) to (1, 1) with optional in / out handles over several segments. x is the
fraction of the span's time, y the fraction of its value change; y may leave 0…1 (overshoot) within
`EASE_Y_LIMIT`. A segment from key A to key B reads as `easesToCubic(outgoingEase(A), incomingEase(B))` — the
evaluator's own effective eases (`packages/project/src/keyframes.ts`, so auto-bezier keys show their computed
slope); a linear key's segment is the straight line, a hold segment has no curve. Three or more keys of a numeric
property become one multi curve: point i at (time fraction, value fraction), each segment's handles scaled from
its own cubic into the span (`selection.ts`, `spanCurve`). Numeric vectors use the cumulative straight-line
distance between key values as the value fraction (an assumption: it is not the arc length of a curved motion
path).

### Editor

- Drag handles and points; Shift keeps the axis that moved further; a symmetric cubic stays symmetric and a smooth
  multi-curve point (in and out handles on one line) stays smooth, unless Alt is held.
- Ctrl/Cmd-click the curve adds a point by splitting the piece at that time with de Casteljau's algorithm, so the
  shape does not change; Ctrl/Cmd-click a point removes it (the two neighbouring handles stay). A multi curve left
  with its end points becomes a cubic. Double-click empty space resets to linear.
- Keyboard: Tab reaches each handle (`role="slider"`), arrows nudge by 0.01 (Shift 0.1), `+` adds a point in the
  middle of the widest piece, Delete removes the focused point, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or the Undo /
  Redo buttons) step through the editor's own history (100 steps), separate from document History.
- Mirror makes the curve point-symmetric about (½, ½) from its first half (the first handle of a cubic, the points
  before the middle of a multi curve).
- Numeric fields: x1 y1 x2 y2 for a cubic; per point x, y and handle coordinates for a multi curve. The text field
  reads `cubic-bezier(a, b, c, d)`, a bare `a, b, c, d` / `[a, b, c, d]` / `a b c d`, or the CSS keywords `linear`,
  `ease`, `ease-in`, `ease-out`, `ease-in-out` (CSS Easing Functions Level 1, §2.2), and writes the CSS form
  rounded to 3 decimals. Pasting a valid value applies it at once; invalid text is refused with the reason.
- Every function in `curve-edit.ts` returns a schema-valid curve (handles clamped into their piece, points kept
  apart, y within the limit); a fast-check test runs random add / remove / drag / mirror sequences against
  `EaseCurveSchema`.
- Auto-apply: a drag is one live gesture (`session.beginGesture`, the document updates while dragging and commits
  once, one undo step); other committed edits apply through the Apply Ease command, one undo step each.
- The view's vertical range grows in quarter steps to show the curve; it is frozen during a drag so the handle stays
  under the pointer. The bands above 1 and below 0 are shaded (`--pr-warning` mixed into the graph background).

### Targeting

The In | Middle | Out control picks the segments explicitly (none = the command's automatic choice: between selected
keys, or both sides of a single key; multi curves only between keys). Click modifiers on Apply, Paste Ease and
library tiles override it for that click: Shift = in, Alt = out, Ctrl (Cmd on macOS) = middle, and they add up. The
info line counts the segments and properties an apply reaches, following the modifiers held at that moment.

### Preview

A dot travels and a bar scales along the edited (or hovered) curve: 1.1 s play, 0.45 s hold, looping, with room
for overshoot at both ends. With `prefers-reduced-motion`, or while the panel is hidden, it shows five still frames
(u = 0, ¼, ½, ¾, 1) instead of animating.

### Library

Tabs: Favourites, the built-in groups (read-only; Duplicate to My Curves copies one), the user's groups (New Group,
rename / delete from the tab's context menu; a deleted group's curves move to My Curves). Tiles: size slider
(40–160 px), fitted or fixed columns; hover previews a curve and shows its values in the info line; click applies
it (with the targeting modifiers) and loads it into the editor; the tile matching the editor's curve is
highlighted. User curves: rename (F2 or menu), colour label (the design tokens' label palette), move to a group
(menu, or drop on a tab), reorder (drag, Alt+←/→ on a focused tile, or Move Earlier / Later), delete (with Undo in
the notice), favourite. The library, recent curves, favourites and the panel settings (view, tile size, columns,
sections, Auto-apply, active tab, current curve) are a per-user preference in `localStorage`
(`jasper.easing.v1`, schema version 1): each entry is validated with zod on load and a damaged one is dropped on its
own; a library written by a newer version is neither read nor overwritten.

Export writes `{format: "jasper-ease-presets", version: 1, groups, presets}` (the active user group, or every user
curve). Import refuses files over 1 MB, non-JSON, other formats and newer versions; each preset is validated with
`EasePresetSchema` (plus the optional colour), invalid ones are skipped and listed (first five reasons), clashing ids
get new ones, groups are matched by id or name or created; the library limits (1000 curves, 100 groups) hold.

### Commands, menus and shortcuts

| Command | Default key | Document command |
| --- | --- | --- |
| Easy Ease / Easy Ease In / Easy Ease Out | F9 / Shift+F9 / Ctrl(Cmd)+Shift+F9 | `keyframe.setInterpolation` (bezier, {⅓, 0} on the side) |
| Apply Ease | — | `keyframe.applyEase` |
| Copy Ease / Paste Ease | Ctrl(Cmd)+C / Ctrl(Cmd)+V in the Easing panel | — / `keyframe.pasteEase` |
| Paste Values | — | `keyframe.pasteValues` |
| Duplicate / Mirror Keys at Playhead | — | `keyframe.paste` (mirror: reversed payload, latest key at the playhead) |
| Spatial ▸ Linear, Temporal ▸ Continuous | — | `keyframe.setSpatialInterpolation`, `keyframe.setInterpolation` |
| Drive Along Path, Clean Up Motion Path | — | `keyframe.createPathController`, `keyframes.cleanupPath` |
| Add Overshoot / Bounce Expression | — | `expression.set` with the `inertial-bounce` / `bounce` presets |

F9 is free in the default layout; in the Final Cut Pro 7 layout F9 stays Insert in the editing panels (their scope
comes first) and is Easy Ease elsewhere. Copy Ease reads the selection itself: one key gives its two sides, two or
more neighbouring keys of one property the cubic of each segment between them (and the span's multi curve); hold
segments cannot be copied. Mirror Keys at Playhead reuses the keyframe paste's reversed path (`reversedKeyTiming`,
`reversedSpatial`), so each segment's ease is mirrored: cubic (x1, y1, x2, y2) becomes (1 − x2, 1 − y2, 1 − x1,
1 − y1) — tested.

The Bounce back expression preset (`packages/expressions/src/presets.ts`, original) bounces the value back off its
last key like a ball off a wall: the first bounce leaves at `elasticity` × the arrival speed, each arc is a parabola
of `gravity` lasting 2·s/g, each next bounce keeps `elasticity` of the speed, at most `maxBounces`.

### Status and limits

- The keyframe-ease document commands (`keyframe.applyEase`, `keyframe.pasteEase`, `keyframe.pasteValues`,
  `keyframe.createPathController`, `keyframes.cleanupPath`) and the built-in curve catalogue come from separate work
  packages. Until they are in the build, the actions that need them are disabled with "This build has no … command
  yet" (`docCommandSupport` checks the model's command catalogue at run time) and the Library shows the user's
  groups only.
- The velocity editor (`keyframe.setVelocity`) is not part of the panel.
- Tests: `apps/web/test/easing-curve-edit.test.ts`, `easing-library.test.ts`, `easing-commands.test.ts`,
  `easing-panel.test.tsx`; `packages/expressions/test/engine.test.ts` (Bounce back preset).
