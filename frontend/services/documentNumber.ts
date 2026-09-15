/**
 * Human-readable document numbers like "INQ-2026-042". The suffix comes from
 * crypto.getRandomValues rather than Math.random.
 */
export function makeDocumentNumber(prefix: string): string {
    const [random] = crypto.getRandomValues(new Uint32Array(1));
    const suffix = (random % 1000).toString().padStart(3, '0');
    return `${prefix}-${new Date().getFullYear()}-${suffix}`;
}
