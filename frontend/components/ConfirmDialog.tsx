import React, { useEffect } from "react";

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  message: string;
  onConfirm: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  title = "Confirm",
  message,
  onConfirm,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", handleEsc);
    return () => globalThis.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <button
        type="button"
        className="fixed inset-0 neu-scrim transition-opacity border-none p-0 cursor-default"
        onClick={onClose}
        aria-label="Close dialog"
      />
      {/* Panel */}
      <div className="relative z-10 w-[min(28rem,92vw)] neu-modal p-6 text-left align-middle">
        <h3 className="text-lg font-serif leading-6 text-gray-900 dark:text-white">
          {title}
        </h3>
        <div className="mt-2">
          <p className="text-sm text-gray-700 dark:text-gray-200">{message}</p>
        </div>
        <div className="mt-5 flex justify-end gap-2.5">
          <button type="button" className="neu-button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="neu-button neu-button-danger" onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
};