import { spawn } from "node:child_process";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const server = spawn(npmCmd, ["run", "dev:server"], { stdio: "inherit", shell: false });
const client = spawn(npmCmd, ["run", "dev"], { stdio: "inherit", shell: false });

function shutdown() {
  server.kill();
  client.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
