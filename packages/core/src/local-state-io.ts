import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';

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
  canonicalPath: string;
  handle: FileHandle;
  dev: number | bigint;
  ino: number | bigint;
}

export interface NoFollowReadOptions {
  noFollowFlag?: number;
}

function securityError(targetPath: string, reason: string): LocalStateSecurityError {
  return new LocalStateSecurityError(`${targetPath}: ${reason}`);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function fileType(stat: Stats): number {
  return stat.mode & constants.S_IFMT;
}

function assertSameEntry(
  targetPath: string,
  before: Stats,
  opened: Stats,
  after: Stats,
): void {
  const expectedType = fileType(before);
  if (
    before.dev !== opened.dev
    || before.ino !== opened.ino
    || opened.dev !== after.dev
    || opened.ino !== after.ino
    || fileType(opened) !== expectedType
    || fileType(after) !== expectedType
  ) {
    throw securityError(targetPath, 'I/O中にファイルシステムentryが置き換えられました');
  }
}

async function openDirectory(
  directoryPath: string,
  options: {
    create: boolean;
    mode?: number;
    canonicalParent?: string;
    noFollowFlag?: number;
  },
): Promise<OpenDirectory> {
  if (options.create) {
    try {
      await fs.mkdir(directoryPath, { mode: options.mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  const before = await fs.lstat(directoryPath);
  if (before.isSymbolicLink()) throw securityError(directoryPath, 'シンボリックリンクは使用できません');
  if (!before.isDirectory()) throw securityError(directoryPath, '通常のディレクトリではありません');

  const canonicalPath = await fs.realpath(directoryPath);
  if (options.canonicalParent && path.dirname(canonicalPath) !== options.canonicalParent) {
    throw securityError(directoryPath, '許可されたディレクトリの外部を参照しています');
  }

  const noFollowFlag = options.noFollowFlag ?? NOFOLLOW;
  const handle = await fs.open(directoryPath, constants.O_RDONLY | DIRECTORY | noFollowFlag);
  try {
    const opened = await handle.stat();
    const after = await fs.lstat(directoryPath);
    if (after.isSymbolicLink() || !opened.isDirectory() || !after.isDirectory()) {
      throw securityError(directoryPath, '通常のディレクトリではありません');
    }
    assertSameEntry(directoryPath, before, opened, after);
    if (await fs.realpath(directoryPath) !== canonicalPath) {
      throw securityError(directoryPath, 'I/O中にディレクトリの参照先が変化しました');
    }
    if (options.mode !== undefined) await handle.chmod(options.mode);
    return {
      path: directoryPath,
      canonicalPath,
      handle,
      dev: opened.dev,
      ino: opened.ino,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openOrCreateDirectoryTree(
  directoryPath: string,
  noFollowFlag = NOFOLLOW,
): Promise<OpenDirectory> {
  const missingSegments: string[] = [];
  let existingAncestor = path.resolve(directoryPath);

  while (true) {
    try {
      const stat = await fs.lstat(existingAncestor);
      if (stat.isSymbolicLink()) {
        throw securityError(existingAncestor, 'シンボリックリンクは使用できません');
      }
      if (!stat.isDirectory()) {
        throw securityError(existingAncestor, '通常のディレクトリではありません');
      }
      break;
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.push(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }

  const canonicalAncestor = await fs.realpath(existingAncestor);
  let directory = await openDirectory(canonicalAncestor, {
    create: false,
    noFollowFlag,
  });
  try {
    for (const segment of missingSegments.reverse()) {
      await assertDirectoryUnchanged(directory);
      const childPath = path.join(directory.canonicalPath, segment);
      try {
        await fs.mkdir(childPath, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const child = await openDirectory(childPath, {
        create: false,
        canonicalParent: directory.canonicalPath,
        noFollowFlag,
      });
      try {
        await assertDirectoryUnchanged(directory);
        await directory.handle.close();
        directory = child;
      } catch (error) {
        await child.handle.close();
        throw error;
      }
    }
    return directory;
  } catch (error) {
    await directory.handle.close();
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

async function openVaultStateDirectory(
  vaultPath: string,
  create: boolean,
  noFollowFlag?: number,
): Promise<OpenDirectory> {
  const canonicalVault = await fs.realpath(vaultPath);
  const vaultStat = await fs.stat(canonicalVault);
  if (!vaultStat.isDirectory()) throw securityError(vaultPath, 'vaultがディレクトリではありません');
  return openDirectory(path.join(canonicalVault, '.o2n'), {
    create,
    mode: 0o700,
    canonicalParent: canonicalVault,
    noFollowFlag,
  });
}

async function openHomeStateDirectory(
  create: boolean,
  noFollowFlag?: number,
): Promise<OpenDirectory> {
  const canonicalHome = await fs.realpath(os.homedir());
  return openDirectory(path.join(canonicalHome, '.o2n'), {
    create,
    mode: 0o700,
    canonicalParent: canonicalHome,
    noFollowFlag,
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

async function readFromDirectory(
  directory: OpenDirectory,
  fileName: string,
  noFollowFlag = NOFOLLOW,
): Promise<string> {
  const filePath = path.join(directory.path, fileName);
  await assertDirectoryUnchanged(directory);
  const before = await fs.lstat(filePath);
  if (before.isSymbolicLink()) throw securityError(filePath, 'シンボリックリンクは使用できません');
  if (!before.isFile()) throw securityError(filePath, '通常ファイルではありません');

  const handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag);
  try {
    const opened = await handle.stat();
    const afterOpen = await fs.lstat(filePath);
    if (afterOpen.isSymbolicLink() || !opened.isFile() || !afterOpen.isFile()) {
      throw securityError(filePath, '通常ファイルではありません');
    }
    assertSameEntry(filePath, before, opened, afterOpen);
    await assertDirectoryUnchanged(directory);
    const content = await handle.readFile('utf-8');
    const afterRead = await fs.lstat(filePath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile()) {
      throw securityError(filePath, 'I/O中にファイルが置き換えられました');
    }
    assertSameEntry(filePath, before, opened, afterRead);
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
  options: NoFollowReadOptions = {},
): Promise<string> {
  const noFollowFlag = options.noFollowFlag ?? NOFOLLOW;
  const directory = await openVaultStateDirectory(vaultPath, false, noFollowFlag);
  try {
    return await readFromDirectory(directory, fileName, noFollowFlag);
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

export async function readHomeStateFile(
  fileName: HomeStateFileName,
  options: NoFollowReadOptions = {},
): Promise<string> {
  const noFollowFlag = options.noFollowFlag ?? NOFOLLOW;
  const directory = await openHomeStateDirectory(false, noFollowFlag);
  try {
    return await readFromDirectory(directory, fileName, noFollowFlag);
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

export async function readRegularFileNoFollow(
  filePath: string,
  options: NoFollowReadOptions = {},
): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const noFollowFlag = options.noFollowFlag ?? NOFOLLOW;
  const directory = await openDirectory(path.dirname(resolvedPath), {
    create: false,
    noFollowFlag,
  });
  try {
    return await readFromDirectory(directory, path.basename(resolvedPath), noFollowFlag);
  } finally {
    await directory.handle.close();
  }
}

export async function atomicWriteRegularFileNoFollow(filePath: string, content: string): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const directory = await openOrCreateDirectoryTree(path.dirname(resolvedPath));
  try {
    await atomicWriteToDirectory(directory, path.basename(resolvedPath), content, 0o600);
  } finally {
    await directory.handle.close();
  }
}
