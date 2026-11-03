/**
 * The alert catalog: every Prometheus alert for a Rail402 deployment, with its severity, the role that
 * owns it, what it means, the first step, who is called next, the recovery, whether a rollback applies
 * and the runbook procedure behind it. `alerts.yml` (Prometheus rules) and the
 * alert section of the operator runbook (`docs/runbook.mdx`) are rendered from this file:
 *
 *   node deploy/monitoring/alerts.ts            write deploy/monitoring/alerts.yml
 *   node deploy/monitoring/alerts.ts --check    exit 1 when alerts.yml is out of date
 *
 * Thresholds that depend on a deployment's own settings are in `THRESHOLDS`; copy the rendered file
 * and change them there, or keep this file as the source and re-render.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** page: someone acts now, day or night. ticket: handled in working hours. */
export type Severity = "page" | "ticket" | "heartbeat";

/**
 * Roles, not people. Who fills each role is an operator setting: the deployment's role sheet
 * (`deploy/monitoring/roles.example.yml`, copied next to the deployment's private settings) maps each
 * role to names and contacts, and the paging service routes on the `owner` label.
 */
export const ROLES = [
  "primary on-call",
  "secondary on-call",
  "release approver",
  "key custodian",
  "security contact",
] as const;
export type Role = (typeof ROLES)[number];

/**
 * Whether undoing a change is part of the response: `release`, roll back to the previous release when
 * the alert started with a deploy; `configuration`, revert the setting changed before it; `none`, no
 * change of this deployment causes it (chain, provider, load or host state), so there is nothing to roll
 * back.
 */
/**
 * The recovery procedures alerts link to, by link and heading text: sections of the runbook (`#…`) and
 * of the operations guide (`/operations#…`).
 */
export const PROCEDURES = {
  "#replica-or-network-outage": "Replica or network outage",
  "#rpc-failure": "RPC failure",
  "#sequence-conflicts": "Sequence conflicts",
  "#channel-pool-exhaustion": "Channel-pool exhaustion",
  "#sponsor-depletion": "Sponsor depletion",
  "#degraded-indexing": "Degraded indexing",
  "#disk-space": "Disk space",
  "#rollback": "Rollback",
  "#monitoring": "Monitoring",
  "/operations#state-backups-and-recovery": "State, backups and recovery",
  "/operations#backups": "Backups",
  "/operations#contract-ttls": "Contract TTLs",
  "/operations#the-upto-settlement-contract": "The `upto` settlement contract",
  "/operations#serving-per-network": "Serving per network",
  "/operations#access-and-metering": "Access and metering",
} as const;
export type Procedure = keyof typeof PROCEDURES;

export const ROLLBACKS = ["release", "configuration", "none"] as const;
export type Rollback = (typeof ROLLBACKS)[number];

export interface Alert {
  readonly name: string;
  readonly expr: string;
  /** How long the condition must hold, as a Prometheus duration; "0s" fires at once. */
  readonly for: string;
  readonly severity: Severity;
  readonly owner: Role;
  readonly summary: string;
  /** What is wrong, for the runbook. */
  readonly meaning: string;
  readonly firstStep: string;
  /** Who is called when the owner cannot resolve it within the time given. */
  readonly escalation: string;
  readonly recovery: string;
  /**
   * The recovery procedure: a heading of the runbook (`#anchor`) or of another documentation page
   * (`/page#anchor`).
   */
  readonly procedure: Procedure;
  readonly rollback: Rollback;
  /**
   * Set while the series the alert reads is specified but not exported by every Rail402 version
   * yet: the interface that defines it. An alert over a missing series never fires.
   */
  readonly pending?: string;
  /**
   * Where the series comes from: the service's own metrics (default); the host collector,
   * node_exporter with the textfile that `deploy/postgres/backup-metrics.sh` writes; the Explorer's
   * indexers and web role; or the hosted MCP endpoint.
   */
  readonly scope?: "service" | "host" | "explorer" | "mcp";
  /**
   * The failure the alert reports, when one page covers it: a page with a cause silences the tickets
   * of the same cause on the same network (Alertmanager's inhibition, `alertmanager.yml`), because
   * those tickets are consequences of what the page already reports. An alert without a cause is
   * never silenced, so an unrelated page can never hide an independent failure. Only alerts whose
   * series carry a `network` label may have one.
   */
  readonly cause?: Cause;
  /**
   * The severity and owner of the alert's `stellar:testnet` series, when they differ from the other
   * networks' (testnet XLM has no value). Rendered as label templates on the `network` label.
   */
  readonly onTestnet?: { readonly severity: Severity; readonly owner: Role };
}

/**
 * Causes that one page covers: `channels`, every channel busy (Rail402ChannelsExhausted) and
 * settlements timing out for a channel; `rpc`, the network's RPC stale (Rail402RpcStale) and the
 * failover away from it.
 */
export const CAUSES = ["channels", "rpc"] as const;
export type Cause = (typeof CAUSES)[number];

/** Deployment-specific values. Stroops: 1 XLM = 10,000,000 stroops. */
export const THRESHOLDS = {
  /**
   * The sponsor alert fires below each network's readiness floor, which the service exports from
   * `<NET>_MIN_SPONSOR_BALANCE_XLM`, and, on every network but testnet, below this balance whatever the
   * floor: a pubnet sponsor pages the key custodian below 100 XLM even with a low or missing floor.
   */
  sponsorBalancePageStroops: 1_000_000_000,
  /** Share of a network's hourly fee budget (`<NET>_MAX_SPONSOR_SPEND_XLM_PER_HOUR`) committed. */
  budgetUsedRatio: 0.8,
  wastedFeesPerHourStroops: 5_000_000,
  outboxBacklog: 500,
  /** Discovery requests refused with 503 in 10 minutes, per reason, before a ticket. */
  discoveryShedPer10m: 20,
  explorerLagLedgers: 720,
  /** A window in which the Explorer's walked-through ledger must move. */
  explorerStall: "1h",
  /** Facilitator replicas the deployment runs. */
  replicas: 2,
  /** The oldest WAL segment still waiting for the archive; the recovery point objective is 1 hour. */
  walPendingSeconds: 900,
  /** Daily backups, with room for a slow or delayed run. */
  backupMaxAgeSeconds: 30 * 3600,
  /** Hours archiving may run before the first backup must be listed. */
  firstBackupGraceHours: 6,
  /** Free share of a host filesystem below which the host pages. */
  diskFreeRatio: 0.1,
} as const;

/** Host filesystems worth watching: not memory-backed or image layers. */
const DISKS = 'fstype!~"tmpfs|overlay|squashfs|ramfs"';

export const RUNBOOK_URL = "https://docs.rail402.dev/runbook";

export function anchor(name: string): string {
  return name.toLowerCase();
}

export const ALERTS: readonly Alert[] = [
  {
    name: "Rail402Down",
    expr: 'up{job="rail402"} == 0',
    for: "2m",
    severity: "page",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "release",
    summary: "A Rail402 replica does not answer its metrics scrape.",
    meaning: "Prometheus cannot reach a replica: the process is down, restarting or wedged.",
    firstStep:
      "Check the replica's container state and its last log lines; check whether the other replica still serves (`/ready` answers 200).",
    escalation: "Secondary on-call after 15 minutes, or at once if both replicas are down.",
    recovery:
      "Restart the replica. If it fails its startup checks, read the coded line it printed (`rail402: <code>: …`) and fix that setting; roll back to the previous release if the failure came with a deploy.",
  },
  {
    name: "Rail402NoReplica",
    expr: 'absent(up{job="rail402"} == 1)',
    for: "2m",
    severity: "page",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "release",
    summary: "No Rail402 replica answers its metrics scrape.",
    meaning:
      "Prometheus finds no replica that answers: every replica is down, or none is registered under the service name at all (a stopped container leaves no target behind, so Rail402Down cannot fire for it).",
    firstStep: "Check the containers' state and whether the proxy still finds a ready replica.",
    escalation: "Secondary on-call at once.",
    recovery: "Start the replicas; if they fail their startup checks, fix the coded setting they print.",
  },
  {
    name: "Rail402ReplicaMissing",
    expr: `count(up{job="rail402"} == 1) < ${String(THRESHOLDS.replicas)}`,
    for: "10m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "release",
    summary: "Fewer replicas answer than the deployment runs.",
    meaning:
      "One replica has been gone or down for 10 minutes: the service still answers, but a restart or a deploy would now take it down.",
    firstStep: "Find the missing replica's container and its last log lines.",
    escalation: "Secondary on-call if it is not back within a working day.",
    recovery: "Restart the replica; a deploy restarts the replicas one at a time only when both are ready.",
  },
  {
    name: "Rail402NotReady",
    expr: 'probe_success{job="rail402-ready"} == 0',
    for: "5m",
    severity: "page",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "release",
    summary: "A replica's /ready has failed for 5 minutes.",
    meaning:
      "The process runs but one of its process-level readiness checks fails: database, search index, access keys, or a network that gates readiness (on a one-network deployment, that network's RPC, sponsor balance and channels).",
    firstStep:
      "Read `/ready` and `/health` on the replica: the failing check and the warning code name the cause.",
    escalation: "Secondary on-call after 15 minutes.",
    recovery:
      "Fix the named dependency (see the alert for that condition below); the replica returns to rotation on its own once `/ready` answers 200.",
  },
  {
    name: "Rail402SupportedBroken",
    expr: 'probe_success{job="rail402-supported"} == 0',
    for: "5m",
    severity: "page",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "release",
    summary: "/supported does not advertise sponsored fees.",
    meaning:
      'The probe of `/supported` failed or its body lacks `"areFeesSponsored":true`: clients cannot discover the facilitator\'s payment kinds. Reachability from outside is measured by the external status page.',
    firstStep: "Fetch `/supported` from a replica and compare it with the last release's answer.",
    escalation: "Secondary on-call after 15 minutes.",
    recovery:
      "Roll back the release that changed it, or fix the network configuration that removed the kinds.",
  },
  {
    name: "Rail402NetworkNotReady",
    expr: 'probe_success{job=~"rail402-ready-(testnet|pubnet)"} == 0 and on (network) count by (network) (rail402_network_serving)',
    for: "5m",
    severity: "page",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "configuration",
    summary: "A network's /ready/<network> has failed for 5 minutes.",
    meaning:
      "One network's checks fail (RPC, sponsor balance, assets, channels) while the process may still be ready: with two networks in one process, neither network gates the process-level /ready, so this is the per-network outage signal. Probes of a network the service does not serve are ignored.",
    firstStep: "Read `/ready/<network>` and `/health/private`: the failing check names the cause.",
    escalation: "Secondary on-call after 15 minutes; the key custodian when the check is the sponsor.",
    recovery:
      "Fix the named dependency (RPC failure, sponsor depletion); the network is ready again on the next poll without a restart.",
  },
  {
    name: "Rail402NetworkHeld",
    expr: "rail402_network_serving == 0",
    for: "5m",
    severity: "page",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "configuration",
    summary: "A network has not been serving payments for 5 minutes.",
    meaning:
      "One network is held (or still starting): its /verify and /settle answer 503 while the other network keeps serving. The hold reason names the failed chain check.",
    firstStep: "Read `holdReason` for the network in `/health/private` or `/ready/<network>`.",
    escalation:
      "Secondary on-call after 15 minutes; the key custodian when the reason is the sponsor account.",
    recovery:
      "Fix the cause (RPC, sponsor funding, asset or channel accounts). The network returns to serving on the next poll without a restart, except for a contract or asset contradiction, which needs a configuration change and a restart.",
  },
  {
    name: "Rail402SponsorBalanceLow",
    expr: `rail402_sponsor_balance_stroops < rail402_sponsor_balance_floor_stroops or rail402_sponsor_balance_stroops{network!="stellar:testnet"} < ${String(THRESHOLDS.sponsorBalancePageStroops)}`,
    for: "5m",
    severity: "page",
    owner: "key custodian",
    procedure: "#sponsor-depletion",
    rollback: "none",
    onTestnet: { severity: "ticket", owner: "primary on-call" },
    summary:
      "A network's fee sponsor balance is below its readiness floor, or a pubnet sponsor below 100 XLM.",
    meaning:
      "The sponsor pays every settlement fee and the reserves of channels and the settlement authority. Each network is watched against its own floor (`<NET>_MIN_SPONSOR_BALANCE_XLM`, exported as `rail402_sponsor_balance_floor_stroops`): below it the network's readiness fails; below `<NET>_SPONSOR_RESERVE_XLM` settlements are refused. Every network but testnet also pages below 100 XLM whatever its floor, and pubnet refuses a floor below 1 XLM at startup, so a low or missing floor never switches the page off. Testnet XLM has no value, so a testnet sponsor raises a ticket for the primary on-call; every other network pages the key custodian.",
    firstStep:
      "Read the `network` label, then check the spend rate (`rail402_sponsor_fees_committed_stroops`) to see whether this is normal use or a drain.",
    escalation:
      "Primary on-call if the custodian does not answer within 30 minutes; for testnet, secondary on-call if readiness fails.",
    recovery:
      "Top up the sponsor from the treasury account with a reviewed payment to the recorded sponsor address (testnet: Friendbot or another testnet account). If the spend rate is abnormal, find the caller first (sponsor depletion procedure).",
  },
  {
    name: "Rail402SponsorBudgetNearlySpent",
    expr: `rail402_sponsor_budget_used_ratio > ${String(THRESHOLDS.budgetUsedRatio)}`,
    for: "5m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#sponsor-depletion",
    rollback: "none",
    summary: "More than 80% of a network's hourly sponsor budget is committed.",
    meaning:
      "Fees committed in the last hour approach the network's `<NET>_MAX_SPONSOR_SPEND_XLM_PER_HOUR` (the service exports the share, so the threshold follows each network's own budget); at 100% settlements are refused.",
    firstStep:
      "Compare settlements per caller and per payer over the last hour; look for one caller or dust payments.",
    escalation: "Secondary on-call if the guard starts refusing (Rail402SponsorGuardRefusing).",
    recovery:
      "Throttle or revoke the abusive caller; raise the budget only after deciding the traffic is legitimate.",
  },
  {
    name: "Rail402SponsorGuardRefusing",
    expr: "increase(rail402_sponsor_guard_refusals_total[10m]) > 0",
    for: "0s",
    severity: "page",
    owner: "primary on-call",
    procedure: "#sponsor-depletion",
    rollback: "none",
    summary: "The sponsor guard refused settlements.",
    meaning:
      "Settlements were refused because the sponsor is below its reserve or the hourly budget is spent. Sellers see a retryable refusal.",
    firstStep: "Read the `reason` label: reserve (fund the sponsor) or budget (find the spend).",
    escalation: "Key custodian for a reserve refusal.",
    recovery: "Top up, or wait for the hour to roll over after stopping the abusive caller.",
  },
  {
    name: "Rail402WastedFees",
    expr: `increase(rail402_sponsor_fees_stroops_total{outcome="wasted"}[1h]) > ${THRESHOLDS.wastedFeesPerHourStroops}`,
    for: "0s",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#sponsor-depletion",
    rollback: "configuration",
    summary: "Settlements that failed on chain cost more than the hourly allowance.",
    meaning:
      "The sponsor paid fees for settlements that failed at inclusion (payer drained between simulation and inclusion, smart accounts failing at apply).",
    firstStep: "Group failed settlements by payer in the logs and `rail402_settlements_finalized_total`.",
    escalation: "Secondary on-call if one payer causes most of them.",
    recovery: "Rate-limit or block the payer; check that fee ceilings fit the payers served.",
  },
  {
    name: "Rail402ChannelsExhausted",
    expr: "rail402_channels_total > 0 and rail402_channels_in_use >= rail402_channels_total",
    for: "5m",
    severity: "page",
    cause: "channels",
    owner: "primary on-call",
    procedure: "#channel-pool-exhaustion",
    rollback: "none",
    summary: "Every channel account has been busy for 5 minutes.",
    meaning: "All channel accounts are leased; new settlements wait and then fail with a retryable refusal.",
    firstStep: "Check settlement latency and RPC health: slow confirmation holds channels longer.",
    escalation: "Secondary on-call after 30 minutes.",
    recovery:
      "Fix a slow RPC first. For sustained load, raise `CHANNEL_COUNT` and provision the new channels (`channels provision`).",
  },
  {
    name: "Rail402ChannelLeaseTimeouts",
    expr: "increase(rail402_channel_lease_timeouts_total[10m]) > 0",
    for: "0s",
    severity: "ticket",
    cause: "channels",
    owner: "primary on-call",
    procedure: "#channel-pool-exhaustion",
    rollback: "none",
    summary: "Settlements timed out waiting for a channel.",
    meaning: "A settlement waited longer than its lease timeout for a free channel account.",
    firstStep: "Look at `rail402_channels_in_use` and the settlement duration histogram.",
    escalation: "Secondary on-call if it repeats for an hour.",
    recovery: "As for Rail402ChannelsExhausted.",
  },
  {
    name: "Rail402SequenceConflict",
    expr: 'increase(rail402_sequence_conflicts_total{kind="bad_seq"}[10m]) > 0',
    for: "0s",
    severity: "page",
    owner: "primary on-call",
    procedure: "#sequence-conflicts",
    rollback: "none",
    summary: "A channel account's sequence number was used outside Rail402.",
    meaning:
      "A transaction from a channel account was refused with txBadSeq: something else submitted from the account, or two deployments share one sponsor seed. Once the channel's sequence number on the network has reached the settlement's and neither its hash nor its inner hash landed, the settlement gives its channel back at once, and the channel is quarantined: out of rotation for `SETTLE_CHANNEL_QUARANTINE_MS` (60 s), doubled for each further conflict in a row up to 16 times. An `upto` settlement finishes then as `settle_upto_stellar_transaction_submission_failed` (no funds moved, nothing charged; the payer signs a new payment). An `exact` one waits for the payer's authorization, which anyone holding the payment can carry until it expires: it is answered as settled when a copy landed, and as `settle_exact_stellar_transaction_submission_failed` once the authorization expired unused. When the quarantine ends, the next lease compares the account's sequence number with the one seen at the conflict; if it moved, someone still uses the account and the channel is quarantined again for twice as long (log line `the quarantined channel's sequence number moved again`). This holds whether the conflict first showed as `TRY_AGAIN_LATER` (the other transaction held the channel's queue slot) or as `txBadSeq`: every send's answer is recorded on the settlement, so any replica or the reconciler can tell whether the network ever accepted the bytes. The log line `sequence conflict not finished early` names why a settlement waits.",
    firstStep:
      "Check that no other deployment or tool uses the same sponsor seed; list the channel's recent transactions. The log line `another transaction took the channel's sequence number` names the channel; `rail402_sequence_conflict_outcomes_total` and the log line `sequence conflict not finished early` (once per settlement and replica) say why a settlement keeps waiting.",
    escalation:
      "Key custodian and security contact at once if an unknown party used the account: treat it as a key compromise.",
    recovery:
      "Stop the other user of the seed. If the seed may be compromised, rotate it (signer rotation procedure). A quarantined channel returns to rotation by itself; the next settlement on it reads its current sequence number.",
  },
  {
    name: "Rail402SettlementsUnresolvable",
    expr: "rail402_settlements_unresolvable > 0",
    for: "0s",
    severity: "page",
    owner: "primary on-call",
    procedure: "/operations#state-backups-and-recovery",
    rollback: "none",
    summary: "A recorded settlement can no longer be proven landed or not.",
    meaning:
      "The RPC's retained history no longer covers a settlement whose outcome is unknown, or the reads that would decide one keep coming from an RPC behind the ledger they must cover (or keep failing); Rail402 will not guess and keeps it unresolved.",
    firstStep:
      "Look for the log line `settlement undecided` and compare the RPC providers' latest ledgers; otherwise look up the recorded transaction hashes in a full-history source (an explorer or Horizon).",
    escalation: "Secondary on-call; the seller may need to be told the outcome by hand.",
    recovery:
      "Record the outcome from the full-history source as described in the unresolvable settlements procedure.",
  },
  {
    name: "Rail402SettlementFailureRate",
    expr: 'sum by (network) (rate(rail402_settlements_total{outcome="failure"}[10m])) > 0.2 * sum by (network) (rate(rail402_settlements_total[10m])) and sum by (network) (rate(rail402_settlements_total[10m])) > 0.01',
    for: "10m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#rollback",
    rollback: "release",
    summary: "More than 20% of settlements fail.",
    meaning: "A fifth of settlement requests on a network end in a refusal or failure.",
    firstStep:
      "Break failures down by `reason`; most reasons point at the payer or seller, a few at the service.",
    escalation: "Secondary on-call if the reason is a service-side code.",
    recovery: "Fix the service-side cause, or contact the seller whose requests fail.",
  },
  {
    name: "Rail402RpcStale",
    expr: "rail402_rpc_ledger_age_seconds > 60",
    for: "2m",
    severity: "page",
    cause: "rpc",
    owner: "primary on-call",
    procedure: "#rpc-failure",
    rollback: "configuration",
    summary: "The RPC's latest ledger is more than a minute old.",
    meaning:
      "The RPC provider is down, stuck or far behind; verification and settlement cannot work on that network. The age is computed at every scrape from the last ledger read, so it keeps growing while polls fail, and on a replica that never read a ledger it counts from when the replica started watching the network: such a replica is reported 3 minutes after start.",
    firstStep: "Compare with a public status source for the network and with another provider.",
    escalation: "Secondary on-call after 15 minutes.",
    recovery:
      "Wait for failover to another provider when configured, or switch the network's RPC setting and restart one replica at a time.",
  },
  {
    name: "Rail402RpcTransportErrors",
    expr: "increase(rail402_rpc_transport_errors_total[10m]) > 10",
    for: "0s",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#rpc-failure",
    rollback: "configuration",
    summary: "RPC or Horizon requests fail at the transport level.",
    meaning: "Connections to a watched RPC or Horizon target fail, time out or get 5xx/429 answers.",
    firstStep: "Read the `target` and `kind` labels; 429 means a quota.",
    escalation: "Secondary on-call if it persists for an hour.",
    recovery: "Reduce load on the provider, raise its quota, or add a second provider.",
  },
  {
    name: "Rail402RpcFailover",
    expr: "increase(rail402_rpc_failovers_total[15m]) > 0",
    for: "0s",
    severity: "ticket",
    cause: "rpc",
    owner: "primary on-call",
    procedure: "#rpc-failure",
    rollback: "none",
    summary: "A network failed over to another RPC provider.",
    meaning: "The active provider was unhealthy or stale for two polls and the next one took over.",
    firstStep: "Check the failed provider's status; `/health` names the active provider alias.",
    escalation: "None while the fallback serves; Rail402RpcStale pages if it fails too.",
    recovery: "Fail-back is automatic after five healthy polls of the higher-priority provider.",
  },
  {
    name: "Rail402ContractTtlLow",
    expr: "rail402_contract_ttl_ledgers < 120960",
    for: "15m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "/operations#contract-ttls",
    rollback: "none",
    summary: "A watched contract entry expires in less than about 7 days.",
    meaning: "The upto contract or a watched token's instance or code entry approaches archival.",
    firstStep: "Check whether the TTL keeper is enabled and whether it failed (Rail402TtlKeeperFailed).",
    escalation: "Secondary on-call below 2 days.",
    recovery: "Run `upto ttl extend` for the network, or extend the token entry.",
  },
  {
    name: "Rail402UptoAuthorityFunded",
    expr: "rail402_upto_authority_balance_stroops > 0",
    for: "15m",
    severity: "ticket",
    owner: "key custodian",
    procedure: "/operations#the-upto-settlement-contract",
    rollback: "none",
    summary: "The settlement authority holds XLM.",
    meaning:
      "The upto settlement authority is meant to hold a zero balance; funds there are not needed and are at risk.",
    firstStep: "Find who sent XLM to the authority account.",
    escalation: "Primary on-call; the security contact if no one on the team sent the funds.",
    recovery: "Move the balance back to the treasury.",
  },
  {
    name: "Rail402TtlKeeperFailed",
    expr: 'increase(rail402_upto_ttl_keeper_actions_total{outcome="failed"}[1h]) > 0',
    for: "0s",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "/operations#contract-ttls",
    rollback: "none",
    summary: "The contract TTL keeper failed an extension or restore.",
    meaning: "An automatic TTL extension of the upto contract failed.",
    firstStep:
      "Read the keeper's log line; check the sponsor balance and the fee ceiling for TTL operations.",
    escalation: "Secondary on-call if the TTL falls below 2 days.",
    recovery: "Run `upto ttl extend` by hand once the cause is fixed.",
  },
  {
    name: "Rail402SearchIndexBuildFailed",
    expr: 'increase(rail402_search_index_builds_total{outcome!="ok"}[1h]) > 0',
    for: "0s",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#degraded-indexing",
    rollback: "release",
    summary: "A search index build failed or fell back.",
    meaning:
      "The Bazaar search index could not be rebuilt; search serves the previous index or lexical results.",
    firstStep: "Read the `outcome` label and the search warning in `/health`.",
    escalation: "Secondary on-call if search stays degraded for a day.",
    recovery: "Fix the embedding model files or memory limits and restart one replica at a time.",
  },
  {
    name: "Rail402DiscoveryShedding",
    expr: `sum without (route) (increase(rail402_discovery_shed_total[10m])) > ${String(THRESHOLDS.discoveryShedPer10m)}`,
    for: "5m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "/operations#serving-per-network",
    rollback: "configuration",
    summary: "Discovery keeps refusing requests with 503 under load.",
    meaning:
      "Discovery sheds load so searches cannot starve settlement and health checks: requests beyond `DISCOVERY_MAX_IN_FLIGHT` running and `DISCOVERY_QUEUE_LENGTH` waiting (`reason=admission`), or that got no discovery database connection or hit its statement timeout (`database_busy`), are refused with 503 `discovery_overloaded` and `Retry-After`; with the catalog database unreachable (`database_unavailable`), with 503 `discovery_catalog_unavailable`. Settlement is not affected; buyers and agents see failed searches.",
    firstStep:
      "Read the `reason` label. For `admission`, compare `rail402_discovery_in_flight` and `rail402_discovery_queued` with the limits and look for one client in the access log; for the database reasons, check the catalog database's load and connections.",
    escalation: "Secondary on-call if it lasts an hour or the reason is `database_unavailable`.",
    recovery:
      "Throttle or block an abusive client (`RATE_LIMIT_PER_MINUTE`, access keys); for legitimate traffic raise the discovery limits or the discovery pool together with the database's capacity. Refusals stop by themselves once the load falls.",
  },
  {
    name: "Rail402CatalogOutboxBacklog",
    expr: `rail402_catalog_outbox_pending > ${THRESHOLDS.outboxBacklog}`,
    for: "30m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#degraded-indexing",
    rollback: "release",
    summary: "Settled payments are waiting to be cataloged.",
    meaning: "The catalog outbox grows: cataloging or origin checks are failing or slower than settlements.",
    firstStep: 'Check `rail402_background_errors_total{task="catalog_queue"}` and origin-check outcomes.',
    escalation: "Secondary on-call if the backlog keeps growing for a day.",
    recovery: "Fix the failing task; the outbox drains by itself and nothing is lost.",
  },
  {
    name: "Rail402BackgroundErrors",
    expr: "increase(rail402_background_errors_total[15m]) > 5",
    for: "0s",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "release",
    summary: "A background task keeps failing.",
    meaning: "Origin checks, cataloging, listing facts, the search index or the TTL keeper raised errors.",
    firstStep: "Read the `task` label and that task's log lines.",
    escalation: "Secondary on-call if it continues for a day.",
    recovery: "Fix the task's dependency; background tasks retry on their own.",
  },
  {
    name: "Rail402AccessKeysReloadFailed",
    expr: "increase(rail402_access_keys_reload_failures_total[15m]) > 0",
    for: "0s",
    severity: "page",
    owner: "primary on-call",
    procedure: "/operations#access-and-metering",
    rollback: "configuration",
    summary: "The access-key file could not be reloaded.",
    meaning:
      "A changed access-key file was refused; the service keeps the last good set, so a revocation may not be in force.",
    firstStep:
      "Validate the key file with the configuration check; read the reload error in `/health/private`.",
    escalation:
      "Key custodian if a revocation is waiting on the reload; the security contact if the key being revoked leaked.",
    recovery: "Fix the file; the next reload applies it.",
  },
  {
    name: "Rail402ExplorerLag",
    expr: `rail402_explorer_lag_ledgers > ${String(THRESHOLDS.explorerLagLedgers)} or changes(rail402_explorer_last_ledger[${THRESHOLDS.explorerStall}]) == 0 or on (instance) (up{job="rail402-explorer-indexer"} == 1 unless on (instance) rail402_explorer_last_ledger)`,
    for: "15m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#degraded-indexing",
    rollback: "release",
    summary: "The Explorer indexer is more than about an hour behind the network, or not progressing.",
    meaning:
      "The ledger every discovery route has walked trails the discovery source's head, has not moved for an hour, or is not exported at all by an indexer that answers its scrape (a series that is missing never crosses a threshold); new payments do not appear in the Explorer yet. A stopped indexer is reported by Rail402ExplorerIndexerDown instead, not twice.",
    firstStep:
      "Check the indexer's log and `rail402_explorer_lumeus_errors_total` for discovery (Lumeus) or ledger source failures; a missing or frozen `rail402_explorer_last_ledger` means discovery has not completed a pass since the indexer started.",
    escalation: "Secondary on-call if the lag approaches the RPC's retention window.",
    recovery:
      "Restore discovery or the ledger source; the indexer resumes from every route's checkpoint by itself, and older ledgers come from the data lake.",
    scope: "explorer",
  },
  {
    name: "Rail402ExplorerIndexerDown",
    expr: 'up{job="rail402-explorer-indexer"} == 0',
    for: "5m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#degraded-indexing",
    rollback: "release",
    summary: "An Explorer indexer does not answer its metrics scrape.",
    meaning:
      "The indexer stopped: it exits on an integrity fault (`ledger_mismatch`, `anchor_mismatch`, `events_unbound`), a refused discovery key or request, or a configuration error, and the Explorer and the ecosystem report go stale for its network.",
    firstStep:
      "Read the indexer's last log lines for the code it stopped with; do not restart it in a loop over an integrity fault.",
    escalation: "Secondary on-call if the indexer stays down for a working day.",
    recovery:
      "Fix the cause (Lumeus key, ledger source, anchor Horizon, database); after an integrity fault, rebuild the affected range from the data lake before restarting. After a `heap out of memory` crash, lower `EXPLORER_BYTES_IN_FLIGHT_MIB` (the raw ledger bytes it holds, `rail402_explorer_ledger_bytes_in_flight`) or give the process more memory.",
    scope: "explorer",
  },
  {
    name: "Rail402ExplorerIndexerFailures",
    expr: "increase(rail402_explorer_failures_total[15m]) > 0 or increase(rail402_explorer_chain_breaks_total[15m]) > 0",
    for: "0s",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#degraded-indexing",
    rollback: "release",
    summary: "An Explorer indexer recorded indexing failures or a chain break.",
    meaning:
      "Discovery requests or ledgers failed, or a ledger's hash differed from its anchor or the ledger asked for; integrity failures stop the indexer.",
    firstStep: "Read the `code` label and the indexer's log lines around the failure.",
    escalation: "Secondary on-call if failures continue for a day.",
    recovery: "Fix discovery or the ledger source; the indexer retries transient failures by itself.",
    scope: "explorer",
  },
  {
    name: "Rail402ExplorerDiscoveryAnomaly",
    expr: "increase(rail402_explorer_candidates_capped_total[1h]) > 0 or increase(rail402_explorer_head_regressions_total[1h]) > 0 or increase(rail402_explorer_discovery_restarts_total[1h]) > 0",
    for: "0s",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#degraded-indexing",
    rollback: "release",
    summary:
      "Explorer discovery listed unusually many candidates, saw its source's head far behind, or restarted routes.",
    meaning:
      "A route listed more new candidate ledgers than one round reads (a very busy account, or a source listing ledgers it should not), the discovery source's head fell far behind the indexed candidates, or a new index generation or decoder made routes walk again from their first ledger. Nothing is counted wrongly: rows still come only from verified ledgers.",
    firstStep:
      "Read the `kind` label and the indexer's warnings; compare `rail402_explorer_candidates_unattributed_total` with the candidates found, and check the source's status page.",
    escalation:
      "Secondary on-call if mainnet Lumeus credit use climbs or the report's ledgersWithoutAttributedRow grows sharply.",
    recovery:
      "Nothing to do for a rebuilt index or a busy route; for a source listing invented ledgers, lower EXPLORER_MAX_CANDIDATES_PER_ROUND and raise it with the source.",
    scope: "explorer",
  },
  {
    name: "Rail402ExplorerWebDown",
    expr: 'up{job="rail402-explorer-web"} == 0',
    for: "5m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "release",
    summary: "The Explorer web role does not answer its metrics scrape.",
    meaning: "The public Explorer pages and read API are down.",
    firstStep: "Check the web container's health and log; check the reader role's database connection.",
    escalation: "Secondary on-call after a working day.",
    recovery: "Restart the web role once the cause is fixed; it holds no state.",
    scope: "explorer",
  },
  {
    name: "Rail402McpDown",
    expr: 'up{job="rail402-mcp"} == 0',
    for: "5m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "release",
    summary: "The hosted MCP endpoint does not answer its metrics scrape.",
    meaning: "Remote MCP clients cannot search the Bazaar through the hosted endpoint.",
    firstStep: "Check the endpoint's container health and log, and that the Bazaar answers it.",
    escalation: "Secondary on-call after a working day.",
    recovery: "Restart the endpoint once the cause is fixed; it holds no key and no state.",
    scope: "mcp",
  },
  {
    name: "Rail402McpUpstreamBudget",
    expr: 'increase(rail402_mcp_refusals_total{reason="upstream_budget"}[15m]) > 10',
    for: "15m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "#replica-or-network-outage",
    rollback: "configuration",
    summary: "The hosted MCP endpoint keeps refusing calls for lack of upstream budget.",
    meaning:
      "Calls are refused with `rpc_upstream_budget`: the endpoint's requests to the Bazaar per minute (`RAIL402_MCP_UPSTREAM_PER_MINUTE`) are used up, so remote users see 503s.",
    firstStep:
      "Compare `rail402_mcp_calls_total` by tool with the budget; look for one client driving the load (per-client refusals).",
    escalation: "Secondary on-call if it continues for a day.",
    recovery:
      "Raise the budget within the Bazaar's limit for the endpoint's discovery key, or lower the per-client rate.",
    scope: "mcp",
  },
  {
    name: "Rail402WalArchiveFailing",
    expr: "rail402_wal_last_failed_timestamp_seconds > rail402_wal_last_archived_timestamp_seconds",
    for: "5m",
    severity: "page",
    owner: "primary on-call",
    procedure: "/operations#backups",
    rollback: "configuration",
    summary: "Postgres cannot archive WAL to the backup repository.",
    meaning:
      "The last archive attempt failed after the last success: the backup repository is unreachable, full or refusing writes. Postgres keeps every unarchived WAL segment on its disk, so the disk fills, and the recovery point falls behind.",
    firstStep:
      "Read the Postgres log for the archive command's error, and run `pgbackrest check` in the database container.",
    escalation: "Secondary on-call after 30 minutes, or at once when the disk alert fires too.",
    recovery:
      "Restore access to the repository (credentials, network, quota); archiving resumes by itself and the queued segments drain. Never delete WAL by hand.",
    scope: "host",
  },
  {
    name: "Rail402WalArchiveBehind",
    expr: `rail402_wal_archive_oldest_pending_seconds > ${String(THRESHOLDS.walPendingSeconds)}`,
    for: "0s",
    severity: "page",
    owner: "primary on-call",
    procedure: "/operations#backups",
    rollback: "configuration",
    summary: "A WAL segment has waited more than 15 minutes for the archive.",
    meaning:
      "Segments are queued faster than they are archived, or the archive command stalls without failing: a restore could lose the writes since the oldest queued segment.",
    firstStep:
      "Check `rail402_wal_archive_pending_segments` and the archive command's latency in the Postgres log.",
    escalation: "Secondary on-call after 30 minutes.",
    recovery: "As for Rail402WalArchiveFailing; the queue drains once the repository keeps up.",
    scope: "host",
  },
  {
    name: "Rail402BackupStale",
    expr: `time() - max without (type) (rail402_backup_last_completed_timestamp_seconds) > ${String(THRESHOLDS.backupMaxAgeSeconds)} or absent(rail402_backup_last_completed_timestamp_seconds) and on() rail402_wal_archive_enabled == 1 and on() rail402_wal_archive_enabled offset ${String(THRESHOLDS.firstBackupGraceHours)}h == 1`,
    for: "0s",
    severity: "page",
    owner: "primary on-call",
    procedure: "/operations#backups",
    rollback: "none",
    summary: "The newest completed backup is more than 30 hours old, or none is listed.",
    meaning:
      "The daily backup did not complete, or WAL has been archived for 6 hours while the repository lists no completed backup (none was ever taken, or `pgbackrest info` cannot read the repository): a restore would need more WAL to replay, or would have no base backup to start from.",
    firstStep: "Read the backup timer's last run (its journal) and `pgbackrest info`.",
    escalation: "Secondary on-call after a working day.",
    recovery: "Fix the cause and run the backup by hand; the alert clears when it completes.",
    scope: "host",
  },
  {
    name: "Rail402BackupMetricsStale",
    expr: "time() - rail402_backup_metrics_collected_timestamp_seconds > 600 or absent(rail402_backup_metrics_collected_timestamp_seconds)",
    for: "5m",
    severity: "ticket",
    owner: "primary on-call",
    procedure: "/operations#backups",
    rollback: "none",
    summary: "The archive and backup metrics stopped updating.",
    meaning:
      "The collector that reads Postgres' archiver and pgBackRest's backups has not written its file for 10 minutes: the archive and backup alerts above cannot fire while it is stale.",
    firstStep: "Check the collector's timer and node_exporter's textfile directory.",
    escalation: "Secondary on-call if it stays stale for a day.",
    recovery: "Restart the collector; the alerts above work again on its next run.",
    scope: "host",
  },
  {
    name: "Rail402DiskAlmostFull",
    expr: `node_filesystem_avail_bytes{${DISKS}} / node_filesystem_size_bytes{${DISKS}} < ${String(THRESHOLDS.diskFreeRatio)}`,
    for: "5m",
    severity: "page",
    owner: "primary on-call",
    procedure: "#disk-space",
    rollback: "none",
    summary: "A host filesystem has less than 10% free space.",
    meaning:
      "When the database's filesystem fills, Postgres stops accepting writes and every settlement fails; other services on the same disk stop too.",
    firstStep:
      "Find what grows: Postgres' WAL (an archive failure), container logs, images, or backups kept on the host.",
    escalation: "Secondary on-call at once if the database's filesystem is the one filling.",
    recovery:
      "Fix the cause (archiving, log rotation), then free space with the owner of each item; never remove WAL or data files by hand.",
    scope: "host",
  },
  {
    name: "Rail402DiskFillingFast",
    expr: `predict_linear(node_filesystem_avail_bytes{${DISKS}}[6h], 4 * 3600) < 0`,
    for: "30m",
    severity: "page",
    owner: "primary on-call",
    procedure: "#disk-space",
    rollback: "none",
    summary: "A host filesystem will be full within 4 hours at its current rate.",
    meaning: "Free space has been falling fast enough for six hours to reach zero within four.",
    firstStep: "As for Rail402DiskAlmostFull.",
    escalation: "Secondary on-call after an hour.",
    recovery: "As for Rail402DiskAlmostFull.",
    scope: "host",
  },
  {
    name: "Watchdog",
    expr: "vector(1)",
    for: "0s",
    severity: "heartbeat",
    owner: "primary on-call",
    procedure: "#monitoring",
    rollback: "none",
    summary: "Always firing: proves the alerting pipeline works.",
    meaning:
      "Alertmanager sends this alert to an off-host dead-man's switch on a fixed schedule. When it stops arriving, the switch alerts the on-call: the host, Prometheus or Alertmanager is down.",
    firstStep: "When the dead-man's switch fires, check whether the host is reachable at all.",
    escalation: "Secondary on-call after 15 minutes.",
    recovery: "Restore the host or the monitoring services; the switch clears on the next heartbeat.",
  },
];

/** A YAML scalar, quoted the way the repository's formatter writes it: single quotes when that avoids escapes. */
function quote(value: string): string {
  return value.includes('"') && !value.includes("'") ? `'${value}'` : JSON.stringify(value);
}

/** A label template: `testnet` on the alert's `stellar:testnet` series, `other` on every other network's. */
function onTestnet(other: string, testnet: string): string {
  return `{{ if eq $labels.network "stellar:testnet" }}${testnet}{{ else }}${other}{{ end }}`;
}

function ruleLines(alert: Alert): string[] {
  return [
    `      - alert: ${alert.name}`,
    `        expr: ${quote(alert.expr)}`,
    `        for: ${alert.for}`,
    "        labels:",
    `          severity: ${alert.onTestnet === undefined ? alert.severity : quote(onTestnet(alert.severity, alert.onTestnet.severity))}`,
    `          owner: ${quote(alert.onTestnet === undefined ? alert.owner : onTestnet(alert.owner, alert.onTestnet.owner))}`,
    ...(alert.cause === undefined ? [] : [`          cause: ${alert.cause}`]),
    "        annotations:",
    `          summary: ${quote(alert.summary)}`,
    `          runbook_url: ${quote(`${RUNBOOK_URL}#${anchor(alert.name)}`)}`,
  ];
}

/** The Prometheus rule file. */
export function renderRules(alerts: readonly Alert[] = ALERTS): string {
  const service = alerts.filter((alert) => (alert.scope ?? "service") === "service");
  const live = service.filter((alert) => alert.pending === undefined);
  const pending = service.filter((alert) => alert.pending !== undefined);
  const apps = alerts.filter((alert) => alert.scope === "explorer" || alert.scope === "mcp");
  const host = alerts.filter((alert) => alert.scope === "host");
  return [
    "# Rendered from deploy/monitoring/alerts.ts by `node deploy/monitoring/alerts.ts`; edit that file.",
    "# Every alert carries a severity (page, ticket or heartbeat), an owner role and a runbook link.",
    "groups:",
    "  - name: rail402",
    "    rules:",
    ...live.flatMap(ruleLines),
    ...(pending.length === 0
      ? []
      : [
          "  # Alerts over series that newer Rail402 versions export; they never fire on a version without them.",
          "  - name: rail402-newer-series",
          "    rules:",
          ...pending.flatMap(ruleLines),
        ]),
    "  # The Explorer (indexers and web role) and the hosted MCP endpoint.",
    "  - name: rail402-apps",
    "    rules:",
    ...apps.flatMap(ruleLines),
    "  # The database host: WAL archiving and backups (deploy/postgres/backup-metrics.sh through",
    "  # node_exporter's textfile collector) and free disk space (node_exporter).",
    "  - name: rail402-host",
    "    rules:",
    ...host.flatMap(ruleLines),
    "",
  ].join("\n");
}

export const RULES_FILE = fileURLToPath(new URL("alerts.yml", import.meta.url));

function main(): void {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  const rendered = renderRules();
  if (values.check) {
    if (readFileSync(RULES_FILE, "utf8") !== rendered) {
      process.stderr.write(
        "deploy/monitoring/alerts.yml is out of date: run node deploy/monitoring/alerts.ts\n",
      );
      process.exit(1);
    }
    return;
  }
  writeFileSync(RULES_FILE, rendered);
}

if (import.meta.main) main();

const SEVERITY_TEXT: Readonly<Record<Severity, string>> = {
  page: "Page",
  ticket: "Ticket",
  heartbeat: "Heartbeat",
};

function severityText(alert: Alert): string {
  return alert.onTestnet === undefined || alert.onTestnet.severity === alert.severity
    ? SEVERITY_TEXT[alert.severity]
    : `${SEVERITY_TEXT[alert.severity]} (${SEVERITY_TEXT[alert.onTestnet.severity].toLowerCase()} on testnet)`;
}

const ROLLBACK_TEXT: Readonly<Record<Rollback, string>> = {
  release: "If it started with a deploy, roll back to the previous release ([Rollback](#rollback)).",
  configuration:
    "If it started with a configuration change, revert that change and restart the replicas one at a time; if it came with a release, roll back ([Rollback](#rollback)).",
  none: "None: nothing this deployment changed causes it; recover as below.",
};

/** The procedure as a Markdown link: runbook headings by anchor, other pages by path. */
export function procedureLink(alert: Alert): string {
  const title = PROCEDURES[alert.procedure];
  return `[${title}](${alert.procedure})`;
}

function ownerText(alert: Alert): string {
  return alert.onTestnet === undefined || alert.onTestnet.owner === alert.owner
    ? alert.owner
    : `${alert.owner} (${alert.onTestnet.owner} on testnet)`;
}

/** What an alert silences, or what silences it, through its cause (see `Alert.cause`). */
function inhibitionLines(alert: Alert, alerts: readonly Alert[]): string[] {
  if (alert.cause === undefined) return [];
  const names = (severity: Severity) =>
    alerts
      .filter((other) => other.cause === alert.cause && other.severity === severity)
      .map((other) => `[${other.name}](#${anchor(other.name)})`)
      .join(", ");
  if (alert.severity === "page") return [`Silences ${names("ticket")} on the same network while it fires.`];
  if (alert.severity === "ticket") return [`Silenced on a network while ${names("page")} fires for it.`];
  return [];
}

/** The runbook's alert catalog: one section per alert, in catalog order. */
export function renderRunbookAlerts(alerts: readonly Alert[] = ALERTS): string {
  const rows = alerts.map(
    (alert) =>
      `| [${alert.name}](#${anchor(alert.name)}) | ${severityText(alert)} | ${ownerText(alert)} | ${alert.summary} |`,
  );
  const sections = alerts.map((alert) =>
    [
      `### ${alert.name}`,
      `${severityText(alert)} · owner: ${ownerText(alert)} · fires after \`${alert.for}\` of \`${alert.expr.replaceAll("|", "\\|")}\``,
      ...(alert.pending === undefined
        ? []
        : [
            `Reads a series that newer Rail402 versions export (${alert.pending}); it never fires without it.`,
          ]),
      ...(alert.scope === "host"
        ? [
            "Reads the host collector: node_exporter, with the textfile `deploy/postgres/backup-metrics.sh` writes.",
          ]
        : alert.scope === "explorer"
          ? ["Reads the Explorer's metrics: each indexer on port 9464, the web role on port 9465."]
          : alert.scope === "mcp"
            ? ["Reads the hosted MCP endpoint's metrics on port 9464."]
            : []),
      ...inhibitionLines(alert, alerts),
      `**Meaning.** ${alert.meaning}`,
      `**First step.** ${alert.firstStep}`,
      `**Escalation.** ${alert.escalation}`,
      `**Rollback.** ${ROLLBACK_TEXT[alert.rollback]}`,
      `**Recovery.** ${alert.recovery}`,
      `**Procedure.** ${procedureLink(alert)}`,
    ].join("\n\n"),
  );
  return [
    "| Alert | Severity | Owner | Summary |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}
