use gstreamer::prelude::*;
use gstreamer::{Element, ElementFactory, Pad};

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
    queue.sync_state_with_parent()?;

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

    Ok(MixLink {
        source_peer_id: source_peer_id.to_string(),
        dest_peer_id: dest_peer_id.to_string(),
        tee_pad,
        mixer_pad,
        queue,
    })
}

/// Unlink and release the request pads created by `link_tee_to_mixer`, and
/// tear down the intermediate queue.
pub fn unlink(link: &MixLink, pipeline: &gstreamer::Pipeline, tee: &Element, mixer: &Element) {
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
