// ITEM 184(a) PROOF: run the new babel.config.js plugin against the REAL
// constants/buildMarker.ts source and show the placeholders are substituted.
// Run from expo/: bun scripts/item184a_babel_marker_proof.cjs
const babel = require("@babel/core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const cwd = process.cwd();
const source = fs.readFileSync(path.join(cwd, "constants/buildMarker.ts"), "utf8");
const gitSha = execSync("git rev-parse --short HEAD").toString().trim();
const out = babel.transformSync(source, {
  filename: path.join(cwd, "constants/buildMarker.ts"),
  configFile: path.join(cwd, "babel.config.js"),
  babelrc: false,
});
const code = out.code;
const shaMatch = code.match(/BUILD_SHA\s*=\s*"([^"]+)"/);
const stampMatch = code.match(/BUILD_MARKED_AT\s*=\s*"([^"]+)"/);
console.log("git rev-parse --short HEAD :", gitSha);
console.log("transformed BUILD_SHA      :", shaMatch ? shaMatch[1] : "NOT FOUND");
console.log("transformed BUILD_MARKED_AT:", stampMatch ? stampMatch[1] : "NOT FOUND");
console.log("sha substituted correctly  :", shaMatch && shaMatch[1] === gitSha ? "YES" : "NO");
console.log("stamp is a fresh ISO string:", stampMatch && !Number.isNaN(Date.parse(stampMatch[1])) ? "YES (" + stampMatch[1] + ")" : "NO");
console.log("literal placeholder remains:", code.includes('"__BUILD_SHA__"') || code.includes('"__BUILD_STAMP__"') ? "YES (BAD)" : "NO (good)");
