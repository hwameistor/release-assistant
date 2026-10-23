import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { safePath } from './config.js';

async function checked(root: string, relative: string): Promise<string> {
  safePath(relative);
  await mkdir(resolve(root), { recursive: true });
  if ((await lstat(resolve(root))).isSymbolicLink()) throw new Error('Output directory must not be a symbolic link');
  let part = await realpath(resolve(root));
  const path = join(part, relative);
  for (const component of relative.split('/')) {
    part = join(part, component);
    try { if ((await lstat(part)).isSymbolicLink()) throw new Error(`Output path contains a symbolic link: ${part}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return path;
}
export async function readOutput(root: string, relative: string): Promise<string | null> {
  try { return await readFile(await checked(root, relative), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function writeOutput(root: string, relative: string, text: string): Promise<void> {
  const path = await checked(root, relative);
  await mkdir(resolve(path, '..'), { recursive: true });
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(text); } finally { await file.close(); }
}
