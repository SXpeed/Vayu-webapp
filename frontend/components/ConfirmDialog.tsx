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
        className="fixed inset-0 bg-black/30 transition-opacity border-none p-0 cursor-default"
        onClick={onClose}
        aria-label="Close dialog"
      />
      {/* Panel */}
      <div className="relative z-10 w-full max-w-md transform rounded-2xl bg-white dark:bg-[#1e1e1e] p-6 text-left align-middle shadow-xl transition-all">
        <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-white">
          {title}
        </h3>
        <div className="mt-2">
          <p className="text-sm text-gray-500 dark:text-gray-300">{message}</p>
        </div>
        <div className="mt-4 flex justify-end space-x-2">
          <button
            type="button"
            className="inline-flex justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-[#2a2a2a] px-[6px] py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex justify-center rounded-md border border-transparent bg-red-600 hover:bg-red-700 px-[6px] py-2 text-sm font-medium text-white focus:outline-none"
            onClick={onConfirm}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
};