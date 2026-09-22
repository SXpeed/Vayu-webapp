/** A single-flight refresh loop. Events request a refresh but cannot bypass
 * the cooldown or failure backoff. Hidden/offline tabs perform no work. */
export function createRefreshScheduler(options: {
    run: () => Promise<unknown>;
    /** A function is re-read after every run, e.g. to slow down while a
     *  realtime socket is delivering change signals. */
    intervalMs: number | (() => number);
    enabled: () => boolean;
    initialDelayMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
    const now = options.now ?? Date.now;
    const setTimer = options.setTimer ?? ((callback: () => void, delay: number): ReturnType<typeof setTimeout> => setTimeout(callback, delay));
    const clearTimer = options.clearTimer ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let running = false;
    let failures = 0;
    let nextAt = now() + (options.initialDelayMs ?? 0);
    const interval = () => (typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs);
    const schedule = (delay: number) => {
        if (timer !== undefined) clearTimer(timer);
        timer = setTimer(() => { void request(); }, delay);
    };
    const request = async () => {
        if (stopped || running) return;
        if (timer !== undefined) clearTimer(timer);
        timer = undefined;
        if (!options.enabled()) return; // visibility/online event resumes us
        if (now() < nextAt) { schedule(nextAt - now()); return; }
        running = true;
        try {
            await options.run();
            failures = 0;
        } catch {
            failures = Math.min(failures + 1, 4);
        } finally {
            running = false;
            nextAt = now() + Math.min(interval() * 2 ** failures, 15 * 60_000);
            if (!stopped) schedule(nextAt - now());
        }
    };
    schedule(Math.max(0, nextAt - now()));
    return {
        request,
        stop() {
            stopped = true;
            if (timer !== undefined) clearTimer(timer);
        },
    };
}
