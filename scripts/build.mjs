import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "public");
const assets = ["index.html", "privacy.html", "terms.html", "client.js", "styles.css", "landing.css", "logic-map.css", "calendar-focus.css", "legal.css"];

await mkdir(output, { recursive: true });
await Promise.all(assets.map(asset => copyFile(resolve(root, asset), resolve(output, asset))));
console.log(`Prepared ${assets.length} static assets in public/`);
