import React, { useState } from 'react';
import { CloudCheck, CloudDownload, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { photoStore } from '../services/photoStore';

interface OfflineToggleProps {
    /** The catalog's or collection's id. */
    setId: string;
    /** Its name, for the messages. */
    name: string;
    /** The files to keep: computed when tapped, so they are current. */
    addresses: () => string[];
    /** Icon size: 14 on tiles, 18 in a header. */
    size?: number;
    className?: string;
}

/**
 * "Save for offline": keeps a catalog's or collection's full-size photos (and
 * its PDF) on the device until tapped again, e.g. before a visit with no
 * signal. Kept apart from the 300 MB of recently opened photos, so they are
 * never removed to make room.
 */
export const OfflineToggle: React.FC<OfflineToggleProps> = ({ setId, name, addresses, size = 14, className = '' }) => {
    const [saved, setSaved] = useState(() => photoStore.isSavedForOffline(setId));
    const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

    const save = async () => {
        const files = addresses();
        if (files.length === 0) {
            toast('Nothing to save: it has no photos yet.');
            return;
        }
        if (!navigator.onLine) {
            toast.error('Connect to the internet to save it for offline use.');
            return;
        }
        setProgress({ done: 0, total: files.length });
        try {
            const { failed } = await photoStore.saveForOffline(setId, files, (done, total) => setProgress({ done, total }));
            setSaved(true);
            if (failed > 0) toast.error(`Saved for offline, except ${failed} ${failed === 1 ? 'file' : 'files'} that could not be downloaded.`);
            else toast.success(`"${name}" is saved for offline use.`);
        } catch (e) {
            toast.error((e as Error).message || 'Could not save it for offline use.');
        } finally {
            setProgress(null);
        }
    };

    const remove = async () => {
        await photoStore.removeOffline(setId);
        setSaved(false);
        toast.success(`"${name}" is no longer kept offline.`);
    };

    let label = `Save ${name} for offline use`;
    if (progress) label = `Saving for offline: ${progress.done} of ${progress.total}`;
    else if (saved) label = `${name} is saved for offline use. Tap to remove it from this device`;

    let icon = <CloudDownload size={size} />;
    if (progress) icon = <Loader2 size={size} className="animate-spin" />;
    else if (saved) icon = <CloudCheck size={size} />;

    return (
        <button
            type="button"
            onClick={(e) => { e.stopPropagation(); if (!progress) void (saved ? remove() : save()); }}
            aria-label={label}
            title={label}
            aria-pressed={saved}
            disabled={!!progress}
            className={`neu-icon-btn neu-btn active-scale relative z-[2] ${saved ? 'text-gold-700 dark:text-gold-300' : ''} ${className}`}
        >
            {icon}
            {progress && progress.total > 0 && (
                <span className="sr-only">{Math.round((progress.done / progress.total) * 100)}%</span>
            )}
        </button>
    );
};
