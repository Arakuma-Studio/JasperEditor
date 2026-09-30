//! Tiny JSON Schema builders for template params (`jasper-mg schema`).
//!
//! The shapes follow what zod 4's `z.toJSONSchema(schema, {io: 'input'})` emits for the TS twins
//! (draft 2020-12, `default` on every property, no `required` because every field has a default),
//! so the parity test only has to normalize key order.
use serde_json::{Map, Value, json};

pub const DRAFT: &str = "https://json-schema.org/draft/2020-12/schema";

pub fn string(default: &str, max_len: u32) -> Value {
    json!({ "type": "string", "maxLength": max_len, "default": default })
}

pub fn integer(default: i64, min: i64, max: i64) -> Value {
    json!({ "type": "integer", "minimum": min, "maximum": max, "default": default })
}

pub fn string_enum(default: &str, options: &[&str]) -> Value {
    json!({ "type": "string", "enum": options, "default": default })
}

/// Straight sRGB RGBA float tuple, channels `0..=1` (S01 `RGBA`).
pub fn rgba(default: [f64; 4]) -> Value {
    json!({
        "type": "array",
        "items": { "type": "number", "minimum": 0, "maximum": 1 },
        "minItems": 4,
        "maxItems": 4,
        "default": default,
    })
}

/// `[x, y]` in design-canvas pixels.
pub fn vec2(default: [f64; 2], min: f64, max: f64) -> Value {
    json!({
        "type": "array",
        "items": { "type": "number", "minimum": min, "maximum": max },
        "minItems": 2,
        "maxItems": 2,
        "default": default,
    })
}

/// Object schema with `additionalProperties: false` (serde `deny_unknown_fields`).
pub fn object(properties: Vec<(&str, Value)>) -> Value {
    let mut props = Map::new();
    for (k, v) in properties {
        props.insert(k.to_string(), v);
    }
    json!({
        "$schema": DRAFT,
        "type": "object",
        "properties": Value::Object(props),
        "additionalProperties": false,
    })
}
