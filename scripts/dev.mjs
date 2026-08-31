import { spawn } from "node:child_process";

const app = process.argv[2] ?? process.env.ROBOT_RADIO_APP ?? "google";
if (app !== "google" && app !== "eleven") {
  console.error(`Unknown Robot Radio app: ${app}`);
  process.exit(1);
}

const hosted = Boolean(process.env.PORT || process.env.K_SERVICE || process.env.AI_STUDIO_APP);
const command = hosted ? "npm" : "pnpm";
const args = hosted
  ? ["run", `dev:hosted:${app}`]
  : ["--parallel", "--filter", `@robot-radio/${app}-server`, "--filter", `@robot-radio/${app}-web`, "dev"];

const child = spawn(command, args, { stdio: "inherit", env: process.env });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`Unable to start the ${app} app in ${hosted ? "hosted" : "local"} development mode:`, error);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
