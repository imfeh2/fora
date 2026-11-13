import { resolve } from "node:path";
import { root, run } from "./process.mjs";

const environment = resolve(root, "dist", "web-environment");
const scripts = process.platform === "win32" ? "Scripts" : "bin";
const extension = process.platform === "win32" ? ".exe" : "";

run("pnpm", ["build:static"]);
run(
  "uv",
  [
    "sync",
    "--locked",
    "--no-dev",
    "--no-editable",
    "--package",
    "fora-web",
    "--python",
    "3.13",
  ],
  { env: { ...process.env, UV_PROJECT_ENVIRONMENT: environment } },
);
run(
  resolve(environment, scripts, `fora-web${extension}`),
  process.argv.slice(2),
);
