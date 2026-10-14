// A module a browser page must never import: the bundle check proves it would be caught.
import * as crypto from "crypto";
import * as fs from "node:fs";

export const read = (path: string): string => fs.readFileSync(path, "utf8");
export const digest = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
export const home = (): string | undefined => process.env["HOME"];
