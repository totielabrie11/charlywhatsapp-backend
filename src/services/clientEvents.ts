import { db } from "@workspace/db";
import { clientEventsTable } from "@workspace/db";
import { logger } from "../lib/logger";

// Uniform event types for the client timeline. Keep this list in sync with the
// "EJEMPLOS DE EVENTOS" spec — new event kinds should be added here first.
// A few types (salesperson_changed, idea_comercial, etc.) are declared for
// forward-compatibility with future features but are not emitted anywhere yet.
export type ClientEventType =
  | "client_created"
  | "client_edited"
  | "conversation_started"
  | "message_received"
  | "message_sent"
  | "file_received"
  | "file_sent"
  | "audio_received"
  | "audio_sent"
  | "quote_requested"
  | "quote_sent"
  | "task_created"
  | "task_completed"
  | "task_cancelled"
  | "task_updated"
  | "opportunity_created"
  | "opportunity_won"
  | "opportunity_lost"
  | "opportunity_updated"
  | "opportunity_reopened"
  | "opportunity_deleted"
  | "priority_changed"
  | "stage_changed"
  | "salesperson_changed"
  | "category_changed"
  | "note_added"
  | "document_added"
  | "photo_updated"
  | "name_updated_from_wa";

const ICONS: Record<ClientEventType, string> = {
  client_created: "user-plus",
  client_edited: "pencil",
  conversation_started: "message-square",
  message_received: "message-circle",
  message_sent: "send",
  file_received: "paperclip",
  file_sent: "paperclip",
  audio_received: "mic",
  audio_sent: "mic",
  quote_requested: "file-question",
  quote_sent: "file-check-2",
  task_created: "check-square",
  task_completed: "check-circle-2",
  task_cancelled: "x-circle",
  task_updated: "pencil",
  opportunity_created: "trending-up",
  opportunity_won: "trophy",
  opportunity_lost: "trending-down",
  opportunity_updated: "pencil",
  opportunity_reopened: "trending-up",
  opportunity_deleted: "x-circle",
  priority_changed: "flag",
  stage_changed: "git-branch",
  salesperson_changed: "user",
  category_changed: "tag",
  note_added: "sticky-note",
  document_added: "file",
  photo_updated: "image",
  name_updated_from_wa: "user-check",
};

/**
 * Append one event to a client's timeline. Never throws — a failure here must
 * never break the action that triggered it (sending a message, creating a
 * task, etc.), so failures are only logged.
 *
 * Silently no-ops when `clientId` is missing: events are keyed by client, and
 * many actions (e.g. a conversation not yet linked to a client record) have
 * nowhere to attach the event yet.
 */
export async function logClientEvent(opts: {
  workspaceId: number;
  clientId: number | null | undefined;
  type: ClientEventType;
  detail: string;
  actor?: string | null;
  relatedType?: string | null;
  relatedId?: number | null;
}): Promise<void> {
  if (!opts.clientId) return;
  try {
    await db.insert(clientEventsTable).values({
      workspaceId: opts.workspaceId,
      clientId: opts.clientId,
      type: opts.type,
      icon: ICONS[opts.type] ?? "circle",
      actor: opts.actor ?? null,
      detail: opts.detail,
      relatedType: opts.relatedType ?? null,
      relatedId: opts.relatedId ?? null,
    });
  } catch (e) {
    logger.warn({ err: e, type: opts.type, clientId: opts.clientId }, "Client event log failed");
  }
}
