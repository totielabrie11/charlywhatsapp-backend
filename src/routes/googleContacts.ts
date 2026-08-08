import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db";
import { eq, desc, and, isNotNull } from "drizzle-orm";
import {
  CheckClientDuplicatesBody,
  CheckClientDuplicatesResponse,
  PreviewGoogleContactsImportBody,
  PreviewGoogleContactsImportResponse,
  ConfirmGoogleContactsImportBody,
  ConfirmGoogleContactsImportResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  parseGoogleContactsTable,
  parseGoogleContactsCsv,
  parseXlsxBuffer,
  isXlsxBuffer,
  findDuplicateCandidates,
  applyGoogleImportRows,
} from "../services/googleContactsImport";

// Decoupled Google Contacts CSV/XLSX import module.
const router: IRouter = Router();

router.post("/clients/duplicate-check", async (req, res): Promise<void> => {
  const workspaceId = req.workspaceId!;
  const parsed = CheckClientDuplicatesBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const existingClients = await db.select().from(clientsTable).where(eq(clientsTable.workspaceId, workspaceId));
  const matches = findDuplicateCandidates(parsed.data, existingClients, parsed.data.excludeClientId);
  res.json(CheckClientDuplicatesResponse.parse({ matches }));
});

router.post("/clients/google-import/preview", async (req, res): Promise<void> => {
  const workspaceId = req.workspaceId!;
  const parsed = PreviewGoogleContactsImportBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  let parseResult: Awaited<ReturnType<typeof parseGoogleContactsCsv>>;
  try {
    const buf = Buffer.from(parsed.data.csvBase64, "base64");
    if (isXlsxBuffer(buf)) {
      // XLSX file — parse with xlsx package, then map columns
      const table = await parseXlsxBuffer(buf);
      parseResult = parseGoogleContactsTable(table);
    } else {
      // CSV file
      const csvText = buf.toString("utf-8");
      parseResult = parseGoogleContactsCsv(csvText);
    }
  } catch {
    res.status(400).json({ error: "No se pudo leer el archivo. Verificá que sea un CSV o XLSX exportado de Google Contacts." });
    return;
  }

  const { rows, parseErrors, contactsRead, phonesFound, phonesCorrected, phonesDiscarded } = parseResult;

  const existingClients = await db.select().from(clientsTable).where(eq(clientsTable.workspaceId, workspaceId));

  const previewRows = rows.map(row => {
    const candidates = findDuplicateCandidates(
      { name: row.name, company: row.company, email: row.email, phone: row.phone },
      existingClients,
    );
    // Any match (phone, email, or name similarity) → protect the existing client
    const phoneOrEmailMatch = candidates.find(c => c.reason === "phone" || c.reason === "email");
    if (phoneOrEmailMatch) {
      return {
        ...row,
        matchType: "exists" as const,
        matchedClientId: phoneOrEmailMatch.clientId,
        matchReason: phoneOrEmailMatch.reason === "phone"
          ? `Ya existe · mismo teléfono → "${phoneOrEmailMatch.name}"`
          : `Ya existe · mismo email → "${phoneOrEmailMatch.name}"`,
      };
    }
    const similarMatch = candidates.find(
      c => c.reason === "similar_name" || c.reason === "company_and_name",
    );
    if (similarMatch) {
      const reason = similarMatch.reason === "company_and_name"
        ? `Ya existe · empresa y nombre coinciden → "${similarMatch.name}"`
        : `Ya existe · nombre similar → "${similarMatch.name}"`;
      return {
        ...row,
        matchType: "exists" as const,
        matchedClientId: similarMatch.clientId,
        matchReason: reason,
      };
    }
    if (!row.phone) {
      return { ...row, matchType: "invalid" as const, matchedClientId: null, matchReason: "Sin teléfono — se necesita para crear el cliente" };
    }
    return { ...row, matchType: "new" as const, matchedClientId: null, matchReason: null };
  });

  logger.info({
    contactsRead, phonesFound, phonesCorrected, phonesDiscarded,
    previewRows: previewRows.length, parseErrors: parseErrors.length,
  }, "Google Contacts import preview generated");

  res.json(PreviewGoogleContactsImportResponse.parse({
    rows: previewRows,
    totalRows: rows.length,
    parseErrors,
    contactsRead,
    phonesFound,
    phonesCorrected,
    phonesDiscarded,
  }));
});

router.post("/clients/google-import/confirm", async (req, res): Promise<void> => {
  const workspaceId = req.workspaceId!;
  const parsed = ConfirmGoogleContactsImportBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const startedAt = Date.now();
  const { imported, updated, errors } = await applyGoogleImportRows(parsed.data.rows, workspaceId);
  const durationMs = Date.now() - startedAt;

  logger.info({ read: parsed.data.rows.length, imported, updated, errors, durationMs }, "Google Contacts import confirmed");

  res.json(ConfirmGoogleContactsImportResponse.parse({
    read: parsed.data.rows.length,
    imported,
    updated,
    duplicates: 0,
    errors,
    durationMs,
  }));
});

/**
 * Export all workspace clients as an XLSX file using Google Contacts-compatible
 * column headers so the file can be edited and re-imported without any changes
 * to the structure.
 *
 * Columns that match the importer's regex patterns come first; extra CRM-only
 * columns follow and are silently ignored on re-import.
 */
router.get("/clients/google-export", async (req, res): Promise<void> => {
  const workspaceId = req.workspaceId!;

  const { conversationsTable } = await import("@workspace/db");
  const { count, isNotNull } = await import("drizzle-orm");

  const clients = await db.select().from(clientsTable)
    .where(eq(clientsTable.workspaceId, workspaceId))
    .orderBy(desc(clientsTable.createdAt));

  // Count conversations per client in a single query
  const convCounts = await db
    .select({ clientId: conversationsTable.clientId, total: count() })
    .from(conversationsTable)
    .where(and(eq(conversationsTable.workspaceId, workspaceId), isNotNull(conversationsTable.clientId)))
    .groupBy(conversationsTable.clientId);

  const convCountMap = new Map<number, number>();
  for (const row of convCounts) {
    if (row.clientId != null) convCountMap.set(row.clientId, row.total);
  }

  const XLSX = await import("xlsx");

  // Header row — names chosen to match the importer's column-detection regexes
  const header = [
    "First Name",            // → nameIdx
    "Organization 1 - Name", // → orgNameIdx
    "Phone 1 - Value",       // → phoneIndices
    "E-mail 1 - Value",      // → emailIdx
    "Notes",                 // → notesIdx
    "Labels",                // → labelsIdx
    // ── CRM-only columns (ignored on re-import) ──────────────────────────────
    "Cargo",
    "Etapa CRM",
    "Prioridad CRM",
    "Estado",
    "Conversaciones",        // count of linked WhatsApp conversations (info only)
  ];

  const dataRows = clients.map(c => [
    c.name,
    c.company   ?? "",
    c.phone     ?? "",
    c.email     ?? "",
    c.notes     ?? "",
    (c.tags     ?? []).join(" ::: "),
    c.position  ?? "",
    c.stage     ?? "",
    c.priority  ?? "",
    c.isGoogleContact
      ? (c.syncStatus === "updated" ? "actualizado" : "importado")
      : "manual",
    convCountMap.get(c.id) ?? 0,
  ]);

  const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);

  // Auto-width for readability
  const colWidths = header.map((h, i) => ({
    wch: Math.max(
      h.length,
      ...dataRows.map(r => String(r[i] ?? "").length),
    ),
  }));
  ws["!cols"] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Contactos");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="contactos-crm-${workspaceId}.xlsx"`);
  res.setHeader("Content-Length", buf.length);
  res.send(buf);
});

export default router;
