/**
 * Prepares a settle probe on the local private Stellar network: issues an asset, funds payers and a
 * recipient, writes them to a setup file and prints the settings the facilitator under test needs.
 *
 *   node --conditions=@rail402/source tools/loadtest/src/settle-setup.ts [--payers 20] \
 *     [--rpc http://localhost:8000/rpc] [--friendbot http://localhost:8000/friendbot] [--out <file>]
 *     [--sponsor-env <file>] [--code USDC]
 *
 * The setup file holds the secret keys of throwaway accounts on that private network; it is written
 * under the git-ignored results directory unless --out says otherwise. `--sponsor-env` also funds a fee
 * sponsor for the facilitator under test and writes `TESTNET_SPONSOR_SECRET` to that file (mode 600).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { LOCAL_FRIENDBOT_URL, LOCAL_RPC_URL, LocalNetwork } from "@rail402.dev/testkit";
import { assertLocalRpc, createSettleSetup, settleFacilitatorEnv } from "./settle.ts";

const { values: args } = parseArgs({
  options: {
    payers: { type: "string", default: "20" },
    rpc: { type: "string", default: LOCAL_RPC_URL },
    friendbot: { type: "string", default: LOCAL_FRIENDBOT_URL },
    out: { type: "string" },
    "sponsor-env": { type: "string" },
    code: { type: "string", default: "USDC" },
  },
});
assertLocalRpc(args.rpc);
const net = new LocalNetwork(args.rpc, args.friendbot);
if (!(await net.available())) {
  console.error(`no local Stellar network answers at ${args.rpc}`);
  process.exit(2);
}
const setup = await createSettleSetup(net, { payers: Number(args.payers), code: args.code });
const out = resolve(
  args.out ?? join(fileURLToPath(new URL("../results/", import.meta.url)), "settle-setup.json"),
);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(setup, null, 2)}\n`, { mode: 0o600 });
console.log(`settle setup: ${String(setup.payers.length)} payers of ${setup.asset}, written to ${out}`);
console.log("start the facilitator under test with:");
for (const [key, value] of Object.entries(settleFacilitatorEnv(setup))) console.log(`  ${key}=${value}`);
if (args["sponsor-env"] !== undefined) {
  const sponsor = Keypair.random();
  await net.fund(sponsor);
  const file = resolve(args["sponsor-env"]);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `TESTNET_SPONSOR_SECRET=${sponsor.secret()}\n`, { mode: 0o600 });
  console.log(`  TESTNET_SPONSOR_SECRET in ${file} (sponsor ${sponsor.publicKey()}, funded)`);
}
