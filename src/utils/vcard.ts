/**
 * vCard parser — supports v2.1 / v3.0 / v4.0 (common subset).
 * Used by whatsapp.ts to turn contactMessage / contactsArrayMessage
 * payloads into structured JSON stored in messages.mediaData.
 */

export interface ParsedContactPhone  { number: string; type: string; }
export interface ParsedContactEmail  { address: string; type: string; }
export interface ParsedContactAddr {
  type: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface ParsedContact {
  fullName:     string | null;
  firstName:    string | null;
  lastName:     string | null;
  organization: string | null;
  title:        string | null;
  phones:       ParsedContactPhone[];
  emails:       ParsedContactEmail[];
  addresses:    ParsedContactAddr[];
  websites:     string[];
  notes:        string | null;
  vcardRaw:     string;
}

/** Unfold RFC-2426 continuation lines then split on CRLF or LF. */
function unfoldLines(raw: string): string[] {
  const folded = raw.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  return folded.split(/\r?\n/);
}

/** Extract TYPE parameter from a vCard param string like ";TYPE=CELL;TYPE=VOICE" */
function extractType(params: string): string {
  const m = params.match(/TYPE=([^;:,\r\n]+)/i);
  return m ? m[1].toLowerCase() : "";
}

export function parseVCard(raw: string): ParsedContact {
  const lines = unfoldLines(raw);

  let fullName:     string | null = null;
  let firstName:    string | null = null;
  let lastName:     string | null = null;
  let organization: string | null = null;
  let title:        string | null = null;
  let notes:        string | null = null;

  const phones:    ParsedContactPhone[] = [];
  const emails:    ParsedContactEmail[] = [];
  const addresses: ParsedContactAddr[]  = [];
  const websites:  string[]             = [];

  for (const line of lines) {
    if (!line || line === "BEGIN:VCARD" || line === "END:VCARD") continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const propFull  = line.slice(0, colonIdx);  // e.g. "TEL;TYPE=CELL" or "item1.TEL;waid=..."
    const value     = line.slice(colonIdx + 1).trim();

    // Strip WhatsApp property-group prefix: "item1.TEL" → "TEL"
    const dotIdx    = propFull.indexOf(".");
    const propMain  = dotIdx !== -1 ? propFull.slice(dotIdx + 1) : propFull;

    const semicolon = propMain.indexOf(";");
    const propName  = (semicolon === -1 ? propMain : propMain.slice(0, semicolon)).toUpperCase();
    const params    = semicolon === -1 ? "" : propMain.slice(semicolon);

    switch (propName) {
      case "FN":
        fullName = value || null;
        break;

      case "N": {
        // N:Family;Given;Additional;Prefix;Suffix
        const parts = value.split(";");
        lastName  = parts[0]?.replace(/\\,/g, ",").trim() || null;
        firstName = parts[1]?.replace(/\\,/g, ",").trim() || null;
        break;
      }

      case "ORG":
        // ORG:Company;Department
        organization = value.split(";")[0]?.trim() || null;
        break;

      case "TITLE":
        title = value || null;
        break;

      case "TEL":
        if (value) phones.push({ number: value, type: extractType(params) || "voice" });
        break;

      case "EMAIL":
        if (value) emails.push({ address: value, type: extractType(params) || "email" });
        break;

      case "ADR": {
        // ADR:POBox;Extended;Street;City;State;PostalCode;Country
        const parts = value.split(";");
        const addr: ParsedContactAddr = {
          type:       extractType(params) || "home",
          street:     parts[2]?.trim() || undefined,
          city:       parts[3]?.trim() || undefined,
          state:      parts[4]?.trim() || undefined,
          postalCode: parts[5]?.trim() || undefined,
          country:    parts[6]?.trim() || undefined,
        };
        if (addr.street || addr.city || addr.country) addresses.push(addr);
        break;
      }

      case "URL":
        if (value) websites.push(value);
        break;

      case "NOTE":
        notes = value.replace(/\\n/g, "\n") || null;
        break;

      default:
        break;
    }
  }

  return {
    fullName,
    firstName,
    lastName,
    organization,
    title,
    phones,
    emails,
    addresses,
    websites,
    notes,
    vcardRaw: raw,
  };
}

/** Parse one or more vCard strings and return the array. */
export function parseVCards(vcardStrings: string[]): ParsedContact[] {
  return vcardStrings.map(parseVCard);
}

/** One-liner to get the best display name from a ParsedContact. */
export function contactDisplayName(c: ParsedContact): string {
  return (
    c.fullName ||
    [c.firstName, c.lastName].filter(Boolean).join(" ") ||
    c.organization ||
    c.phones[0]?.number ||
    "Contacto"
  );
}
