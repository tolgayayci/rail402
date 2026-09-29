import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** What a search cursor pins: the index snapshot, the request it continues, and the next offset. */
export interface CursorState {
  readonly revision: number;
  readonly offset: number;
  /** Digest of the normalised query and filters; a cursor only continues the request that made it. */
  readonly request: string;
  readonly expiresAt: number;
}

/**
 * Opaque, HMAC-signed search cursors. They cannot be forged or edited, they expire, and they pin
 * the index snapshot so pages of one search never skip or repeat results when the catalog changes.
 */
export class CursorCodec {
  private readonly secret: Buffer;

  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error("the cursor secret must be at least 32 bytes");
    this.secret = secret;
  }

  encode(state: CursorState): string {
    const body = Buffer.from(
      JSON.stringify([state.revision, state.offset, state.request, state.expiresAt]),
    ).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  /** The cursor's state, or why it cannot be used. */
  decode(token: string, now: number): CursorState | "invalid" | "expired" {
    if (token.length > 512) return "invalid";
    const [body, signature, ...rest] = token.split(".");
    if (body === undefined || signature === undefined || rest.length > 0) return "invalid";
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
    try {
      const [revision, offset, request, expiresAt] = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      ) as [number, number, string, number];
      if (![revision, offset, expiresAt].every(Number.isSafeInteger) || typeof request !== "string")
        return "invalid";
      if (expiresAt < now) return "expired";
      return { revision, offset, request, expiresAt };
    } catch {
      return "invalid";
    }
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url").slice(0, 32);
  }
}

/** Stable digest of a search request (query and filters), for binding cursors to it. */
export function requestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 22);
}
