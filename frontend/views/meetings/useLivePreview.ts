// Words on screen as they are spoken, from the browser's own speech
// recognition (free; Chrome sends the audio to Google). A preview only: the
// saved transcript still comes from Whisper, part by part.
import { useEffect, useRef, useState } from 'react';

interface Recognizer {
    lang: string; continuous: boolean; interimResults: boolean;
    onresult: ((e: SpeechRecognitionEvent) => void) | null;
    onend: (() => void) | null;
    onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
    start(): void; stop(): void;
}
type RecognizerClass = new () => Recognizer;

const Recognition = (globalThis as unknown as { SpeechRecognition?: RecognizerClass; webkitSpeechRecognition?: RecognizerClass }).SpeechRecognition
    ?? (globalThis as unknown as { webkitSpeechRecognition?: RecognizerClass }).webkitSpeechRecognition;

// shortcut: off on phones, where a second listener on the microphone may silence the recording itself; turn on once tested on Android and iPhone.
export const livePreviewSupported = !!Recognition && !globalThis.matchMedia?.('(pointer: coarse)').matches;

const KEEP = 400; // characters of preview kept on screen

/** The last few hundred characters heard while `on`; '' when unsupported. */
export function useLivePreview(on: boolean): string {
    const [text, setText] = useState('');
    const heard = useRef('');
    useEffect(() => {
        if (!on || !Recognition) return;
        const r = new Recognition();
        r.lang = navigator.language || 'en-IN';
        r.continuous = true;
        r.interimResults = true;
        let active = true;
        r.onresult = e => {
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const said = e.results[i][0].transcript;
                if (e.results[i].isFinal) heard.current = (heard.current + ' ' + said).slice(-KEEP);
                else interim += said;
            }
            setText((heard.current + ' ' + interim).trim().slice(-KEEP));
        };
        r.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') active = false; };
        r.onend = () => { if (active) try { r.start(); } catch { /* already starting */ } }; // browsers stop after a silence
        try { r.start(); } catch { /* the preview is optional */ }
        return () => { active = false; r.onend = null; r.stop(); };
    }, [on]);
    return text;
}
