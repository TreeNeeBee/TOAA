import { promises as fs } from 'node:fs';
import path from 'node:path';

export class Workspace {
  constructor(public readonly root: string) {}

  abs(...p: string[]): string {
    return path.resolve(this.root, ...p);
  }

  async ensure(dir: string): Promise<void> {
    await fs.mkdir(this.abs(dir), { recursive: true });
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const full = this.abs(rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  async appendFile(rel: string, content: string): Promise<void> {
    const full = this.abs(rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.appendFile(full, content, 'utf8');
  }

  async readFile(rel: string): Promise<string> {
    return fs.readFile(this.abs(rel), 'utf8');
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.stat(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  async remove(rel: string): Promise<void> {
    await fs.rm(this.abs(rel), { recursive: true, force: true });
  }
}
