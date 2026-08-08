export * from "./generated/api";
export * from "./generated/types";

// ── Pre-existing Orval naming collisions ────────────────────────────────────
// A handful of query-param types (numeric/boolean params trigger both a zod
// validator in generated/api.ts AND a plain TS type of the same name in
// generated/types/) collide under the two `export *` above. Neither side is
// used by name anywhere in the codebase — explicit re-exports here just
// resolve the star-export ambiguity in favor of the runtime zod objects.
export type { GetConversationParams } from "./generated/api";
export type { GetConversationMessagesParams } from "./generated/api";
export type { AssignRoleDocumentBody } from "./generated/api";
