import { MemoryChannelPool, MemorySettlementLedger } from "@rail402.dev/facilitator";
import { channelPoolSuite, settlementLedgerSuite } from "@rail402.dev/facilitator/testing";

settlementLedgerSuite("memory", () => {
  let offset = 0;
  const ledger = new MemorySettlementLedger(() => Date.now() + offset);
  return Promise.resolve({
    ledger,
    expireClaims: () => {
      offset += 3_600_000;
      return Promise.resolve();
    },
  });
});

channelPoolSuite("memory", (addresses) => Promise.resolve(new MemoryChannelPool(addresses)));
