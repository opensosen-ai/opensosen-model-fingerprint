import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute } from 'node:path';
import { CodexError, findCodex } from './codex-process.js';

export class CodexSelection {
  path: string | null = null;

  constructor(private readonly file: string) {}

  async load() {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new CodexError('无法读取 Codex 路径设置，请重新选择程序或恢复 PATH 自动查找。');
    }
    try {
      const saved = JSON.parse(text);
      const path: unknown = saved?.executable;
      if (path !== null && (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.exe')) {
        throw new Error('Invalid executable path');
      }
      this.path = path as string | null;
    } catch {
      throw new CodexError('Codex 路径设置无效，请重新选择程序或恢复 PATH 自动查找。');
    }
  }

  async save(path: string | null) {
    if (path !== null && !await findCodex(path)) {
      throw new CodexError('请选择存在的 Codex .exe 文件；不会自动改用 PATH 中的其他版本。');
    }
    const temporary = `${this.file}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(temporary, JSON.stringify({ executable: path }) + '\n', 'utf8');
      await rename(temporary, this.file);
      this.path = path;
    } catch {
      throw new CodexError('无法保存 Codex 路径设置，原来的选择保持不变。');
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
