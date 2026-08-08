/**
 * One-off migration for the multi-tenant rollout.
 *
 * Creates a single "legacy" workspace and assigns every pre-existing row
 * (across all tables) to it, so nothing that was in the CRM before
 * multi-tenancy disappears. The auth middleware (see
 * middlewares/workspaceAuth.ts) recognizes this workspace by name and
 * automatically attaches the *first* person who ever signs in to it — that
 * person becomes the admin who inherits all existing data. Every signup
 * after that gets a brand new, empty workspace.
 *
 * Safe to re-run: it no-ops if the legacy workspace already exists.
 *
 * Usage: pnpm --filter @workspace/api-server exec tsx scripts/backfillWorkspaces.ts
 */
import { db } from "@workspace/db";
import {
  workspacesTable,
  clientsTable,
  conversationsTable,
  messagesTable,
  tasksTable,
  opportunitiesTable,
  documentsTable,
  clientEventsTable,
  activityLogTable,
  tokenUsageTable,
  aiSettingsTable,
  aiRolesTable,
  restrictionPoliciesTable,
  priorityPoliciesTable,
  whatsappConfigTable,
  waCredentialsTable,
  waInstanceLockTable,
} from "@workspace/db";
import { eq, isNull } from "drizzle-orm";
import { LEGACY_WORKSPACE_NAME } from "../src/lib/legacyWorkspace";

export { LEGACY_WORKSPACE_NAME };

async function main() {
  let [legacy] = await db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.name, LEGACY_WORKSPACE_NAME))
    .limit(1);

  if (!legacy) {
    [legacy] = await db
      .insert(workspacesTable)
      .values({ name: LEGACY_WORKSPACE_NAME })
      .returning();
    console.log(`Created legacy workspace id=${legacy.id}`);
  } else {
    console.log(`Legacy workspace already exists id=${legacy.id}`);
  }

  const workspaceId = legacy.id;
  const tables = [
    { name: "clients", table: clientsTable },
    { name: "conversations", table: conversationsTable },
    { name: "messages", table: messagesTable },
    { name: "tasks", table: tasksTable },
    { name: "opportunities", table: opportunitiesTable },
    { name: "documents", table: documentsTable },
    { name: "client_events", table: clientEventsTable },
    { name: "activity_log", table: activityLogTable },
    { name: "token_usage", table: tokenUsageTable },
    { name: "ai_settings", table: aiSettingsTable },
    { name: "ai_roles", table: aiRolesTable },
    { name: "restriction_policies", table: restrictionPoliciesTable },
    { name: "priority_policies", table: priorityPoliciesTable },
    { name: "whatsapp_config", table: whatsappConfigTable },
    { name: "wa_credentials", table: waCredentialsTable },
    { name: "wa_instance_lock", table: waInstanceLockTable },
  ] as const;

  for (const { name, table } of tables) {
    const result = await db
      .update(table)
      .set({ workspaceId } as any)
      .where(isNull((table as any).workspaceId));
    console.log(`Backfilled ${name}: ${result.rowCount ?? 0} row(s)`);
  }

  console.log("Backfill complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
