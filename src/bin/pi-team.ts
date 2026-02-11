#!/usr/bin/env node

import { runCli } from "../cli/run.js";

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.exitCode);
}

void main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
