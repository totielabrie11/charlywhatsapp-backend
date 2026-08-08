/**
 * Canonical phone normalization shared by every client-creation/lookup path
 * (manual client creation, "start conversation", inbound WhatsApp messages).
 *
 * Why this exists: each of those paths used to normalize phone numbers
 * differently (or not at all), so the same person could end up with two
 * Client rows — one matched by the WhatsApp-inbound format, one by whatever
 * an operator typed in the "new client" form — silently splitting that
 * client's tasks/opportunities/history across two ids.
 *
 * Rule: strip everything but digits, then for a 12-digit number starting
 * with "54" (Argentina without the mobile "9"), insert it so the canonical
 * 13-digit AR mobile form is always used. All other country codes/lengths
 * pass through unchanged. Short local numbers (≤10 digits, no country code)
 * get "549" prepended, matching how the app already treats bare AR numbers.
 */
export function normalizePhone(rawPhone: string): string {
  const digits = (rawPhone || "").replace(/\D/g, "");
  if (digits.startsWith("54") && digits.length === 12) {
    return `549${digits.slice(2)}`;
  }
  if (digits.length > 0 && digits.length <= 10) {
    return `549${digits}`;
  }
  return digits;
}
