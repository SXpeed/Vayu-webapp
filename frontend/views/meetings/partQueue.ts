// Parts of a recording going up one at a time, in order, retried until they
// are saved: the server takes part n only after part n - 1.

import type { Meeting } from '../../meetingRules';
import { meetingService } from '../../services/meetingService';
import type { RecordedPart } from './recorder';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export class PartQueue {
    private readonly parts: (RecordedPart & { key?: string })[] = [];
    private sent = 0;
    private running = false;
    private readonly idle: (() => void)[] = [];

    constructor(
        private readonly meetingId: string,
        private readonly onMeeting: (m: Meeting & { transcribeError?: string }) => void,
        private readonly onState: (waiting: number, problem: string) => void,
    ) {}

    add(part: RecordedPart): void {
        this.parts.push(part);
        this.onState(this.parts.length - this.sent, '');
        void this.pump();
    }

    /** Resolves once every part added so far is saved. */
    drained(): Promise<void> {
        if (!this.running && this.sent === this.parts.length) return Promise.resolve();
        return new Promise(r => this.idle.push(r));
    }

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        let tries = 0;
        while (this.sent < this.parts.length) {
            const part = this.parts[this.sent];
            try {
                part.key ??= await meetingService.uploadPart(part.blob, this.sent); // NOSONAR: parts go up in order, one at a time
                this.onMeeting(await meetingService.addPart(this.meetingId, this.sent, part.key, part.sec)); // NOSONAR: as above
                this.sent += 1;
                tries = 0;
                this.onState(this.parts.length - this.sent, '');
            } catch (e) {
                tries += 1;
                this.onState(this.parts.length - this.sent, `${(e as Error).message || 'Upload failed'}. Trying again…`);
                await wait(Math.min(30_000, 1000 * 2 ** tries)); // NOSONAR: back off before the retry
            }
        }
        this.running = false;
        this.idle.splice(0).forEach(r => r());
    }
}
