import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  RecordReplayChannel,
  RecordReplayEntry,
  RecordReplayStore,
} from '../../application/record_replay/types.js';

export class FileRecordReplayStore implements RecordReplayStore {
  constructor(private readonly root: string) {}

  async find(channel: RecordReplayChannel, requestKey: string): Promise<RecordReplayEntry[]> {
    const directory = this.directory(channel, requestKey);
    let files: string[];
    try {
      files = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries = await Promise.all(files.filter((file) => file.endsWith('.json')).sort().map(async (file) =>
      JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')) as RecordReplayEntry,
    ));
    return entries;
  }

  async append(entry: RecordReplayEntry): Promise<void> {
    const directory = this.directory(entry.channel, entry.requestKey);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `${entry.recordedAt.replace(/[:.]/gu, '-')}-${entry.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, target);
  }

  async list(): Promise<RecordReplayEntry[]> {
    const entries: RecordReplayEntry[] = [];
    await visitJsonFiles(this.root, async (file) => {
      entries.push(JSON.parse(await fs.readFile(file, 'utf8')) as RecordReplayEntry);
    });
    return entries;
  }

  private directory(channel: RecordReplayChannel, requestKey: string): string {
    const digest = requestKey.replace(/^sha256:/u, '');
    return path.join(this.root, channel, digest.slice(0, 2), digest);
  }
}

async function visitJsonFiles(
  directory: string,
  visit: (file: string) => Promise<void>,
): Promise<void> {
  let items: Array<import('node:fs').Dirent>;
  try {
    items = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(directory, item.name);
    if (item.isDirectory()) await visitJsonFiles(target, visit);
    else if (item.isFile() && item.name.endsWith('.json')) await visit(target);
  }
}
