//! `lower-third@1`: name + title on a translucent panel with an accent bar.
//!
//! Intro (≈1 s): the accent bar grows from its center, the panel widens, name and title slide in on
//! a spring and fade up. Outro (0.5 s, anchored at the end of the clip or at `holdUntilFrames`):
//! everything slides left and fades out. TS twin: `packages/mg-templates/src/templates/lower-third.ts`.
use jasper_mg_core::{
    FONT_FAMILY, Fit, FrameTime, Rgba, SpecError, ease_in_cubic, ease_out_cubic, escape,
    estimate_text_width, fill, fit_group_open, num, progress, schema, spec_error, spring, svg_open,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ID: &str = "lower-third";
pub const VERSION: u32 = 1;
pub const NAME: &str = "Lower Third";
pub const CATEGORY: &str = "Lower Thirds";
/// Natural length of the intro / outro at 30 fps (the animation itself is time based).
pub const INTRO_FRAMES: u32 = 30;
pub const OUTRO_FRAMES: u32 = 15;
pub const DEFAULT_DURATION_SECONDS: f64 = 5.0;

pub const PANEL_H: f64 = 150.0;
pub const BAR_W: f64 = 10.0;
pub const TEXT_X: f64 = 40.0;
pub const NAME_SIZE: f64 = 60.0;
pub const TITLE_SIZE: f64 = 34.0;
pub const OUTRO_SECONDS: f64 = 0.5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct LowerThirdParams {
    pub name: String,
    pub title: String,
    pub accent_color: Rgba,
    pub text_color: Rgba,
    pub background_color: Rgba,
    /// Top-left of the block in design-canvas pixels.
    pub position: [f64; 2],
    /// Content frame where the outro starts; 0 = automatic (outro ends with the clip).
    pub hold_until_frames: u32,
}

impl Default for LowerThirdParams {
    fn default() -> Self {
        Self {
            name: "Alex Morgan".into(),
            title: "Producer, JasperEditor".into(),
            accent_color: [0.22, 0.53, 1.0, 1.0],
            text_color: [1.0, 1.0, 1.0, 1.0],
            background_color: [0.04, 0.06, 0.12, 0.78],
            position: [120.0, 800.0],
            hold_until_frames: 0,
        }
    }
}

pub const NAME_MAX: u32 = 120;
pub const TITLE_MAX: u32 = 160;
pub const POS_MIN: f64 = -4000.0;
pub const POS_MAX: f64 = 4000.0;
pub const HOLD_MAX: i64 = 432_000;

pub fn params_schema() -> Value {
    let d = LowerThirdParams::default();
    schema::object(vec![
        ("name", schema::string(&d.name, NAME_MAX)),
        ("title", schema::string(&d.title, TITLE_MAX)),
        ("accentColor", schema::rgba(d.accent_color)),
        ("textColor", schema::rgba(d.text_color)),
        ("backgroundColor", schema::rgba(d.background_color)),
        ("position", schema::vec2(d.position, POS_MIN, POS_MAX)),
        ("holdUntilFrames", schema::integer(0, 0, HOLD_MAX)),
    ])
}

fn check_color(name: &str, c: &Rgba) -> Result<(), SpecError> {
    if c.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)) {
        Ok(())
    } else {
        Err(spec_error(format!(
            "params.{name}: every channel must be within 0..=1"
        )))
    }
}

impl LowerThirdParams {
    pub fn validate(&self) -> Result<(), SpecError> {
        if self.name.chars().count() > NAME_MAX as usize {
            return Err(spec_error(format!(
                "params.name: at most {NAME_MAX} characters"
            )));
        }
        if self.title.chars().count() > TITLE_MAX as usize {
            return Err(spec_error(format!(
                "params.title: at most {TITLE_MAX} characters"
            )));
        }
        check_color("accentColor", &self.accent_color)?;
        check_color("textColor", &self.text_color)?;
        check_color("backgroundColor", &self.background_color)?;
        if !self
            .position
            .iter()
            .all(|v| v.is_finite() && (POS_MIN..=POS_MAX).contains(v))
        {
            return Err(spec_error(format!(
                "params.position: within {POS_MIN}..={POS_MAX}"
            )));
        }
        if i64::from(self.hold_until_frames) > HOLD_MAX {
            return Err(spec_error(format!(
                "params.holdUntilFrames: at most {HOLD_MAX}"
            )));
        }
        Ok(())
    }
}

/// Panel width that fits the (estimated) name and title.
pub fn panel_width(p: &LowerThirdParams) -> f64 {
    let text = estimate_text_width(&p.name, NAME_SIZE, 700)
        .max(estimate_text_width(&p.title, TITLE_SIZE, 400));
    (text + TEXT_X + 48.0).max(320.0)
}

/// SVG markup of one frame (straight alpha, transparent background).
pub fn render_svg(p: &LowerThirdParams, ft: &FrameTime, fit: &Fit, id_prefix: &str) -> String {
    let t = ft.t;
    let outro_start = if p.hold_until_frames > 0 {
        ft.frames_to_seconds(f64::from(p.hold_until_frames))
    } else {
        (ft.total - OUTRO_SECONDS).max(0.0)
    };
    let out = ease_in_cubic(progress(t, outro_start, OUTRO_SECONDS));
    let group_opacity = 1.0 - out;
    let out_x = -40.0 * out;

    let bar_h = PANEL_H * ease_out_cubic(progress(t, 0.0, 0.35));
    let bar_y = (PANEL_H - bar_h) / 2.0;
    let full_w = panel_width(p);
    let panel_w = full_w * ease_out_cubic(progress(t, 0.12, 0.55));
    let name_x = -60.0 * (1.0 - spring(t - 0.25, 180.0, 20.0, 1.0));
    let name_o = ease_out_cubic(progress(t, 0.25, 0.3));
    let title_x = -40.0 * (1.0 - spring(t - 0.4, 180.0, 20.0, 1.0));
    let title_o = ease_out_cubic(progress(t, 0.4, 0.3));
    let clip_id = format!("{id_prefix}-lt-clip");

    let mut s = String::with_capacity(1400);
    s.push_str(&svg_open(fit));
    s.push_str(&format!(
        "<defs><clipPath id=\"{clip_id}\"><rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\"/></clipPath></defs>",
        num(panel_w),
        num(PANEL_H)
    ));
    s.push_str(&fit_group_open(fit));
    s.push_str(&format!(
        "<g transform=\"translate({} {})\" opacity=\"{}\">",
        num(p.position[0] + out_x),
        num(p.position[1]),
        num(group_opacity)
    ));
    s.push_str(&format!(
        "<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" {}/>",
        num(panel_w),
        num(PANEL_H),
        fill(&p.background_color)
    ));
    s.push_str(&format!(
        "<rect x=\"0\" y=\"{}\" width=\"{}\" height=\"{}\" {}/>",
        num(bar_y),
        num(BAR_W),
        num(bar_h),
        fill(&p.accent_color)
    ));
    s.push_str(&format!("<g clip-path=\"url(#{clip_id})\">"));
    s.push_str(&format!(
        "<g transform=\"translate({} 0)\" opacity=\"{}\"><text x=\"{}\" y=\"74\" font-family=\"{}\" font-size=\"{}\" font-weight=\"700\" {}>{}</text></g>",
        num(name_x),
        num(name_o),
        num(TEXT_X),
        FONT_FAMILY,
        num(NAME_SIZE),
        fill(&p.text_color),
        escape(&p.name)
    ));
    s.push_str(&format!(
        "<g transform=\"translate({} 0)\" opacity=\"{}\"><text x=\"{}\" y=\"124\" font-family=\"{}\" font-size=\"{}\" font-weight=\"400\" {}>{}</text></g>",
        num(title_x),
        num(title_o),
        num(TEXT_X),
        FONT_FAMILY,
        num(TITLE_SIZE),
        fill(&p.accent_color),
        escape(&p.title)
    ));
    s.push_str("</g></g></g></svg>");
    s
}
