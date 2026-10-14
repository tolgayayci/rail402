/**
 * The deployment tables of the settlement contract's reference page, rendered from its deployment
 * record so the page can never disagree with it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/** The `upto` settlement contract's testnet deployment record. */
export const UPTO_DEPLOYMENT_RECORD = "contracts/stellar/deployments/testnet.json";

const transaction = z.object({ tx: z.string().regex(/^[0-9a-f]{64}$/), ledger: z.number().int().positive() });

const deploymentRecord = z.object({
  caip2: z.string().min(1),
  contract_id: z.string().regex(/^C[A-Z2-7]{55}$/),
  wasm_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  wasm_size: z.number().int().positive(),
  source: z.string().min(1),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bldimg: z.string().min(1),
  bldopt: z.array(z.string()),
  /** The stellar-cli version that built the WASM (records before it was kept: the deploying CLI). */
  build_cli: z.string().min(1).optional(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  deployer: z.string().regex(/^G[A-Z2-7]{55}$/),
  salt: z.string().regex(/^[0-9a-f]{64}$/),
  salt_preimage: z.string().min(1),
  stellar_cli: z.string().min(1),
  transactions: z.object({
    upload: transaction,
    deploy: transaction,
    extend_instance: transaction,
    extend_code: transaction,
  }),
  live_until_ledger: z.object({ instance: z.number().int(), code: z.number().int() }),
  /** Earlier deployments this one replaced, newest first, each with an optional note on how it was built. */
  previous: z
    .array(
      z.object({
        contract_id: z.string().regex(/^C[A-Z2-7]{55}$/),
        wasm_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        salt_preimage: z.string().min(1),
        deploy: transaction,
        note: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

export type DeploymentRecord = z.infer<typeof deploymentRecord>;

/** Reads and checks the deployment record. */
export function loadDeploymentRecord(root: string, path = UPTO_DEPLOYMENT_RECORD): DeploymentRecord {
  return deploymentRecord.parse(JSON.parse(readFileSync(join(root, path), "utf8")));
}

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

const code = (value: string | number): string => `\`${String(value)}\``;

/** The network, address and code hash of the deployment, with a link to it in an explorer. */
export function renderDeployments(record: DeploymentRecord): string {
  const network = record.caip2.replace(/^stellar:/, "");
  return [
    table(
      ["Network", "Contract", "WASM SHA-256"],
      [[code(record.caip2), code(record.contract_id), code(record.wasm_sha256)]],
    ),
    `[View it on stellar.expert](https://stellar.expert/explorer/${network}/contract/${record.contract_id}).`,
  ].join("\n\n");
}

/** Every provenance field of the deployment record. */
export function renderDeploymentRecord(record: DeploymentRecord): string {
  const tx = (entry: { tx: string; ledger: number }) => `${code(entry.tx)} (ledger ${entry.ledger})`;
  const { transactions: txs, live_until_ledger: liveUntil } = record;
  return table(
    ["Field", "Value"],
    [
      ["Source revision", `${code(record.commit)} (${code(record.source)})`],
      ["Source archive SHA-256", code(record.source_sha256)],
      ["Build image", code(record.bldimg)],
      ["Build options", record.bldopt.map(code).join(" ")],
      ["Build CLI", `${code(`stellar`)} ${record.build_cli ?? record.stellar_cli}`],
      ["WASM size", `${record.wasm_size.toLocaleString("en-US")} bytes`],
      ["Deployer", code(record.deployer)],
      ["Salt", `${code(`sha256("${record.salt_preimage}")`)} = ${code(record.salt)}`],
      ["Upload", tx(txs.upload)],
      ["Deploy", tx(txs.deploy)],
      ["Instance TTL extension", `${tx(txs.extend_instance)}, live until ledger ${liveUntil.instance}`],
      ["Code TTL extension", `${tx(txs.extend_code)}, live until ledger ${liveUntil.code}`],
      ["Deployment CLI", `${code(`stellar`)} ${record.stellar_cli}`],
      ...(record.previous ?? []).map((entry) => [
        "Replaces",
        `${code(entry.contract_id)} (WASM ${code(entry.wasm_sha256)}, salt ${code(`sha256("${entry.salt_preimage}")`)}), ` +
          `deployed in ${tx(entry.deploy)} from source revision ${code(entry.commit)}` +
          (entry.note === undefined ? "" : `. ${entry.note}`),
      ]),
    ],
  );
}
