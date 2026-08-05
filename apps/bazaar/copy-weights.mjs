// tsc emits the tokenizer .json (resolveJsonModule) but NOT the binary weight blob, which
// `src/search/embedding.ts` reads via `readFileSync`. Copy it next to the compiled module so a build
// consumed from `dist/` (e.g. the facilitator co-deploying the Bazaar) can search too. Source stays
// authoritative; this is a post-`tsc` asset step, not codegen.
import { copyFileSync } from "node:fs";

copyFileSync(
  new URL("./src/search/potion-embeddings.bin", import.meta.url),
  new URL("./dist/search/potion-embeddings.bin", import.meta.url),
);
