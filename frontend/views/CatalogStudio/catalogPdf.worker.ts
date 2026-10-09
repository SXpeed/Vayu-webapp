import { buildCatalogPdf, CatalogPdfJob, CatalogPdfProgress } from './catalogPdf';

/**
 * Web Worker entry for catalog PDF generation.
 *
 * Image decoding, background removal, jsPDF page assembly and the final
 * serialisation all run here, so the page stays responsive however large the
 * catalog is. The finished bytes are transferred back, not copied.
 */

export type CatalogPdfRequest = { type: 'generate'; id: number; job: CatalogPdfJob };

export type CatalogPdfResponse =
    | { type: 'progress'; id: number; progress: CatalogPdfProgress }
    | { type: 'warning'; id: number; message: string }
    | { type: 'done'; id: number; buffer: ArrayBuffer }
    | { type: 'error'; id: number; message: string };

// Typed locally: this file is compiled with the DOM lib, not WebWorker.
const scope = self as unknown as {
    postMessage(message: CatalogPdfResponse, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent<CatalogPdfRequest>) => void) | null;
};

scope.onmessage = (event) => { void build(event.data); };

async function build({ id, job }: CatalogPdfRequest): Promise<void> {
    try {
        const buffer = await buildCatalogPdf(job, {
            onProgress: (progress) => scope.postMessage({ type: 'progress', id, progress }),
            onWarning: (message) => scope.postMessage({ type: 'warning', id, message }),
        });
        scope.postMessage({ type: 'done', id, buffer }, [buffer]);
    } catch (err) {
        console.error('Catalog PDF generation failed in worker:', err);
        scope.postMessage({ type: 'error', id, message: (err as Error)?.message || String(err) });
    }
}
