/**
 * Resolves the authenticated Clerk user into a `profile` + `workspace`, and
 * attaches `req.workspaceId` / `req.profileId` for every downstream route.
 *
 * Every business-data query/insert/update/delete in this app must be scoped
 * by `req.workspaceId` — there is no such thing as "global" data anymore.
 *
 * First-ever signup is special-cased: it claims the pre-existing "legacy"
 * workspace created by the multi-tenant migration (see
 * scripts/backfillWorkspaces.ts), so whoever signs in first inherits all the
 * data that existed before multi-tenancy. Every signup after that gets a
 * brand new, empty workspace.
 */
import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { db } from "@workspace/db";
import { profilesTable, workspacesTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { LEGACY_WORKSPACE_NAME } from "../lib/legacyWorkspace";
import { logger } from "../lib/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspaceId?: number;
      profileId?: number;
      clerkUserId?: string;
    }
  }
}

async function resolveOrCreateProfile(clerkUserId: string, email: string) {
  const [existing] = await db
    .select()
    .from(profilesTable)
    .where(eq(profilesTable.clerkUserId, clerkUserId))
    .limit(1);
  if (existing) return existing;

  return db.transaction(async (tx) => {
    // Re-check inside the transaction in case of a race between two
    // concurrent first requests for the same brand-new user.
    const [raced] = await tx
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.clerkUserId, clerkUserId))
      .limit(1);
    if (raced) return raced;

    // Claim the legacy workspace only if it exists AND has no owner yet.
    // Using a LEFT JOIN so the check is atomic inside the transaction and
    // immune to any other rows that might exist in the profiles table
    // (test accounts, seed rows, etc.).
    const [legacyUnclaimed] = await tx
      .select({ workspaceId: workspacesTable.id })
      .from(workspacesTable)
      .leftJoin(profilesTable, eq(profilesTable.workspaceId, workspacesTable.id))
      .where(and(
        eq(workspacesTable.name, LEGACY_WORKSPACE_NAME),
        // profilesTable.id being null means no profile row owns this workspace yet.
        isNull(profilesTable.id),
      ))
      .limit(1);

    let workspaceId: number;
    if (legacyUnclaimed) {
      // First real user to sign in inherits all pre-migration data.
      workspaceId = legacyUnclaimed.workspaceId;
    } else {
      const [created] = await tx
        .insert(workspacesTable)
        .values({ name: `Workspace de ${email}` })
        .returning();
      workspaceId = created.id;
    }

    const [profile] = await tx
      .insert(profilesTable)
      .values({ clerkUserId, email, workspaceId })
      .returning();
    logger.info({ clerkUserId, workspaceId }, "Provisioned new profile/workspace");
    return profile;
  });
}

export async function requireWorkspace(req: Request, res: Response, next: NextFunction) {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const user = await clerkClient.users.getUser(userId);
    const email =
      user.primaryEmailAddress?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      `${userId}@unknown.local`;

    const profile = await resolveOrCreateProfile(userId, email);
    req.workspaceId = profile.workspaceId;
    req.profileId = profile.id;
    req.clerkUserId = userId;
    next();
  } catch (err) {
    logger.error({ err }, "Failed to resolve workspace for authenticated request");
    res.status(500).json({ error: "Failed to resolve workspace" });
  }
}
