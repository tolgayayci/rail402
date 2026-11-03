import { raw } from "hono/html";
import { STYLESHEET_TEXT } from "./assets.ts";

if (/<\/?style/i.test(STYLESHEET_TEXT)) throw new Error("the stylesheet must not contain a style tag");

/**
 * The Explorer's own stylesheet as the raw text of a `<style>` element, for the standalone snapshot.
 * A style element's content is not HTML, so escaping it would break selectors like `a > b` and quoted
 * values. It takes no argument: only the compile-time stylesheet can ever be inlined this way.
 */
export function inlineStylesheet(): ReturnType<typeof raw> {
  return raw(STYLESHEET_TEXT);
}
