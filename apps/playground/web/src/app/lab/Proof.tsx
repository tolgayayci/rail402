/**
 * The end of a run on the stage: the proof of a payment the chain confirmed, or the verdict of one
 * that was refused or stopped.
 */
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { shortHash, type ProofView, type VerdictView } from "../../projection/proof.ts";
import { short, signedAmount } from "../../projection/format.ts";
import { DoneIcon, ExternalIcon, FailedIcon } from "../../ui/icons.tsx";
import { DocLink, ExternalLink } from "../../ui/links.tsx";
import { FactList } from "./Inspector.tsx";

/** Most pairs of the result the proof shows; each step's own card shows them all. */
const PROOF_RESULT_PAIRS = 4;

/** Staggers the entrance of a panel's parts. */
function order(index: number): CSSProperties {
  return { "--order": index } as CSSProperties;
}

export function ProofPanel({
  proof,
  docsUrl,
  actions,
}: {
  readonly proof: ProofView;
  readonly docsUrl: string;
  /** Actions on the finished run: its steps, its report. */
  readonly actions: ReactNode;
}): ReactElement {
  return (
    <section className="proof" aria-labelledby="proof-title">
      <p className="proof-eyebrow eyebrow">
        <DoneIcon size={16} />
        <span id="proof-title">Proof · Stellar testnet</span>
      </p>
      <div className="proof-amount reveal" style={order(0)}>
        <span className="proof-number">
          {proof.paid} <span className="proof-symbol">{proof.symbol}</span>
        </span>
        <span className="proof-caption">paid to the seller, in one transaction</span>
      </div>
      <div className="proof-tiles reveal" style={order(1)}>
        {proof.scheme === "upto" && proof.untaken !== null ? (
          <span className="proof-tile">
            <b>{proof.untaken}</b>of your cap never taken
          </span>
        ) : proof.cap !== null ? (
          <span className="proof-tile">
            <b>{proof.cap}</b>your cap, checked first
          </span>
        ) : null}
        <span className="proof-tile">
          {proof.feeSponsored ? (
            <>
              <b>0 XLM</b>from you, fee by {proof.facilitator}
            </>
          ) : (
            <>
              <b>Fee</b>paid by your wallet
            </>
          )}
        </span>
      </div>
      <div className="reveal" style={order(2)}>
        <ExternalLink className="proof-tx" href={proof.tx.url}>
          Open transaction {shortHash(proof.tx.hash)} <ExternalIcon />
        </ExternalLink>
      </div>
      <ul className="proof-parties" aria-label="Who did what">
        {proof.parties.map((party, index) => (
          <li key={party.role} className="proof-party reveal" data-tone={party.tone} style={order(3 + index)}>
            <span className="proof-party-head">
              <span className="proof-party-role">
                <span className="proof-dot" aria-hidden="true" />
                {party.role}
              </span>
              <ExternalLink className="proof-party-address mono" href={party.href}>
                {short(party.address)} {party.href === undefined ? null : <ExternalIcon />}
              </ExternalLink>
            </span>
            <span className="proof-party-did">{party.did}</span>
          </li>
        ))}
      </ul>
      {proof.result.length > 0 ? (
        <div className="result-card reveal" style={order(3 + proof.parties.length)}>
          <span className="eyebrow">What came back</span>
          <FactList
            facts={proof.result.slice(0, PROOF_RESULT_PAIRS)}
            className="fact-list fact-list-compact"
          />
        </div>
      ) : null}
      <div className="panel-foot">
        <span className="panel-actions">{actions}</span>
        <span className="panel-docs">
          {proof.docs.map((doc) => (
            <DocLink key={doc.label} doc={doc} docsUrl={docsUrl} />
          ))}
        </span>
      </div>
    </section>
  );
}

export function VerdictPanel({
  verdict,
  docsUrl,
  symbol,
  actions,
}: {
  readonly verdict: VerdictView;
  readonly docsUrl: string;
  readonly symbol: string;
  readonly actions: ReactNode;
}): ReactElement {
  const { good } = verdict;
  return (
    <section className="verdict" data-tone={verdict.tone} data-good={good} aria-labelledby="verdict-title">
      <p className="verdict-eyebrow eyebrow">
        {good ? <DoneIcon size={16} /> : <FailedIcon size={16} />}
        <span>{verdict.badge}</span>
      </p>
      <h2 id="verdict-title" className="verdict-title reveal" style={order(0)}>
        {verdict.title}
      </h2>
      {verdict.reason !== null ? (
        <p className="verdict-reason reveal" style={order(1)}>
          {verdict.reason}
        </p>
      ) : null}
      <dl className="fact-list reveal" style={order(2)}>
        {verdict.code !== null ? (
          <div className="fact" data-long={verdict.code.length > 30}>
            <dt>Code</dt>
            <dd className="mono">{verdict.code}</dd>
          </div>
        ) : null}
        {verdict.check !== null && verdict.check.expected !== verdict.code ? (
          <div className="fact" data-long>
            <dt>Expected</dt>
            <dd className="mono">{verdict.check.expected}</dd>
          </div>
        ) : null}
        {verdict.by !== null ? (
          <div className="fact">
            <dt>Refused by</dt>
            <dd>{verdict.by}</dd>
          </div>
        ) : null}
        <div className="fact">
          <dt>Signed</dt>
          <dd>
            {verdict.signed === 0
              ? "nothing"
              : `${String(verdict.signed)} payment${verdict.signed === 1 ? "" : "s"}`}
          </dd>
        </div>
        <div className="fact">
          <dt>Your balance</dt>
          <dd className="mono">
            {verdict.balance === "unchanged"
              ? "unchanged"
              : verdict.balance === "changed" && verdict.delta !== null
                ? signedAmount(verdict.delta, symbol)
                : "not read"}
          </dd>
        </div>
      </dl>
      {verdict.transactions.length > 0 ? (
        <ul className="verdict-txs reveal" style={order(3)} aria-label="Transactions">
          {verdict.transactions.map((tx) => (
            <li key={tx.hash}>
              <ExternalLink href={tx.url}>
                {tx.label} {shortHash(tx.hash)} <ExternalIcon />
              </ExternalLink>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="panel-foot">
        <span className="panel-actions">{actions}</span>
        <span className="panel-docs">
          {verdict.docs.map((doc) => (
            <DocLink key={doc.label} doc={doc} docsUrl={docsUrl} />
          ))}
        </span>
      </div>
    </section>
  );
}
