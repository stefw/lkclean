import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });

const ctx = await esbuild.context({
  entryPoints: {
    content: "src/content.ts",
    background: "src/background.ts",
    options: "src/options.ts",
  },
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir: "dist",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("lkclean: watching…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
