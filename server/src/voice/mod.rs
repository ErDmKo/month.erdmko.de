pub fn init() {
    gstreamer::init().expect("GStreamer initialization failed");
}

#[cfg(test)]
mod tests {
    #[test]
    fn gstreamer_init_smoke() {
        gstreamer::init().expect("GStreamer init failed");
    }
}
