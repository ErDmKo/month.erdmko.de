// Keep ['property'] and { ['property']: value } intact for Closure ADVANCED.
// Syntax minification would turn these into renameable dot/unquoted accesses.
export default {
    minifyIdentifiers: true,
    minifyWhitespace: true,
    minifySyntax: false,
    ignoreAnnotations: false,
};
