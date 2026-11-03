/**
 * The Explorer image's entry point: one image, the role chosen by its first argument.
 *
 *   node src/main.ts web        public pages and the read API (reader role)
 *   node src/main.ts indexer    registry-scope indexing and live tail (writer role)
 *   node src/main.ts network-window  the report's network-wide window, off unless configured (writer role)
 *   node src/main.ts snapshot   export a report snapshot (see snapshot/main.ts)
 *   node src/main.ts migrate    apply pending migrations as the owner role, then exit (see migrate.ts)
 */
const role = process.argv[2] ?? process.env["EXPLORER_ROLE"];
if (process.argv[2] !== undefined) process.argv.splice(2, 1);

if (role === "web") await import("./web/main.ts");
else if (role === "indexer") await import("./indexer/main.ts");
else if (role === "network-window") await import("./window/main.ts");
else if (role === "snapshot") await import("./snapshot/main.ts");
else if (role === "migrate") await (await import("./migrate.ts")).runMigrate();
else {
  process.stderr.write("usage: main.ts web|indexer|network-window|snapshot|migrate (or EXPLORER_ROLE)\n");
  process.exitCode = 2;
}
