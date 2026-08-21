import next from "eslint-config-next";

// Two things this file works around, stated rather than left as folklore:
//
// 1. `eslint-config-next` exports a flat-config ARRAY, not a factory. Calling
//    it throws "next is not a function" before ESLint reads a single file, so a
//    one-line config error looks like a broken toolchain. It was one.
// 2. ESLint is pinned to 9 in package.json, not 10. The plugins this config
//    pulls in (eslint-plugin-react, typescript-eslint) still use the ESLint 9
//    context and scope-manager APIs, and under 10 they throw inside the rule
//    loader. `eslint-config-next@16` declares `eslint: >=9`, and 9 is the half
//    of that range that actually runs.
//
// The React version is declared so eslint-plugin-react does not go looking for
// it by walking node_modules, which is both slower and one more thing to break.
const config = [
  { ignores: [".next/**", "node_modules/**", "public/**", "lib/oracle/**"] },
  ...next,
  { settings: { react: { version: "19.2" } } },
];

export default config;
