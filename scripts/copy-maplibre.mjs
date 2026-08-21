/**
 * Copy MapLibre's web worker out of node_modules into public/maplibre.
 *
 * MapLibre does its GeoJSON tiling in a worker, and it locates that worker with
 * `new URL("./maplibre-gl-worker.mjs", import.meta.url)`. Inside a Next bundle
 * `import.meta.url` is the URL of the page that loaded the chunk, so the worker
 * script URL came out as the page itself: the browser dutifully started a
 * worker, fed it HTML, and the worker died.
 *
 * Nothing announced this. The raster basemap needs no worker, so the map drew
 * normally; only the GeoJSON layer was affected, and a source whose worker is
 * gone does not error, it just never finishes loading. The parcels source held
 * all 3,998 features, `isSourceLoaded()` stayed false forever, and the map
 * showed an empty city.
 *
 * So the worker is self hosted from a path we control and handed to MapLibre
 * explicitly, exactly as the DuckDB runtime already is. The worker imports
 * `./maplibre-gl-shared.mjs`, which is why both files are copied and why they
 * have to land in the same directory.
 */
import { mkdir, copyFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const dist = join(dirname(require.resolve("maplibre-gl/package.json")), "dist");
const outDir = resolve(process.cwd(), "public", "maplibre");

const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

await mkdir(outDir, { recursive: true });

let bytes = 0;
for (const file of FILES) {
  const to = join(outDir, file);
  await copyFile(join(dist, file), to);
  bytes += (await stat(to)).size;
}

console.log(
  `[copy-maplibre] copied ${FILES.length} files (${(bytes / 1024).toFixed(0)} kB) to public/maplibre`,
);
