import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // Hermes and older browsers run this. Metro and bundlers take it from here.
  target: "es2019",
  external: ["drizzle-orm"],
});
