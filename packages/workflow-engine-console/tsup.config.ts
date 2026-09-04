import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/node.ts", "src/testing.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // The UI bundle is a ~53 kB string constant shared by the library entry and
  // the CLI. Without splitting, tsup inlines it into both and the package
  // carries it twice.
  splitting: true,
  treeshake: true,
});
