/**
 * Template Variable Substitution Engine — Fase 3
 *
 * Replaces {{placeholders}} in message templates with actual client data
 * before each campaign send. Pure function — no side effects.
 *
 * Supported variables:
 *   {{nombre}}    — first name only (e.g. "Carlos Martínez - Armada" → "Carlos")
 *   {{cliente}}   — full client name (alias: {{nombre}} for first-name-only)
 *   {{empresa}}   — company name (falls back to client name)
 *   {{telefono}}  — phone number
 *   {{vendedor}}  — seller / workspace display name
 *   {{fecha}}     — today's date in es-AR format (DD/MM/YYYY)
 *   {{ciudad}}    — city
 *   {{provincia}} — province
 */

export interface SubstituteContext {
  name: string;
  company?: string | null;
  phone?: string | null;
  city?: string | null;
  province?: string | null;
  vendedor?: string | null;
}

/**
 * Extract the first name from a full name string.
 * Strips suffixes like " - Empresa SA" or " – División", then takes the first word.
 * Examples:
 *   "Carlos Martínez - Armada Argentina" → "Carlos"
 *   "María José López"                   → "María"
 *   "Pocha"                              → "Pocha"
 */
function extractFirstName(name: string): string {
  if (!name) return "";
  // Remove everything after " - " or " – " (company suffixes)
  const cleaned = name.split(/\s+[-–]\s+/)[0].trim();
  // Return first word (first name)
  return cleaned.split(/\s+/)[0] || name;
}

export function substituteVariables(text: string, ctx: SubstituteContext): string {
  const today = new Date().toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const firstName = extractFirstName(ctx.name);

  return text
    .replace(/\{\{nombre\}\}/gi, firstName)
    .replace(/\{\{cliente\}\}/gi, ctx.name || "")
    .replace(/\{\{empresa\}\}/gi, ctx.company || ctx.name || "")
    .replace(/\{\{telefono\}\}/gi, ctx.phone || "")
    .replace(/\{\{vendedor\}\}/gi, ctx.vendedor || "")
    .replace(/\{\{fecha\}\}/gi, today)
    .replace(/\{\{ciudad\}\}/gi, ctx.city || "")
    .replace(/\{\{provincia\}\}/gi, ctx.province || "");
}

/** Extract all variable names referenced in a template text */
export function extractVariables(text: string): string[] {
  const matches = text.match(/\{\{(\w+)\}\}/gi) ?? [];
  return [...new Set(matches.map((m) => m.slice(2, -2).toLowerCase()))];
}

/** Returns a preview with example data substituted */
export function previewVariables(text: string): string {
  return substituteVariables(text, {
    name: "Juan García",
    company: "Empresa Ejemplo S.A.",
    phone: "+54 9 11 1234-5678",
    city: "Buenos Aires",
    province: "Buenos Aires",
    vendedor: "Carlos",
  });
}
