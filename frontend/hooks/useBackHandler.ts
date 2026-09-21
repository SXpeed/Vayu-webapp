import { useEffect } from 'react';

export function useBackHandler(isOpen: boolean, onClose: () => void) {
    useEffect(() => {
        if (!isOpen) return;

        // Push a state when modal opens
        globalThis.history.pushState({ modalOpen: true }, '');

        const handlePopState = () => {
            // Prevent the global popstate in useNavigation from triggering
            (globalThis as any)._modalJustClosed = true;
            setTimeout(() => { (globalThis as any)._modalJustClosed = false; }, 50);
            
            onClose();
        };

        globalThis.addEventListener('popstate', handlePopState);
        
        return () => {
            globalThis.removeEventListener('popstate', handlePopState);
        };
    }, [isOpen, onClose]);
}

