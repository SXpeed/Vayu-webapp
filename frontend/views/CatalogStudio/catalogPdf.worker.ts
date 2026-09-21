import { buildCatalogPdf, CatalogPdfJob } from './catalogPdf';

/**
 * Web Worker entry for catalog PDF generation.
 *
 * Image decoding, background removal, jsPDF page assembly and the final
 * serialisation all run here, so the page stays responsive however large the
 * catalog is. The finished bytes are transferred back, not copied.
 */

export type CatalogPdfRequest = { type: 'generate'; id: number; job: CatalogPdfJob };

export type CatalogPdfResponse =
    | { type: 'progress'; id: number; message: string }
    | { type: 'warning'; id: number; message: string }
    | { type: 'done'; id: number; buffer: ArrayBuffer }
    | { type: 'error'; id: number; message: string };

// Typed locally: this file is compiled with the DOM lib, not WebWorker.
const scope = self as unknown as {
    postMessage(message: CatalogPdfResponse, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent<CatalogPdfRequest>) => void) | null;
};

scope.onmessage = async (event) => {
    const { id, job } = event.data;
    try {
        const buffer = await buildCatalogPdf(job, {
            onProgress: (message) => scope.postMessage({ type: 'progress', id, message }),
            onWarning: (message) => scope.postMessage({ type: 'warning', id, message }),
        });
        scope.postMessage({ type: 'done', id, buffer }, [buffer]);
    } catch (err) {
        console.error('Catalog PDF generation failed in worker:', err);
        scope.postMessage({ type: 'error', id, message: (err as Error)?.message || String(err) });
    }
};
