// Neither jsdom nor Node has MediaSource. This stands in for just what
// LiveTranscodeSource uses: appends finish on the next tick, and `ranges`
// is set by each test to say what's buffered.
export function timeRanges(ranges: [number, number][]): TimeRanges {
  return { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] };
}

export class FakeSourceBuffer extends EventTarget {
  updating = false;
  ranges: [number, number][] = [];
  appended: Uint8Array[] = [];
  removed: [number, number][] = [];
  aborts = 0;
  quotaFull = false;
  readonly mimeType: string;

  constructor(mimeType: string) {
    super();
    this.mimeType = mimeType;
  }

  get buffered() {
    return timeRanges(this.ranges);
  }

  appendBuffer(chunk: Uint8Array) {
    if (this.updating) throw new DOMException('Still updating', 'InvalidStateError');
    if (this.quotaFull) throw new DOMException('Full', 'QuotaExceededError');
    this.appended.push(chunk);
    this.#update();
  }

  remove(start: number, end: number) {
    this.removed.push([start, end]);
    this.#update();
  }

  abort() {
    this.aborts += 1;
  }

  #update() {
    this.updating = true;
    setTimeout(() => {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    }, 0);
  }
}

export class FakeMediaSource extends EventTarget {
  static last: FakeMediaSource | null = null;
  readyState: 'closed' | 'open' | 'ended' = 'closed';
  duration = NaN;
  sourceBuffers: FakeSourceBuffer[] = [];

  constructor() {
    super();
    FakeMediaSource.last = this;
  }

  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('sourceopen'));
  }

  addSourceBuffer(mimeType: string) {
    const sourceBuffer = new FakeSourceBuffer(mimeType);
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  }

  endOfStream() {
    this.readyState = 'ended';
  }
}

// A fetch Response whose body yields `chunks`, then ends, or stays open
// (like a stream still being converted) with end: false. Aborting `signal`
// errors the body, as a real aborted fetch does.
export function streamResponse(chunks: Uint8Array[], { end = true, signal }: { end?: boolean; signal?: AbortSignal } = {}) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (end) controller.close();
        signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      },
    }),
  };
}
