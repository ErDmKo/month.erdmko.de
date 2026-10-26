"""Browser bundles: esbuild links TypeScript; Closure ADVANCED optimizes JS."""

load("@aspect_rules_esbuild//esbuild:defs.bzl", "esbuild")

def advanced_bundle(name, entry_point, deps):
    """Preserve public bundle targets/filenames while optimizing linked code.

    Args:
        name: Public target and output basename, e.g. month-bundle.
        entry_point: TypeScript browser entry point.
        deps: Type-checked TypeScript projects used by esbuild.
    """
    linked = name + "-esbuild"
    esbuild(
        name = linked,
        config = "//tools/closure:esbuild_config",
        entry_point = entry_point,
        deps = deps,
        format = "iife",
        metafile = False,
        # Preserve bracket/quoted property keys for Closure ADVANCED.
        # The config minifies whitespace and identifiers, not syntax.
        minify = False,
        sourcemap = False,
        target = "esnext",
        tsconfig = ":tsconfig",
    )
    native.genrule(
        name = name,
        srcs = [":" + linked],
        outs = [name + ".js"],
        cmd = " ".join([
            "$(execpath //tools/closure:compiler)",
            "--compilation_level ADVANCED",
            "--language_in ECMASCRIPT_NEXT",
            "--language_out ECMASCRIPT_NEXT",
            "--charset UTF-8",
            "--isolation_mode IIFE",
            "--rewrite_polyfills=false",
            # esbuild strips TypeScript's types and optional parameter metadata.
            # ts_project checks types; retain Closure's non-type diagnostics.
            "--jscomp_off checkTypes",
            "--jscomp_error undefinedVars",
            "--js $(location :" + linked + ")",
            "--js_output_file $@",
        ]),
        tools = ["//tools/closure:compiler"],
    )
