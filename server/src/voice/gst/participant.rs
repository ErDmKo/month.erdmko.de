use gstreamer::prelude::*;
use gstreamer::{Element, ElementFactory};
use gstreamer_app::{AppSink, AppSrc};

/// All GStreamer elements belonging to one connected voice participant:
/// an inbound decode chain (appsrc → depay → decode → tee) and an outbound
/// mix-minus encode chain (audiomixer → encode → appsink).
///
/// Cheap to clone: every field is a refcounted GStreamer/GObject handle.
#[derive(Clone)]
pub struct ParticipantPipeline {
    pub peer_id: String,

    // Inbound: appsrc → rtpopusdepay → opusdec → audioconvert → audioresample → tee
    pub appsrc: AppSrc,
    pub tee: Element,
    inbound_elements: Vec<Element>,

    // Outbound: audiomixer → opusenc → rtpopuspay → appsink
    pub mixer: Element,
    pub appsink: AppSink,
    outbound_elements: Vec<Element>,
}

impl ParticipantPipeline {
    /// Build the elements for a new participant and add them to `pipeline`.
    /// Elements are linked internally but not yet connected to any other
    /// participant's tee/mixer — that is done by `mixer::link_participants`.
    pub fn new(
        pipeline: &gstreamer::Pipeline,
        peer_id: &str,
    ) -> Result<Self, gstreamer::glib::BoolError> {
        let caps = gstreamer::Caps::builder("application/x-rtp")
            .field("media", "audio")
            .field("encoding-name", "OPUS")
            .field("clock-rate", 48000i32)
            .field("payload", 96i32)
            .build();

        let appsrc = ElementFactory::make("appsrc")
            .name(format!("src-{peer_id}"))
            .property("format", gstreamer::Format::Time)
            .property("caps", &caps)
            .property("is-live", true)
            .property("do-timestamp", true)
            .build()?
            .dynamic_cast::<AppSrc>()
            .expect("appsrc factory must build an AppSrc");

        let depay = ElementFactory::make("rtpopusdepay").build()?;
        let decode = ElementFactory::make("opusdec").build()?;
        let convert = ElementFactory::make("audioconvert").build()?;
        let resample = ElementFactory::make("audioresample").build()?;
        let tee = ElementFactory::make("tee")
            .name(format!("tee-{peer_id}"))
            .build()?;

        let inbound_elements: Vec<Element> = vec![
            appsrc.clone().upcast(),
            depay.clone(),
            decode.clone(),
            convert.clone(),
            resample.clone(),
            tee.clone(),
        ];
        for el in &inbound_elements {
            pipeline.add(el)?;
        }
        Element::link_many(inbound_elements.clone())?;

        let mixer = ElementFactory::make("audiomixer")
            .name(format!("mixer-{peer_id}"))
            // "now" mode causes a confirmed self-deadlock in this GStreamer
            // version: gst_aggregator_pad_chain_internal holds
            // GST_OBJECT_LOCK(self) and, for start-time-selection=now,
            // calls gst_element_get_current_running_time(self), which
            // re-locks the same non-recursive GST_OBJECT_LOCK on the same
            // element. "first" avoids this: it locks the *pad's* own
            // object lock (a distinct mutex), and wait_and_check also
            // special-cases FIRST to use the plain cond-wait instead of
            // the clock-deadline wait for a pad's first buffer.
            .property_from_str("start-time-selection", "first")
            .build()?;
        let encode = ElementFactory::make("opusenc")
            .property_from_str("audio-type", "voice")
            .property("bitrate", 32000i32)
            .build()?;
        let pay = ElementFactory::make("rtpopuspay").build()?;
        let appsink = ElementFactory::make("appsink")
            .name(format!("sink-{peer_id}"))
            .property("emit-signals", true)
            .property("sync", false)
            // Without this, appsink needs a real preroll buffer before it can
            // finish PAUSED->PLAYING; a freshly-joined participant who hasn't
            // pushed any RTP yet would otherwise leave the whole pipeline
            // stuck in an async, not-quite-Playing state indefinitely.
            .property("async", false)
            .property("max-buffers", 0u32)
            .property("drop", false)
            .build()?
            .dynamic_cast::<AppSink>()
            .expect("appsink factory must build an AppSink");

        let outbound_elements: Vec<Element> = vec![
            mixer.clone(),
            encode.clone(),
            pay.clone(),
            appsink.clone().upcast(),
        ];
        for el in &outbound_elements {
            pipeline.add(el)?;
        }
        Element::link_many(outbound_elements.clone())?;

        for el in inbound_elements.iter().chain(outbound_elements.iter()) {
            el.sync_state_with_parent()?;
        }

        Ok(Self {
            peer_id: peer_id.to_string(),
            appsrc,
            tee,
            inbound_elements,
            mixer,
            appsink,
            outbound_elements,
        })
    }

    /// Push a chunk of RTP/Opus bytes into this participant's inbound pipeline.
    /// Never panics — malformed input is simply rejected downstream by the
    /// GStreamer elements (logged, not raised as a Rust error).
    pub fn push_rtp(&self, data: &[u8]) {
        let buffer = gstreamer::Buffer::from_slice(data.to_vec());
        if let Err(e) = self.appsrc.push_buffer(buffer) {
            log::warn!(
                "event=voice_gst_push_error peer_id={} error={:?}",
                self.peer_id,
                e
            );
        }
    }

    /// Try to pull one RTP/Opus buffer for this participant's mixed-and-encoded output.
    pub fn pull_rtp(&self) -> Option<Vec<u8>> {
        let timeout = gstreamer::ClockTime::from_mseconds(50);
        // The first buffer of a stream can arrive as a "preroll" sample rather
        // than a regular one; try both so we never silently miss it.
        let sample = self
            .appsink
            .try_pull_sample(timeout)
            .or_else(|| self.appsink.try_pull_preroll(gstreamer::ClockTime::ZERO))?;
        let buffer = sample.buffer()?;
        let map = buffer.map_readable().ok()?;
        Some(map.as_slice().to_vec())
    }

    /// Tear down this participant's elements: drain with EOS, set to Null, remove from pipeline.
    pub fn teardown(&self, pipeline: &gstreamer::Pipeline) {
        let _ = self.appsrc.end_of_stream();
        for el in self
            .inbound_elements
            .iter()
            .chain(self.outbound_elements.iter())
        {
            let _ = el.set_state(gstreamer::State::Null);
            // Block until the Null transition actually completes before removing
            // the element from the pipeline, otherwise the pipeline can be left
            // in a transient Paused state.
            let _ = el.state(gstreamer::ClockTime::NONE);
            let _ = pipeline.remove(el);
        }
    }
}
