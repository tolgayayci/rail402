/**
 * The Playground's local stack (test/local-services.ts) with the page's engine running in
 * this process over the server's relay and proxies, with an in-memory IndexedDB and storage, exactly
 * as the page wires it.
 *
 * Every request the engine sends and every answer it reads passes through `traffic`, so suites can
 * check what reached the wire.
 */
import type { KeyValueStore } from "@rail402.dev/sdk/browser";
import type { LocalNetwork } from "@rail402.dev/testkit";
import { startLocalServices, type LocalServices } from "../../../test/local-services.ts";
import { loadConfig } from "../../src/engine/context.ts";
import { createEngine, type PlaygroundEngine } from "../../src/engine/engine.ts";
import type { LabEvent } from "../../src/engine/events.ts";
import type { RunHandle, RunSummary } from "../../src/engine/types.ts";
import { WalletVault } from "../../src/wallet/vault.ts";
import { FakeIndexedDB } from "../wallet/fake-indexeddb.ts";

/** One exchange the engine had with the Playground server or the chain. */
export interface Exchange {
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: readonly (readonly [string, string])[];
  readonly requestBody: string;
  readonly status: number | null;
  readonly responseHeaders: readonly (readonly [string, string])[];
  /** The response body as the engine received it; empty when it was not read to the end. */
  readonly responseBody: Promise<string>;
}

export interface LocalStack extends LocalServices {
  /** Every exchange of every engine this stack started. */
  readonly traffic: Exchange[];
  /** A fresh engine over the stack, as a page load would start it. */
  engine(): Promise<TestEngine>;
}

export interface TestEngine {
  readonly engine: PlaygroundEngine;
  readonly storage: KeyValueStore & { readonly data: Map<string, string> };
  readonly indexedDB: FakeIndexedDB;
  /** Files the engine handed the user to save. */
  readonly downloads: { readonly fileName: string; readonly text: string }[];
}

/** Starts a run's handle and collects its events until it ends. */
export async function finish(handle: RunHandle): Promise<{ summary: RunSummary; events: LabEvent[] }> {
  const events: LabEvent[] = [];
  handle.subscribe((event) => events.push(event));
  const summary = await handle.done;
  return { summary, events };
}

export async function startLocalStack(net: LocalNetwork): Promise<LocalStack> {
  const services = await startLocalServices(net);
  const { publicUrl } = services;

  const traffic: Exchange[] = [];
  const engines: PlaygroundEngine[] = [];
  const recording: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const requestBody = request.body === null ? "" : await request.clone().text();
    const entry = {
      method: request.method,
      url: request.url,
      requestHeaders: [...request.headers] as [string, string][],
      requestBody,
      status: null as number | null,
      responseHeaders: [] as [string, string][],
      responseBody: Promise.resolve(""),
    };
    traffic.push(entry);
    const response = await fetch(request);
    entry.status = response.status;
    entry.responseHeaders = [...response.headers];
    entry.responseBody = response
      .clone()
      .text()
      .catch(() => "");
    return response;
  };

  return {
    ...services,
    traffic,
    async engine() {
      const config = await loadConfig({ origin: publicUrl, fetch: recording });
      const indexedDB = new FakeIndexedDB();
      const storage = memoryStorage();
      const downloads: { fileName: string; text: string }[] = [];
      const engine = createEngine({
        config,
        fetch: recording,
        storage,
        vault: WalletVault.open({ indexedDB: indexedDB as unknown as IDBFactory }),
        focus: new EventTarget(),
        download: (fileName, blob) => {
          void blob.text().then((text) => downloads.push({ fileName, text }));
        },
      });
      engines.push(engine);
      await engine.ready;
      return { engine, storage, indexedDB, downloads };
    },
    async stop() {
      for (const engine of engines) engine.dispose();
      await services.stop();
    },
  };
}

function memoryStorage(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}
