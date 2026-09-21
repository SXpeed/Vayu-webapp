import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert } from 'lucide-react';

interface TypeDeleteDialogProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    /** What is being deleted, shown in the prompt. */
    itemName: string;
    /** Extra warning line (e.g. what gets archived). */
    message?: string;
    /** The word the user must type to enable the delete button. */
    confirmWord?: string;
    onConfirm: () => void;
}

/**
 * Destructive-action gate — the confirm button stays disabled until the user
 * types the confirm word ("Delete") exactly. Used by every delete flow in the
 * app; the item itself is archived for admin review first (worker-side).
 */
export const TypeDeleteDialog: React.FC<TypeDeleteDialogProps> = ({
    isOpen,
    onClose,
    title,
    itemName,
    message,
    confirmWord = 'Delete',
    onConfirm,
}) => {
    const [typed, setTyped] = useState('');
    const canConfirm = typed.trim() === confirmWord;

    useEffect(() => {
        if (!isOpen) {
            setTyped('');
            return;
        }
        const handleEsc = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        globalThis.addEventListener('keydown', handleEsc);
        return () => globalThis.removeEventListener('keydown', handleEsc);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    // Portaled to <body> so the dialog always sits above every panel/portal
    // and can never be misplaced onto a previous page by nested stacking
    // contexts on iOS.
    return createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center">
            {/* Backdrop */}
            <button
                type="button"
                className="fixed inset-0 neu-scrim transition-opacity border-none p-0 cursor-default"
                onClick={onClose}
                aria-label="Close dialog"
            />
            {/* Panel */}
            <div className="relative z-10 w-[min(28rem,92vw)] neu-modal p-5 text-left align-middle animate-scale-in">
                <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-full neu-inset flex items-center justify-center shrink-0">
                        <TriangleAlert size={18} className="text-red-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-base font-serif font-medium text-gray-900 dark:text-white">{title}</h3>
                        <p className="mt-1 text-sm text-gray-700 dark:text-gray-200 font-light">
                            <span className="font-medium text-gray-700 dark:text-gray-200">“{itemName}”</span> will be removed
                            {message ? ` — ${message}` : '.'}
                        </p>
                    </div>
                </div>
                <div className="mt-4">
                    <label htmlFor="type-delete-input" className="neu-label">
                        Type <span className="text-red-500 dark:text-red-400 font-bold">{confirmWord}</span> to confirm
                    </label>
                    <input
                        id="type-delete-input"
                        type="text"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && canConfirm) onConfirm(); }}
                        placeholder={confirmWord}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="neu-field"
                    />
                </div>
                <div className="mt-4 flex justify-end gap-2.5">
                    <button type="button" className="neu-button" onClick={onClose}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={!canConfirm}
                        className="neu-button neu-button-danger"
                        onClick={onConfirm}
                    >
                        Delete
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};