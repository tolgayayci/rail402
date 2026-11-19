/**
 * Optional, privacy-first page analytics (Veristar): a pinned tracker release, loaded only when
 * `ANALYTICS_SITE_ID` is set. It sets no cookies, stores no IP addresses and sends nothing when the
 * browser signals Global Privacy Control. The browser runs the file only if it matches `integrity`, so
 * the gateway cannot change the code the page runs, and `data-domains` limits it to the Playground's
 * own host. Without a site id the page, its policy and the server are exactly as before.
 * Guide: https://docs.veristar.app
 */
export const TRACKER = Object.freeze({
  origin: "https://in.veristar.app",
  version: "1.4.0",
  integrity: "sha384-8bYExYW1FMGfNg5LETdGYFjtJPLfyY+gJQwWA0rL5xNM7Xl+3wK99GxSV3+siv/A",
});

/** The tag the server adds to the page's head; site id and host are validated configuration. */
export function trackerTag(siteId: string, publicUrl: string): string {
  const host = new URL(publicUrl).hostname;
  return (
    `<script defer src="${TRACKER.origin}/v/${TRACKER.version}/sdk.js" integrity="${TRACKER.integrity}" ` +
    `crossorigin="anonymous" data-website-id="${siteId}" data-domains="${host}"></script>`
  );
}
