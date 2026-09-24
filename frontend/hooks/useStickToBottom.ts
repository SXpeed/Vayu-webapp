import { useCallback, useLayoutEffect, useRef } from 'react';

/** Within this many px of the end still counts as "at the latest message". */
const PIN_SLACK = 48;

/**
 * Keeps a chat's scroller on its latest message for as long as the reader is
 * there, and leaves them alone once they scroll up into history.
 *
 * Jumping to the bottom once on open wasn't enough: photos in the thread load
 * after that jump and grow it, messages still syncing arrive a moment later,
 * and the keyboard shrinks the scroller — each left the chat opening, or
 * sitting, mid-thread. Here a ResizeObserver on both the scroller and its
 * content re-anchors on every one of those while the reader is pinned.
 *
 * Growth of less than a screen (a new message, a photo finishing loading) is
 * followed with a smooth scroll; anything bigger, and every scroller resize
 * (keyboard), snaps, so opening a long chat never visibly scrolls through it.
 *
 * `resetKey` re-pins to the bottom — pass the conversation id.
 */
export const useStickToBottom = (resetKey: unknown) => {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const pinned = useRef(true);
    // A smooth scroll passes through "not at the bottom" on its way down;
    // those scroll events mustn't read as the reader scrolling away.
    const autoUntil = useRef(0);

    const toBottom = useCallback((smooth: boolean) => {
        const scroller = scrollerRef.current;
        if (!scroller) return;
        const top = scroller.scrollHeight - scroller.clientHeight;
        if (smooth) {
            autoUntil.current = performance.now() + 600;
            scroller.scrollTo({ top, behavior: 'smooth' });
        } else {
            scroller.scrollTop = top;
        }
    }, []);

    // Layout effect: the first frame of a freshly opened chat is already at
    // the bottom, never the top of the thread snapping down.
    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        const content = contentRef.current;
        if (!scroller || !content) return;
        pinned.current = true;
        toBottom(false);

        let lastHeight = content.offsetHeight;
        const observer = new ResizeObserver(entries => {
            const height = content.offsetHeight;
            const grewBy = height - lastHeight;
            lastHeight = height;
            if (!pinned.current) return;
            const contentOnly = entries.every(e => e.target === content);
            toBottom(contentOnly && grewBy > 0 && grewBy < scroller.clientHeight);
        });
        observer.observe(scroller);
        observer.observe(content);

        const onScroll = () => {
            if (performance.now() < autoUntil.current) return;
            pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < PIN_SLACK;
        };
        scroller.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            observer.disconnect();
            scroller.removeEventListener('scroll', onScroll);
        };
    }, [resetKey, toBottom]);

    /** Sending: back to the latest message even from deep in history, and
     *  stay there as the new message lands. */
    const scrollToLatest = useCallback(() => {
        pinned.current = true;
        toBottom(true);
    }, [toBottom]);

    return { scrollerRef, contentRef, scrollToLatest };
};
