/**
 * The inspector: what the selected row means and every fact it carries, each with its source. The
 * wording explains the step; the facts come from the row, which came from events.
 */
import type { ScenarioId } from "../engine/events.ts";
import { REPLAY_REFUSAL_CODES, type StepId } from "../../../src/shared/lab.ts";
import { DOCS, type DocRef } from "./docs.ts";
import type { FlowKind } from "./facts.ts";
import type { Lane, LaneTone } from "./lanes.ts";
import type { Row, RowField } from "./rows.ts";

export interface InspectorView {
  readonly title: string;
  readonly note: string;
  /** `You → Weather API`, or the one lane of a step inside it. */
  readonly route: string;
  /** The colour of the route badge: the sending lane's, or `error`. */
  readonly tone: LaneTone | "error" | "idle";
  readonly fields: readonly RowField[];
  readonly doc: DocRef;
}

interface Copy {
  readonly title: string;
  readonly note: string;
}

const COPY: Readonly<Record<StepId, Copy>> = {
  request: {
    title: "Your app asks for the data",
    note: "A normal HTTP request. Nothing about payments yet.",
  },
  quote: {
    title: "The seller answers with its price",
    note: "Instead of an error page, the seller returns machine-readable terms in PAYMENT-REQUIRED. Amounts travel in base units: USDC has 7 decimals.",
  },
  refused: {
    title: "Refused before signing",
    note: "Your spending policy is checked before anything is signed, and again by the signer on the exact transfer. A payment outside it is never signed and never sent.",
  },
  sign: {
    title: "Your wallet signs exactly this payment",
    note: "One Soroban authorization entry for one transfer. Change any byte and the signature no longer verifies. The key never leaves this tab.",
  },
  "paid-request": {
    title: "The request again, now paid",
    note: "The same request, plus the signed payment in the PAYMENT-SIGNATURE header. Its value is never shown on this page.",
  },
  work: {
    title: "The seller measures usage",
    note: "After serving the request, the seller knows the real price and asks to settle only that.",
  },
  settle: {
    title: "The facilitator verifies and settles",
    note: "The seller hands the payment to its facilitator, which checks it and settles it on Stellar before the seller sends the data.",
  },
  "overcharge-refused": {
    title: "The facilitator refuses the settlement",
    note: "The amount the seller asked for is checked against what you signed. It is refused, so no transaction is sent. The settlement contract enforces the cap on chain as well.",
  },
  submit: {
    title: "Settled on Stellar",
    note: "The facilitator wraps your authorization in a transaction and pays the network fee from one of its advertised accounts. It never holds your USDC.",
  },
  deliver: {
    title: "You get the data and a receipt",
    note: "PAYMENT-RESPONSE carries the transaction hash, and the buyer checks that transaction on chain before it returns.",
  },
  resend: {
    title: "The same payment, sent again",
    note: "Retries happen: a timeout, a crash, a double click. This sends the identical paid request. Nothing new is signed.",
  },
  "replay-refused": {
    title: "The seller refuses the copy",
    note: "The facilitator finds that the authorization's nonce was already used and refuses it at /verify, so the seller answers 402 with that code. A seller that retries /settle instead gets the recorded answer back, marked as a repeat.",
  },
  "charged-once": {
    title: "Charged once",
    note: "Your balance did not move on the resend, and the transaction this run read for the nonce is the only one Soroban can accept: a used nonce can never be used twice.",
  },
  search: {
    title: "The agent searches by meaning",
    note: "Natural-language search over the paid APIs and tools in the Bazaar.",
  },
  results: {
    title: "Ranked results",
    note: "Each result carries its price, seller and trust level, and whether this buyer can pay it now.",
  },
  pick: {
    title: "The agent picks a match",
    note: "This is a scripted agent: it always applies the same rule. An agent driven by a model chooses from the same facts.",
  },
  budget: {
    title: "Limits come first",
    note: "The agent reads its per-call cap and what is left of its session budget before paying.",
  },
  "call-tool": {
    title: "Pay and call in one tool",
    note: "pay_and_call runs the whole x402 exchange over MCP: the unpaid call, the requirements, the guarded signature and the paid call. The agent never sees the key.",
  },
  "tool-settle": {
    title: "Settled on Stellar",
    note: "The tool's facilitator settles the charge and sponsors the fee. The receipt comes back in the result's _meta.",
  },
  "tool-result": {
    title: "The agent gets data it can use",
    note: "A structured result plus the receipt, so the agent can explain what it spent.",
  },
  catalog: {
    title: "The route is cataloged",
    note: "The settlement carried the bazaar extension, so the route is cataloged and bound to the payTo that was just paid. No other account can change the listing.",
  },
  "origin-check": {
    title: "The origin check",
    note: "Before a new or changed listing is published, the catalog calls the route itself and confirms that it asks for the same price and recipient.",
  },
  listed: {
    title: "Live in the Bazaar",
    note: "Agents now find the route by describing what they need.",
  },
};

/** Wording that differs by what was paid (HTTP or an MCP tool, exact or upto) or what the row shows. */
const VARIANTS: Readonly<Partial<Record<StepId, (row: Row, scenario: ScenarioId, flow: FlowKind) => Copy>>> =
  {
    request: (_row, scenario) =>
      scenario === "sell"
        ? {
            title: "A buyer calls the route",
            note: "The buyer knows only the URL. On the first run ever there is no listing to find yet.",
          }
        : COPY.request,
    quote: (_row, scenario, flow) => {
      if (scenario === "sell")
        return {
          title: "The 402 describes the route",
          note: "The route's discovery metadata travels in its 402. It is what agents read in the Bazaar.",
        };
      if (flow.mcp)
        return {
          title: "The tool answers with its price",
          note: "Instead of a result, the tool call returns an x402 payment-required error with machine-readable terms. Amounts travel in base units: USDC has 7 decimals.",
        };
      if (flow.scheme === "upto")
        return {
          title: "The seller quotes a maximum",
          note: "You authorize a cap. The seller can charge less, never more.",
        };
      return COPY.quote;
    },
    sign: (_row, _scenario, flow) =>
      flow.scheme === "upto"
        ? {
            title: "You sign the terms, not the amount",
            note: "The terms bind the recipient, token, cap, expiry and the one account allowed to settle.",
          }
        : COPY.sign,
    "paid-request": (_row, _scenario, flow) =>
      flow.mcp
        ? {
            title: "The tool call again, now paid",
            note: 'The same tools/call, plus the signed payment in _meta["x402/payment"]. Its value is never shown on this page.',
          }
        : flow.scheme === "upto"
          ? {
              title: COPY["paid-request"].title,
              note: "The same request, plus the signed authorization of your terms in the PAYMENT-SIGNATURE header. Its value is never shown on this page.",
            }
          : COPY["paid-request"],
    settle: (row, _scenario, flow) => {
      if (row.status === "error")
        return {
          title: "The facilitator refuses to settle",
          note: "The seller handed the payment to its facilitator, which refused to settle it, so no transaction was sent for it.",
        };
      if (row.fields.some((field) => field.key === "/verify" || field.key === "/settle"))
        return {
          title: COPY.settle.title,
          note: `${COPY.settle.note} This seller reports each facilitator answer in its trace header.`,
        };
      const where = flow.mcp ? "the result's _meta" : "its PAYMENT-RESPONSE";
      return row.sub.includes("proven on chain")
        ? {
            title: COPY.settle.title,
            note: `The facilitator verified and settled the payment. This seller does not report its facilitator calls, so this row shows what ${where} reports and what the chain proves.`,
          }
        : {
            title: "The seller reports a settlement",
            note: `This seller does not report its facilitator calls. This row shows what ${where} reports; the chain has not proven this payment's settlement.`,
          };
    },
    submit: (row, _scenario, flow) => {
      if (row.status === "error")
        return {
          title: "The reported transaction is not this payment",
          note: "The seller reported this transaction, but it did not consume this payment's nonce with its amount, so it proves nothing about this payment. The hold stays in your budget until the chain proves what moved.",
        };
      return flow.scheme === "upto"
        ? {
            title: "The contract moves only the usage",
            note: "The rest of the cap stays in your wallet, and the authorization cannot be used again.",
          }
        : COPY.submit;
    },
    deliver: (row, _scenario, flow) =>
      row.status === "error"
        ? {
            title: "The seller answers without the data",
            note: "The payment did not settle, so the seller sends no data. The buyer reports the facilitator's code, and the hold on your budget stays until the authorization expires.",
          }
        : flow.mcp
          ? {
              title: "You get the result and a receipt",
              note: "The result's _meta carries the transaction hash, and the buyer checks that transaction on chain before it returns.",
            }
          : COPY.deliver,
    refused: (row) =>
      row.sub.startsWith("egress_")
        ? {
            title: "Refused before sending",
            note: "The address is private or unsafe, so nothing was sent to it and nothing was signed.",
          }
        : row.label === "Refused"
          ? {
              title: "Refused",
              note: "Your spending policy refused this call before it was signed. An earlier call of the run was signed and paid; this one never left your tab.",
            }
          : COPY.refused,
    "replay-refused": (row) => {
      const meaning = Object.hasOwn(REPLAY_REFUSAL_CODES, row.sub)
        ? REPLAY_REFUSAL_CODES[row.sub]
        : undefined;
      return meaning === undefined
        ? {
            title: COPY["replay-refused"].title,
            note: "The seller refused the copy. Its answer names no refusal code this page knows, so it is shown as the seller sent it.",
          }
        : {
            title: COPY["replay-refused"].title,
            note: `The facilitator refused the copy at /verify (${row.sub}): ${meaning}. The seller answers 402 with that code.`,
          };
    },
    "charged-once": (row) =>
      row.label === "Charged once"
        ? COPY["charged-once"]
        : {
            title: row.label,
            note: "Your balance or the transactions read around the resend show more than one charge for this payment. Look at the fields for what moved.",
          },
  };

function copyFor(row: Row, scenario: ScenarioId, flow: FlowKind): Copy {
  return VARIANTS[row.step]?.(row, scenario, flow) ?? COPY[row.step];
}

/** The inspector for a row, or the idle view when nothing is selected. */
export function inspectorFor(
  row: Row | undefined,
  lanes: readonly Lane[],
  scenario: ScenarioId,
  flow: FlowKind = {
    mcp: scenario === "agent",
    scheme: scenario === "upto" ? "upto" : scenario === "agent" ? null : "exact",
  },
): InspectorView {
  if (row === undefined) {
    return {
      title: "Nothing to inspect yet",
      note: "Run the scenario, then click any message to see exactly what it carried.",
      route: "idle",
      tone: "idle",
      fields: [],
      doc: DOCS.x402,
    };
  }
  const copy = copyFor(row, scenario, flow);
  const name = (index: number): string => lanes[index]?.label ?? "?";
  const route = "self" in row.lane ? name(row.lane.self) : `${name(row.lane.from)} → ${name(row.lane.to)}`;
  const toneLane = "self" in row.lane ? row.lane.self : row.lane.from;
  return {
    title: copy.title,
    note: copy.note,
    route,
    tone: row.status === "error" ? "error" : (lanes[toneLane]?.tone ?? "idle"),
    fields: row.fields,
    doc: row.doc,
  };
}
