/**
 * The wallet as the engine sees it: public facts and operations, never the key. The key object stays
 * inside this module and goes only to the signer tap (handed to the browser buyer, whose guard wraps
 * it) and to onboarding. The engine imports this file, never the keystore.
 */
import { KeyHolder, paymentError, type Sep43AuthSigner } from "@rail402.dev/sdk/browser";
import { openKeystore, type Keystore, type KeystoreOptions, type StoredWallet } from "./keystore.ts";
import {
  CHAIN_OPERATIONS,
  fundAccount,
  type OnboardingOperations,
  type OnboardingOptions,
} from "./onboarding.ts";
import { tapSigner, type SignerTapOptions } from "./signer.ts";

export type { StoredWallet };

export class WalletVault {
  readonly #keystore: Keystore;
  #key: KeyHolder | undefined;
  #wallet: StoredWallet | undefined;

  private constructor(keystore: Keystore) {
    this.#keystore = keystore;
  }

  static async open(options: KeystoreOptions = {}): Promise<WalletVault> {
    return new WalletVault(await openKeystore(options));
  }

  /** A vault over a given keystore (tests). */
  static over(keystore: Keystore): WalletVault {
    return new WalletVault(keystore);
  }

  get storage(): Keystore["storage"] {
    return this.#keystore.storage;
  }

  /** The wallet in this tab, if any. */
  get wallet(): StoredWallet | undefined {
    return this.#wallet;
  }

  /** Loads the stored wallet; rejects with `playground_wallet_storage_unavailable` when unreadable. */
  async load(): Promise<StoredWallet | undefined> {
    const loaded = await this.#keystore.load();
    this.#key = loaded?.key;
    this.#wallet = loaded?.wallet;
    return this.#wallet;
  }

  /** Generates and stores a fresh key. Refused (`key_exists`) while a wallet exists. */
  async create(network: string): Promise<StoredWallet> {
    return this.#store(KeyHolder.random(), network);
  }

  /** Stores an imported testnet seed; `key_invalid` for anything that is not one. */
  async import(seed: string, network: string): Promise<StoredWallet> {
    return this.#store(KeyHolder.fromSecret(seed), network);
  }

  async #store(key: KeyHolder, network: string): Promise<StoredWallet> {
    if (this.#wallet !== undefined) {
      throw paymentError("key_exists", {
        reason:
          "This browser already holds a testnet wallet; forget it before creating or importing another.",
      });
    }
    const wallet = await this.#keystore.save(key, network);
    this.#key = key;
    this.#wallet = wallet;
    return wallet;
  }

  /** Deletes the wallet from this browser. */
  async forget(): Promise<void> {
    await this.#keystore.remove();
    this.#key = undefined;
    this.#wallet = undefined;
  }

  /**
   * The key as a file: the seed on one line. A browser saves it readable by others, so it is used
   * through `rail402 keys import < file` (or after `chmod 600`), as the page says.
   */
  keyFile(): { readonly fileName: string; readonly blob: Blob } {
    const key = this.#heldKey();
    return {
      fileName: `rail402-testnet-${key.address.slice(0, 8).toLowerCase()}.key`,
      blob: new Blob([`${key.exportSecret()}\n`], { type: "application/octet-stream" }),
    };
  }

  /** The key behind the signer tap, for the browser buyer (whose guard wraps it). */
  signer(options: SignerTapOptions): Sep43AuthSigner {
    return tapSigner(this.#heldKey(), options);
  }

  /** Funds the wallet's account (Friendbot, trustline, purchase). */
  async fund(options: OnboardingOptions, operations: OnboardingOperations = CHAIN_OPERATIONS): Promise<void> {
    await fundAccount(this.#heldKey(), options, operations);
  }

  #heldKey(): KeyHolder {
    if (this.#key === undefined) throw paymentError("payment_signer_unavailable");
    return this.#key;
  }
}
