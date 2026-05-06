fn main() {
    prost_build::compile_protos(
        &["../contracts/assets/assets.proto"],
        &["../contracts/"],
    )
    .expect("Failed to compile proto files");
}
