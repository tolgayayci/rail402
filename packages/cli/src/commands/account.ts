import { StrKey, rpc } from "@stellar/stellar-sdk";
import {
  KeyHolder,
  PUBNET,
  TESTNET,
  XLM_DECIMALS,
  accountState,
  addTrustline,
  buyAsset,
  classicAssetFor,
  fundWithFriendbot,
  keySetupSigner,
  paymentError,
  policyAsset,
  toAtomic,
  toDecimal,
  type Buyer,
} from "@rail402.dev/sdk";
import { AssetDirectory, networkPassphrase } from "@rail402.dev/stellar";
import { booleanFlag, stringFlag } from "../args.ts";
import { cliError, usage } from "../codes.ts";
import type { CommandHandler, CommandInput, CommandOutcome } from "../command.ts";
import { fields } from "../output.ts";
import { withBuyer } from "./common.ts";

/**
 * `rail402 account setup|status`: onboarding for the configured key. On testnet, setup funds the
 * account with Friendbot, adds the asset's trustline and can buy USDC with XLM from the testnet
 * exchange. On pubnet it only adds the trustline, never uses Friendbot, and needs --yes. These are
 * classic transactions the key holder submits; they never pay a seller.
 */
export const account: CommandHandler = {
  pays: false,
  run: (input) =>
    withBuyer(input, { signer: false }, (opened) =>
      input.parsed.subcommand === "setup" ? setup(input, opened.buyer) : status(input, opened.buyer),
    ),
};

const MAX_USDC = "1000";

interface Chain {
  readonly server: rpc.Server;
  readonly assets: AssetDirectory;
  readonly passphrase: string;
}

function chainFor(input: CommandInput): Chain {
  const { rpcUrl, network } = input.context.agent;
  const server = new rpc.Server(rpcUrl, { allowHttp: new URL(rpcUrl).protocol === "http:" });
  const passphrase = networkPassphrase(network);
  return { server, assets: new AssetDirectory(server, passphrase), passphrase };
}

async function status(input: CommandInput, buyer: Buyer): Promise<CommandOutcome> {
  const given = input.parsed.positionals[0];
  let address: string;
  if (given !== undefined) {
    if (!StrKey.isValidEd25519PublicKey(given)) throw usage("The account is a G… address.");
    address = given;
  } else {
    address = (await holderFor(input)).address;
  }
  const chain = chainFor(input);
  const report = await accountReport(chain, buyer, address);
  return {
    result: report,
    human: () =>
      [
        fields([
          ["account", report.address],
          ["network", report.network],
          ["exists", report.exists ? "yes" : "no (fund it first: rail402 account setup)"],
          ["XLM", report.xlm ?? undefined],
        ]),
        ...report.assets.map(
          (asset) =>
            `${asset.asset}: ${
              asset.trustline === null
                ? "not readable as a trustline asset"
                : asset.trustline
                  ? `balance ${asset.balance ?? "0"}${asset.authorized === false ? " (trustline not authorized)" : ""}`
                  : "no trustline"
            }`,
        ),
      ].join("\n"),
  };
}

async function setup(input: CommandInput, buyer: Buyer): Promise<CommandOutcome> {
  const { network } = input.context;
  const { flags } = input.parsed;
  if (input.parsed.positionals.length > 0)
    throw usage("rail402 account setup uses the configured key; it takes no address.");
  const usdc = stringFlag(flags, "usdc");
  const assetName = stringFlag(flags, "asset") ?? "USDC";
  if (network === PUBNET) {
    if (usdc !== undefined) {
      throw cliError(
        "cli_command_not_supported_on_network",
        "--usdc buys test USDC and exists on testnet only.",
      );
    }
    if (!booleanFlag(flags, "yes")) {
      throw usage("On pubnet, account setup submits a real transaction (a trustline); add --yes to confirm.");
    }
  }
  const asset = policyAsset(buyer.policy, assetName);
  if (asset === undefined) {
    throw usage(
      `${assetName.slice(0, 64)} is not an asset of the spending policy (RAIL402_ASSETS adds more).`,
    );
  }
  if (usdc !== undefined && asset.symbol !== "USDC") throw usage("--usdc applies to USDC only.");
  const usdcAtomic = usdc === undefined ? undefined : toAtomic(usdc, asset.decimals);
  if (
    usdc !== undefined &&
    (usdcAtomic === undefined || usdcAtomic <= 0n || usdcAtomic > (toAtomic(MAX_USDC, asset.decimals) ?? 0n))
  ) {
    throw usage(
      `--usdc is an amount above 0 and at most ${MAX_USDC}, with at most ${String(asset.decimals)} decimals.`,
    );
  }

  const holder = await holderFor(input);
  const chain = chainFor(input);
  const transactions: string[] = [];
  let funded: "friendbot" | "existing" = "existing";
  if (!(await accountState(chain, holder.address)).exists) {
    if (network !== TESTNET || input.context.friendbotUrl === undefined) {
      throw paymentError("account_not_found", {
        reason: "The account does not exist on pubnet; send it XLM from another account first.",
      });
    }
    await fundWithFriendbot(
      { friendbotUrl: input.context.friendbotUrl, fetch: input.deps.fetch, signal: input.signal },
      holder.address,
    );
    funded = "friendbot";
  }

  const facts = await chain.assets.describe(asset.contract);
  const classic =
    facts === undefined ? undefined : classicAssetFor(facts.name, asset.contract, chain.passphrase);
  if (classic === undefined) {
    throw usage(`${asset.symbol} is not a classic Stellar asset, so it needs no trustline.`);
  }
  const signer = keySetupSigner(holder, chain.passphrase, {
    asset: classic,
    ...(usdcAtomic === undefined ? {} : { maxBuy: toDecimal(usdcAtomic, asset.decimals) }),
  });
  let trustline: "added" | "existing" = "existing";
  const funds = await chain.assets.funds(asset.contract, holder.address);
  if (funds !== undefined && !funds.trustline) {
    transactions.push(await addTrustline(chain, signer, classic));
    trustline = "added";
  }

  let bought: { amount: string; asset: string } | null = null;
  if (usdcAtomic !== undefined) {
    const amount = toDecimal(usdcAtomic, asset.decimals);
    transactions.push(await buyAsset(chain, signer, { asset: classic, amount }));
    bought = { amount, asset: asset.symbol };
  }

  const report = await accountReport(chain, buyer, holder.address);
  const result = { ...report, funded, trustline, asset: asset.symbol, bought, transactions };
  return {
    result,
    human: () =>
      [
        fields([
          ["account", result.address],
          ["funded", funded === "friendbot" ? "by Friendbot" : "already existed"],
          ["trustline", `${asset.symbol} ${trustline === "added" ? "added" : "already present"}`],
          ["bought", bought === null ? undefined : `${bought.amount} ${bought.asset}`],
          ["XLM", result.xlm ?? undefined],
        ]),
        ...result.assets.map((item) => `${item.asset}: balance ${item.balance ?? "unknown"}`),
        ...transactions.map((hash) => `transaction: ${hash}`),
      ].join("\n"),
  };
}

async function holderFor(input: CommandInput): Promise<KeyHolder> {
  const { key } = input.context.agent;
  if (key === undefined) {
    throw paymentError("key_not_found", {
      reason: "No key is configured for this network; create one with rail402 keys new.",
    });
  }
  return "secretFile" in key ? KeyHolder.fromFile(key.secretFile) : KeyHolder.fromSecret(key.secret);
}

interface AccountReport {
  readonly address: string;
  readonly network: string;
  readonly exists: boolean;
  readonly xlm: string | null;
  readonly assets: readonly {
    readonly asset: string;
    readonly contract: string;
    /** Null when the asset is not a classic asset whose trustline can be read. */
    readonly trustline: boolean | null;
    readonly authorized: boolean | null;
    readonly balance: string | null;
  }[];
}

async function accountReport(chain: Chain, buyer: Buyer, address: string): Promise<AccountReport> {
  const xlm = (await accountState(chain, address)).xlm ?? undefined;
  const assets = await Promise.all(
    buyer.policy.assets.map(async (asset) => {
      const funds =
        xlm === undefined
          ? undefined
          : await chain.assets.funds(asset.contract, address).catch(() => undefined);
      return {
        asset: asset.symbol,
        contract: asset.contract,
        trustline: xlm === undefined ? false : (funds?.trustline ?? null),
        authorized: funds === undefined ? null : funds.authorized,
        balance: funds === undefined ? null : toDecimal(funds.balance, asset.decimals),
      };
    }),
  );
  return {
    address,
    network: buyer.network,
    exists: xlm !== undefined,
    xlm: xlm === undefined ? null : toDecimal(xlm, XLM_DECIMALS),
    assets,
  };
}
