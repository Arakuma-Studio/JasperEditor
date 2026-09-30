//! `title-card@1`: full-frame title and optional subtitle over a background that may be translucent.
//!
//! The whole card fades in over `fadeInFrames` and out over the last `fadeOutFrames` of the clip;
//! title and subtitle rise into place and an accent underline grows. TS twin:
//! `packages/mg-templates/src/templates/title-card.ts`.
use jasper_mg_core::{
    FONT_FAMILY, Fit, FrameTime, Rgba, SpecError, ease_in_out_cubic, ease_out_cubic, escape, fill,
    fit_group_open, num, progress, schema, spec_error, svg_open,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ID: &str = "title-card";
pub const VERSION: u32 = 1;
pub const NAME: &str = "Title Card";
pub const CATEGORY: &str = "Titles";
pub const INTRO_FRAMES: u32 = 15;
pub const OUTRO_FRAMES: u32 = 15;
pub const DEFAULT_DURATION_SECONDS: f64 = 4.0;

pub const TITLE_SIZE: f64 = 96.0;
pub const SUBTITLE_SIZE: f64 = 44.0;
pub const UNDERLINE_W: f64 = 160.0;
pub const FADE_MAX: i64 = 600;
pub const TITLE_MAX: u32 = 160;
pub const SUBTITLE_MAX: u32 = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Alignment {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct TitleCardParams {
    pub title: String,
    pub subtitle: String,
    pub background: Rgba,
    pub text_color: Rgba,
    pub accent_color: Rgba,
    pub alignment: Alignment,
    pub fade_in_frames: u32,
    pub fade_out_frames: u32,
}

impl Default for TitleCardParams {
    fn default() -> Self {
        Self {
            title: "Your Title Here".into(),
            subtitle: "A JasperEditor production".into(),
            background: [0.02, 0.03, 0.06, 0.85],
            text_color: [1.0, 1.0, 1.0, 1.0],
            accent_color: [0.22, 0.53, 1.0, 1.0],
            alignment: Alignment::Center,
            fade_in_frames: 15,
            fade_out_frames: 15,
        }
    }
}

pub fn params_schema() -> Value {
    let d = TitleCardParams::default();
    schema::object(vec![
        ("title", schema::string(&d.title, TITLE_MAX)),
        ("subtitle", schema::string(&d.subtitle, SUBTITLE_MAX)),
        ("background", schema::rgba(d.background)),
        ("textColor", schema::rgba(d.text_color)),
        ("accentColor", schema::rgba(d.accent_color)),
        (
            "alignment",
            schema::string_enum("center", &["left", "center", "right"]),
        ),
        ("fadeInFrames", schema::integer(15, 0, FADE_MAX)),
        ("fadeOutFrames", schema::integer(15, 0, FADE_MAX)),
    ])
}

impl TitleCardParams {
    pub fn validate(&self) -> Result<(), SpecError> {
        if self.title.chars().count() > TITLE_MAX as usize {
            return Err(spec_error(format!(
                "params.title: at most {TITLE_MAX} characters"
            )));
        }
        if self.subtitle.chars().count() > SUBTITLE_MAX as usize {
            return Err(spec_error(format!(
                "params.subtitle: at most {SUBTITLE_MAX} characters"
            )));
        }
        for (name, c) in [
            ("background", &self.background),
            ("textColor", &self.text_color),
            ("accentColor", &self.accent_color),
        ] {
            if !c.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)) {
                return Err(spec_error(format!(
                    "params.{name}: every channel must be within 0..=1"
                )));
            }
        }
        if i64::from(self.fade_in_frames) > FADE_MAX || i64::from(self.fade_out_frames) > FADE_MAX {
            return Err(spec_error(format!(
                "params.fadeInFrames/fadeOutFrames: at most {FADE_MAX}"
            )));
        }
        Ok(())
    }
}

pub fn render_svg(p: &TitleCardParams, ft: &FrameTime, fit: &Fit, _id_prefix: &str) -> String {
    let t = ft.t;
    let fade_in = ft.frames_to_seconds(f64::from(p.fade_in_frames));
    let fade_out = ft.frames_to_seconds(f64::from(p.fade_out_frames));
    let fin = if p.fade_in_frames > 0 {
        ease_in_out_cubic(progress(t, 0.0, fade_in))
    } else {
        1.0
    };
    let fout = if p.fade_out_frames > 0 {
        ease_in_out_cubic(progress(t, ft.total - fade_out, fade_out))
    } else {
        0.0
    };
    let opacity = fin.min(1.0 - fout);

    let (w, h) = (fit.design_w, fit.design_h);
    let (ax, anchor) = match p.alignment {
        Alignment::Left => (w * 0.1, "start"),
        Alignment::Center => (w / 2.0, "middle"),
        Alignment::Right => (w * 0.9, "end"),
    };
    let has_sub = !p.subtitle.is_empty();
    let title_y = if has_sub {
        h / 2.0 - 8.0
    } else {
        h / 2.0 + 34.0
    };
    let underline_y = if has_sub {
        h / 2.0 + 22.0
    } else {
        h / 2.0 + 62.0
    };
    let sub_y = h / 2.0 + 92.0;
    let title_dy = 36.0 * (1.0 - ease_out_cubic(progress(t, 0.0, 0.7)));
    let sub_dy = 36.0 * (1.0 - ease_out_cubic(progress(t, 0.12, 0.7)));
    let sub_o = ease_out_cubic(progress(t, 0.12, 0.5));
    let uw = UNDERLINE_W * ease_out_cubic(progress(t, 0.15, 0.6));
    let ux = match p.alignment {
        Alignment::Left => ax,
        Alignment::Center => ax - uw / 2.0,
        Alignment::Right => ax - uw,
    };

    let mut s = String::with_capacity(1400);
    s.push_str(&svg_open(fit));
    s.push_str(&format!("<g opacity=\"{}\">", num(opacity)));
    s.push_str(&format!(
        "<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" {}/>",
        num(fit.out_w),
        num(fit.out_h),
        fill(&p.background)
    ));
    s.push_str(&fit_group_open(fit));
    s.push_str(&format!(
        "<g transform=\"translate(0 {})\"><text x=\"{}\" y=\"{}\" text-anchor=\"{anchor}\" font-family=\"{}\" font-size=\"{}\" font-weight=\"700\" {}>{}</text></g>",
        num(title_dy),
        num(ax),
        num(title_y),
        FONT_FAMILY,
        num(TITLE_SIZE),
        fill(&p.text_color),
        escape(&p.title)
    ));
    s.push_str(&format!(
        "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"4\" {}/>",
        num(ux),
        num(underline_y),
        num(uw),
        fill(&p.accent_color)
    ));
    if has_sub {
        s.push_str(&format!(
            "<g transform=\"translate(0 {})\" opacity=\"{}\"><text x=\"{}\" y=\"{}\" text-anchor=\"{anchor}\" font-family=\"{}\" font-size=\"{}\" font-weight=\"400\" {}>{}</text></g>",
            num(sub_dy),
            num(sub_o * 0.85),
            num(ax),
            num(sub_y),
            FONT_FAMILY,
            num(SUBTITLE_SIZE),
            fill(&p.text_color),
            escape(&p.subtitle)
        ));
    }
    s.push_str("</g></g></svg>");
    s
}
