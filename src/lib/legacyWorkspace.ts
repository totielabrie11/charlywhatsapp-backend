/**
 * Name of the workspace created by the multi-tenant migration
 * (see scripts/backfillWorkspaces.ts) that inherited all data that existed
 * before multi-tenancy. The first person who ever signs in claims it (see
 * middlewares/workspaceAuth.ts) so nothing pre-existing is orphaned.
 */
export const LEGACY_WORKSPACE_NAME = "Workspace principal";
