//! Rendering decoded Audio Vivid to stereo.
//!
//! The bed is gain-panned onto a BS.2051 `0+2+0` layout and the sum runs through
//! a peak limiter. There is no binauralisation. The currently supported
//! channel-based streams use a static matrix. Diffuse gains are identically zero
//! for this material, so the decorrelators contribute nothing. The tests pin
//! every gain value.

use avs3a::header::ChannelConfig;

/// Output channel count. Only stereo is implemented; the bed table is laid out
/// so that a multichannel output can be added without restructuring anything.
pub const OUTPUT_CHANNELS: usize = 2;

/// Frames of preroll the *render* needs on top of the decoder's own warm-up.
///
/// The limiter's memory is longer than its look-ahead ring: the envelope decays
/// per sample and the gain smooths against its previous value. One frame covers
/// both. More preroll buys nothing, because the remaining difference against a
/// contiguous decode is the decoder's, not the render's — see the seek note in
/// `Av3aPcmStreamer.restartAt`.
pub const WARMUP_FRAMES: usize = 1;

/// Full-scale magnitude of the render domain.
///
/// Matches `avs3a::decode::FLOAT_FULL_SCALE`. Rendering happens in PCM16 units
/// rather than `-1.0..=1.0` because the gains and the limiter threshold are
/// defined against that domain.
const FULL_SCALE: f32 = 32_768.0;

/// Base gain for any bed channel that is not L, R or LFE.
///
/// Those have no counterpart in `0+2+0`, so they go through the stereo downmix
/// panner, which power-normalises to `sqrt(0.5)`.
const BASE: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// Per-bed-channel stereo trim.
const TRIM: f32 = 0.85;

/// Centre-channel entry of the DLL's stereo trim table, by bit pattern.
///
/// The current 64-bit build holds a hand-typed `1.414` here rather than
/// `sqrt(2)` (`0x3FB504F3`), so the centre lands on
/// `1.414 * TRIM * BASE = 0.8498716` per side — a hair under full [`TRIM`],
/// and +6.02 dB over the previous build's `0.425`.
const CENTER_COEF: f32 = f32::from_bits(0x3FB4_FDF4); // 1.4140000343322754

/// `BASE * TRIM`, i.e. the gain every non-L/R/LFE bed channel ends up with.
///
/// The centre is the exception: its table coefficient is [`CENTER_COEF`], not
/// `BASE`, so it comes out near full trim instead of at [`G`].
const G: f32 = BASE * TRIM;

/// Per-bed-channel stereo gains, indexed by **channel position**.
///
/// The verified `7.1.4` configuration uses all rows in this table. The base
/// gain is [`BASE`] for everything but L, R, LFE and C.
///
/// A consequence worth knowing: the order is 7.1.4's, where rows 6/7 are the rear
/// surrounds and 8/9 the front heights. Feed 5.1.4, whose rows 6/7 are the
/// *front* heights, and the trims land on differently-named channels. That is
/// intended — the table is positional.
pub const BED_GAINS_STEREO: [[f32; OUTPUT_CHANNELS]; 12] = [
    [TRIM, 0.0],                                            //  0 L    M+030
    [0.0, TRIM],                                            //  1 R    M-030
    [CENTER_COEF * TRIM * BASE, CENTER_COEF * TRIM * BASE], //  2 C    M+000
    [TRIM, TRIM], //  3 LFE  LFE1   (substituted, not scaled; see below)
    [G, -G],      //  4 Lss  M+090  (anti-phase: cancels in a mono fold-down)
    [-G, G],      //  5 Rss  M-090
    [G, G],       //  6 Lrs  M+135
    [G, G],       //  7 Rrs  M-135
    [G, 0.0],     //  8 Ltf  U+045
    [0.0, G],     //  9 Rtf  U-045
    [G, 0.0],     // 10 Ltb  U+135
    [-0.0, G],    // 11 Rtb  U-135  (-0.0 == 0.0; sign is cosmetic)
];

/// Bed channel index whose gain is *substituted* rather than scaled.
///
/// `0+2+0` has no LFE output, so panning `LFE1` into it yields zero. Scaling that
/// would drop the LFE entirely, so row 3 of [`BED_GAINS_STEREO`] replaces it
/// outright — which puts the LFE at the same level as the (now near-full-trim)
/// centre; in the previous build's table it sat +6 dB above it.
pub const LFE_BED_INDEX: usize = 3;

/// Pin the substitution at compile time: if someone "simplifies" the table by
/// multiplying through, the LFE would silently vanish from the downmix.
const _: () = assert!(BED_GAINS_STEREO[LFE_BED_INDEX][0] == TRIM);
const _: () = assert!(BED_GAINS_STEREO[LFE_BED_INDEX][1] == TRIM);

/// Gains for bed channel `index` (0-based within the bed).
///
/// Beyond the table a channel contributes nothing; silence beats a panic in an
/// audio callback.
fn bed_gains(index: usize) -> [f32; OUTPUT_CHANNELS] {
    BED_GAINS_STEREO
        .get(index)
        .copied()
        .unwrap_or([0.0; OUTPUT_CHANNELS])
}

/// Look-ahead delay line length, in samples.
const LIMITER_LEN: usize = 100;
/// Envelope decay per sample.
///
/// Given by bit pattern so the value is exact rather than a decimal that
/// cannot be represented.
const LIMITER_DECAY: f32 = f32::from_bits(0x3F7F_F972); // 0.9998999834
/// Weight of the *previous* gain when smoothing. Near-instant attack.
const LIMITER_SMOOTH: f32 = 0.001;
/// Ceiling, in PCM16 units: `32768 * 0.9999`, again by bit pattern.
const LIMITER_CEILING: f32 = f32::from_bits(0x46FF_F972); // 32764.72266

/// Per-output-channel look-ahead peak limiter.
///
/// The gain applied to a sample is derived from an envelope that has seen
/// `LIMITER_LEN - 1` samples *after* it, so this is genuine look-ahead. It
/// consequently delays the signal by `LIMITER_LEN - 1` samples; see
/// `LIMITER_LEN - 1` samples.
#[derive(Debug, Clone)]
pub struct Limiter {
    ring: [f32; LIMITER_LEN],
    write: usize,
    envelope: f32,
    gain: f32,
}

impl Limiter {
    pub fn new() -> Self {
        Self {
            ring: [0.0; LIMITER_LEN],
            write: 0,
            envelope: 0.0,
            gain: 1.0,
        }
    }

    pub fn reset(&mut self) {
        self.ring = [0.0; LIMITER_LEN];
        self.write = 0;
        self.envelope = 0.0;
        self.gain = 1.0;
    }

    fn process_sample(&mut self, sample: f32) -> f32 {
        self.ring[self.write] = sample;
        let read = (self.write + 1) % LIMITER_LEN;
        self.write = read;

        self.envelope = (self.envelope * LIMITER_DECAY).max(sample.abs());
        let target = if self.envelope > LIMITER_CEILING {
            LIMITER_CEILING / self.envelope
        } else {
            1.0
        };
        self.gain = (1.0 - LIMITER_SMOOTH) * target + LIMITER_SMOOTH * self.gain;
        self.gain * self.ring[read]
    }
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new()
    }
}

/// Configurations covered by the currently verified static matrix.
///
/// The rows in [`BED_GAINS_STEREO`] follow the `4+7+0` channel order.  Other
/// layouts with the same channel count use different speaker positions, so
/// accepting them would produce plausible audio with incorrect spatial image.
/// They are rejected until they get their own verified matrix.
pub fn is_renderable(config: ChannelConfig) -> bool {
    matches!(config, ChannelConfig::Stereo | ChannelConfig::Mc7_1_4)
}

/// BS.2051 layout name a configuration maps to.
pub fn layout_name(config: ChannelConfig) -> &'static str {
    match config {
        ChannelConfig::Mono => "0+1+0",
        ChannelConfig::Stereo => "0+2+0",
        ChannelConfig::Mc5_1 => "0+5+0",
        ChannelConfig::Mc7_1 => "0+7+0",
        ChannelConfig::Mc10_2 => "2+10+0",
        ChannelConfig::Mc22_2 => "2+22+0",
        ChannelConfig::Mc4_0 => "0+4+0",
        ChannelConfig::Mc5_1_2 => "2+5+0",
        ChannelConfig::Mc5_1_4 => "4+5+0",
        ChannelConfig::Mc7_1_2 => "2+7+0",
        ChannelConfig::Mc7_1_4 => "4+7+0",
        ChannelConfig::Hoa1 => "N3D",
        ChannelConfig::Hoa2 => "SN3D",
        ChannelConfig::Hoa3 => "FuMa",
    }
}

/// Renders interleaved decoder output to interleaved stereo int16.
///
/// Two deviations from the reference renderer, both audibly null or strictly
/// better:
///
/// * The diffuse path is delayed by `2 * blockSize` samples to align with the
///   direct path. With the diffuse gains identically zero that is a pure delay,
///   so it is dropped.
/// * The reference primes its output with `skip = latency + one frame`,
///   discarding the first 1024 input samples (~23 ms) of every track. That is
///   a bug, not a feature; we emit from sample 0.
///
/// # Latency and why it is safe to leave in
///
/// The limiter is a genuine look-ahead, so the output stream is uniformly
/// `LIMITER_LEN - 1` samples late: output sample `n` carries input sample
/// `n - 99`. A streaming renderer cannot undo that without buffering input it
/// has not been given yet, so it is left in place. The delay is the same wherever
/// a run starts, which is what keeps the render from contributing to a seek
/// discontinuity — pinned by `output_is_independent_of_where_the_run_started`.
/// The exception is a run's first frame, which sees a zero-filled ring;
/// [`WARMUP_FRAMES`] is the preroll that covers it.
#[derive(Debug)]
pub struct StereoRenderer {
    /// Per output channel, the input channels that contribute and their gain,
    /// in input-channel order. Zero gains are pruned here rather than in the
    /// mix loop, which keeps the accumulation order — and therefore the result
    /// bit-for-bit — identical to summing the full matrix.
    contribs: [Vec<(usize, f32)>; OUTPUT_CHANNELS],
    input_channels: usize,
    limiters: [Limiter; OUTPUT_CHANNELS],
}

impl StereoRenderer {
    pub fn new(bed_channels: usize, input_channels: usize) -> Self {
        let mut contribs: [Vec<(usize, f32)>; OUTPUT_CHANNELS] = [Vec::new(), Vec::new()];
        for channel in 0..input_channels {
            if channel >= bed_channels {
                // Channels past the bed are not part of the supported input.
                continue;
            }
            let gains = bed_gains(channel);
            for (out, list) in contribs.iter_mut().enumerate() {
                if gains[out] != 0.0 {
                    list.push((channel, gains[out]));
                }
            }
        }
        Self {
            contribs,
            input_channels,
            limiters: [Limiter::new(), Limiter::new()],
        }
    }

    pub fn reset(&mut self) {
        for limiter in &mut self.limiters {
            limiter.reset();
        }
    }

    /// Render `input` (interleaved, `input_channels` wide, PCM16 units) into
    /// `output` (interleaved stereo int16).
    ///
    /// `output.len()` must be `OUTPUT_CHANNELS * (input.len() / input_channels)`.
    pub fn render(&mut self, input: &[f32], output: &mut [i16]) -> Result<(), String> {
        if self.input_channels == 0 {
            return Err("render: zero input channels".to_string());
        }
        if !input.len().is_multiple_of(self.input_channels) {
            return Err(format!(
                "render: {} input samples is not a multiple of {} channels",
                input.len(),
                self.input_channels
            ));
        }
        let frames = input.len() / self.input_channels;
        if output.len() != frames * OUTPUT_CHANNELS {
            return Err(format!(
                "render: output holds {} samples, expected {}",
                output.len(),
                frames * OUTPUT_CHANNELS
            ));
        }

        for (frame, input_frame) in input.chunks_exact(self.input_channels).enumerate() {
            for (out, limiter) in self.limiters.iter_mut().enumerate() {
                let value = self.contribs[out]
                    .iter()
                    .map(|&(channel, gain)| gain * input_frame[channel])
                    .sum();
                output[frame * OUTPUT_CHANNELS + out] = quantise(limiter.process_sample(value));
            }
        }

        Ok(())
    }
}

/// Convert one PCM16-unit float to int16.
fn quantise(value: f32) -> i16 {
    if value > 32_767.0 {
        i16::MAX
    } else if value < -FULL_SCALE {
        i16::MIN
    } else {
        // Truncate toward zero rather than round.
        value as i16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference values for `BED_GAINS_STEREO`.
    #[test]
    fn bed_table_matches_reference() {
        let expected: [[f32; 2]; 12] = [
            [0.850000, 0.000000],
            [0.000000, 0.850000],
            // `1.414 * TRIM * BASE` — the DLL's hand-typed centre coefficient.
            [0.849872, 0.849872],
            [0.850000, 0.850000],
            [0.601041, -0.601041],
            [-0.601041, 0.601041],
            [0.601041, 0.601041],
            [0.601041, 0.601041],
            [0.601041, 0.000000],
            [0.000000, 0.601041],
            [0.601041, 0.000000],
            [-0.000000, 0.601041],
        ];
        for (row, (got, want)) in BED_GAINS_STEREO.iter().zip(expected.iter()).enumerate() {
            for out in 0..OUTPUT_CHANNELS {
                assert!(
                    (got[out] - want[out]).abs() < 1e-6,
                    "row {row} out {out}: {} vs {}",
                    got[out],
                    want[out]
                );
            }
        }
    }

    /// Stereo and 7.1.4 use the expected prefix/full table rows.
    #[test]
    fn shorter_configs_are_prefixes() {
        for channels in [2usize, 12] {
            for (index, expected) in BED_GAINS_STEREO.iter().enumerate().take(channels) {
                assert_eq!(bed_gains(index), *expected);
            }
        }
    }

    #[test]
    fn side_surrounds_cancel_in_mono() {
        // Rows 4 and 5 are anti-phase, so an L+R fold-down loses them entirely.
        for row in [4usize, 5] {
            let [l, r] = BED_GAINS_STEREO[row];
            assert!((l + r).abs() < 1e-6, "row {row} does not cancel");
        }
    }

    #[test]
    fn unrenderable_configs_are_refused() {
        for config in [
            ChannelConfig::Mono,
            ChannelConfig::Mc5_1,
            ChannelConfig::Mc7_1,
            ChannelConfig::Mc4_0,
            ChannelConfig::Mc5_1_2,
            ChannelConfig::Mc5_1_4,
            ChannelConfig::Mc7_1_2,
            ChannelConfig::Mc10_2,
            ChannelConfig::Mc22_2,
            ChannelConfig::Hoa1,
            ChannelConfig::Hoa2,
            ChannelConfig::Hoa3,
        ] {
            assert!(!is_renderable(config), "{config:?} should be refused");
        }
        for config in [ChannelConfig::Stereo, ChannelConfig::Mc7_1_4] {
            assert!(is_renderable(config), "{config:?} should render");
        }
    }

    /// A DC input through a known column must come out at the matrix gain, and
    /// the frame count must be preserved on every call.
    #[test]
    fn frame_count_is_preserved_and_gain_applied() {
        let frames = 1024usize;
        let channels = 12usize;
        let mut renderer = StereoRenderer::new(channels, channels);

        // Only channel 0 (L) carries signal, at a level the limiter leaves alone.
        let mut input = vec![0.0f32; frames * channels];
        for frame in 0..frames {
            input[frame * channels] = 1000.0;
        }
        let mut output = vec![0i16; frames * OUTPUT_CHANNELS];

        renderer.render(&input, &mut output).unwrap();
        assert_eq!(output.len(), frames * OUTPUT_CHANNELS);
        // The first samples are the look-ahead ramp.
        let expected = (1000.0 * TRIM) as i16;
        for frame in LIMITER_LEN..frames {
            assert_eq!(output[frame * OUTPUT_CHANNELS], expected, "frame {frame}");
            assert_eq!(output[frame * OUTPUT_CHANNELS + 1], 0);
        }

        // A second call is in steady state, so every sample is the matrix gain.
        renderer.render(&input, &mut output).unwrap();
        for frame in 0..frames {
            assert_eq!(output[frame * OUTPUT_CHANNELS], expected, "frame {frame}");
            assert_eq!(output[frame * OUTPUT_CHANNELS + 1], 0);
        }
    }

    /// The property the streaming layer depends on: given the same input frames,
    /// a run that starts earlier produces identical samples for the frames both
    /// runs cover. That makes the render itself contribute nothing to a seek
    /// discontinuity — the decoder still does, because its noise stream
    /// free-runs, so this is not a claim that a seeked decode is bit-exact.
    #[test]
    fn output_is_independent_of_where_the_run_started() {
        let frames = 512usize;
        let channels = 12usize;
        let total = 6usize;

        // Deterministic pseudo-audio across `total` frames.
        let mut all = vec![0.0f32; total * frames * channels];
        let mut seed = 0x1234_5678u32;
        for slot in all.iter_mut() {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *slot = ((seed >> 8) as f32 / 8_388_608.0 - 1.0) * 8_000.0;
        }
        let frame_samples = frames * channels;

        let render_run = |start: usize| {
            let mut r = StereoRenderer::new(channels, channels);
            let mut out = vec![0i16; (total - start) * frames * OUTPUT_CHANNELS];
            for (k, chunk) in out.chunks_mut(frames * OUTPUT_CHANNELS).enumerate() {
                let base = (start + k) * frame_samples;
                r.render(&all[base..base + frame_samples], chunk).unwrap();
            }
            out
        };

        let from_zero = render_run(0);
        let from_two = render_run(2);

        // Compare frames 3.. : both runs have had at least one whole frame of
        // real audio through the look-ahead by then.
        let per_frame = frames * OUTPUT_CHANNELS;
        for k in 3..total {
            let a = &from_zero[k * per_frame..(k + 1) * per_frame];
            let b = &from_two[(k - 2) * per_frame..(k - 1) * per_frame];
            assert_eq!(a, b, "frame {k} differs between runs");
        }
    }

    #[test]
    fn limiter_pulls_loud_input_under_the_ceiling() {
        let frames = 4096usize;
        let mut limiter = Limiter::new();
        // Well over full scale, like a real bed summing through the matrix.
        let mut samples = vec![46_000.0f32; frames];
        for sample in &mut samples {
            *sample = limiter.process_sample(*sample);
        }
        // Skip the look-ahead priming region, then nothing should be far over.
        let steady = &samples[LIMITER_LEN..];
        let peak = steady.iter().fold(0.0f32, |a, v| a.max(v.abs()));
        assert!(peak <= LIMITER_CEILING * 1.02, "limiter let {peak} through");
        assert!(
            peak > LIMITER_CEILING * 0.9,
            "limiter over-attenuated to {peak}"
        );
    }
}
