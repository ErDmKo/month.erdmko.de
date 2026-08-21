use gstreamer::prelude::*;
use gstreamer::{Element, ElementFactory, Pad, PadProbeData, PadProbeReturn, PadProbeType};
use std::sync::Mutex as StdMutex;
use std::sync::mpsc;
use std::time::Duration;

/// How long to wait for the blocking pad probe to actually fire, and for the
/// drain EOS to reach the far end of the branch, before giving up and tearing
/// the branch down anyway. Both events are local (in-process pad probe
/// callbacks, no network hop), so they should resolve in well under a
/// millisecond in practice — this is only a safety net against a wedged
/// pipeline blocking `remove_participant` (and therefore the global
/// `VOICE_GST` room-registry lock) indefinitely.
const DRAIN_TIMEOUT: Duration = Duration::from_millis(50);

/// A single mix-minus link: participant `source`'s decoded audio (from their `tee`)
/// feeding into participant `dest`'s personal `audiomixer`.
///
/// A `queue` element sits between the `tee` and the `audiomixer`: `tee` does not
/// run its own streaming thread, so without a queue to decouple threads, feeding
/// a `tee` branch straight into another element's (e.g. `audiomixer`'s aggregate)
/// thread can stall or race with caps negotiation.
pub struct MixLink {
    pub source_peer_id: String,
    pub dest_peer_id: String,
    tee_pad: Pad,
    mixer_pad: Pad,
    queue: Element,
}

/// Request a new src pad on `tee`, a new sink pad on `mixer`, and link them
/// through an intermediate `queue` element (added to the same `pipeline` as
/// `tee`/`mixer`). Safe to call while the pipeline is in `Playing` state.
pub fn link_tee_to_mixer(
    source_peer_id: &str,
    dest_peer_id: &str,
    pipeline: &gstreamer::Pipeline,
    tee: &Element,
    mixer: &Element,
) -> Result<MixLink, gstreamer::glib::BoolError> {
    let tee_pad = tee
        .request_pad_simple("src_%u")
        .ok_or_else(|| gstreamer::glib::bool_error!("tee has no free src pad"))?;
    let mixer_pad = mixer
        .request_pad_simple("sink_%u")
        .ok_or_else(|| gstreamer::glib::bool_error!("mixer has no free sink pad"))?;

    let queue = ElementFactory::make("queue").build()?;
    pipeline.add(&queue)?;

    let queue_sink = queue
        .static_pad("sink")
        .ok_or_else(|| gstreamer::glib::bool_error!("queue has no sink pad"))?;
    let queue_src = queue
        .static_pad("src")
        .ok_or_else(|| gstreamer::glib::bool_error!("queue has no src pad"))?;

    tee_pad
        .link(&queue_sink)
        .map_err(|_| gstreamer::glib::bool_error!("failed to link tee pad to queue"))?;
    queue_src
        .link(&mixer_pad)
        .map_err(|_| gstreamer::glib::bool_error!("failed to link queue to mixer pad"))?;
    // A source may already be streaming when a participant joins. Do not start
    // this queue until both pads are linked, otherwise its first buffer hits an
    // unlinked src pad and the branch stops permanently.
    queue.sync_state_with_parent()?;

    Ok(MixLink {
        source_peer_id: source_peer_id.to_string(),
        dest_peer_id: dest_peer_id.to_string(),
        tee_pad,
        mixer_pad,
        queue,
    })
}

/// Safely detach a live mix-minus branch before it's unlinked and torn down.
///
/// Unlinking `tee_pad -> queue -> mixer_pad` directly, with no synchronization,
/// is a real race whenever a buffer might already be mid-flight through the
/// branch (see the "Dynamic Pipelines" pattern in GStreamer's
/// application-development manual): a buffer already inside the `queue`, or
/// one about to be pushed from `tee`, can land on half-unlinked pads.
///
/// 1. Install a blocking pad probe on `tee_pad` — this stops new buffers from
///    entering the branch from this point on.
/// 2. Once blocked, push an EOS event into the branch via the queue's sink pad.
/// 3. Wait (bounded by `DRAIN_TIMEOUT`) for that EOS to reach the queue's src
///    pad, meaning everything already queued has drained out.
///
/// Only after this returns is it safe to unlink and release the pads.
fn drain_branch(link: &MixLink) {
    let Some(queue_sink) = link.queue.static_pad("sink") else {
        return;
    };
    let Some(queue_src) = link.queue.static_pad("src") else {
        return;
    };

    let (blocked_tx, blocked_rx) = mpsc::channel::<()>();
    let blocked_tx = StdMutex::new(Some(blocked_tx));
    let block_probe = link
        .tee_pad
        .add_probe(PadProbeType::BLOCK_DOWNSTREAM, move |_, _| {
            if let Ok(mut tx) = blocked_tx.lock() {
                if let Some(tx) = tx.take() {
                    let _ = tx.send(());
                }
            }
            PadProbeReturn::Ok
        });
    // Bounded wait: this only guards against a wedged pipeline, the callback
    // above fires as soon as GStreamer's streaming thread reaches this pad.
    let _ = blocked_rx.recv_timeout(DRAIN_TIMEOUT);

    let (drained_tx, drained_rx) = mpsc::channel::<()>();
    let drained_tx = StdMutex::new(Some(drained_tx));
    let drain_probe = queue_src.add_probe(PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
        if let Some(PadProbeData::Event(event)) = &info.data {
            if event.type_() == gstreamer::EventType::Eos {
                if let Ok(mut tx) = drained_tx.lock() {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(());
                    }
                }
            }
        }
        PadProbeReturn::Ok
    });

    queue_sink.send_event(gstreamer::event::Eos::new());
    let _ = drained_rx.recv_timeout(DRAIN_TIMEOUT);

    if let Some(id) = block_probe {
        link.tee_pad.remove_probe(id);
    }
    if let Some(id) = drain_probe {
        queue_src.remove_probe(id);
    }
}

/// Unlink and release the request pads created by `link_tee_to_mixer`, and
/// tear down the intermediate queue.
pub fn unlink(link: &MixLink, pipeline: &gstreamer::Pipeline, tee: &Element, mixer: &Element) {
    drain_branch(link);

    if let Some(queue_sink) = link.queue.static_pad("sink") {
        let _ = link.tee_pad.unlink(&queue_sink);
    }
    if let Some(queue_src) = link.queue.static_pad("src") {
        let _ = queue_src.unlink(&link.mixer_pad);
    }
    tee.release_request_pad(&link.tee_pad);
    mixer.release_request_pad(&link.mixer_pad);
    let _ = link.queue.set_state(gstreamer::State::Null);
    let _ = pipeline.remove(&link.queue);
}

/// Diagnostic helper: play a short sine tone directly into `mixer`, bypassing
/// the tee/RTP path entirely. Useful for confirming the GStreamer side of the
/// pipeline (mixer → encode → appsink → outbound RTP → browser) can actually
/// deliver audio, independent of whether real microphone input or another
/// participant's link is working.
///
/// Fire-and-forget: builds a temporary `audiotestsrc ! audioconvert !
/// audioresample` chain, links it to a fresh request pad on `mixer`, lets it
/// play for `duration`, then tears the branch back down on a dedicated OS
/// thread (not tied to any tokio/actix runtime, since this is diagnostic-only
/// and self-contained).
pub fn play_test_tone(
    pipeline: &gstreamer::Pipeline,
    mixer: &Element,
    duration: Duration,
) -> Result<(), gstreamer::glib::BoolError> {
    let src = ElementFactory::make("audiotestsrc")
        .property_from_str("wave", "sine")
        .property("freq", 440.0f64)
        .property("volume", 0.3f64)
        .property("is-live", true)
        .build()?;
    let convert = ElementFactory::make("audioconvert").build()?;
    let resample = ElementFactory::make("audioresample").build()?;

    let elements: [Element; 3] = [src.clone(), convert.clone(), resample.clone()];
    for el in &elements {
        pipeline.add(el)?;
    }
    Element::link_many(elements.clone())?;

    let mixer_pad = mixer
        .request_pad_simple("sink_%u")
        .ok_or_else(|| gstreamer::glib::bool_error!("mixer has no free sink pad"))?;
    let resample_src = resample
        .static_pad("src")
        .ok_or_else(|| gstreamer::glib::bool_error!("resample has no src pad"))?;

    for el in &elements {
        el.sync_state_with_parent()?;
    }
    resample_src
        .link(&mixer_pad)
        .map_err(|_| gstreamer::glib::bool_error!("failed to link test tone to mixer"))?;

    let pipeline = pipeline.clone();
    let mixer = mixer.clone();
    std::thread::spawn(move || {
        std::thread::sleep(duration);
        let _ = resample_src.unlink(&mixer_pad);
        mixer.release_request_pad(&mixer_pad);
        for el in &elements {
            let _ = el.set_state(gstreamer::State::Null);
            let _ = el.state(gstreamer::ClockTime::from_mseconds(50));
            let _ = pipeline.remove(el);
        }
    });

    Ok(())
}
