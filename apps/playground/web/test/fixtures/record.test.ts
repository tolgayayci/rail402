import { describe, expect, it } from "vitest";
import { IDS, URLS } from "./ids.ts";
import { normalizeRun } from "./record.ts";

const stack = {
  publicUrl: "http://127.0.0.1:18791",
  demoSellerUrl: "http://127.0.0.1:40001",
  facilitatorUrl: "http://127.0.0.1:40002",
  payer: "GPAYER",
  demoPayTo: "GDEMO",
  labPayTo: "GLAB",
  sponsor: "GSPONSOR",
  asset: "CASSET",
  assetIssuer: "GISSUER",
  uptoContract: "CUPTO",
};

describe("recorded run fixtures", () => {
  it("replace the local stack's URLs, hosts and accounts with the fixture identities", () => {
    const text = JSON.stringify({
      url: "http://127.0.0.1:40001/weather?city=Ankara",
      lab: "http://127.0.0.1:18791/lab/sell/forecast/Ankara",
      host: "127.0.0.1:40001",
      from: "GPAYER",
      to: "GDEMO",
      contract: "CASSET",
      untouched: "https://127.0.0.1/",
    });
    expect(JSON.parse(normalizeRun(text, stack))).toEqual({
      url: `${URLS.demoSeller}/weather?city=Ankara`,
      lab: `${URLS.public}/lab/sell/forecast/Ankara`,
      host: new URL(URLS.demoSeller).host,
      from: IDS.buyer,
      to: IDS.demoPayTo,
      contract: IDS.usdc,
      untouched: "https://127.0.0.1/",
    });
  });
});
