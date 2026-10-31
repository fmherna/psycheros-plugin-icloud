/**
 * One-time migration: Google Takeout `Tasks.json` → my iCloud Reminders.
 *
 * Run from this plugin directory:
 *
 *   deno run -A import-google-tasks.ts ~/Downloads/Takeout/Tasks/Tasks.json
 *
 * Options:
 *   --into <name>          Target Reminders list (default: my first list)
 *   --include-completed    Also migrate completed tasks (default: skip)
 *   --dry-run              Show what would be created, write nothing
 *
 * Credentials come from the environment (PSYCHEROS_PLUGIN_ICLOUD_APPLE_ID /
 * PSYCHEROS_PLUGIN_ICLOUD_APP_PASSWORD) or are read from
 * ../../plugin-secrets/icloud.env relative to this script. The Google side
 * of the migration is a plain file read — no OAuth, no API, no billing.
 */

import { createTask, getDiscovery, listCollections } from "./lib/caldav.ts";
import { buildVtodo } from "./lib/ics.ts";

interface TakeoutTask {
  title?: string;
  notes?: string;
  status?: string;
  due?: string;
  deleted?: boolean;
}
interface TakeoutList {
  title?: string;
  items?: TakeoutTask[];
}

function parseArgs(argv: string[]): {
  file: string;
  into?: string;
  includeCompleted: boolean;
  dryRun: boolean;
} {
  const rest = argv.filter((arg) =>
    !arg.startsWith("--") && !arg.endsWith(".json")
  );
  const file = argv.find((arg) => arg.endsWith(".json")) ?? rest[0] ?? "";
  if (!file) {
    console.error(
      "usage: deno run -A import-google-tasks.ts <path/to/Tasks.json> [--into <name>] [--include-completed] [--dry-run]",
    );
    Deno.exit(2);
  }
  return {
    file,
    into: argv.includes("--into")
      ? argv[argv.indexOf("--into") + 1]
      : undefined,
    includeCompleted: argv.includes("--include-completed"),
    dryRun: argv.includes("--dry-run"),
  };
}

function readSecretsFromEnvFile(): void {
  const candidates = [
    new URL("../../plugin-secrets/icloud.env", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      const text = Deno.readTextFileSync(url);
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/\\"/g, '"').replace(
            /\\\\/g,
            "\\",
          );
        }
        if (value && !Deno.env.has(key)) Deno.env.set(key, value);
      }
      return;
    } catch {
      // try the next candidate
    }
  }
}

function dueToInput(due: string | undefined): string | undefined {
  if (!due) return undefined;
  const date = new Date(due);
  if (Number.isNaN(date.getTime())) return undefined;
  // Preserve Google's date-only dues as date-only; timed dues become ISO UTC.
  const dateOnly = /T00:00:00(?:\.000)?Z$/.test(due);
  return dateOnly ? date.toISOString().slice(0, 10) : date.toISOString();
}

async function main(): Promise<void> {
  const opts = parseArgs(Deno.args);
  readSecretsFromEnvFile();

  const appleId = Deno.env.get("PSYCHEROS_PLUGIN_ICLOUD_APPLE_ID") ?? "";
  const appPassword = Deno.env.get("PSYCHEROS_PLUGIN_ICLOUD_APP_PASSWORD") ??
    "";
  if (!appleId || !appPassword) {
    console.error(
      "Credentials missing. Set PSYCHEROS_PLUGIN_ICLOUD_APPLE_ID and " +
        "PSYCHEROS_PLUGIN_ICLOUD_APP_PASSWORD (env or plugin-secrets/icloud.env).",
    );
    Deno.exit(1);
  }
  const deps = { appleId, appPassword };

  const raw = JSON.parse(await Deno.readTextFile(opts.file));
  const lists: TakeoutList[] = Array.isArray(raw) ? raw : raw.items ?? [];
  if (lists.length === 0) {
    console.error(
      "No task lists found in that file — is it the Takeout Tasks.json?",
    );
    Deno.exit(1);
  }

  // Resolve the target list up front so a typo'd --into fails before any write.
  const discovery = opts.dryRun
    ? await getDiscovery(deps)
    : await listCollections(deps);
  const vtodoLists = discovery.collections.filter((c) =>
    c.kinds.includes("VTODO")
  );
  if (vtodoLists.length === 0) {
    console.error(
      "No Reminders (VTODO) list exists in the iCloud calendar home yet.",
    );
    Deno.exit(1);
  }
  const target = opts.into
    ? vtodoLists.find((c) =>
      c.displayName.toLowerCase() === opts.into!.toLowerCase()
    )
    : vtodoLists[0];
  if (!target) {
    console.error(
      `No Reminders list named "${opts.into}" — available: ${
        vtodoLists.map((c) => c.displayName).join(", ")
      }`,
    );
    Deno.exit(1);
  }

  let created = 0;
  let skipped = 0;
  for (const list of lists) {
    const listName = list.title ?? "(untitled list)";
    for (const task of list.items ?? []) {
      const title = task.title?.trim();
      if (!title || task.deleted) {
        skipped++;
        continue;
      }
      if (task.status === "completed" && !opts.includeCompleted) {
        skipped++;
        continue;
      }
      const uid = crypto.randomUUID() + "@psycheros";
      const ics = buildVtodo({
        uid,
        title,
        due: dueToInput(task.due),
        notes: task.notes,
      });
      if (opts.dryRun) {
        console.log(
          `[dry-run] would add to "${target.displayName}": ${title}${
            task.due ? ` (due ${task.due})` : ""
          }`,
        );
        created++;
        continue;
      }
      try {
        await createTask(deps, { uid, ics, listName: target.displayName });
        created++;
        console.log(`added: ${title}`);
      } catch (error) {
        skipped++;
        console.error(
          `failed: "${title}" — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    void listName;
  }

  console.log(
    `\nDone: ${created} task(s) ${
      opts.dryRun ? "would be " : ""
    }imported into "${target.displayName}", ${skipped} skipped.`,
  );
}

await main();
