// Getting a file out of the app without leaving it: save to the device, or
// show a PDF in a new tab. An installed iPhone app has no downloads: a
// download link replaces the app with the file and Back reloads it
// half-drawn, so there the share sheet ("Save to Files") does it.

import { createElement } from 'react';
import toast from 'react-hot-toast';

const iPhoneApp = (): boolean => (navigator as Navigator & { standalone?: boolean }).standalone === true;

const failUnlessCancelled = (e: Error) => {
    if (e.name !== 'AbortError') toast.error('Could not save the file');
};

const quietShare = (file: File) => navigator.share({ files: [file] }).catch(failUnlessCancelled);

/** Save a file to the device. Rejects with AbortError when the person closes the share sheet. */
export async function saveBlob(blob: Blob, name: string): Promise<'shared' | 'downloaded'> {
    const file = new File([blob], name, { type: blob.type });
    if (iPhoneApp() && navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ files: [file] });
        } catch (e) {
            if ((e as Error).name !== 'NotAllowedError') throw e;
            // Safari opens the share sheet only right after a tap, and a slow fetch or
            // PDF build used that up: ask for one more tap instead of failing.
            toast(t => createElement('button', {
                type: 'button',
                className: 'font-semibold underline',
                onClick: () => { toast.dismiss(t.id); void quietShare(file); },
            }, `Tap to save ${name}`), { duration: 20_000 });
        }
        return 'shared';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'downloaded';
}

/** saveBlob for a tap handler that doesn't wait: closing the share sheet is fine, any other failure says so. */
export function saveBlobNow(blob: Blob, name: string): void {
    saveBlob(blob, name).catch(failUnlessCancelled);
}

/** Show a PDF or text file in a new tab where that works, else save it. Phone
 *  browsers have no built-in PDF viewer (a blank tab, then a download), and an
 *  installed iPhone app would replace itself with the file. */
export async function openBlob(blob: Blob, name: string): Promise<'opened' | 'shared' | 'downloaded'> {
    const viewable = blob.type === 'application/pdf' ? navigator.pdfViewerEnabled : blob.type.startsWith('text/plain');
    if (viewable && !iPhoneApp()) {
        const url = URL.createObjectURL(blob);
        const win = globalThis.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        if (win) return 'opened';
    }
    return saveBlob(blob, name);
}
