// Veristar analytics for docs.rail402.dev: no cookies, no IP addresses, and nothing is sent when the
// browser signals Global Privacy Control. Mintlify runs every .js file in the docs on every page; the
// pinned version and its integrity value make the browser refuse any other file, and data-domains keeps
// local previews (mint dev) from sending anything. Guide: https://docs.veristar.app
const tracker = document.createElement("script");
tracker.src = "https://in.veristar.app/v/1.4.0/sdk.js";
tracker.integrity = "sha384-8bYExYW1FMGfNg5LETdGYFjtJPLfyY+gJQwWA0rL5xNM7Xl+3wK99GxSV3+siv/A";
tracker.crossOrigin = "anonymous";
tracker.dataset.websiteId = "01a1f1c1-546c-7061-9cdc-42db555cefda";
tracker.dataset.domains = "docs.rail402.dev";
document.head.appendChild(tracker);
