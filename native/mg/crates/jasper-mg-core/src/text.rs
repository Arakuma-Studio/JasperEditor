//! Deterministic text width estimate used for layout (panel widths). It needs no font files, so the
//! native renderer and the TS twin (browser, Node tests) compute identical layouts. Tuned for Inter.

/// Approximate advance of one character in em.
pub fn char_em(c: char) -> f64 {
    match c {
        ' ' => 0.28,
        'i' | 'l' | 'j' | '.' | ',' | ':' | ';' | '\'' | '!' | '|' | 'I' => 0.3,
        'f' | 't' | 'r' => 0.38,
        'm' | 'w' => 0.84,
        'M' | 'W' => 0.92,
        'A'..='Z' => 0.68,
        '0'..='9' => 0.6,
        'a'..='z' => 0.56,
        _ => 0.62,
    }
}

/// Estimated width in px of `s` at `size` px; bold (weight ≥ 600) is 6 % wider.
pub fn estimate_text_width(s: &str, size: f64, weight: u32) -> f64 {
    let em: f64 = s.chars().map(char_em).sum();
    em * size * if weight >= 600 { 1.06 } else { 1.0 }
}
