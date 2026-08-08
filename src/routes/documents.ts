import { Router } from "express";
import express from "express";
import { spawn } from "child_process";
import * as path from "path";
import { db } from "@workspace/db";
import { documentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import * as ai from "../services/ai";
import { extractPdfWithVision } from "../services/catalogQuery";
import { logger } from "../lib/logger";
import { rateLimit } from "../lib/rateLimit";

const router = Router();

// ── 30 MB limit scoped only to the document upload route (covers PDFs up to ~20 MB as base64) ──
const uploadBodyParser = express.json({ limit: "30mb" });

interface PdfExtractResult {
  /** Direct text from PyMuPDF (digital PDFs). Non-empty = no Vision API needed. */
  text: string;
  /** Base64 PNG images — only populated when text is insufficient (scanned PDF). */
  pages: string[];
  totalInDoc: number;
}

// ── Spawn PyMuPDF script — passes base64 PDF via stdin to avoid E2BIG ─────────
async function spawnPdfExtract(b64Pdf: string, maxPages: number): Promise<PdfExtractResult> {
  // Use __dirname (set by build banner) so the path works in both dev and production
  const scriptPath = path.resolve(__dirname, "scripts/pdf_to_images.py");
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, String(maxPages)]);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) { reject(err); return; }
      try {
        const result = JSON.parse(stdout);
        if (result.error) { reject(new Error(result.error)); return; }
        resolve({
          text: result.text ?? "",
          pages: result.pages ?? [],
          totalInDoc: result.total_in_doc ?? 0,
        });
      } catch (e) { reject(new Error(`JSON parse failed: ${e} — raw: ${stdout.substring(0, 200)}`)); }
    };

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      done(code !== 0 ? new Error(`pdf_to_images.py exited ${code}: ${stderr}`) : undefined);
    });
    proc.on("error", (e) => done(e));

    // Suppress EPIPE: if the Python process exits early (e.g. memory error),
    // stdin write will fail — we handle the actual error via proc close.
    proc.stdin.on("error", () => { /* intentionally suppressed — error captured via proc close */ });

    // Stream the base64 PDF to the script via stdin (avoids E2BIG arg-list limit)
    proc.stdin.write(b64Pdf, (err) => {
      if (err && !settled) return; // error will surface via proc close
      proc.stdin.end();
    });
  });
}

// ── Word/DOCX text extraction via mammoth ─────────────────────────────────────
async function extractDocxText(base64: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require("mammoth");
    const buf = Buffer.from(base64, "base64");
    const result = await mammoth.extractRawText({ buffer: buf });
    const text = result.value?.trim() ?? "";
    return text.length > 10 ? text : null;
  } catch (e) {
    logger.warn({ err: e }, "docx extraction failed");
    return null;
  }
}

// ── XLSX/Excel text extraction via xlsx package ───────────────────────────────
async function extractXlsxText(base64: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const XLSX = require("xlsx");
    const buf = Buffer.from(base64, "base64");
    const wb = XLSX.read(buf, { type: "buffer" });
    const lines: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      // csv conversion preserves structure for keyword search
      const csv: string = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
      if (csv.trim()) {
        lines.push(`=== Hoja: ${sheetName} ===`);
        lines.push(csv.trim());
      }
    }
    const text = lines.join("\n");
    return text.length > 10 ? text : null;
  } catch (e) {
    logger.warn({ err: e }, "xlsx extraction failed");
    return null;
  }
}

// ── Max extracted text: 200 KB to avoid memory pressure ──────────────────────
const MAX_CONTENT_CHARS = 200_000;

// ── GET /documents — metadata only, no content column ────────────────────────
router.get("/documents", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const docs = await db
    .select({
      id: documentsTable.id,
      name: documentsTable.name,
      type: documentsTable.type,
      size: documentsTable.size,
      category: documentsTable.category,
      description: documentsTable.description,
      indexed: documentsTable.indexed,
      createdAt: documentsTable.createdAt,
    })
    .from(documentsTable)
    .where(eq(documentsTable.workspaceId, workspaceId))
    .orderBy(documentsTable.createdAt);
  res.json(docs.map(d => ({ ...d, createdAt: d.createdAt.toISOString() })));
});

/**
 * POST /documents — Upload a document.
 * Body: { name, type?, category?, description?, content (base64 or plain text), isBase64? }
 *
 * For PDFs: stored as base64 blob (indexed=false). Use /reindex to extract text.
 * For xlsx: text extracted immediately via xlsx package.
 * For txt/csv: content stored as-is and indexed immediately.
 */
router.post("/documents", uploadBodyParser, async (req, res) => {
  const workspaceId = req.workspaceId!;
  try {
    const body = req.body as {
      name: string;
      type?: string;
      category?: string;
      description?: string;
      content?: string;
      isBase64?: boolean;
    };

    if (!body.name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    // Server-side size guard: base64 of 20 MB ≈ 27 MB; reject anything over 28 MB of encoded content
    const MAX_CONTENT_BYTES = 28 * 1024 * 1024;
    if (body.content && Buffer.byteLength(body.content, "utf8") > MAX_CONTENT_BYTES) {
      res.status(413).json({
        error: "Archivo demasiado grande. El límite es 20 MB. Comprimí el PDF o dividilo en partes más pequeñas.",
      });
      return;
    }

    const fileType = body.type || "pdf";
    const rawContent = body.content || "";
    let contentStr = rawContent;
    let indexed = false;

    if (body.isBase64 && rawContent) {
      if (fileType === "pdf") {
        // Store PDF as base64 blob — use /reindex (which falls back to Vision API) to extract text
        contentStr = rawContent;
        indexed = false;
      } else if (fileType === "excel" || fileType === "xlsx") {
        const extracted = await extractXlsxText(rawContent);
        if (extracted) {
          contentStr = extracted.substring(0, MAX_CONTENT_CHARS);
          indexed = true;
          logger.info({ name: body.name, chars: contentStr.length }, "Excel text extracted");
        }
      }
      // docx/images: keep base64 as-is (not text-searchable)
    } else if (!body.isBase64 && rawContent) {
      // Plain text (txt, csv)
      contentStr = rawContent.substring(0, MAX_CONTENT_CHARS);
      indexed = true;
    }

    // `size` reflects the original file size (base64 → ~75% of original bytes)
    const size = body.isBase64
      ? Math.floor(Buffer.byteLength(rawContent, "utf-8") * 0.75)
      : Buffer.byteLength(rawContent, "utf-8");

    const [doc] = await db.insert(documentsTable).values({
      workspaceId,
      name: body.name,
      type: fileType,
      size,
      category: body.category || null,
      description: body.description || null,
      content: contentStr,
      indexed,
    }).returning({
      id: documentsTable.id,
      name: documentsTable.name,
      type: documentsTable.type,
      size: documentsTable.size,
      category: documentsTable.category,
      description: documentsTable.description,
      indexed: documentsTable.indexed,
      createdAt: documentsTable.createdAt,
    });

    res.status(201).json({ ...doc, createdAt: doc.createdAt.toISOString() });
  } catch (e) {
    logger.error({ err: e }, "Document upload failed");
    res.status(500).json({ error: "Upload failed" });
  }
});

// Search — must precede /:id
router.post("/documents/search", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const { query, limit = 5 } = req.body as { query: string; limit?: number };
  const results = await ai.searchDocuments(query, limit, workspaceId);
  res.json(results);
});

/**
 * POST /documents/:id/reindex — Re-extract text from a stored binary document.
 *
 * PDFs — two-stage strategy:
 *   1. PyMuPDF direct text extraction (fast, free — works for digital PDFs).
 *   2. If text < 50 chars (scanned/image PDF), render pages and call Groq Vision API.
 * Excel — xlsx package.
 * Plain text — already indexed, re-stores as-is.
 */
// 0.4: Heavy route — PDF extraction + optional Vision API — limit 10 req/min per IP
router.post("/documents/:id/reindex", rateLimit({ max: 10, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [doc] = await db.select().from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.workspaceId, workspaceId)))
    .limit(1);
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const rawContent = doc.content ?? "";
  let newContent: string | null = null;
  let method = "unknown";

  // Detect base64 (binary blob has very low whitespace ratio)
  const sample = rawContent.substring(0, 200);
  const isBase64 = (sample.match(/\s/g) || []).length / Math.max(sample.length, 1) < 0.02;

  if (isBase64) {
    if (doc.type === "pdf") {
      logger.info({ id, name: doc.name }, "Extracting PDF text via PyMuPDF");
      try {
        const extracted = await spawnPdfExtract(rawContent, 20);

        if (extracted.text.length >= 50) {
          // ✅ Digital PDF — text extracted directly, no AI needed
          newContent = extracted.text;
          method = "pymupdf-text";
          logger.info({ id, chars: newContent.length }, "PDF text extracted directly (digital PDF)");
        } else if (extracted.pages.length > 0) {
          // 📷 Scanned/image PDF — fall back to Groq Vision API
          logger.info({ id, pages: extracted.pages.length }, "No embedded text — using Vision API (scanned PDF)");
          try {
            newContent = await extractPdfWithVision(extracted.pages, doc.name);
            method = "vision-groq";
          } catch (e: any) {
            logger.error({ err: e, id }, "Vision API extraction failed");
            res.status(500).json({
              error: `El PDF parece ser un escaneo, pero la extracción por IA falló: ${e.message}`,
            });
            return;
          }
        } else {
          res.status(422).json({ error: "El PDF no contiene páginas legibles." });
          return;
        }
      } catch (e: any) {
        logger.error({ err: e, id }, "PyMuPDF extraction failed");
        res.status(500).json({ error: `Error procesando el PDF: ${e.message}` });
        return;
      }
    } else if (doc.type === "excel" || doc.type === "xlsx") {
      newContent = await extractXlsxText(rawContent);
      method = "xlsx";
    } else if (doc.type === "word") {
      newContent = await extractDocxText(rawContent);
      method = "docx";
    }
  } else if (rawContent.trim()) {
    // Already plain text (txt/csv uploaded as text)
    newContent = rawContent;
    method = "plaintext";
  }

  if (!newContent || newContent.length < 10) {
    const typeHint =
      doc.type === "pdf"
        ? "Si es un PDF escaneado, asegurate de que tenga buena resolución de imagen."
        : doc.type === "excel" || doc.type === "xlsx"
        ? "Verificá que el archivo Excel no esté vacío o protegido."
        : "Verificá que el archivo tenga contenido de texto legible.";
    res.status(422).json({ error: `No se pudo extraer texto de este documento. ${typeHint}` });
    return;
  }

  const truncated = newContent.substring(0, MAX_CONTENT_CHARS);
  await db.update(documentsTable)
    .set({ content: truncated, indexed: true })
    .where(and(eq(documentsTable.id, id), eq(documentsTable.workspaceId, workspaceId)));

  logger.info({ id, name: doc.name, chars: truncated.length, method }, "Document re-indexed");
  res.json({ id, name: doc.name, indexed: true, chars: truncated.length, method });
});

/**
 * POST /documents/:id/extract-ai
 * Re-extracts text from an image-based PDF using Gemini Vision API.
 * Uses PyMuPDF to render each page to PNG, then sends to Vision API.
 * Stores the extracted text and marks the document as indexed.
 */
// 0.4: Vision API calls are expensive — limit 5 req/min per IP
router.post("/documents/:id/extract-ai", rateLimit({ max: 5, windowMs: 60_000 }), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [doc] = await db.select().from(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.workspaceId, workspaceId)))
    .limit(1);
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  if (doc.type !== "pdf") {
    res.status(422).json({ error: "Este endpoint solo procesa documentos PDF" });
    return;
  }

  const rawContent = doc.content ?? "";
  if (!rawContent) {
    res.status(422).json({ error: "Documento sin contenido almacenado" });
    return;
  }

  // Determine base64 payload (either stored raw or needs re-extraction)
  const sample = rawContent.substring(0, 200);
  const isStoredBase64 = (sample.match(/\s/g) || []).length / Math.max(sample.length, 1) < 0.02;
  const b64Pdf = isStoredBase64 ? rawContent : Buffer.from(rawContent).toString("base64");

  // Hard-cap maxPages: min 1, max 20, default 10
  const rawMax = parseInt(String(req.body?.maxPages ?? 10), 10);
  const maxPages = Math.min(Math.max(isNaN(rawMax) ? 10 : rawMax, 1), 20);

  logger.info({ id, name: doc.name }, "Starting AI Vision PDF extraction");

  let pages: string[] = [];
  try {
    const extracted = await spawnPdfExtract(b64Pdf, maxPages);
    // For extract-ai we always use vision; but if direct text is sufficient, use it
    if (extracted.text.length >= 50) {
      const truncated = extracted.text.substring(0, MAX_CONTENT_CHARS);
      await db.update(documentsTable).set({ content: truncated, indexed: true })
        .where(and(eq(documentsTable.id, id), eq(documentsTable.workspaceId, workspaceId)));
      logger.info({ id, name: doc.name, chars: truncated.length }, "PDF text extracted directly (no vision needed)");
      res.json({ id, name: doc.name, indexed: true, chars: truncated.length, pagesProcessed: 0, method: "pymupdf-text" });
      return;
    }
    pages = extracted.pages;
  } catch (e: any) {
    logger.error({ err: e, id }, "PDF rendering failed");
    res.status(500).json({ error: `Error renderizando PDF: ${e.message}` });
    return;
  }

  if (!pages.length) {
    res.status(422).json({ error: "No se pudieron renderizar páginas del PDF" });
    return;
  }

  logger.info({ id, pages: pages.length }, "PDF rendered — sending to Vision API");

  let extractedText = "";
  try {
    extractedText = await extractPdfWithVision(pages, doc.name);
  } catch (e: any) {
    logger.error({ err: e, id }, "Vision extraction failed");
    res.status(500).json({ error: `Error en extracción IA: ${e.message}` });
    return;
  }

  if (!extractedText || extractedText.length < 10) {
    res.status(422).json({ error: "La IA no pudo extraer texto de este PDF" });
    return;
  }

  const truncated = extractedText.substring(0, MAX_CONTENT_CHARS);
  await db.update(documentsTable)
    .set({ content: truncated, indexed: true })
    .where(and(eq(documentsTable.id, id), eq(documentsTable.workspaceId, workspaceId)));

  logger.info({ id, name: doc.name, chars: truncated.length, pagesProcessed: pages.length }, "AI Vision extraction complete");
  res.json({ id, name: doc.name, indexed: true, chars: truncated.length, pagesProcessed: pages.length });
});

router.delete("/documents/:id", async (req, res) => {
  const workspaceId = req.workspaceId!;
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(documentsTable)
    .where(and(eq(documentsTable.id, id), eq(documentsTable.workspaceId, workspaceId)));
  res.status(204).end();
});

export default router;
