//! `MgRenderSpec` (ARCHITECTURE §10.2, `@jasper/api` `MgRenderSpecSchema`) and frame timing.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;

/// Largest accepted output edge in pixels.
pub const MAX_EDGE: u32 = 8192;
/// Largest accepted duration (2 h at 60 fps).
pub const MAX_FRAMES: u32 = 432_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rational {
    pub num: u32,
    pub den: u32,
}

impl Rational {
    /// Frames per second as a float (`num / den`), the value the TS twins receive as `fps`.
    pub fn as_f64(self) -> f64 {
        f64::from(self.num) / f64::from(self.den)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateRef {
    pub id: String,
    pub version: u32,
}

/// The JSON spec read by `jasper-mg render|frame --spec <file|->`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MgSpec {
    pub template: TemplateRef,
    #[serde(default)]
    pub params: Map<String, Value>,
    pub width: u32,
    pub height: u32,
    pub fps: Rational,
    pub duration_frames: u32,
    /// Frames of the template timeline skipped at the head (clip `sourceIn`), default 0.
    #[serde(default)]
    pub source_in_frames: u32,
}

/// A spec or parameter problem: the CLI exits with code 2 (ARCHITECTURE §10.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecError(pub String);

impl fmt::Display for SpecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SpecError {}

pub fn spec_error(msg: impl Into<String>) -> SpecError {
    SpecError(msg.into())
}

impl MgSpec {
    pub fn parse(json: &str) -> Result<Self, SpecError> {
        let spec: MgSpec =
            serde_json::from_str(json).map_err(|e| spec_error(format!("invalid spec: {e}")))?;
        spec.validate()?;
        Ok(spec)
    }

    pub fn validate(&self) -> Result<(), SpecError> {
        if self.width < 2 || self.height < 2 || self.width > MAX_EDGE || self.height > MAX_EDGE {
            return Err(spec_error(format!(
                "width/height must be within 2..={MAX_EDGE} (got {}x{})",
                self.width, self.height
            )));
        }
        if self.fps.num == 0 || self.fps.den == 0 {
            return Err(spec_error("fps.num and fps.den must be positive"));
        }
        let fps = self.fps.as_f64();
        if !(1.0..=240.0).contains(&fps) {
            return Err(spec_error(format!(
                "fps must be within 1..=240 (got {fps})"
            )));
        }
        if self.duration_frames == 0 || self.duration_frames > MAX_FRAMES {
            return Err(spec_error(format!(
                "durationFrames must be within 1..={MAX_FRAMES}"
            )));
        }
        if self.source_in_frames > MAX_FRAMES {
            return Err(spec_error(format!(
                "sourceInFrames must be within 0..={MAX_FRAMES}"
            )));
        }
        Ok(())
    }

    /// Timing of output frame `index` (0-based, `< duration_frames`).
    pub fn frame_time(&self, index: u32) -> FrameTime {
        FrameTime::new(
            self.fps.as_f64(),
            f64::from(self.source_in_frames) + f64::from(index),
            f64::from(self.source_in_frames) + f64::from(self.duration_frames),
        )
    }
}

/// Where a frame sits on the template's own timeline, in seconds.
///
/// Content frame `n` (sourceIn + output index) maps to `t = n / fps`; `total` is the full content
/// length `(sourceIn + durationFrames) / fps`. Intros are anchored at `t = 0`, outros at `total`
/// ("Responsive Design – Time", S01:KND-009). TS: `frameTime()` in `core.ts`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameTime {
    pub fps: f64,
    pub t: f64,
    pub total: f64,
}

impl FrameTime {
    pub fn new(fps: f64, content_frame: f64, content_frames: f64) -> Self {
        Self {
            fps,
            t: content_frame / fps,
            total: content_frames / fps,
        }
    }

    /// Seconds for a frame count at this frame rate.
    pub fn frames_to_seconds(&self, frames: f64) -> f64 {
        frames / self.fps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LT: &str = r#"{"template":{"id":"lower-third","version":1},"params":{"name":"A"},
        "width":1920,"height":1080,"fps":{"num":30,"den":1},"durationFrames":150}"#;

    #[test]
    fn rejects_unknown_fields_and_bad_values() {
        assert!(MgSpec::parse(&LT.replace("\"width\"", "\"bogus\":1,\"width\"")).is_err());
        assert!(MgSpec::parse(&LT.replace("150", "0")).is_err());
        assert!(MgSpec::parse(&LT.replace("\"den\":1", "\"den\":0")).is_err());
        assert!(MgSpec::parse(&LT.replace("1920", "1")).is_err());
        assert!(MgSpec::parse("{").is_err());
    }

    #[test]
    fn frame_time_uses_the_rational_rate() {
        let mut spec = MgSpec::parse(LT).unwrap();
        spec.fps = Rational {
            num: 30000,
            den: 1001,
        };
        spec.source_in_frames = 10;
        let ft = spec.frame_time(20);
        assert!((ft.t - 1.001).abs() < 1e-12);
        assert!((ft.total - 5.338_666_666_666_667).abs() < 1e-12);
    }
}
