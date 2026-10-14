#!/usr/bin/env bash
# Deploys a contract of this repository from its committed wasm fixture and writes a deployment record.
#
#   scripts/contracts/deploy.sh --network testnet|local --deployer-secret-file <file> [options]
#
#   --contract <name>         upto (default) or test-token
#   --symbol <SYMBOL>         test-token: token symbol, e.g. TEST6 (required for test-token)
#   --decimals <n>            test-token: decimals, 0..18 (required for test-token)
#   --name <name>             test-token: token name (default "Rail402 Test Token (<n> decimals)")
#   --fund                    fund the deployer from the network's Friendbot first
#   --record <file>           where to write the record (defaults below)
#
# The contract address is derived from (network, deployer, salt) and printed before anything is sent.
# The salt is sha256("x402-upto-stellar/v1.1") for upto and sha256("rail402-test-token/v1/<SYMBOL>")
# for a test token, so one deployer always gets the same address on a network. The script uploads the
# fixture wasm (unchanged: no optimisation), deploys it with the salt, extends the instance and the
# code to the network's maximum TTL, checks that the wasm the instance runs equals the fixture, and
# writes the record: contracts/stellar/deployments/<network>.json for upto,
# contracts/testing/deployments/<symbol>-<network>.json for a test token, and target/contracts/
# deployments/ for the local network. A record it replaces for another contract is kept, shortened,
# in the new record's `previous` list. Only testnet and a local network are supported. The deployer's
# secret is read from a file and handed to the CLI through the environment, never on a command line.
# Needs Docker, git, jq and curl.
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
# shellcheck source=scripts/contracts/common.sh
source scripts/contracts/common.sh

network=""
contract="upto"
secret_file=""
symbol=""
decimals=""
token_name=""
fund=0
record=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      network="${2:?--network needs a name}"
      shift 2
      ;;
    --contract)
      contract="${2:?--contract needs a name}"
      shift 2
      ;;
    --deployer-secret-file)
      secret_file="${2:?--deployer-secret-file needs a file}"
      shift 2
      ;;
    --symbol)
      symbol="${2:?--symbol needs a value}"
      shift 2
      ;;
    --decimals)
      decimals="${2:?--decimals needs a value}"
      shift 2
      ;;
    --name)
      token_name="${2:?--name needs a value}"
      shift 2
      ;;
    --fund) fund=1 && shift ;;
    --record)
      record="${2:?--record needs a file}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,23p' "$0"
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

case "$network" in
  testnet)
    rpc_url="https://soroban-testnet.stellar.org"
    friendbot="https://friendbot.stellar.org"
    ;;
  local)
    rpc_url="${LOCAL_RPC_URL:-http://localhost:8000/rpc}"
    friendbot="${LOCAL_FRIENDBOT_URL:-http://localhost:8000/friendbot}"
    ;;
  "") fail "give --network testnet or --network local (see --help)" ;;
  *) fail "unsupported network: $network (testnet or local)" ;;
esac
passphrase="Test SDF Network ; September 2015"

[[ -n "$secret_file" ]] || fail "give --deployer-secret-file"
[[ -r "$secret_file" ]] || fail "cannot read $secret_file"
STELLAR_ACCOUNT="$(tr -d '[:space:]' <"$secret_file")"
[[ "$STELLAR_ACCOUNT" =~ ^S[A-Z2-7]{55}$ ]] || fail "$secret_file does not hold a Stellar secret key (S…)"
export STELLAR_ACCOUNT

select_contract "$contract"
constructor_args=()
case "$CONTRACT_NAME" in
  upto)
    [[ -z "$symbol$decimals$token_name" ]] || fail "--symbol, --decimals and --name are for test-token"
    # v1 (sha256("x402-upto-stellar/v1")) holds the same source built without SEP-55 metadata.
    salt_input="x402-upto-stellar/v1.1"
    default_record="contracts/stellar/deployments/$network.json"
    ;;
  test-token)
    [[ "$symbol" =~ ^[A-Z0-9]{1,12}$ ]] || fail "--symbol needs 1 to 12 upper-case letters or digits"
    [[ "$decimals" =~ ^[0-9]+$ ]] && ((decimals <= 18)) || fail "--decimals needs a number from 0 to 18"
    [[ -n "$token_name" ]] || token_name="Rail402 Test Token ($decimals decimals)"
    constructor_args=(--name "$token_name" --symbol "$symbol" --decimals "$decimals")
    salt_input="rail402-test-token/v1/$symbol"
    default_record="contracts/testing/deployments/$(tr '[:upper:]' '[:lower:]' <<<"$symbol")-$network.json"
    ;;
  *) fail "$CONTRACT_NAME is not deployable with this script" ;;
esac
[[ "$network" != "local" ]] || default_record="target/contracts/deployments/$CONTRACT_NAME${symbol:+-$symbol}-local.json"
[[ -n "$record" ]] || record="$default_record"

command -v docker >/dev/null || fail "docker is not installed"
command -v jq >/dev/null || fail "jq is not installed"
command -v curl >/dev/null || fail "curl is not installed"

# The record names the commit the wasm was built from, so that commit must hold exactly these inputs.
git diff --quiet HEAD -- "$CONTRACT_CRATE" "$FIXTURE_WASM" "$FIXTURE_PROVENANCE" ||
  fail "$CONTRACT_CRATE or its fixture has uncommitted changes; commit them first"
wasm_sha256="$(sha256 "$FIXTURE_WASM")"
[[ "$wasm_sha256" == "$(jq -er .wasm_sha256 "$FIXTURE_PROVENANCE")" ]] ||
  fail "$FIXTURE_WASM does not match $FIXTURE_PROVENANCE"
commit="$(git rev-parse HEAD)"
salt="$(printf '%s' "$salt_input" | sha256sum | cut -d' ' -f1)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$FIXTURE_WASM" "$work/contract.wasm"

# cli <args...>: the pinned image's stellar CLI, signing with the deployer's key from the environment.
cli() {
  docker run --rm --platform "$BUILD_PLATFORM" --interactive --network host --user "$(id -u):$(id -g)" \
    --env HOME=/tmp --env STELLAR_ACCOUNT \
    --env STELLAR_RPC_URL="$rpc_url" --env STELLAR_NETWORK_PASSPHRASE="$passphrase" \
    --volume "$work:/work" "$BUILD_IMAGE" "$@"
}
# cli_tx <log> <args...>: runs a transaction command, keeps its log and prints its stdout.
cli_tx() {
  local log="$1"
  shift
  cli "$@" 2>"$work/$log" || {
    cat "$work/$log" >&2
    return 1
  }
  cat "$work/$log" >&2
}
# tx_hash <log>: the hash of the transaction a CLI command signed, or "" when it sent none.
tx_hash() { sed -n 's/.*Signing transaction: \([0-9a-f]\{64\}\).*/\1/p' "$work/$1" | tail -1; }
rpc() {
  curl -fsS "$rpc_url" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"
}
# tx_ledger <hash>: the ledger that included a successful transaction.
tx_ledger() {
  local out status
  out="$(rpc getTransaction "{\"hash\":\"$1\"}")"
  status="$(jq -r .result.status <<<"$out")"
  [[ "$status" == "SUCCESS" ]] || fail "transaction $1 has status $status"
  jq -r .result.ledger <<<"$out"
}
# ledger_key <json>: a LedgerKey in base64 XDR.
ledger_key() { cli xdr encode --type LedgerKey --input json --output single-base64 <<<"$1" 2>/dev/null; }
# live_until <key-base64>: the entry's liveUntilLedgerSeq.
live_until() { rpc getLedgerEntries "{\"keys\":[\"$1\"]}" | jq -er '.result.entries[0].liveUntilLedgerSeq'; }
# tx_step <tx-hash>: {tx, ledger} for the record, or null when no transaction was needed.
tx_step() {
  if [[ -n "$1" ]]; then
    jq -n --arg tx "$1" --argjson ledger "$(tx_ledger "$1")" '{tx: $tx, ledger: $ledger}'
  else
    echo null
  fi
}

deployer="$(docker run --rm --platform "$BUILD_PLATFORM" --env HOME=/tmp --env STELLAR_ACCOUNT --user "$(id -u):$(id -g)" \
  --entrypoint sh "$BUILD_IMAGE" -c 'stellar keys public-key "$STELLAR_ACCOUNT"')"
contract_id="$(cli contract id wasm --salt "$salt" 2>/dev/null)"
cli_version="$(cli version --only-version 2>/dev/null)"
say "network      $network ($rpc_url)"
say "contract     $CONTRACT_CRATE${symbol:+ as $symbol ($decimals decimals)}"
say "wasm         $wasm_sha256 ($FIXTURE_WASM)"
say "deployer     $deployer"
say "salt         $salt = sha256(\"$salt_input\")"
say "address      $contract_id"

if ((fund)); then
  say "funding the deployer from $friendbot"
  # Friendbot refuses an account that already exists; a deployer without funds fails at the upload.
  curl -fsS "$friendbot?addr=$deployer" >/dev/null || say "Friendbot did not fund $deployer (already funded?)"
fi

say "uploading the wasm"
uploaded="$(cli_tx upload.log contract upload --wasm /work/contract.wasm --optimize=false)"
[[ "$uploaded" == "$wasm_sha256" ]] || fail "the network installed $uploaded, not $wasm_sha256"
upload_tx="$(tx_hash upload.log)"

instance_key="$(ledger_key "{\"contract_data\":{\"contract\":\"$contract_id\",\"key\":\"ledger_key_contract_instance\",\"durability\":\"persistent\"}}")"
code_key="$(ledger_key "{\"contract_code\":{\"hash\":\"$wasm_sha256\"}}")"
if [[ "$(rpc getLedgerEntries "{\"keys\":[\"$instance_key\"]}" | jq '.result.entries // [] | length')" != "0" ]]; then
  fail "$contract_id already exists; it was deployed before (see $record)"
fi

say "deploying"
deployed="$(cli_tx deploy.log contract deploy --wasm-hash "$wasm_sha256" --salt "$salt" -- "${constructor_args[@]}")"
deployed="$(tail -1 <<<"$deployed")"
[[ "$deployed" == "$contract_id" ]] || fail "deployed at $deployed, expected $contract_id"
deploy_tx="$(tx_hash deploy.log)"

max_entry_ttl="$(rpc getLedgerEntries "{\"keys\":[\"$(ledger_key '{"config_setting":{"config_setting_id":"state_archival"}}')\"]}" |
  jq -er '.result.entries[0].xdr' |
  cli xdr decode --type LedgerEntryData --input single-base64 --output json 2>/dev/null |
  jq -er '.config_setting.state_archival.max_entry_ttl')"
extend_to=$((max_entry_ttl - 1))
say "extending the instance and the code by $extend_to ledgers (max_entry_ttl $max_entry_ttl)"
cli_tx extend-instance.log contract extend --id "$contract_id" --durability persistent \
  --ledgers-to-extend "$extend_to" >/dev/null
cli_tx extend-code.log contract extend --wasm-hash "$wasm_sha256" --ledgers-to-extend "$extend_to" >/dev/null
instance_live_until="$(live_until "$instance_key")"
code_live_until="$(live_until "$code_key")"

say "fetching the wasm that $contract_id runs"
cli contract fetch --id "$contract_id" --out-file /work/fetched.wasm >&2
fetched="$(sha256 "$work/fetched.wasm")"
[[ "$fetched" == "$wasm_sha256" ]] || fail "the deployed wasm is $fetched, not $wasm_sha256"

# The record this one replaces, if it names another contract: kept as the first `previous` entry.
previous="[]"
if [[ -f "$record" ]] && [[ "$(jq -r '.contract_id // empty' "$record")" != "$contract_id" ]]; then
  previous="$(jq '[{
      contract_id, wasm_sha256, commit, salt_preimage,
      deploy: .transactions.deploy
    }] + (.previous // [])' "$record")"
fi

constructor="null"
if [[ "$CONTRACT_NAME" == "test-token" ]]; then
  constructor="$(jq -n --arg name "$token_name" --arg symbol "$symbol" --argjson decimals "$decimals" \
    '{name: $name, symbol: $symbol, decimals: $decimals}')"
fi
mkdir -p "$(dirname "$record")"
jq -n \
  --arg contract "$CONTRACT_NAME" \
  --arg network "$network" \
  --arg caip2 "stellar:testnet" \
  --arg passphrase "$passphrase" \
  --arg rpc_url "$rpc_url" \
  --arg contract_id "$contract_id" \
  --argjson constructor "$constructor" \
  --arg wasm_sha256 "$wasm_sha256" \
  --slurpfile provenance "$FIXTURE_PROVENANCE" \
  --arg commit "$commit" \
  --arg deployer "$deployer" \
  --arg salt "$salt" \
  --arg salt_input "$salt_input" \
  --arg cli_version "$cli_version" \
  --argjson upload "$(tx_step "$upload_tx")" \
  --argjson deploy "$(tx_step "$deploy_tx")" \
  --argjson extend_instance "$(tx_step "$(tx_hash extend-instance.log)")" \
  --argjson extend_code "$(tx_step "$(tx_hash extend-code.log)")" \
  --argjson extend_to "$extend_to" \
  --argjson instance_live_until "$instance_live_until" \
  --argjson code_live_until "$code_live_until" \
  --argjson previous "$previous" \
  '{
    contract: $contract,
    network: $network,
    caip2: $caip2,
    network_passphrase: $passphrase,
    rpc_url: $rpc_url,
    contract_id: $contract_id,
    constructor: $constructor,
    wasm_sha256: $wasm_sha256,
    wasm_size: $provenance[0].wasm_size,
    crate: $provenance[0].crate,
    source: $provenance[0].source,
    source_sha256: $provenance[0].source_sha256,
    bldimg: $provenance[0].bldimg,
    bldopt: $provenance[0].bldopt,
    build_cli: $provenance[0].stellar_cli,
    commit: $commit,
    deployer: $deployer,
    salt: $salt,
    salt_preimage: $salt_input,
    stellar_cli: $cli_version,
    transactions: {
      upload: $upload,
      deploy: $deploy,
      extend_instance: ($extend_instance + {extend_to: $extend_to}),
      extend_code: ($extend_code + {extend_to: $extend_to})
    },
    live_until_ledger: {instance: $instance_live_until, code: $code_live_until},
    previous: $previous
  }
  | if .constructor == null then del(.constructor) else . end
  | if .previous == [] then del(.previous) else . end' >"$record"
say "wrote $record"
