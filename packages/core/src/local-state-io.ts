import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

export type VaultStateFileName = 'plan.json' | 'report.md' | 'state.json';
export type HomeStateFileName = 'credentials.json' | 'state-signing-key';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

export class LocalStateSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalStateSecurityError';
  }
}

interface OpenDirectory {
  path: string;
  handle: FileHandle;
  dev: number | bigint;
  ino: number | bigint;
}

function securityError(targetPath: string, reason: string): LocalStateSecurityError {
  return new LocalStateSecurityError(`${targetPath}: ${reason}`);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function openDirectory(
  directoryPath: string,
  options: { create: boolean; mode?: number; canonicalParent?: string },
): Promise<OpenDirectory> {
  if (options.create) {
    try {
      await fs.mkdir(directoryPath, { mode: options.mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  const entry = await fs.lstat(directoryPath);
  if (entry.isSymbolicLink()) throw securityError(directoryPath, 'シンボリックリンクは使用できません');
  if (!entry.isDirectory()) throw securityError(directoryPath, '通常のディレクトリではありません');

  const canonicalPath = await fs.realpath(directoryPath);
  if (options.canonicalParent && path.dirname(canonicalPath) !== options.canonicalParent) {
    throw securityError(directoryPath, '許可されたディレクトリの外部を参照しています');
  }

  const handle = await fs.open(directoryPath, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw securityError(directoryPath, '通常のディレクトリではありません');
    if (options.mode !== undefined) await handle.chmod(options.mode);
    return { path: directoryPath, handle, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertDirectoryUnchanged(directory: OpenDirectory): Promise<void> {
  const current = await fs.lstat(directory.path);
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== directory.dev
    || current.ino !== directory.ino
  ) {
    throw securityError(directory.path, 'I/O中にディレクトリが置き換えられました');
  }
}

async function openVaultStateDirectory(vaultPath: string, create: boolean): Promise<OpenDirectory> {
  const canonicalVault = await fs.realpath(vaultPath);
  const vaultStat = await fs.stat(canonicalVault);
  if (!vaultStat.isDirectory()) throw securityError(vaultPath, 'vaultがディレクトリではありません');
  return openDirectory(path.join(canonicalVault, '.o2n'), {
    create,
    mode: 0o700,
    canonicalParent: canonicalVault,
  });
}

async function openHomeStateDirectory(create: boolean): Promise<OpenDirectory> {
  const canonicalHome = await fs.realpath(os.homedir());
  return openDirectory(path.join(canonicalHome, '.o2n'), {
    create,
    mode: 0o700,
    canonicalParent: canonicalHome,
  });
}

async function assertRegularDestination(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw securityError(filePath, 'シンボリックリンクは使用できません');
    if (!stat.isFile()) throw securityError(filePath, '通常ファイルではありません');
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

async function readFromDirectory(directory: OpenDirectory, fileName: string): Promise<string> {
  const filePath = path.join(directory.path, fileName);
  const handle = await fs.open(filePath, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw securityError(filePath, '通常ファイルではありません');
    const content = await handle.readFile('utf-8');
    await assertDirectoryUnchanged(directory);
    return content;
  } finally {
    await handle.close();
  }
}

async function atomicWriteToDirectory(
  directory: OpenDirectory,
  fileName: string,
  content: string,
  mode: number,
): Promise<void> {
  const destination = path.join(directory.path, fileName);
  await assertRegularDestination(destination);

  const temporary = path.join(
    directory.path,
    `.${fileName}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  let temporaryCreated = false;
  try {
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      mode,
    );
    temporaryCreated = true;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw securityError(temporary, '通常ファイルではありません');
      await handle.writeFile(content, 'utf-8');
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await assertDirectoryUnchanged(directory);
    await assertRegularDestination(destination);
    await fs.rename(temporary, destination);
    temporaryCreated = false;
    await directory.handle.sync();
  } finally {
    if (temporaryCreated) {
      await fs.unlink(temporary).catch((error: unknown) => {
        if (!isEnoent(error)) throw error;
      });
    }
  }
}

export async function readVaultStateFile(
  vaultPath: string,
  fileName: VaultStateFileName,
): Promise<string> {
  const directory = await openVaultStateDirectory(vaultPath, false);
  try {
    return await readFromDirectory(directory, fileName);
  } finally {
    await directory.handle.close();
  }
}

export async function atomicWriteVaultStateFile(
  vaultPath: string,
  fileName: VaultStateFileName,
  content: string,
): Promise<void> {
  const directory = await openVaultStateDirectory(vaultPath, true);
  try {
    await atomicWriteToDirectory(directory, fileName, content, 0o600);
  } finally {
    await directory.handle.close();
  }
}

export async function readHomeStateFile(fileName: HomeStateFileName): Promise<string> {
  const directory = await openHomeStateDirectory(false);
  try {
    return await readFromDirectory(directory, fileName);
  } finally {
    await directory.handle.close();
  }
}

export async function atomicWriteHomeStateFile(
  fileName: HomeStateFileName,
  content: string,
): Promise<void> {
  const directory = await openHomeStateDirectory(true);
  try {
    await atomicWriteToDirectory(directory, fileName, content, 0o600);
  } finally {
    await directory.handle.close();
  }
}

export async function removeHomeStateFile(fileName: HomeStateFileName): Promise<void> {
  const directory = await openHomeStateDirectory(false);
  try {
    const filePath = path.join(directory.path, fileName);
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw securityError(filePath, 'シンボリックリンクは使用できません');
    if (!stat.isFile()) throw securityError(filePath, '通常ファイルではありません');
    await assertDirectoryUnchanged(directory);
    await fs.unlink(filePath);
  } finally {
    await directory.handle.close();
  }
}

export async function readRegularFileNoFollow(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw securityError(filePath, '通常ファイルではありません');
    return await handle.readFile('utf-8');
  } finally {
    await handle.close();
  }
}

export async function atomicWriteRegularFileNoFollow(filePath: string, content: string): Promise<void> {
  const directory = await openDirectory(path.dirname(path.resolve(filePath)), { create: true });
  try {
    await atomicWriteToDirectory(directory, path.basename(filePath), content, 0o600);
  } finally {
    await directory.handle.close();
  }
}
