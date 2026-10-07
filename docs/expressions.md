# Expressions

After Effects-style expressions on any animatable property: a short JavaScript program, evaluated every frame,
whose result replaces the property's keyframed value. Design and verification: [wp-notes/expressions.md](wp-notes/expressions.md).

## Using them

- **Effect Controls:** Alt-click (Option-click) a property's stopwatch to add an expression; Alt-click again removes
  it. The expression row under the property has the Enable Expression switch (`=`), the pick-whip (drag it onto
  another property to insert a reference to it) and the expression language menu (presets, links to the properties
  of every clip, the reference below, Enable/Remove). The editor highlights JavaScript and completes the object
  model, effect names, parameter names and clip names. `Ctrl/Cmd+Enter` or the keypad `Enter` commits, `Escape`
  cancels, leaving the field commits. Values set by an expression are shown in red; an error shows a warning
  under the field and the property renders its keyframed value.
- **Expression Controls** (Effects ▸ Video Effects ▸ Expression Controls): Slider, Angle, Checkbox, Color, Point,
  3D Point, Layer and Dropdown Menu Control. They draw nothing; expressions read them, e.g.
  `effect("Slider Control")("Slider")`. Right-click an effect header ▸ Rename… to name an instance
  (`effect("Speed")("Slider")`).
- **Graphs:** the Value and Velocity graphs of a property with an expression also draw the post-expression curve.
- **Agents:** `set_expression`, `clear_expression`, `enable_expression`, `test_expression`, `get_property_values`,
  `list_expression_properties`, `list_expression_presets`, `add_expression_control` (MCP), or the commands
  `expression.set`, `expression.clear`, `expression.setEnabled`, `effect.rename` (`apply_commands`).

Which properties: clip Motion (Position, Anchor Point, Scale, Scale Width, Rotation), Opacity, every effect
parameter of a clip (numbers, points, colours, checkboxes, menus, text), mask Feather / Opacity / Expansion, shape
size, fill, stroke and roundness, clip audio Volume and Pan (evaluated per frame, interpolated between frames),
transition parameters, and a text clip's Source Text. Not supported (refused with an error): track and Mix faders
and audio effects (the Audio Track Mixer automates those), mask paths, tone curves, LUT and media parameters,
motion-graphic template parameters.

## Expression language reference

Expressions are JavaScript (ES2023, run by QuickJS) with After Effects' expression object model. The result
is the value of the last statement. `+ - * /` work on arrays (`value + [10, 0]`, `[1, 2] * 2`). Everything
is deterministic: no clock (`Date` is fixed at 0), `Math.random` is the seeded `random()`, no I/O. Limits: about
5 million operations, 64 MiB memory and 16 levels of expressions reading each other per evaluation. A failing
expression renders the keyframed value and reports `expressionError`.

Mapping: comp = sequence, layer = clip, `time` = sequence seconds. Values: numbers; points `[x, y]`; colours
`[r, g, b, a]` in 0…1; checkboxes 1/0; menus (Dropdown Menu Control, enum params) the 1-based item index (a
result may also be the item name); text a string; Layer Control a layer.

### Global

| Name | Description |
|---|---|
| `time` | Sequence time in seconds at which the expression is evaluated. |
| `value` | The property's keyframed (pre-expression) value at the current time. |
| `thisComp` | The sequence the property belongs to (AE comp). |
| `thisLayer` | The clip the property belongs to (AE layer). Not available on track, master or transition properties. |
| `thisProperty` | The property the expression is on. |
| `thisProject` | The project (bitsPerChannel = 8, linearBlending = false). |
| `comp(name)` | Another sequence by its project name. |
| `effect(nameOrIndex)` | An effect of this clip by name (renamed instance name, else label; duplicates are "Label 2", "Label 3"…), effect id or 1-based index. Call the result with a parameter name or index: effect("Slider Control")("Slider"). |
| `wiggle(freq, amp, octaves = 1, amp_mult = 0.5, t = time)` | Randomly wiggles the value: freq wiggles per second, amp in the property units; octaves of noise each amp_mult times the previous. Deterministic per clip and property. |
| `temporalWiggle(freq, amp, octaves = 1, amp_mult = 0.5, t = time)` | Samples the property at a wiggled time. |
| `smooth(width = .2, samples = 5, t = time)` | Average of `samples` values spread over `width` seconds around t. |
| `loopOut(type = "cycle", numKeyframes = 0)` | Repeats the animation after the last keyframe: "cycle", "pingpong", "offset" or "continue"; numKeyframes = how many last segments loop (0 = all). |
| `loopIn(type = "cycle", numKeyframes = 0)` | Repeats the animation before the first keyframe. |
| `loopOutDuration(type = "cycle", duration = 0)` | loopOut over the last `duration` seconds. |
| `loopInDuration(type = "cycle", duration = 0)` | loopIn over the first `duration` seconds. |
| `valueAtTime(t)` | The property's value at sequence time t (its own expression reads its keyframed value). |
| `velocityAtTime(t)` | Rate of change per second at time t. |
| `speedAtTime(t)` | Length of the velocity at time t. |
| `velocity` | velocityAtTime(time). |
| `speed` | speedAtTime(time). |
| `key(n)` | Keyframe n (1-based): {time, value, index}. |
| `numKeys` | Number of keyframes of this property. |
| `nearestKey(t)` | The keyframe nearest to time t. |
| `marker` | This clip's markers (marker.key(n), marker.numKeys, marker.nearestKey(t)). |
| `inPoint` | This clip's first frame in sequence seconds. |
| `outPoint` | One past this clip's last frame in sequence seconds. |
| `linear(t, [tMin, tMax,] value1, value2)` | Linear interpolation of value1 → value2 as t goes tMin → tMax (0 → 1 with three arguments); clamped outside. |
| `ease(t, [tMin, tMax,] value1, value2)` | Like linear with zero velocity at both ends. |
| `easeIn(t, [tMin, tMax,] value1, value2)` | Like linear with zero velocity at tMin only. |
| `easeOut(t, [tMin, tMax,] value1, value2)` | Like linear with zero velocity at tMax only. |
| `random() | random(max) | random(min, max)` | Uniform random number (or array) — deterministic: seeded by clip, property, time and seedRandom. |
| `gaussRandom() | gaussRandom(max) | gaussRandom(min, max)` | Gaussian random: about 90% of results lie in the range. |
| `seedRandom(offset, timeless = false)` | Changes the random seed; timeless = the same numbers at every frame. |
| `noise(valOrArray)` | Smooth noise in −1…1 (1D–3D input); nearby inputs give nearby results. |
| `clamp(value, limit1, limit2)` | Limits a number or each array component. |
| `length(vec) | length(point1, point2)` | Vector length / distance. |
| `normalize(vec)` | Vector divided by its length. |
| `add(a, b)` | Component-wise sum (the + operator does the same on arrays). |
| `sub(a, b)` | Component-wise difference. |
| `mul(vec, amount)` | Vector times a number. |
| `div(vec, amount)` | Vector divided by a number. |
| `dot(a, b)` | Dot product. |
| `cross(a, b)` | Cross product of 3D vectors. |
| `lookAt(fromPoint, atPoint)` | Orientation [x, y, 0] in degrees pointing from one point to another. |
| `degreesToRadians(deg)` | Degrees → radians. |
| `radiansToDegrees(rad)` | Radians → degrees. |
| `Math` | JavaScript Math (Math.sin, Math.PI, …). Math.random is the deterministic random(). |
| `timeToFrames(t = time + thisComp.displayStartTime, fps = 1 / thisComp.frameDuration)` | Seconds → frames. |
| `framesToTime(frames, fps = 1 / thisComp.frameDuration)` | Frames → seconds. |
| `timeToTimecode(t = time + thisComp.displayStartTime, timecodeBase = fps)` | Seconds → "HH:MM:SS:FF". |
| `timeToCurrentFormat(t, fps)` | Seconds → timecode at the sequence rate. |
| `timeToFeetAndFrames(t, fps, framesPerFoot = 16)` | Seconds → "feet+frames". |
| `posterizeTime(fps)` | Evaluates the rest of the expression at a lower frame rate. |
| `hexToRgb("#RRGGBB" | "RRGGBBAA")` | Hex string → [r, g, b, a] in 0…1. |
| `rgbToHsl([r, g, b, a])` | RGBA → HSLA (all 0…1). |
| `hslToRgb([h, s, l, a])` | HSLA → RGBA (all 0…1). |
| `toComp(point, t = time)` | Layer pixels → sequence pixels (Motion and Corner Pin). |
| `fromComp(point, t = time)` | Sequence pixels → layer pixels. |
| `toCompVec(vec, t = time)` | Direction vector, layer → sequence. |
| `fromCompVec(vec, t = time)` | Direction vector, sequence → layer. |
| `toWorld(point, t = time)` | Same as toComp (sequences are 2D). |
| `fromWorld(point, t = time)` | Same as fromComp. |
| `sourceRectAtTime(t = time)` | {top, left, width, height} of the clip box in layer pixels. |
| `sampleImage(point, radius = [.5, .5], postEffect = true, t = time)` | Average straight RGBA in point ± radius (layer pixels). Solid clips only; other kinds report an error. |

### Comp (`thisComp`, `comp(name)`)

| Name | Description |
|---|---|
| `thisComp.layer(index | name | otherLayer, relIndex)` | A clip by 1-based index (1 = topmost: caption tracks, video tracks top to bottom, audio tracks), name or id. |
| `thisComp.name` | Sequence name. |
| `thisComp.width` | Frame width in pixels. |
| `thisComp.height` | Frame height in pixels. |
| `thisComp.duration` | Sequence duration in seconds. |
| `thisComp.frameDuration` | Seconds per frame. |
| `thisComp.numLayers` | Number of clips. |
| `thisComp.displayStartTime` | Start timecode in seconds. |
| `thisComp.bgColor` | Background colour [r, g, b, a]. |
| `thisComp.pixelAspect` | Always 1. |
| `thisComp.marker` | Sequence markers. |

### Layer (`thisLayer`, `thisComp.layer(…)`)

| Name | Description |
|---|---|
| `thisLayer.name` | Clip name. |
| `thisLayer.index` | Layer index (1 = topmost). |
| `thisLayer.inPoint` | First frame in sequence seconds. |
| `thisLayer.outPoint` | One past the last frame in sequence seconds. |
| `thisLayer.startTime` | Sequence time at which the source time 0 would play. |
| `thisLayer.width` | Layer box width (media size, text box, shape box, sequence size). |
| `thisLayer.height` | Layer box height. |
| `thisLayer.hasVideo` | True for visual clips. |
| `thisLayer.hasAudio` | True for audio clips (and video clips). |
| `thisLayer.enabled` | The clip is enabled. |
| `thisLayer.active` | Enabled and inside its in/out points at the current time. |
| `thisLayer.transform` | Motion: anchorPoint, position, scale, scaleWidth, rotation, opacity. |
| `thisLayer.position` | transform.position ([x, y] sequence pixels). |
| `thisLayer.anchorPoint` | transform.anchorPoint ([x, y] layer pixels). |
| `thisLayer.scale` | transform.scale (percent, one number as in Premiere; Scale Width is transform.scaleWidth). |
| `thisLayer.rotation` | transform.rotation (degrees, clockwise). |
| `thisLayer.opacity` | Opacity (percent). |
| `thisLayer.effect(nameOrIndex)(paramNameOrIndex)` | An effect parameter. |
| `thisLayer.text.sourceText` | Text clips: the Source Text (string; .style.fontSize, .fillColor, … read the style). |
| `thisLayer.shape` | Shape clips: size, fillColor, strokeColor, strokeWidth, cornerRadius (rectangles / ellipses); vector shapes: their contents. |
| `content("Group 1").content("Rectangle Path 1").size` | Vector shapes: an item by name, index or id; groups have .content(name) and .transform (anchorPoint, position, scale, skew, skewAxis, rotation, opacity); items expose their properties by name (size, roundness, color, opacity, strokeWidth → width, start, end, offset, copies…). |
| `thisLayer.audio` | Audio clips: audioLevels (Volume, dB) and pan. |
| `thisLayer.params(name)` | Motion-graphic template parameters (read only). |
| `thisLayer.marker` | Clip markers. |
| `thisLayer.toComp(point, t)` | Layer → sequence pixels. |
| `thisLayer.fromComp(point, t)` | Sequence → layer pixels. |
| `thisLayer.sourceRectAtTime(t)` | Layer box. |
| `thisLayer.sampleImage(point, radius, postEffect, t)` | Average colour (solid clips). |

### Property

| Name | Description |
|---|---|
| `prop.value` | Value at the current time (post-expression). |
| `prop.valueAtTime(t)` | Value at sequence time t. |
| `prop.velocityAtTime(t)` | Velocity at t. |
| `prop.speedAtTime(t)` | Speed at t. |
| `prop.wiggle(freq, amp, octaves, amp_mult, t)` | Wiggle of that property. |
| `prop.loopOut(type, numKeyframes)` | loopOut of that property. |
| `prop.loopIn(type, numKeyframes)` | loopIn of that property. |
| `prop.smooth(width, samples, t)` | Smoothed value. |
| `prop.numKeys` | Keyframe count. |
| `prop.key(n)` | Keyframe n. |
| `prop.nearestKey(t)` | Nearest keyframe. |
| `prop.name` | Property name. |
| `prop.propertyIndex` | Index inside its group. |
| `prop.preExpressionValue` | Keyframed value at the current time. |

### Keyframe (`key(n)`)

| Name | Description |
|---|---|
| `key.time` | Keyframe time (sequence seconds). |
| `key.value` | Keyframe value. |
| `key.index` | Keyframe index. |

### Marker

| Name | Description |
|---|---|
| `marker.key(indexOrName)` | A marker: {time, duration, comment, name, chapter, url, type, color, index}. |
| `marker.numKeys` | Number of markers. |
| `marker.nearestKey(t)` | Nearest marker. |

### Text Expression Selector

| Name | Description |
|---|---|
| `textIndex` | Expression Selector: 1-based index of the character, word or line. |
| `textTotal` | Expression Selector: number of characters, words or lines. |
| `selectorValue` | Expression Selector: amount of the selectors above (percent, 3 components). |
