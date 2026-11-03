import type { RegistryAccount, RegistryFacilitator, SettlementRow } from "@rail402.dev/x402-index";
import type { Answer, PaidFor } from "../bazaar.ts";
import type { Holdings } from "../holdings.ts";
import {
  aside,
  badge,
  body,
  externalLink,
  facilitatorName,
  h,
  layout,
  monogram,
  note,
  pageHead,
  panel,
  paymentTable,
  rows,
  row,
  shortAddress,
  stat,
  table,
  tierBadge,
  tierLabel,
} from "../components.ts";
import { decimalAmount, groupThousands, percent } from "../format.ts";
import { displayText } from "../text.ts";
import { usdcContract, type PageContext } from "./context.ts";
import { facilitatorTable, shapedNote } from "./home.ts";

const ROLE_NAMES: Readonly<Record<string, string>> = {
  sponsor: "Sponsor",
  channel: "Channel account",
  "fee-bump": "Fee bump account",
  "upto-authority": "upto settlement authority",
  relayer: "Relayer",
};

const roleName = (role: string) => ROLE_NAMES[role] ?? displayText(role, 32);

/** The facilitators of the registry, with their share of attributed payments. */
export function facilitatorsPage(context: PageContext): string {
  const view = context.layout.view;
  const beta = context.registry.document.facilitators.filter((entry) => entry.tier === "rail402-beta");
  return layout(
    {
      ...context.layout,
      section: "facilitators",
      title: `Facilitators (${view.label})`,
      path: "/facilitators",
      description:
        "x402 facilitators on Stellar from the public registry, with their payments, payers, sellers and evidence.",
    },
    body(
      pageHead(
        { eyebrow: "Facilitators" },
        h("h1", null, "Who settles x402 payments on Stellar"),
        h(
          "p",
          { class: "muted" },
          `A payment is attributed to a facilitator only when its fee payer or source is one of that facilitator's registry accounts in that ledger. The registry changes only by reviewed commit, each account with public evidence. Registry ${context.registry.registryVersion}.`,
        ),
      ),
      panel(
        {
          title: "Facilitators",
          id: "facilitators",
          aside: h("a", { href: "/methodology#tiers" }, "How attribution works"),
        },
        facilitatorTable(context),
        shapedNote(context),
      ),
      beta.length === 0
        ? null
        : panel(
            { title: "Concluded history", id: "beta" },
            rows(
              undefined,
              beta.map((entry) =>
                row(
                  displayText(entry.name, 60),
                  tierBadge(entry.tier),
                  h(
                    "span",
                    null,
                    `${groupThousands(context.report?.aggregates.byFacilitator[entry.id]?.payments ?? 0)} payments, shown apart and never in the totals · `,
                  ),
                  h("a", { href: `${view.prefix}/facilitator/${entry.id}` }, "details"),
                ),
              ),
            ),
          ),
    ),
  );
}

/** Registry accounts grouped by role and range: channel accounts collapse into one row. */
function accountGroups(accounts: readonly RegistryAccount[]) {
  const groups = new Map<string, RegistryAccount[]>();
  for (const account of accounts) {
    const key = `${account.role}|${String(account.validFromLedger)}|${String(account.validToLedger)}|${account.epoch}`;
    const group = groups.get(key) ?? [];
    group.push(account);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    const [x] = a;
    const [y] = b;
    if (x === undefined || y === undefined) return 0;
    const active = Number(y.validToLedger === null) - Number(x.validToLedger === null);
    return active || y.validFromLedger - x.validFromLedger || x.role.localeCompare(y.role);
  });
}

export interface FacilitatorModel {
  readonly facilitator: RegistryFacilitator;
  readonly items: readonly SettlementRow[];
  readonly nextCursor: string | null;
  readonly paid: Answer<ReadonlyMap<string, PaidFor>> | undefined;
  /** The current sponsor's live XLM (Lumeus): context only, never counted. */
  readonly sponsor: string | undefined;
  readonly holdings: Answer<Holdings> | undefined;
}

export function facilitatorPage(context: PageContext, model: FacilitatorModel): string {
  const view = context.layout.view;
  const facilitator = model.facilitator;
  const report = context.report;
  const totals = report?.aggregates.byFacilitator[facilitator.id];
  const all = report?.aggregates.headline.payments ?? 0;
  const usdc = usdcContract(report);
  const volume = usdc === undefined ? undefined : totals?.volume[usdc];
  const upto = facilitator.accounts.some((account) => account.role === "upto-authority");
  const base = `${view.prefix}/facilitator/${facilitator.id}`;
  const beta = facilitator.tier === "rail402-beta";
  const name = facilitatorName(facilitator);
  const xlm =
    model.holdings?.status === "ok"
      ? model.holdings.value.items.find((item) => item.kind === "native")?.balance
      : undefined;
  const paid = model.paid?.status === "ok" ? model.paid.value : undefined;
  return layout(
    {
      ...context.layout,
      section: "facilitators",
      title: displayText(facilitator.name, 100),
      path: `/facilitator/${facilitator.id}`,
    },
    body(
      pageHead(
        {
          eyebrow: `${view.label} · facilitator`,
          avatar: h(
            "span",
            { class: facilitator.tier === "rail402" ? "avatar accent" : "avatar", "aria-hidden": "true" },
            facilitator.id === "rail402" ? "R4" : monogram(facilitator.name),
          ),
        },
        [
          h("h1", null, displayText(facilitator.name, 100)),
          beta ? badge("Concluded", "stripes") : badge("Registered", "ok"),
          tierBadge(facilitator.tier),
        ],
        facilitator.urls === undefined
          ? null
          : h(
              "div",
              { class: "line" },
              facilitator.urls.map((url) => externalLink(url, displayText(url, 120), "mono")),
            ),
      ),
      facilitator.sharedRelayer
        ? h(
            "p",
            { class: "notice", role: "note" },
            "Shared relayer: these accounts also relay transactions that are not x402 payments. Its rows are x402-shaped transactions submitted through an x402-capable relayer.",
          )
        : null,
      h(
        "section",
        { class: "panel stats", "aria-label": "Facilitator statistics" },
        stat(
          "Payments",
          totals === undefined ? "0" : groupThousands(totals.payments),
          beta
            ? "shown apart, never in the totals"
            : `${percent(totals?.payments ?? 0, all)} of attributed ${view.label.toLowerCase()} payments`,
        ),
        stat(
          "Distinct payers",
          totals === undefined ? "0" : groupThousands(totals.payers),
          "in the report's range",
        ),
        stat(
          "Distinct sellers",
          totals === undefined ? "0" : groupThousands(totals.sellers),
          "in the report's range",
        ),
        stat("USDC settled", volume === undefined ? "—" : decimalAmount(volume), "verified USDC"),
        stat(
          "Schemes",
          upto ? "exact · upto" : "exact",
          upto ? "has an upto settlement authority" : "from its registry accounts",
        ),
      ),
      h(
        "div",
        { class: "grid-2" },
        panel(
          { title: "Overview", id: "overview" },
          rows(
            undefined,
            row("Name", displayText(facilitator.name, 100)),
            row("Tier", tierLabel(facilitator.tier)),
            facilitator.urls === undefined
              ? null
              : row(
                  "Endpoint",
                  facilitator.urls.map((url) => externalLink(url, displayText(url, 120), "mono")),
                ),
            row("Network", view.network),
            row("Shared relayer", facilitator.sharedRelayer ? "Yes" : "No"),
            facilitator.note === undefined ? null : row("Note", displayText(facilitator.note, 500)),
            report === undefined
              ? null
              : row(
                  "Range",
                  `Ledgers ${groupThousands(report.range.from)}–${groupThousands(report.range.to)}; self-payments excluded`,
                ),
          ),
        ),
        panel(
          {
            title: "Non-custody",
            id: "custody",
            aside:
              totals === undefined
                ? null
                : badge(`${groupThousands(totals.payments)} / ${groupThousands(totals.payments)} pass`, "ok"),
          },
          h(
            "div",
            { class: "panel-body" },
            h(
              "p",
              null,
              "Every payment counted for this facilitator passed the rule checks: the payer paid no fee, and the token events prove the amount moved from the payer to the seller. Its accounts only paid network fees.",
            ),
            model.sponsor === undefined
              ? null
              : h(
                  "div",
                  { class: "panel live" },
                  rows(
                    undefined,
                    row("Current sponsor", shortAddress(view, model.sponsor)),
                    row(
                      "Holds",
                      model.holdings === undefined
                        ? h("span", { class: "muted" }, "Live balances are off for this network.")
                        : model.holdings.status !== "ok"
                          ? h("span", { class: "muted" }, "The live balance source did not answer.")
                          : h("span", { class: "mono" }, `${xlm ?? "0"} XLM`),
                      badge("Live · not audited", "live"),
                    ),
                  ),
                ),
          ),
        ),
      ),
      panel(
        {
          title: "Registry accounts",
          id: "accounts",
          aside: aside(
            `Registry ${context.registry.registryVersion} · changed by pull request, with evidence`,
          ),
        },
        table(
          "mid",
          [
            { label: "Role" },
            { label: "Account" },
            { label: "Valid ledgers" },
            { label: "Status" },
            { label: "Evidence", num: true },
          ],
          accountGroups(facilitator.accounts).map((group) => {
            const [first] = group;
            if (first === undefined) return null;
            const shown = group.slice(0, 2);
            return h(
              "tr",
              null,
              h(
                "td",
                { class: "strong" },
                group.length > 1
                  ? `${String(group.length)} ${roleName(first.role).toLowerCase()}s`
                  : roleName(first.role),
              ),
              h(
                "td",
                null,
                shown.map((account, index) => [index > 0 ? ", " : "", shortAddress(view, account.address)]),
                group.length > shown.length
                  ? h("span", { class: "muted" }, `, +${String(group.length - shown.length)}`)
                  : null,
                group.length > shown.length
                  ? h(
                      "details",
                      null,
                      h("summary", { class: "small" }, "All accounts"),
                      h(
                        "ul",
                        { class: "plain" },
                        group.map((account) => h("li", null, shortAddress(view, account.address))),
                      ),
                    )
                  : null,
              ),
              h(
                "td",
                { class: "mono nowrap" },
                `${groupThousands(first.validFromLedger)} – ${first.validToLedger === null ? "now" : groupThousands(first.validToLedger)}`,
              ),
              h(
                "td",
                null,
                first.validToLedger === null ? badge("Active", "ok") : badge("Retired", "stripes"),
              ),
              h(
                "td",
                { class: "num" },
                first.evidence.map((item, index) => [
                  index > 0 ? ", " : "",
                  externalLink(item.url, `source (archived ${item.archivedAt.slice(0, 10)})`),
                ]),
              ),
            );
          }),
        ),
        note(
          `A settlement is attributed to ${tierLabel(facilitator.tier).toLowerCase()} only when its fee payer or source is one of these accounts inside the listed ledger range.`,
        ),
      ),
      panel(
        {
          title: `Latest payments settled by ${name}`,
          id: "history",
          aside: h(
            "a",
            { href: `${view.prefix}/payments?facilitator=${facilitator.id}` },
            totals === undefined ? "View all" : `View all ${groupThousands(totals.payments)}`,
          ),
        },
        model.paid?.status === "down"
          ? h("p", { class: "notice" }, "The Bazaar did not answer: what each payment paid for is not shown.")
          : null,
        paymentTable(view, context.registry, model.items, paid, context.now, {
          facilitator: false,
          fee: true,
        }),
        model.nextCursor === null
          ? null
          : h(
              "div",
              { class: "pager" },
              h(
                "div",
                { class: "actions" },
                h(
                  "a",
                  { class: "btn small", href: `${base}?cursor=${model.nextCursor}#history`, rel: "next" },
                  "Older payments ›",
                ),
              ),
            ),
      ),
    ),
  );
}
