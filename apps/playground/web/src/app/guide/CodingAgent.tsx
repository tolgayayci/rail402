/** The box at the top of Sell and Agents: hand the job to a coding agent, with the docs written for one. */
import type { ReactElement } from "react";
import { DOCS, docHref } from "../../projection/docs.ts";
import { ExternalIcon } from "../../ui/icons.tsx";
import { ExternalLink } from "../../ui/links.tsx";

export function CodingAgent({
  docsUrl,
  task,
}: {
  readonly docsUrl: string;
  readonly task: string;
}): ReactElement {
  const docs = docsUrl.replace(/\/+$/, "");
  return (
    <section className="coding-agent" aria-labelledby="coding-agent-title">
      <div className="coding-agent-text">
        <span className="r4-eyebrow" data-tone="accent">
          Fastest way
        </span>
        <h2 id="coding-agent-title">{task}</h2>
        <p>
          Give it the docs written for coding agents:{" "}
          <ExternalLink href={`${docs}/llms.txt`}>
            {docs.replace(/^https:\/\//, "")}/llms.txt <ExternalIcon />
          </ExternalLink>
        </p>
      </div>
      <ExternalLink href={docHref(DOCS.codingAgents, docsUrl)} className="coding-agent-cta">
        {DOCS.codingAgents.label} <ExternalIcon />
      </ExternalLink>
    </section>
  );
}
