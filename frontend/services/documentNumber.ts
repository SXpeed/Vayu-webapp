/**
 * Human-readable document numbers like "INQ-2026-K3F9QZ". Six base-36
 * characters (about 2 billion per year): three digits repeated within weeks.
 * The app and the server (worker.ts) both use this.
 */
export function makeDocumentNumber(prefix: string): string {
    const [random] = crypto.getRandomValues(new Uint32Array(1));
    const suffix = (random % 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
    return `${prefix}-${new Date().getFullYear()}-${suffix}`;
}
