/**
 * Optional, privacy-first page analytics (Veristar): a pinned tracker release, loaded only when
 * `EXPLORER_ANALYTICS_SITE_ID` is set. It sets no cookies, stores no IP addresses and sends nothing when
 * the browser signals Global Privacy Control. The browser runs the file only if it matches `integrity`,
 * so the gateway cannot change the code the pages run, and `data-domains` limits it to the Explorer's
 * own host. Without a site id the pages and their policy are exactly as before.
 * Guide: https://docs.veristar.app
 */
export const TRACKER = Object.freeze({
  origin: "https://in.veristar.app",
  version: "1.4.0",
  integrity: "sha384-8bYExYW1FMGfNg5LETdGYFjtJPLfyY+gJQwWA0rL5xNM7Xl+3wK99GxSV3+siv/A",
});

/** What the page shell needs to render the tag: the site id and the host it may report from. */
export interface Analytics {
  readonly siteId: string;
  readonly host: string;
}

export const TRACKER_SRC = `${TRACKER.origin}/v/${TRACKER.version}/sdk.js`;
