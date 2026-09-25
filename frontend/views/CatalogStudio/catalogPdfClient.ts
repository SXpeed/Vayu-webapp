import type { CatalogPdfJob, CatalogPdfCallbacks } from './catalogPdf';
import type { CatalogPdfRequest, CatalogPdfResponse } from './catalogPdf.worker';

/**
 * Page-side handle on the catalog PDF worker.
 *
 * One worker is kept for the session rather than one per PDF: the
 * background-removal model and its cutout cache live in it, so a second
 * generation doesn't reload a large model or redo cutouts.
 */

let worker: Worker | null = null;
let nextId = 0;

const getWorker = (): Worker => {
    worker ??= new Worker(new URL('./catalogPdf.worker.ts', import.meta.url), { type: 'module' });
    return worker;
};

/** Generate the catalog PDF off the main thread; resolves with its bytes. */
export const generateCatalogPdf = (job: CatalogPdfJob, callbacks: CatalogPdfCallbacks): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
        const w = getWorker();
        const id = ++nextId;

        const cleanup = () => {
            w.removeEventListener('message', onMessage);
            w.removeEventListener('error', onError);
        };

        const onMessage = (event: MessageEvent<CatalogPdfResponse>) => {
            const msg = event.data;
            if (msg.id !== id) return;
            switch (msg.type) {
                case 'progress':
                    callbacks.onProgress(msg.progress);
                    break;
                case 'warning':
                    callbacks.onWarning(msg.message);
                    break;
                case 'done':
                    cleanup();
                    resolve(msg.buffer);
                    break;
                case 'error':
                    cleanup();
                    reject(new Error(msg.message));
                    break;
            }
        };

        // The worker itself failed (bad script load, uncaught crash): drop it so
        // the next attempt starts a fresh one.
        const onError = (event: ErrorEvent) => {
            cleanup();
            w.terminate();
            if (worker === w) worker = null;
            reject(new Error(event.message || 'PDF generator stopped unexpectedly'));
        };

        w.addEventListener('message', onMessage);
        w.addEventListener('error', onError);
        const request: CatalogPdfRequest = { type: 'generate', id, job };
        w.postMessage(request);
    });
