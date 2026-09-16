import React, { useEffect, useState } from 'react';
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

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <button
                type="button"
                className="fixed inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity border-none p-0 cursor-default"
                onClick={onClose}
                aria-label="Close dialog"
            />
            {/* Panel */}
            <div className="relative z-10 w-full max-w-md mx-4 transform rounded-2xl bg-white dark:bg-[#1e1e1e] p-5 text-left align-middle shadow-xl transition-all animate-scale-in">
                <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center shrink-0">
                        <TriangleAlert size={18} className="text-red-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-base font-serif font-medium text-gray-900 dark:text-white">{title}</h3>
                        <p className="mt-1 text-sm text-gray-500 dark:text-gray-300 font-light">
                            <span className="font-medium text-gray-700 dark:text-gray-200">“{itemName}”</span> will be removed
                            {message ? ` — ${message}` : '.'}
                        </p>
                    </div>
                </div>
                <div className="mt-4">
                    <label htmlFor="type-delete-input" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">
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
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-red-400 dark:focus:border-red-500 transition-colors"
                    />
                </div>
                <div className="mt-4 flex justify-end space-x-2">
                    <button
                        type="button"
                        className="inline-flex justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#2a2a2a] px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none transition-colors"
                        onClick={onClose}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={!canConfirm}
                        className={`inline-flex justify-center rounded-md border border-transparent px-3 py-2 text-sm font-medium text-white focus:outline-none transition-colors ${canConfirm
                            ? 'bg-red-600 hover:bg-red-700'
                            : 'bg-red-300 dark:bg-red-900/40 cursor-not-allowed opacity-60'
                            }`}
                        onClick={onConfirm}
                    >
                        Delete
                    </button>
                </div>
            </div>
        </div>
    );
};