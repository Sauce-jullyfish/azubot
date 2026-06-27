// oxlint-disable no-control-regex
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

const children = new Map();

let isShuttingDown = false;
let finalExitCode = 0;

function abs(path) {
  return join(rootDir, path);
}

function hasFile(path) {
  return existsSync(abs(path));
}

function now() {
  const date = new Date();

  return date.toLocaleTimeString("zh-TW", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeBool(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  return defaultValue;
}

function selectedByEnv(name) {
  const selectedServices = process.env.AZUBOT_DEV_SERVICES;

  if (selectedServices) {
    const services = selectedServices
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    return services.includes(name.toLowerCase());
  }

  const key = `AZUBOT_DEV_${name.toUpperCase()}`;

  return normalizeBool(process.env[key], true);
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function detectSeverityColor(line) {
  const lower = stripAnsi(line).toLowerCase();

  if (
    lower.includes("error") ||
    lower.includes("exception") ||
    lower.includes("traceback") ||
    lower.includes("fatal") ||
    lower.includes("failed") ||
    lower.includes("failure") ||
    lower.includes("eaddrinuse")
  ) {
    return RED;
  }

  if (lower.includes("warn") || lower.includes("warning") || lower.includes("deprecated")) {
    return YELLOW;
  }

  if (
    lower.includes("ready") ||
    lower.includes("started") ||
    lower.includes("running") ||
    lower.includes("listening") ||
    lower.includes("healthy") ||
    lower.includes("connected") ||
    lower.includes("success") ||
    lower.includes("compiled") ||
    lower.includes("done")
  ) {
    return GREEN;
  }

  if (lower.includes("info") || lower.includes("debug")) {
    return BLUE;
  }

  return "";
}

function printLine(service, line) {
  if (!line) {
    return;
  }

  const severityColor = detectSeverityColor(line);
  const bodyColor = severityColor || "";
  const timestamp = `${DIM}${now()}${RESET}`;
  const prefix = `${service.color}[${service.name}]${RESET}`;

  process.stdout.write(`${timestamp} ${prefix} ${bodyColor}${line}${RESET}\n`);
}

function printSystem(line) {
  process.stdout.write(`${DIM}${now()}${RESET} ${GRAY}[dev]${RESET} ${line}\n`);
}

function createLineReader(service) {
  let buffer = "";

  function push(chunk) {
    buffer += chunk.toString("utf8").replace(/\r(?!\n)/g, "\n");

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      printLine(service, line);
    }
  }

  function flush() {
    if (buffer.length > 0) {
      printLine(service, buffer);
      buffer = "";
    }
  }

  return {
    push,
    flush,
  };
}

function buildServices() {
  return [
    {
      name: "web",
      color: CYAN,
      requiredFile: "apps/web/package.json",
      command: "mise",
      args: ["run", "dev-web"],
    },
    {
      name: "api",
      color: GREEN,
      requiredFile: "apps/api/main.py",
      command: "mise",
      args: ["run", "dev-api"],
    },
    {
      name: "bot",
      color: MAGENTA,
      requiredFile: "apps/bot/main.py",
      command: "mise",
      args: ["run", "dev-bot"],
    },
    {
      name: "infra",
      color: YELLOW,
      requiredFile: "docker/compose.yaml",
      command: "mise",
      args: ["run", "dev-infra"],
    },
  ];
}

function killChild(serviceName, child, signal) {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }

    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      printSystem(`${RED}failed to stop ${serviceName}: ${error.message}${RESET}`);
    }
  }
}

function stopAll(reason, exitCode = 0) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  finalExitCode = exitCode;

  printSystem(`${YELLOW}stopping services: ${reason}${RESET}`);

  for (const [serviceName, child] of children.entries()) {
    killChild(serviceName, child, "SIGTERM");
  }

  setTimeout(() => {
    for (const [serviceName, child] of children.entries()) {
      killChild(serviceName, child, "SIGKILL");
    }

    process.exit(finalExitCode);
  }, 4000).unref();
}

function startService(service) {
  const commandText = [service.command, ...service.args].join(" ");

  printSystem(`${service.color}starting ${service.name}${RESET} ${DIM}${commandText}${RESET}`);

  const child = spawn(service.command, service.args, {
    cwd: rootDir,
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  children.set(service.name, child);

  const stdout = createLineReader(service);
  const stderr = createLineReader(service);

  child.stdout.on("data", stdout.push);
  child.stderr.on("data", stderr.push);

  child.on("error", (error) => {
    stdout.flush();
    stderr.flush();
    children.delete(service.name);

    printSystem(`${RED}${service.name} failed to start: ${error.message}${RESET}`);
    stopAll(`${service.name} failed to start`, 1);
  });

  child.on("exit", (code, signal) => {
    stdout.flush();
    stderr.flush();
    children.delete(service.name);

    if (isShuttingDown) {
      if (children.size === 0) {
        process.exit(finalExitCode);
      }

      return;
    }

    if (signal) {
      printSystem(`${YELLOW}${service.name} exited by signal ${signal}${RESET}`);
      stopAll(`${service.name} exited`, 1);
      return;
    }

    if (code && code !== 0) {
      printSystem(`${RED}${service.name} exited with code ${code}${RESET}`);
      stopAll(`${service.name} failed`, code);
      return;
    }

    printSystem(`${YELLOW}${service.name} exited${RESET}`);

    if (children.size === 0) {
      process.exit(0);
    }
  });
}

function main() {
  const services = buildServices();
  const runnableServices = [];

  for (const service of services) {
    if (!selectedByEnv(service.name)) {
      printSystem(`${GRAY}skip ${service.name}: disabled by env${RESET}`);
      continue;
    }

    if (!hasFile(service.requiredFile)) {
      printSystem(
        `${GRAY}skip ${service.name}: missing ${relative(rootDir, abs(service.requiredFile))}${RESET}`,
      );
      continue;
    }

    runnableServices.push(service);
  }

  if (runnableServices.length === 0) {
    printSystem(`${RED}no services to run${RESET}`);
    process.exit(1);
  }

  for (const service of runnableServices) {
    startService(service);
  }
}

process.on("SIGINT", () => {
  stopAll("SIGINT", 0);
});

process.on("SIGTERM", () => {
  stopAll("SIGTERM", 0);
});

process.on("uncaughtException", (error) => {
  printSystem(`${RED}uncaught exception: ${error.stack ?? error.message}${RESET}`);
  stopAll("uncaught exception", 1);
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);

  printSystem(`${RED}unhandled rejection: ${message}${RESET}`);
  stopAll("unhandled rejection", 1);
});

main();
