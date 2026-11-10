use prost::Message;
use prost_types::field_descriptor_proto::{Label, Type};
use std::env;
use std::fs;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("Usage: descriptor_to_json <descriptor.bin> <output.json>");
        std::process::exit(1);
    }

    let descriptor_bin = fs::read(&args[1]).expect("failed to read descriptor.bin");
    let fds = prost_types::FileDescriptorSet::decode(descriptor_bin.as_slice())
        .expect("failed to decode FileDescriptorSet");

    let file = fds
        .file
        .first()
        .expect("FileDescriptorSet must contain at least one file");
    let package = file.package().to_string();

    let messages: Vec<serde_json::Value> = file
        .message_type
        .iter()
        .map(|msg| {
            let fields: Vec<serde_json::Value> = msg
                .field
                .iter()
                .filter(|f| f.oneof_index.is_none())
                .map(|f| {
                    let type_name = match f.r#type() {
                        Type::Uint32 => "uint32",
                        Type::Int32 => "int32",
                        Type::Int64 => "int64",
                        Type::Uint64 => "uint64",
                        Type::Bool => "bool",
                        Type::String => "string",
                        Type::Bytes => "bytes",
                        Type::Double => "double",
                        Type::Float => "float",
                        Type::Message => "message",
                        _ => "unknown",
                    };
                    let repeated = f.label() == Label::Repeated;
                    let mut obj = serde_json::json!({
                        "name": f.name(),
                        "number": f.number(),
                        "type": type_name,
                    });
                    if repeated {
                        obj["repeated"] = serde_json::Value::Bool(true);
                    }
                    if type_name == "message" {
                        let inner = f
                            .type_name()
                            .trim_start_matches('.')
                            .split('.')
                            .next_back()
                            .unwrap_or("")
                            .to_string();
                        obj["message_type"] = serde_json::Value::String(inner);
                    }
                    obj
                })
                .collect();

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
                            let inner = f
                                .type_name()
                                .trim_start_matches('.')
                                .split('.')
                                .next_back()
                                .unwrap_or("")
                                .to_string();
                            serde_json::json!({
                                "name": f.name(),
                                "number": f.number(),
                                "message_type": inner,
                            })
                        })
                        .collect();
                    serde_json::json!({
                        "name": oneof_decl.name(),
                        "variants": variants,
                    })
                })
                .collect();

            let mut obj = serde_json::json!({
                "name": msg.name(),
                "fields": fields,
            });
            if !oneofs.is_empty() {
                obj["oneofs"] = serde_json::Value::Array(oneofs);
            }
            obj
        })
        .collect();

    let descriptor = serde_json::json!({
        "package": package,
        "messages": messages,
    });

    fs::write(
        &args[2],
        serde_json::to_string_pretty(&descriptor).expect("failed to serialize descriptor JSON"),
    )
    .expect("failed to write descriptor JSON");
}
