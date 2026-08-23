/**
 * An async readers-writer lock, with the acquisition order `pthread_rwlock` and the kernel's
 * `down_read`/`down_write` give: any number of concurrent readers, one exclusive writer, and a
 * waiting writer holds off new readers so a steady stream of readers cannot starve it.
 *
 * Node runs one JavaScript thread, so this guards *interleaving across await points*, not memory.
 * That is the contention that exists here: several actors read the shared file tree while a tool
 * writes a file, and each `await` inside those sections is a place another one resumes. A reader
 * that observed the tree mid-update would see a path already removed from the index while its
 * bytes are still on disk.
 *
 * `read` and `write` release on the way out of the callback, including when it throws, so a failed
 * mutation cannot leave the lock held and the process wedged.
 */
export class ReadWriteLock {
  private activeReaders = 0;
  private writing = false;
  private readonly readerQueue: (() => void)[] = [];
  private readonly writerQueue: (() => void)[] = [];

  /** Readers currently inside the critical section. Diagnostics only. */
  get readers(): number {
    return this.activeReaders;
  }

  /** Whether a writer holds the lock. Diagnostics only. */
  get writeHeld(): boolean {
    return this.writing;
  }

  async read<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquireRead();
    try {
      return await fn();
    } finally {
      this.releaseRead();
    }
  }

  async write<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquireWrite();
    try {
      return await fn();
    } finally {
      this.releaseWrite();
    }
  }

  private async acquireRead(): Promise<void> {
    // A queued writer blocks newcomers even while other readers are inside: without this a reader
    // arriving every few milliseconds keeps `activeReaders` above zero forever and the writer never
    // runs. It is the difference between a lock and a suggestion.
    if (!this.writing && this.writerQueue.length === 0) {
      this.activeReaders += 1;
      return;
    }
    await new Promise<void>((resolve) => this.readerQueue.push(resolve));
    this.activeReaders += 1;
  }

  private releaseRead(): void {
    this.activeReaders -= 1;
    if (this.activeReaders === 0) this.admitNext();
  }

  private async acquireWrite(): Promise<void> {
    if (!this.writing && this.activeReaders === 0) {
      this.writing = true;
      return;
    }
    await new Promise<void>((resolve) => this.writerQueue.push(resolve));
    this.writing = true;
  }

  private releaseWrite(): void {
    this.writing = false;
    this.admitNext();
  }

  private admitNext(): void {
    const writer = this.writerQueue.shift();
    if (writer) {
      writer();
      return;
    }
    // No writer waiting: release the whole reader cohort at once, which is the point of sharing.
    while (this.readerQueue.length > 0) this.readerQueue.shift()!();
  }
}
