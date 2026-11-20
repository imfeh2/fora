import { resolve } from "node:path";
import { root, run } from "./process.mjs";

const environment = resolve(root, "dist", "web-environment");

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
run(resolve(environment, "bin", "fora-web"), process.argv.slice(2));
