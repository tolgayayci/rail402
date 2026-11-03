import { usage } from "./codes.ts";

/** One seed, optionally after one comment line (a key file's network tag, checked by `parseKeyFile`). */
const PIPED_KEY = /^(?:#[^\r\n]*\r?\n\s*)?\S+$/;

/** Longest input accepted as a seed (an S… seed is 56 characters). */
const MAX_SECRET_BYTES = 1_024;

interface SecretStream extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/**
 * Reads a secret seed for `keys import`. On a terminal it prompts on stderr and reads one line with
 * echo off; from a pipe it reads the whole input: one seed, or a key file (a network tag line, then the
 * seed; `keys import` refuses a tag for another network). The seed never appears on
 * the command line, in the environment or in output.
 */
export function readSecret(stdin: SecretStream, prompt: NodeJS.WritableStream): Promise<string> {
  return stdin.isTTY === true && typeof stdin.setRawMode === "function"
    ? readHidden(stdin, prompt)
    : readPiped(stdin);
}

interface PromptStream extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

/**
 * Asks a yes/no question on the terminal: the question on stderr, one line from stdin. Only "y" or
 * "yes" approves. Undefined when stdin or stderr is not a terminal, so a script never hangs on it.
 */
export function askOnTerminal(
  stdin: SecretStream,
  prompt: PromptStream,
  question: string,
): Promise<boolean | undefined> {
  if (stdin.isTTY !== true || prompt.isTTY !== true) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    prompt.write(question);
    let text = "";
    const finish = (answer: boolean) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
      resolve(answer);
    };
    const onData = (chunk: Buffer | string) => {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end >= 0) finish(/^\s*y(es)?\s*$/i.test(text.slice(0, end)));
      else if (text.length > 64) finish(false);
    };
    const onEnd = () => {
      finish(false);
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });
}

function readPiped(stdin: SecretStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_SECRET_BYTES) {
        cleanup();
        reject(usage("The key read from stdin is too long; it is one S… seed."));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") reject(usage("rail402 keys import reads the seed from stdin; nothing was given."));
      else if (!PIPED_KEY.test(text)) {
        reject(
          usage("stdin must hold exactly one S… seed, or a rail402 key file (its tag line, then the seed)."),
        );
      } else resolve(text);
    };
    const onError = () => {
      cleanup();
      reject(usage("The key could not be read from stdin."));
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    stdin.resume();
  });
}

function readHidden(stdin: SecretStream, prompt: NodeJS.WritableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    prompt.write("Secret seed (input hidden): ");
    stdin.setRawMode?.(true);
    let text = "";
    const finish = (error: Error | undefined) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      prompt.write("\n");
      if (error !== undefined) reject(error);
      else resolve(text.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          finish(undefined);
          return;
        }
        if (char === "\u0003" || char === "\u0004") {
          finish(usage("Key import cancelled."));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          text = text.slice(0, -1);
        } else if (text.length < MAX_SECRET_BYTES) {
          text += char;
        }
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}
