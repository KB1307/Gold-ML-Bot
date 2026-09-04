const vm = require("node:vm");

const { getDefaultConfig } = require("expo/metro-config");
const { withRorkMetro } = require("@rork-ai/toolkit-sdk/metro");

function isWebBundleUrl(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  try {
    return new URL(value, "http://localhost").searchParams.get("platform") === "web";
  } catch {
    return false;
  }
}

function toOriginRelativeSourceMapUrl(value) {
  if (!isWebBundleUrl(value)) {
    return value;
  }

  const parsed = new URL(value, "http://localhost");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function assertParseableWebBundle(bundle, options) {
  if (!options.dev || !isWebBundleUrl(options.sourceUrl)) {
    return;
  }

  const code = typeof bundle === "string" ? bundle : bundle?.code;
  if (typeof code !== "string") {
    throw new Error("Web bundle serializer returned no JavaScript source");
  }

  try {
    new vm.Script(code, { filename: "metro-web-bundle.js" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Refusing to serve malformed Metro web output (${Buffer.byteLength(code, "utf8")} bytes): ${detail}`,
      { cause: error },
    );
  }
}

const config = withRorkMetro(getDefaultConfig(__dirname));

// Keep babel.config.js on Rork's canonical six-line template. Code-sync owns
// that file and has rewritten it repeatedly, so build provenance is injected by
// this dedicated transformer instead of racing a generated Babel config.
config.transformer.babelTransformerPath = require.resolve("./metro.build-marker-transformer");

// Metro derives sourceMapUrl from its internal Host header. Rork's edge talks
// to Metro as localhost:8081, so an untouched trailer sends the user's browser
// to its own localhost. Make web source maps origin-relative and fail closed if
// a serializer ever produces syntactically invalid JavaScript: a 500 is safer
// than immutably caching and repeatedly loading a malformed 17 MB artifact.
const defaultSerializer = config.serializer.customSerializer;
if (typeof defaultSerializer !== "function") {
  throw new Error("Expo Metro custom serializer is unavailable");
}

config.serializer.customSerializer = async (entryPoint, preModules, graph, options) => {
  const safeOptions = {
    ...options,
    sourceMapUrl: toOriginRelativeSourceMapUrl(options.sourceMapUrl),
  };
  const bundle = await defaultSerializer(entryPoint, preModules, graph, safeOptions);
  assertParseableWebBundle(bundle, safeOptions);
  return bundle;
};

module.exports = config;
