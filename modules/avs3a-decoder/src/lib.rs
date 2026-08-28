#![deny(clippy::all)]

pub mod render;

use std::sync::{Arc, Mutex};

use avs3a::decode::{BuiltinDecoder, DecoderConfig};
use avs3a::header::{CodecProfile, FrameHeader};
use avs3a::mp4::{Av3aTrack, parse_sample};
use avs3a::stream::EncodedFrame;
use napi::{
    Error, Result,
    bindgen_prelude::{AsyncTask, Buffer},
};
use napi_derive::napi;

use render::{OUTPUT_CHANNELS, StereoRenderer, is_renderable, layout_name};

/// Largest value that survives a round trip through a JavaScript number.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn to_js_number(value: u64, name: &str) -> std::result::Result<f64, String> {
    if value > MAX_SAFE_INTEGER {
        return Err(format!(
            "{name} is outside the JavaScript safe integer range"
        ));
    }
    Ok(value as f64)
}

// ---------------------------------------------------------------------------
// Decode + render session
// ---------------------------------------------------------------------------

/// Owns the decoder and the render state for one source file.
///
/// The decoder carries MDCT overlap between frames and the renderer carries the
/// limiter's look-ahead, so both are reset together whenever the caller jumps to
/// a discontinuous position.
struct RenderState {
    decoder: Option<BuiltinDecoder>,
    renderer: Option<StereoRenderer>,
    /// Interleaved float scratch, `channels * samples_per_channel` long.
    float_scratch: Vec<f32>,
    /// Interleaved stereo int16 scratch for one frame.
    pcm_scratch: Vec<i16>,
}

impl RenderState {
    fn new() -> Self {
        Self {
            decoder: None,
            renderer: None,
            float_scratch: Vec::new(),
            pcm_scratch: Vec::new(),
        }
    }

    /// Bring the decoder and renderer up for `header`, replacing them if the
    /// stream's configuration changed mid-file.
    fn configure(&mut self, header: &FrameHeader) -> std::result::Result<(), String> {
        if header.profile != CodecProfile::ChannelBased {
            return Err(format!(
                "AV3A profile {:?} is not supported by the stereo renderer",
                header.profile
            ));
        }
        let config = header
            .channel_config
            .ok_or("AV3A channel-based stream has no channel configuration")?;
        if !is_renderable(config) {
            return Err(format!(
                "Audio Vivid configuration {config:?} maps to layout {}, which the renderer \
                 does not define",
                layout_name(config)
            ));
        }

        let samples_per_channel = usize::try_from(header.samples_per_channel)
            .map_err(|_| "AV3A frame length overflow".to_string())?;
        let channels = usize::from(header.channels);
        let sample_count = channels
            .checked_mul(samples_per_channel)
            .ok_or("AV3A sample count overflow")?;

        self.decoder = Some(BuiltinDecoder::configure(header).map_err(|error| error.to_string())?);
        self.renderer = Some(StereoRenderer::new(
            usize::from(header.bed_channels),
            channels,
        ));
        self.float_scratch.clear();
        self.float_scratch.resize(sample_count, 0.0);
        self.pcm_scratch.clear();
        self.pcm_scratch
            .resize(samples_per_channel * OUTPUT_CHANNELS, 0);
        Ok(())
    }

    /// Decode every frame in `input` and render it to interleaved stereo int16.
    fn decode(
        &mut self,
        input: &[u8],
        sample_sizes: Option<&[u32]>,
    ) -> std::result::Result<Vec<u8>, String> {
        let frames = parse_input_frames(input, sample_sizes)?;
        let frame_count = frames.len();
        let mut pcm = Vec::new();

        for frame in frames {
            let header = frame.header();
            // A mid-stream configuration change is legal in AV3A. Rebuild rather
            // than surfacing the decoder's continuity error, which the caller
            // would otherwise have to treat as a fatal decode failure.
            let needs_configure = match &self.decoder {
                None => true,
                Some(decoder) => DecoderConfig::from_header(header) != decoder.config(),
            };
            if let Some(decoder) = &self.decoder {
                let config = decoder.config();
                if config.sample_rate != header.sample_rate
                    || config.channels != header.channels
                    || config.samples_per_channel != header.samples_per_channel
                {
                    return Err(
                        "AV3A stream format changed between frames; PCM timeline cannot be resized"
                            .to_string(),
                    );
                }
            }
            if needs_configure {
                self.configure(header)?;
            }

            let decoder = self
                .decoder
                .as_mut()
                .ok_or("AV3A decoder was not configured")?;
            let renderer = self
                .renderer
                .as_mut()
                .ok_or("AV3A renderer was not configured")?;

            if pcm.is_empty() {
                let frame_bytes = usize::try_from(header.samples_per_channel)
                    .ok()
                    .and_then(|samples| samples.checked_mul(OUTPUT_CHANNELS * 2))
                    .ok_or("AV3A PCM frame size overflow")?;
                pcm.reserve(frame_count.saturating_mul(frame_bytes));
            }

            decoder
                .decode_into_f32(&frame, &mut self.float_scratch)
                .map_err(|error| error.to_string())?;
            renderer.render(&self.float_scratch, &mut self.pcm_scratch)?;
            append_le_i16(&mut pcm, &self.pcm_scratch);
        }
        Ok(pcm)
    }

    fn reset(&mut self) -> std::result::Result<(), String> {
        if let Some(decoder) = self.decoder.as_mut() {
            decoder.reset().map_err(|error| error.to_string())?;
        }
        if let Some(renderer) = self.renderer.as_mut() {
            renderer.reset();
        }
        Ok(())
    }
}

fn append_le_i16(out: &mut Vec<u8>, samples: &[i16]) {
    out.reserve(samples.len() * 2);
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
}

/// Parse either a normal elementary-stream batch or a batch made from MP4
/// samples. MP4 sample sizes may include muxer padding; parsing each sample
/// independently lets the framing parser discard that padding instead of
/// treating it as the start of another AV3A frame.
fn parse_input_frames(
    input: &[u8],
    sample_sizes: Option<&[u32]>,
) -> std::result::Result<Vec<EncodedFrame>, String> {
    let Some(sample_sizes) = sample_sizes else {
        return avs3a::parse_frames(input).map_err(|error| error.to_string());
    };

    let mut frames = Vec::with_capacity(sample_sizes.len());
    let mut offset = 0_usize;
    for (index, &declared_size) in sample_sizes.iter().enumerate() {
        let size = usize::try_from(declared_size)
            .map_err(|_| format!("AV3A sample {index} size overflows usize"))?;
        if size == 0 {
            return Err(format!("AV3A sample {index} is empty"));
        }
        let end = offset
            .checked_add(size)
            .ok_or_else(|| format!("AV3A sample {index} range overflows usize"))?;
        if end > input.len() {
            return Err(format!(
                "AV3A sample batch ends at {end}, but input has only {} bytes",
                input.len()
            ));
        }

        frames.push(parse_sample(&input[offset..end], index).map_err(|error| error.to_string())?);
        offset = end;
    }

    if offset != input.len() {
        return Err(format!(
            "AV3A sample sizes cover {offset} bytes, but input has {}",
            input.len()
        ));
    }
    Ok(frames)
}

/// Decodes AV3A and renders it to interleaved 16-bit stereo.
///
/// See `render.rs` for the render itself.
#[napi(js_name = "Av3aRenderSession")]
pub struct Av3aRenderSession {
    state: Arc<Mutex<Option<RenderState>>>,
}

impl Default for Av3aRenderSession {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl Av3aRenderSession {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(Some(RenderState::new()))),
        }
    }

    /// Decode and render the AV3A frames in `input`.
    ///
    /// Returns interleaved stereo int16, one output frame per input frame.
    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn decode(
        &self,
        input: Buffer,
        #[napi(ts_arg_type = "number[] | undefined")] sample_sizes: Option<Vec<u32>>,
    ) -> AsyncTask<DecodeTask> {
        AsyncTask::new(DecodeTask {
            state: self.state.clone(),
            input: input.to_vec(),
            sample_sizes,
        })
    }

    /// Drop decoder overlap and limiter state, for a discontinuous jump.
    #[napi]
    pub fn reset(&self) -> Result<()> {
        self.with_state(|state| state.reset())
    }

    #[napi]
    pub fn close(&self) -> Result<()> {
        *self
            .state
            .lock()
            .map_err(|error| Error::from_reason(error.to_string()))? = None;
        Ok(())
    }

    fn with_state<T>(
        &self,
        f: impl FnOnce(&mut RenderState) -> std::result::Result<T, String>,
    ) -> Result<T> {
        let mut guard = self
            .state
            .lock()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let state = guard
            .as_mut()
            .ok_or_else(|| Error::from_reason("AV3A render session is closed"))?;
        f(state).map_err(Error::from_reason)
    }
}

pub struct DecodeTask {
    state: Arc<Mutex<Option<RenderState>>>,
    input: Vec<u8>,
    sample_sizes: Option<Vec<u32>>,
}

impl napi::Task for DecodeTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        self.state
            .lock()
            .map_err(|error| Error::from_reason(error.to_string()))?
            .as_mut()
            // `close()` racing a queued decode is normal at teardown.
            .ok_or_else(|| Error::from_reason("AV3A render session is closed"))?
            .decode(&self.input, self.sample_sizes.as_deref())
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Buffer::from(output))
    }
}

// ---------------------------------------------------------------------------
// MP4 indexing
// ---------------------------------------------------------------------------

/// One access unit: a single AV3A frame in `mdat`.
#[napi(object, js_name = "Av3aMp4Sample")]
pub struct Av3aMp4Sample {
    pub offset: f64,
    pub size: f64,
}

#[napi(object, js_name = "Av3aMp4Index")]
pub struct Av3aMp4Index {
    pub samples: Vec<Av3aMp4Sample>,
    pub sample_rate: u32,
    pub samples_per_frame: u32,
    /// Frames the caller must decode ahead of a seek target to refill the
    /// decoder's synthesis overlap.
    pub warmup_frames: u32,
}

fn build_index(
    track: &Av3aTrack,
    first_header: &FrameHeader,
) -> std::result::Result<Av3aMp4Index, String> {
    let samples = track.samples();
    samples.first().ok_or("AV3A MP4 track has no samples")?;

    if first_header.profile != CodecProfile::ChannelBased {
        return Err(format!(
            "AV3A profile {:?} is not supported by the stereo renderer",
            first_header.profile
        ));
    }
    let config = first_header
        .channel_config
        .ok_or("AV3A channel-based stream has no channel configuration")?;
    if !is_renderable(config) {
        return Err(format!(
            "Audio Vivid configuration {config:?} maps to layout {}, which the renderer does not define",
            layout_name(config)
        ));
    }
    if track.edits().iter().any(|edit| !edit.is_identity()) {
        return Err("AV3A MP4 carries an unsupported non-identity edit list".to_string());
    }

    let mut out = Vec::with_capacity(samples.len());
    for sample in samples {
        out.push(Av3aMp4Sample {
            offset: to_js_number(sample.offset, "AV3A sample offset")?,
            size: f64::from(sample.size),
        });
    }

    Ok(Av3aMp4Index {
        samples: out,
        sample_rate: first_header.sample_rate,
        samples_per_frame: first_header.samples_per_channel,
        warmup_frames: u32::try_from(warmup_frames_for(first_header)?)
            .map_err(|_| "AV3A warm-up frame count overflow".to_string())?,
    })
}

/// Frames of preroll a seek needs: the decoder's own warm-up plus the render's.
///
/// The decoder's part is profile-dependent — channel-based needs one frame, HOA
/// needs more for its basis delay — so it comes from the decoder rather than
/// being hardcoded here.
fn warmup_frames_for(header: &FrameHeader) -> std::result::Result<u64, String> {
    Ok(avs3a::decode::warmup_frames_for(header)
        .map_err(|error| error.to_string())?
        .saturating_add(render::WARMUP_FRAMES as u64))
}

fn export_sample(sample: &avs3a::mp4::Mp4Sample) -> std::result::Result<Av3aMp4Sample, String> {
    Ok(Av3aMp4Sample {
        offset: to_js_number(sample.offset, "AV3A sample offset")?,
        size: f64::from(sample.size),
    })
}

fn first_header_from_sample(
    track: &Av3aTrack,
    first_sample: &[u8],
) -> std::result::Result<FrameHeader, String> {
    let sample = track
        .samples()
        .first()
        .ok_or("AV3A MP4 track has no samples")?;
    let sample_size = usize::try_from(sample.size)
        .map_err(|_| "AV3A first sample size overflows usize".to_string())?;
    if first_sample.len() < sample_size {
        return Err(format!(
            "AV3A first sample is incomplete: got {} of {} bytes",
            first_sample.len(),
            sample.size
        ));
    }
    Ok(parse_sample(&first_sample[..sample_size], 0)
        .map_err(|error| error.to_string())?
        .header()
        .to_owned())
}

/// Read only the first sample's location from a complete `moov` box.
#[napi(js_name = "readAv3aMp4FirstSample")]
pub fn read_av3a_mp4_first_sample(moov: Buffer) -> Result<Av3aMp4Sample> {
    let track =
        Av3aTrack::from_moov_box(&moov).map_err(|error| Error::from_reason(error.to_string()))?;
    let sample = track
        .samples()
        .first()
        .ok_or_else(|| Error::from_reason("AV3A MP4 track has no samples"))?;
    export_sample(sample).map_err(Error::from_reason)
}

/// Build the full AV3A index from a complete `moov` box and its first sample.
///
/// The two buffers are intentionally independent: for a non-fast-start MP4,
/// `moov` can be fetched from the tail while the first sample is fetched from
/// the beginning, without materialising the intervening media bytes.
#[napi(js_name = "indexAv3aMp4Moov")]
pub fn index_av3a_mp4_moov(moov: Buffer, first_sample: Buffer) -> Result<Av3aMp4Index> {
    let track =
        Av3aTrack::from_moov_box(&moov).map_err(|error| Error::from_reason(error.to_string()))?;
    let header = first_header_from_sample(&track, &first_sample).map_err(Error::from_reason)?;
    build_index(&track, &header).map_err(Error::from_reason)
}

#[cfg(test)]
mod tests {
    use super::parse_input_frames;
    use avs3a::bitstream::BitWriter;
    use avs3a::crc16;
    use avs3a::header::ChannelConfig;

    fn frame(payload_byte: u8) -> Vec<u8> {
        let payload_len = ((64_000_usize * 1_024 / 48_000) - 56).div_ceil(8);
        let payload = vec![payload_byte; payload_len];
        let crc = crc16(&payload);
        let mut writer = BitWriter::new();
        for (value, width) in [
            (0xfff, 12),
            (2, 4),
            (0, 1),
            (0, 3),
            (0, 3),
            (2, 4),
            (u64::from(crc >> 8), 8),
            (ChannelConfig::Mono.index().into(), 7),
            (1, 2),
            (4, 4),
            (u64::from(crc & 0xff), 8),
        ] {
            writer.write_bits(value, width).unwrap();
        }
        let mut bytes = writer.into_bytes();
        bytes.extend_from_slice(&payload);
        bytes
    }

    #[test]
    fn sample_sizes_strip_mp4_padding_before_decoding() {
        let coded = frame(0x37);
        let mut sample = coded.clone();
        sample.extend_from_slice(&[0xa5; 7]);

        let sizes = [u32::try_from(sample.len()).unwrap()];
        let frames = parse_input_frames(&sample, Some(&sizes)).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].bytes(), coded.as_slice());
    }
}
