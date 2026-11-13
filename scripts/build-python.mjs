import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { root, run } from "./process.mjs";

const packages = resolve(root, "dist", "python");

run("pnpm", ["build:static"]);

rmSync(packages, { force: true, recursive: true });
run("uv", ["build", "--project", "core", "--out-dir", packages]);
run("uv", ["build", "--project", "web", "--out-dir", packages]);
