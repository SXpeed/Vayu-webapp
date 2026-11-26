// Recording in parts: a new file every few minutes, so each part uploads (and
// is transcribed) while the meeting goes on, a long meeting never makes one
// file too big to transcribe, and a closed tab loses minutes, not the meeting.
// Uploaded files bigger than one part are split here too.

import { MAX_AUDIO_BYTES } from '../../meetingRules';

export interface RecordedPart { blob: Blob; sec: number }

export function pickMime(): string {
    for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus']) {
        if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
}

export class SegmentRecorder {
    private current: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private partSec = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private stopped: (() => void) | null = null;
    private readonly mimeType = pickMime();
    /** Seconds recorded so far, pauses left out. */
    elapsed = 0;

    constructor(
        private readonly stream: MediaStream,
        private readonly partSeconds: number,
        private readonly onPart: (part: RecordedPart) => void,
        private readonly onTick: (elapsed: number) => void,
    ) {}

    start(): void {
        this.next();
        this.tick(true);
    }

    pause(): void { this.current?.pause(); this.tick(false); }
    resume(): void { this.current?.resume(); this.tick(true); }

    /** Ends the last part; resolves once it has been handed over. */
    stop(): Promise<void> {
        this.tick(false);
        return new Promise(resolve => {
            this.stopped = () => { this.stream.getTracks().forEach(t => t.stop()); resolve(); };
            if (this.current && this.current.state !== 'inactive') this.current.stop(); else this.stopped();
        });
    }

    private tick(on: boolean): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = on ? setInterval(() => {
            this.elapsed += 1;
            this.partSec += 1;
            this.onTick(this.elapsed);
            if (this.partSec >= this.partSeconds) this.current?.stop(); // its onstop starts the next part
        }, 1000) : null;
    }

    private next(): void {
        // 32 kbps speech: a 3-minute part is under 1 MB.
        const r = new MediaRecorder(this.stream, { ...(this.mimeType ? { mimeType: this.mimeType } : {}), audioBitsPerSecond: 32_000 });
        this.chunks = [];
        r.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
        r.onstop = () => {
            const blob = new Blob(this.chunks, { type: r.mimeType || this.mimeType || 'audio/webm' });
            if (blob.size) this.onPart({ blob, sec: this.partSec });
            this.partSec = 0;
            if (this.stopped) this.stopped(); else this.next();
        };
        r.start(1000);
        this.current = r;
    }
}

/** 16-bit mono PCM WAV of these samples. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
    const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.codePointAt(i)!); };
    ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
}

const SPLIT_RATE = 16_000; // what speech-to-text uses anyway
const SPLIT_SECONDS = 600; // 10 minutes of 16 kHz 16-bit mono ≈ 19 MB

function durationOf(file: Blob): Promise<number> {
    return new Promise(resolve => {
        const a = new Audio();
        const url = URL.createObjectURL(file);
        const done = (sec: number) => { URL.revokeObjectURL(url); resolve(Number.isFinite(sec) ? Math.round(sec) : 0); };
        a.onloadedmetadata = () => done(a.duration);
        a.onerror = () => done(0);
        a.src = url;
    });
}

/**
 * An uploaded recording as parts a transcription request takes: as it is
 * when small enough, else decoded and cut into 10-minute WAV files.
 */
export async function splitAudioFile(file: File): Promise<RecordedPart[]> {
    if (file.size <= MAX_AUDIO_BYTES * 0.95) return [{ blob: file, sec: await durationOf(file) }];
    // shortcut: decodes the whole file in memory (~4 MB a minute at 16 kHz); a phone may run out on recordings of several hours.
    const ctx = new AudioContext({ sampleRate: SPLIT_RATE });
    try {
        const audio = await ctx.decodeAudioData(await file.arrayBuffer());
        const mono = new Float32Array(audio.length);
        for (let c = 0; c < audio.numberOfChannels; c++) {
            const ch = audio.getChannelData(c);
            for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
        }
        const step = SPLIT_SECONDS * audio.sampleRate;
        const parts: RecordedPart[] = [];
        for (let at = 0; at < mono.length; at += step) {
            const piece = mono.subarray(at, at + step);
            parts.push({ blob: encodeWav(piece, audio.sampleRate), sec: Math.round(piece.length / audio.sampleRate) });
        }
        return parts;
    } finally {
        void ctx.close();
    }
}
