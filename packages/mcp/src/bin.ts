#!/usr/bin/env node
// Hosted mode is dispatched before anything else loads. Its modules import only the SDK's discovery
// entry, so the public endpoint never loads key loading, the signing guard, a budget ledger or a
// payment flow (test/hosted-graph.test.ts checks the running process's module graph).
if (process.argv.slice(2).includes("--hosted")) {
  if (process.argv.length !== 3) {
    process.stderr.write(
      "rail402-mcp --hosted takes no other arguments; it is configured from the environment.\n",
    );
    process.exitCode = 64;
  } else {
    const { hostedMain } = await import("./hosted-main.ts");
    process.exitCode = await hostedMain();
  }
} else {
  const { main } = await import("./main.ts");
  process.exitCode = await main();
}
