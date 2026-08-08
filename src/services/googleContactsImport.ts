import { db } from "@workspace/db";
import { clientsTable } from "@workspace/db";
import type { Client } from "@workspace/db";
import { eq, and } from "drizzle-orm";

/**
 * Decoupled module for Google Contacts CSV/XLSX import.
 *
 * Safety rule: this module NEVER deletes a client. Every write is either an
 * insert (new) or an update of a matched client (merge, never overwrite).
 */

// ── Argentine phone normalizer ────────────────────────────────────────────────

export interface PhoneNormResult {
  /** Canonical form: 549XXXXXXXXXX (digits only, no leading +) */
  normalized: string;
  /** true when the input needed format correction (missing 9, missing country code, etc.) */
  corrected: boolean;
}

/**
 * Normalize a raw phone value to the canonical Argentine mobile format 549XXXXXXXXXX (no +).
 *
 * Rules (in order):
 * 1. Strip all non-digit characters (spaces, dashes, parentheses, +, etc.).
 * 2. 549XXXXXXXXXX (13 digits) — already canonical; return as-is
 * 3. 54XXXXXXXXXX  (12 digits, no 9 after 54) — insert 9              [auto-corrected]
 * 4. XXXXXXXXXX    (10 digits, local AR area code + number) — prepend 549  [auto-corrected]
 * 5. Anything else — invalid, return null (will be discarded).
 */
export function normalizePhoneARG(raw: string | number | null | undefined): PhoneNormResult | null {
  if (raw == null || raw === "") return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  // Rule 2: already has country code + mobile 9, 13 digits
  if (digits.startsWith("549") && digits.length === 13) {
    return { normalized: digits, corrected: false };
  }

  // Rule 3: country code 54 present but mobile 9 missing, 12 digits → insert 9
  if (digits.startsWith("54") && !digits.startsWith("549") && digits.length === 12) {
    return { normalized: `549${digits.slice(2)}`, corrected: true };
  }

  // Rule 4: local Argentine number (10 digits), assume mobile → prepend 549
  if (digits.length === 10) {
    return { normalized: `549${digits}`, corrected: true };
  }

  // Not a recognized format — discard
  return null;
}

/** Strip leading + for comparison against existing DB rows. */
function phoneDigitsOnly(phone: string): string {
  return phone.replace(/^\+/, "");
}

/**
 * Fix ASKY / double-encoding artifacts that appear when a UTF-8 file was
 * mistakenly read as Latin-1.  In that scenario "á" (UTF-8 bytes C3 A1)
 * becomes the two-character string "Ã¡".  We detect the pattern and reverse
 * it by treating each character as a raw Latin-1 byte and re-decoding as UTF-8.
 *
 * We only attempt the fix when the string contains "Ã" or "Â" (the two most
 * common lead bytes that show up garbled) so the fast path is a simple indexOf.
 */
function fixAskyEncoding(s: string): string {
  if (!s.includes("Ã") && !s.includes("Â")) return s;
  try {
    // Each JS char ≤ U+00FF → treat its code point as a raw byte value.
    const bytes = Buffer.from([...s].map(c => c.charCodeAt(0) & 0xff));
    const decoded = bytes.toString("utf8");
    // If decoding introduced replacement characters (U+FFFD) the original
    // string was not ASKY-encoded; keep the original.
    return decoded.includes("\uFFFD") ? s : decoded;
  } catch {
    return s;
  }
}

// ── CSV / XLSX parsing ────────────────────────────────────────────────────────

/** Minimal RFC-4180 CSV parser (handles quoted fields, escaped quotes, commas/newlines inside quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

/**
 * Parse XLSX binary buffer to an array-of-arrays (same shape as parseCsv output).
 * Uses the `xlsx` package which is already installed in api-server.
 */
export async function parseXlsxBuffer(buf: Buffer): Promise<string[][]> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buf, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
  // Convert every cell to string; null/undefined → ""
  return raw.map(row => (row as unknown[]).map(cell => (cell == null ? "" : String(cell))));
}

/** Detect XLSX by the PK ZIP magic bytes at the start of the buffer. */
export function isXlsxBuffer(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B;
}

// ── Column detection ──────────────────────────────────────────────────────────

function findColumn(headers: string[], patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const idx = headers.findIndex(h => pattern.test(h.trim()));
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Find ALL phone value columns (Phone 1 - Value, Phone 2 - Value, …).
 * Returns column indices in order.
 */
function findPhoneValueColumns(headers: string[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim();
    if (/^phone\s*\d*\s*-\s*value$/i.test(h) || /^phone$/i.test(h)) {
      indices.push(i);
    }
  }
  return indices;
}

// ── Row mapping ───────────────────────────────────────────────────────────────

export interface MappedGoogleRow {
  rowIndex: number;
  /** Which contact row in the source file this came from (0-based, after header) */
  sourceContactIndex: number;
  name: string | null;
  company: string | null;
  position: string | null;
  email: string | null;
  phone: string | null;
  /** true if the phone needed auto-correction */
  phoneCorrected: boolean;
  notes: string | null;
  labels: string[];
}

export interface ParseResult {
  rows: MappedGoogleRow[];
  parseErrors: string[];
  /** Stats for the import report */
  contactsRead: number;
  phonesFound: number;
  phonesCorrected: number;
  phonesDiscarded: number;
}

/**
 * Map a 2D table (header row + data rows) to MappedGoogleRow[].
 * One row is produced PER VALID PHONE. A contact with 3 phones yields 3 rows.
 * A contact with no valid phone yields one row with phone=null (will be "invalid").
 *
 * Phones that fail normalization are counted as discarded but never concatenated
 * or merged into another phone — they simply do not produce a row.
 */
export function parseGoogleContactsTable(table: string[][]): ParseResult {
  const parseErrors: string[] = [];
  if (table.length === 0) return { rows: [], parseErrors: ["El archivo está vacío."], contactsRead: 0, phonesFound: 0, phonesCorrected: 0, phonesDiscarded: 0 };

  const headers = table[0];
  const nameIdx      = findColumn(headers, [/^name$/i, /^first name$/i, /^given name$/i]);
  const lastNameIdx  = findColumn(headers, [/^last name$/i, /^family name$/i]);
  const orgNameIdx   = findColumn(headers, [/^organization name$/i, /^organization\s*1\s*-\s*name$/i, /^company$/i]);
  const orgTitleIdx  = findColumn(headers, [/^organization title$/i, /^organization\s*1\s*-\s*title$/i, /^title$/i]);
  const emailIdx     = findColumn(headers, [/^e-?mail\s*1\s*-\s*value$/i, /^e-?mail$/i]);
  const notesIdx     = findColumn(headers, [/^notes$/i]);
  const labelsIdx    = findColumn(headers, [/^labels$/i, /^group membership$/i]);
  const phoneIndices = findPhoneValueColumns(headers);

  if (nameIdx === -1 && orgNameIdx === -1) {
    parseErrors.push("No se encontró una columna de nombre reconocible (First Name / Name / Organization Name).");
  }
  if (phoneIndices.length === 0) {
    parseErrors.push(`No se encontró ninguna columna de teléfono (Phone X - Value). Columnas encontradas: ${headers.map(h => h.trim()).filter(Boolean).join(", ")}`);
  }

  const rows: MappedGoogleRow[] = [];
  let phonesFound = 0;
  let phonesCorrected = 0;
  let phonesDiscarded = 0;
  let expandedRowIndex = 0;

  // Track seen phones across the whole import to avoid creating duplicates within
  // the same file (e.g. same number in Phone 1 and Phone 2 of different contacts).
  const seenPhones = new Set<string>();

  for (let i = 1; i < table.length; i++) {
    const cols = table[i];
    const get = (idx: number): string =>
      (idx >= 0 && idx < cols.length ? cols[idx]?.trim() || "" : "");

    const firstOrFullName = get(nameIdx);
    const lastName = get(lastNameIdx);
    const name = [firstOrFullName, lastName].filter(Boolean).join(" ").trim();
    const company  = get(orgNameIdx) || null;
    const position = get(orgTitleIdx) || null;
    const email    = get(emailIdx) || null;
    const notes    = get(notesIdx) || null;
    const labelsRaw = get(labelsIdx);
    const labels = labelsRaw
      ? labelsRaw.split(/[:,]/).map(l => l.trim().replace(/^\*\s*/, "")).filter(l => l && l.toLowerCase() !== "mycontacts")
      : [];

    // Skip fully blank rows
    if (!name && !company && !email && phoneIndices.every(idx => !get(idx))) continue;

    const displayName = name || company || "Sin nombre";
    const contactSourceIndex = i - 1;

    // Collect all phones from all phone columns for this contact
    const validPhones: Array<{ phone: string; corrected: boolean }> = [];

    for (const pIdx of phoneIndices) {
      const rawPhone = get(pIdx);
      if (!rawPhone) continue;
      phonesFound++;

      const result = normalizePhoneARG(rawPhone);
      if (!result) {
        phonesDiscarded++;
        continue;
      }

      // Deduplicate within the same import
      const digits = phoneDigitsOnly(result.normalized);
      if (seenPhones.has(digits)) {
        phonesDiscarded++;
        continue;
      }
      seenPhones.add(digits);

      if (result.corrected) phonesCorrected++;
      validPhones.push({ phone: result.normalized, corrected: result.corrected });
    }

    if (validPhones.length === 0) {
      // No valid phone — keep as a single row marked as invalid
      rows.push({
        rowIndex: expandedRowIndex++,
        sourceContactIndex: contactSourceIndex,
        name: displayName,
        company,
        position,
        email,
        phone: null,
        phoneCorrected: false,
        notes,
        labels,
      });
    } else {
      // One row per valid phone
      for (const { phone, corrected } of validPhones) {
        rows.push({
          rowIndex: expandedRowIndex++,
          sourceContactIndex: contactSourceIndex,
          name: displayName,
          company,
          position,
          email,
          phone,
          phoneCorrected: corrected,
          notes,
          labels,
        });
      }
    }
  }

  return {
    rows,
    parseErrors,
    contactsRead: table.length - 1,
    phonesFound,
    phonesCorrected,
    phonesDiscarded,
  };
}

/** Convenience: parse a CSV string directly (used in tests / legacy paths). */
export function parseGoogleContactsCsv(csvText: string): ParseResult {
  return parseGoogleContactsTable(parseCsv(csvText));
}

// ── Similarity / duplicate detection ─────────────────────────────────────────

function normalizeText(s: string | null | undefined): string {
  return fixAskyEncoding(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Industry-generic words (normalized, no accents) that MUST NOT be used as
 * discriminating company identifiers. These words appear across many unrelated
 * businesses and cause false-positive duplicate matches.
 *
 * Example: "Juan Mantenimiento - Magromer" vs "Dario Mantenimiento - Arcolor"
 * should NOT match; "mantenimiento" must be excluded from token comparison.
 */
const BUSINESS_GENERIC_WORDS = new Set([
  // Maintenance & repair
  "mantenimiento", "reparaciones", "reparacion", "instalaciones", "instalacion",
  "montaje", "servicio", "servicios", "limpieza", "lavado",
  // Administration & management
  "administracion", "administrador", "administradora", "administradores",
  "gerencia", "gerente", "gerentes", "direccion", "direcciones",
  "presidencia", "presidente",
  // Construction & trades
  "construccion", "construcciones", "obras", "obra", "taller", "talleres",
  "pintura", "pintureria", "herreria", "carpinteria", "plomeria", "cerrajeria",
  // Technical domains (appear in many company names)
  "electrica", "electrico", "electronica", "electronico", "hidraulica", "hidraulico",
  "neumatica", "neumatico", "mecanica", "mecanico", "automatizacion",
  "ingenieria", "tecnologia", "sistemas", "soluciones", "integrales", "integral",
  "tecnica", "tecnico", "tecnicas", "tecnicos", "electromecanica",
  // Logistics & commerce
  "logistica", "transporte", "distribuidora", "distribuidor", "distribuidores",
  "ventas", "venta", "comercial", "comerciales", "comercio", "importaciones",
  "exportaciones", "compras",
  // Business & organizational
  "empresa", "empresas", "industrias", "industria", "negocios", "negocio",
  "grupo", "corporacion", "holding", "asociados", "asociado", "hermanos",
  "hermano", "sociedad", "sociedades", "anonima", "limitada", "asociacion",
  // Facility & energy
  "sanitaria", "sanitario", "refrigeracion", "climatizacion", "calefaccion",
  "electricidad", "gasoducto", "gasista",
  // Geographic & generic
  "general", "generales", "nacional", "argentina", "argentino",
  "internacional", "regional", "centro", "norte", "sur", "este", "oeste",
  // Professional services
  "agencia", "consultora", "consultoria", "asesoria", "seguros", "seguridad",
  "inversiones", "inmobiliaria",
  // Common Argentine surnames (7-9 chars) — must not be treated as company identifiers.
  // 6-char surnames are excluded automatically by the ≥7 token length threshold below.
  "herrera", "aguilar", "ramirez", "morales", "fuentes", "peralta",
  "miranda", "gimenez", "benitez", "acevedo", "estrada", "zamora",
  "navarro", "paredes", "salazar", "delgado", "jimenez", "alvarado",
  "guerrero", "salgado", "castillo", "sandoval",
  "martinez", "fernandez", "rodriguez", "gonzalez", "hernandez",
  "gutierrez", "pereyra", "caballero", "contreras", "villanueva",
  // ── Common Argentine first names ≥7 chars ────────────────────────────────────
  // First names must never act as discriminating identifiers: "nicolas" in two
  // unrelated contacts ("Nicolas Onyoff" vs "Nicolas - Sal Park") must NOT match.
  // All entries are normalized (no accents, lowercase).
  // 7-char first names
  "nicolas", "marcelo", "rodrigo", "natalia", "daniela", "marcela",
  "claudia", "valeria", "gustavo", "roberto", "ernesto", "horacio",
  "alfredo", "alberto", "gerardo", "agustin", "adriana", "julieta",
  "soledad", "silvana", "viviana", "mariana", "beatriz", "vanessa",
  "lorenza", "marisol", "leandro", "facundo", "gonzalo", "leticia",
  "ignacio", "luciano", "claudio", "antonio", "ricardo", "eduardo",
  "esteban", "lorraine",
  // 8-char first names
  "graciela", "cristian", "carolina", "patricia", "veronica", "fernanda",
  "josefina", "agustina", "catalina", "andreina", "angelica", "georgina",
  "mauricio", "patricio", "cristina", "ezequiel", "jonathan",
  // 9-char first names
  "alejandro", "alejandra", "sebastian", "guillermo", "florencia",
  "francisco", "francisca", "valentina", "constanza", "alejandra",
  // 10+ char first names
  "maximiliano", "maximiliana",
]);

/**
 * Returns entity-specific identifier tokens from a normalized name string.
 * These are words ≥6 chars that are NOT in the generic business word list.
 *
 * These tokens represent brand names or place names that uniquely identify an
 * entity — e.g. "magromer" (8), "arcolor" (7), "cruzzolin" (9), "belgrano" (8).
 *
 * Threshold ≥7 chars excludes nearly all common given names and short surnames
 * (marcos=6, garcia=6, romero=6, torres=6, flores=6, etc.) without extra lists.
 * Longer common surnames are covered by BUSINESS_GENERIC_WORDS above.
 */
function discriminatingTokens(normalized: string): string[] {
  return normalized.split(" ").filter(t => t.length >= 7 && !BUSINESS_GENERIC_WORDS.has(t));
}

/**
 * Returns true if two contact/company names likely refer to the same entity.
 *
 * Strategy (in priority order):
 * 1. Exact match after normalization — trivially the same.
 * 2. Levenshtein ≤15% of longer string — catches typos and minor differences.
 * 3. Discriminating-token comparison:
 *    a. Extract entity-specific tokens (≥6 chars, not generic business words).
 *    b. If BOTH sides have discriminating tokens:
 *       - Any shared token → same entity ("magromer" in both → match).
 *       - No shared tokens → definitively different entities ("magromer" vs
 *         "arcolor" → NOT a match, even if the rest of the name looks similar).
 *    c. If only ONE side has discriminating tokens (the other is all-generic):
 *       → cannot determine; fall through as no match.
 *
 * This means two contacts that share only generic words ("Juan Mantenimiento"
 * and "Dario Mantenimiento") are NEVER flagged as duplicates.
 */
function namesAreSimilar(a: string, b: string): boolean {
  const na = normalizeText(a), nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  // 1. Levenshtein — handles typos/abbreviations in short or very similar strings
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen >= 4 && levenshtein(na, nb) <= Math.max(1, Math.floor(maxLen * 0.15))) return true;

  // 2. Discriminating-token comparison
  const discA = discriminatingTokens(na);
  const discB = discriminatingTokens(nb);

  // 2b. Compute short (≥3, non-generic) tokens — used in steps 3 and 4 below.
  const shortTokens = (s: string) =>
    s.split(" ").filter(t => t.length >= 3 && !BUSINESS_GENERIC_WORDS.has(t));
  const stA = shortTokens(na);
  const stB = shortTokens(nb);

  if (discA.length > 0 && discB.length > 0) {
    const setB = new Set(discB);
    // Shared specific identifier → same entity
    if (discA.some(t => setB.has(t))) return true;
    // Different specific identifiers → definitively distinct, don't match
    return false;
  }

  // 3. Asymmetric case: one side has discriminating tokens, the other doesn't.
  //    This happens when the DB stores "Daniel Alzuet - Central de Sabores"
  //    (has "central", "sabores" as disc tokens) but the import has just
  //    "Daniel Alzuet" (no token ≥7 chars).  We resolve it by checking whether
  //    the shorter side's meaningful tokens are a complete subset of the longer
  //    side's — i.e. the shorter string is a prefix of the full record.
  //    Guard: require ≥2 tokens on the short side so a lone first name
  //    ("Nicolas") can't accidentally match "Nicolas - Any Company".
  if ((discA.length === 0) !== (discB.length === 0)) {
    // Exactly one side has no discriminating tokens
    if (stA.length >= 2 && stB.length >= 2) {
      const [shorter, longer] =
        stA.length <= stB.length ? [stA, stB] : [stB, stA];
      const longerSet = new Set(longer);
      // The shorter set must be fully contained in the longer one, and the
      // surplus tokens in the longer set should be at most 4 (company words).
      if (
        shorter.every(t => longerSet.has(t)) &&
        longer.length - shorter.length <= 4
      ) {
        return true;
      }
    }
    return false;
  }

  // 4. Token-set equality fallback for all-short / all-generic names.
  //    When neither side produced a discriminating token (≥7 chars, non-generic),
  //    compare the full sets of meaningful tokens (≥3 chars, non-generic).
  //    Exact bidirectional match → same entity.
  //    Example: "Carlos Perez" vs "Carlos Perez" → match even with no 7-char token.
  //    "Carlos" vs "Carlos Gil" → sets differ → no match (avoids false positives).
  if (discA.length === 0 && discB.length === 0) {
    if (stA.length > 0 && stB.length > 0) {
      const setA = new Set(stA);
      const setB = new Set(stB);
      if (stA.every(t => setB.has(t)) && stB.every(t => setA.has(t))) return true;
    }
  }

  return false;
}

export interface DuplicateCandidate {
  clientId: number;
  name: string;
  company: string | null;
  phone: string;
  email: string | null;
  reason: "phone" | "email" | "similar_name" | "company_and_name";
}

export function findDuplicateCandidates(
  candidate: { name?: string | null; company?: string | null; email?: string | null; phone?: string | null },
  existingClients: Client[],
  excludeClientId?: number | null,
): DuplicateCandidate[] {
  const pool = existingClients.filter(c => c.id !== excludeClientId);
  const matches: DuplicateCandidate[] = [];

  if (candidate.phone) {
    // Strip + for comparison — DB may store with or without leading +
    const candidateDigits = phoneDigitsOnly(candidate.phone);
    const byPhone = pool.find(c => phoneDigitsOnly(c.phone) === candidateDigits);
    if (byPhone) {
      matches.push({ clientId: byPhone.id, name: byPhone.name, company: byPhone.company, phone: byPhone.phone, email: byPhone.email, reason: "phone" });
    }
  }

  if (candidate.email) {
    const emailNorm = candidate.email.trim().toLowerCase();
    const byEmail = pool.find(c => c.email?.trim().toLowerCase() === emailNorm && !matches.some(m => m.clientId === c.id));
    if (byEmail) {
      matches.push({ clientId: byEmail.id, name: byEmail.name, company: byEmail.company, phone: byEmail.phone, email: byEmail.email, reason: "email" });
    }
  }

  if (candidate.name) {
    for (const c of pool) {
      if (matches.some(m => m.clientId === c.id)) continue;
      const nameSimilar = namesAreSimilar(candidate.name, c.name);
      if (!nameSimilar) continue;

      // Company check: only BLOCK the match when both sides have a company and
      // their discriminating tokens are mutually exclusive (clearly different orgs).
      // Different formatting ("Administracion Trimsa" vs "Trimsa") must NOT block.
      if (candidate.company && c.company) {
        const discCand = discriminatingTokens(normalizeText(candidate.company));
        const discDB   = discriminatingTokens(normalizeText(c.company));
        if (discCand.length > 0 && discDB.length > 0) {
          const setDB = new Set(discDB);
          const anyShared = discCand.some(t => setDB.has(t));
          if (!anyShared) continue; // definitively different orgs — skip
        }
      }

      matches.push({ clientId: c.id, name: c.name, company: c.company, phone: c.phone, email: c.email, reason: "similar_name" });
    }
  }

  // 4. Company-based match: if the candidate has a company with identifiable tokens
  //    (≥5 chars, non-generic) AND a DB client's company OR name contains those tokens
  //    AND the names share at least one common token (≥3 chars) → same person.
  //
  //    Catches: "Cristian Pose" at "Servimed SC" matching DB "Cristian Pose - Servimed SC"
  //    even when the phone format changed or was corrected.
  //    Guard: requires name token overlap so two different people at the same company
  //    ("Juan Garcia" vs "Pedro Lopez" both at "Servimed") are NOT merged.
  if (candidate.company && candidate.name) {
    const candCompTokens = normalizeText(candidate.company)
      .split(" ")
      .filter(t => t.length >= 5 && !BUSINESS_GENERIC_WORDS.has(t));

    if (candCompTokens.length > 0) {
      const candNameTokens = normalizeText(candidate.name)
        .split(" ")
        .filter(t => t.length >= 3 && !BUSINESS_GENERIC_WORDS.has(t));

      for (const c of pool) {
        if (matches.some(m => m.clientId === c.id)) continue;

        // Build a search surface from the DB client's company + name
        // (handles both "company=Servimed SC" and name="Cristian - Servimed SC")
        const dbSurface = [c.company, c.name]
          .filter(Boolean)
          .map(s => normalizeText(s!))
          .join(" ");
        const dbSurfaceTokens = new Set(
          dbSurface.split(" ").filter(t => t.length >= 5 && !BUSINESS_GENERIC_WORDS.has(t)),
        );

        const companyShared = candCompTokens.some(t => dbSurfaceTokens.has(t));
        if (!companyShared) continue;

        // Require the names to also share at least one token (prevents false merges
        // of different people at the same company).
        const dbNameTokens = new Set(
          normalizeText(c.name).split(" ").filter(t => t.length >= 3),
        );
        const nameShared = candNameTokens.some(t => dbNameTokens.has(t));
        if (!nameShared) continue;

        matches.push({
          clientId: c.id, name: c.name, company: c.company,
          phone: c.phone, email: c.email, reason: "company_and_name",
        });
      }
    }
  }

  return matches;
}

// ── Import execution ──────────────────────────────────────────────────────────

export interface GoogleImportRow {
  rowIndex: number;
  name: string;
  company?: string;
  position?: string;
  email?: string;
  phone?: string;
  notes?: string;
  labels?: string[];
  matchedClientId?: number | null;
}

export interface ImportOutcome {
  imported: number;
  updated: number;
  errors: number;
}

export async function applyGoogleImportRows(rows: GoogleImportRow[], workspaceId: number): Promise<ImportOutcome> {
  let imported = 0, updated = 0, errors = 0;
  const now = new Date();
  // Track phones committed in this batch to avoid double-importing the same number
  // when the user confirmed two rows for the same phone (shouldn't happen via UI but guard here).
  const committedPhones = new Set<string>();

  for (const row of rows) {
    try {
      const normalizedPhone = row.phone
        ? (() => { const r = normalizePhoneARG(row.phone); return r?.normalized ?? null; })()
        : null;

      if (normalizedPhone) {
        const digits = phoneDigitsOnly(normalizedPhone);
        if (committedPhones.has(digits)) { errors++; continue; }
        committedPhones.add(digits);
      }

      if (row.matchedClientId) {
        const [existing] = await db.select().from(clientsTable)
          .where(and(eq(clientsTable.id, row.matchedClientId), eq(clientsTable.workspaceId, workspaceId)));
        if (!existing) { errors++; continue; }
        const mergedTags = Array.from(new Set([...(existing.tags ?? []), ...(row.labels ?? [])]));
        // Apply all non-empty values from the import row so that corrections
        // made in an external editor and re-imported flow through correctly.
        // Fall back to the existing DB value only when the row field is empty.
        await db.update(clientsTable).set({
          name:     row.name     || existing.name,
          company:  row.company  || existing.company  || null,
          position: row.position || existing.position || null,
          email:    row.email    || existing.email    || null,
          notes:    row.notes    || existing.notes    || null,
          tags: mergedTags,
          googleContactId: existing.googleContactId ?? `csv:${row.rowIndex}:${normalizedPhone ?? row.email ?? row.name}`,
          lastGoogleSync: now,
          syncStatus: "updated",
          isGoogleContact: true,
        }).where(and(eq(clientsTable.id, row.matchedClientId), eq(clientsTable.workspaceId, workspaceId)));
        updated++;
      } else {
        if (!normalizedPhone) { errors++; continue; }
        await db.insert(clientsTable).values({
          workspaceId,
          name:     row.name || "Sin nombre",
          company:  row.company  || null,
          phone:    normalizedPhone,
          email:    row.email    || null,
          position: row.position || null,
          notes:    row.notes    || null,
          tags:     row.labels   ?? [],
          priority: "B",
          stage:    "prospect",
          googleContactId: `csv:${row.rowIndex}:${normalizedPhone}`,
          lastGoogleSync: now,
          syncStatus: "imported",
          isGoogleContact: true,
        });
        imported++;
      }
    } catch {
      errors++;
    }
  }

  return { imported, updated, errors };
}
