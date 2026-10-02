//! SVG string helpers. The TS twins format numbers and colors with the same rules (`core.ts`), so
//! for the same inputs both sides emit the same markup (up to last-ulp libm differences).

use crate::canvas::Fit;

/// A straight (not premultiplied) sRGB color, channels `0..=1` (S01 `RGBA`).
pub type Rgba = [f64; 4];

/// Formats a number with at most 3 decimals, no trailing zeros, and `0` for ±0.
pub fn num(x: f64) -> String {
    if !x.is_finite() {
        return "0".into();
    }
    let r = (x * 1000.0 + 0.5).floor() / 1000.0;
    if r == 0.0 {
        return "0".into();
    }
    let s = format!("{r:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.to_string()
}

fn channel(c: f64) -> u8 {
    (crate::clamp01(c) * 255.0 + 0.5).floor() as u8
}

/// `#rrggbb` of an RGBA color (alpha is emitted separately as `fill-opacity`).
pub fn hex(c: &Rgba) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        channel(c[0]),
        channel(c[1]),
        channel(c[2])
    )
}

pub fn alpha(c: &Rgba) -> String {
    num(crate::clamp01(c[3]))
}

/// `fill="#rrggbb" fill-opacity="a"`.
pub fn fill(c: &Rgba) -> String {
    format!("fill=\"{}\" fill-opacity=\"{}\"", hex(c), alpha(c))
}

/// XML text/attribute escaping.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// Opening `<svg>` for the output size.
pub fn svg_open(fit: &Fit) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\" viewBox=\"0 0 {w} {h}\">",
        w = num(fit.out_w),
        h = num(fit.out_h)
    )
}

/// `<g>` mapping design-canvas coordinates to the output.
pub fn fit_group_open(fit: &Fit) -> String {
    format!(
        "<g transform=\"translate({} {}) scale({})\">",
        num(fit.offset_x),
        num(fit.offset_y),
        num(fit.scale)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_conversion_and_xml_escaping() {
        assert_eq!(hex(&[1.0, 0.5, 0.0, 1.0]), "#ff8000");
        assert_eq!(
            escape("a<b & \"c\" 'd'>"),
            "a&lt;b &amp; &quot;c&quot; &#39;d&#39;&gt;"
        );
        assert_eq!(escape("x\u{1}y"), "xy");
    }
}
