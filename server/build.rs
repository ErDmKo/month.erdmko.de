use std::fs;
use std::path::{Path, PathBuf};

fn collect_protos(dir: &Path, protos: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("failed to read contracts dir") {
        let entry = entry.expect("failed to read dir entry");
        let path = entry.path();
        if path.is_dir() {
            collect_protos(&path, protos);
        } else if path.extension().and_then(|e| e.to_str()) == Some("proto") {
            println!("cargo:rerun-if-changed={}", path.display());
            protos.push(path);
        }
    }
}

fn main() {
    let contracts_dir = Path::new("../contracts");
    println!("cargo:rerun-if-changed={}", contracts_dir.display());

    let mut protos = Vec::new();
    collect_protos(contracts_dir, &mut protos);

    if protos.is_empty() {
        return;
    }

    let out_dir = Path::new("src/generated");
    fs::create_dir_all(out_dir).expect("failed to create src/generated");

    // ── Emit Rust structs ─────────────────────────────────────────────────────

    prost_build::Config::new()
        .out_dir(out_dir)
        .compile_protos(&protos, &[contracts_dir])
        .expect("failed to compile proto files");

    // ── Emit descriptor JSON for each proto package ───────────────────────────
    // The JSON is consumed by assets/js/tools/gen-proto.ts to generate TS.

    use prost::Message;
    prost_build::Config::new()
        .file_descriptor_set_path(out_dir.join("descriptor.bin"))
        .compile_protos(&protos, &[contracts_dir])
        .expect("failed to compile proto files for descriptor");

    let descriptor_bin = fs::read(out_dir.join("descriptor.bin"))
        .expect("failed to read descriptor.bin");

    let fds = prost_types::FileDescriptorSet::decode(descriptor_bin.as_slice())
        .expect("failed to decode FileDescriptorSet");

    for file in &fds.file {
        let package = file.package().to_string();
        if package.is_empty() {
            continue;
        }

        // Build a lookup: type_name (e.g. ".chat.ClientJoin") → message descriptor
        let mut type_map: std::collections::HashMap<String, &prost_types::DescriptorProto> =
            std::collections::HashMap::new();
        for msg in &file.message_type {
            let key = format!(".{}.{}", package, msg.name());
            type_map.insert(key, msg);
        }

        let messages: Vec<serde_json::Value> = file
            .message_type
            .iter()
            .map(|msg| {
                // ── Regular scalar/bytes/string fields ────────────────────────
                let fields: Vec<serde_json::Value> = msg
                    .field
                    .iter()
                    // skip oneof fields — they are emitted separately below
                    .filter(|f| f.oneof_index.is_none())
                    .map(|f| {
                        use prost_types::field_descriptor_proto::{Label, Type};
                        let type_name = match f.r#type() {
                            Type::Uint32 => "uint32",
                            Type::Int32  => "int32",
                            Type::Int64  => "int64",
                            Type::Uint64 => "uint64",
                            Type::Bool   => "bool",
                            Type::String => "string",
                            Type::Bytes  => "bytes",
                            Type::Double => "double",
                            Type::Float  => "float",
                            Type::Message => "message",
                            _            => "unknown",
                        };
                        let repeated = f.label() == Label::Repeated;
                        let mut obj = serde_json::json!({
                            "name":   f.name(),
                            "number": f.number(),
                            "type":   type_name,
                        });
                        if repeated {
                            obj["repeated"] = serde_json::Value::Bool(true);
                        }
                        if type_name == "message" {
                            // e.g. ".chat.ChatItem" → "ChatItem"
                            let inner = f.type_name()
                                .trim_start_matches('.')
                                .split('.')
                                .last()
                                .unwrap_or("")
                                .to_string();
                            obj["message_type"] = serde_json::Value::String(inner);
                        }
                        obj
                    })
                    .collect();

                // ── Oneof groups ──────────────────────────────────────────────
                let oneofs: Vec<serde_json::Value> = msg
                    .oneof_decl
                    .iter()
                    .enumerate()
                    .map(|(oneof_idx, oneof_decl)| {
                        let variants: Vec<serde_json::Value> = msg
                            .field
                            .iter()
                            .filter(|f| f.oneof_index == Some(oneof_idx as i32))
                            .map(|f| {
                                // inner type name e.g. "ClientJoin"
                                let inner = f.type_name()
                                    .trim_start_matches('.')
                                    .split('.')
                                    .last()
                                    .unwrap_or("")
                                    .to_string();
                                serde_json::json!({
                                    "name":         f.name(),
                                    "number":       f.number(),
                                    "message_type": inner,
                                })
                            })
                            .collect();
                        serde_json::json!({
                            "name":     oneof_decl.name(),
                            "variants": variants,
                        })
                    })
                    .collect();

                let mut obj = serde_json::json!({
                    "name":   msg.name(),
                    "fields": fields,
                });
                if !oneofs.is_empty() {
                    obj["oneofs"] = serde_json::Value::Array(oneofs);
                }
                obj
            })
            .collect();

        let descriptor = serde_json::json!({
            "package":  package,
            "messages": messages,
        });

        let json_path = out_dir.join(format!("{}.descriptor.json", package));
        fs::write(&json_path, serde_json::to_string_pretty(&descriptor).unwrap())
            .expect("failed to write descriptor JSON");
    }

    // Clean up the binary descriptor — only the JSON is needed downstream
    let _ = fs::remove_file(out_dir.join("descriptor.bin"));
}
