import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });

// package.json est la seule source de vérité pour la version : on la recopie dans le manifest.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (!/^\d+(\.\d+){0,3}$/.test(version)) {
  throw new Error(`Version "${version}" refusée par Chrome : 1 à 4 entiers séparés par des points.`);
}
const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
manifest.version = version;
writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2) + "\n");

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
