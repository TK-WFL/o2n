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
  ownerUid?: number;
  forbidGroupOtherWrite?: boolean;
}

export interface NoFollowReadOptions {
  noFollowFlag?: number;
}

export interface HomeStateReadOptions extends NoFollowReadOptions {
  expectedUid?: number;
  expectedFileUid?: number;
}

export interface AtomicWriteTestContext {
  temporaryPath: string;
  destinationPath: string;
  parentPath: string;
}

export interface AtomicWriteOptions {
  testHooks?: {
    afterTemporaryOpen?: (context: AtomicWriteTestContext) => Promise<void>;
    afterRename?: (context: AtomicWriteTestContext) => Promise<void>;
  };
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

function currentUserId(expectedUid?: number): number {
  if (expectedUid !== undefined) return expectedUid;
  const processWithUid = process as NodeJS.Process & {
    geteuid?: () => number;
    getuid?: () => number;
  };
  const uid = processWithUid.geteuid?.() ?? processWithUid.getuid?.();
  if (uid === undefined) {
    throw new LocalStateSecurityError('現在ユーザーの所有者IDを検証できない環境です');
  }
  return uid;
}

function assertSecureOwner(targetPath: string, stat: Stats, expectedUid: number): void {
  if (stat.uid !== expectedUid) {
    throw securityError(targetPath, '現在ユーザーが所有していません');
  }
}

function assertNoGroupOtherWrite(targetPath: string, stat: Stats): void {
  if ((stat.mode & 0o022) !== 0) {
    throw securityError(targetPath, 'group/other書込み権限が設定されています');
  }
}

function assertSecretFile(targetPath: string, stat: Stats, expectedUid: number): void {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw securityError(targetPath, '単一リンクの通常ファイルではありません');
  }
  assertSecureOwner(targetPath, stat, expectedUid);
  if ((stat.mode & 0o077) !== 0) {
    throw securityError(targetPath, '秘密ファイルの権限が0600相当ではありません');
  }
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
    ownerUid?: number;
    forbidGroupOtherWrite?: boolean;
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
    if (options.ownerUid !== undefined) {
      assertSecureOwner(directoryPath, opened, options.ownerUid);
    }
    if (options.forbidGroupOtherWrite) {
      assertNoGroupOtherWrite(directoryPath, opened);
    }
    if (options.mode !== undefined) await handle.chmod(options.mode);
    const secured = await handle.stat();
    if (options.ownerUid !== undefined) {
      assertSecureOwner(directoryPath, secured, options.ownerUid);
    }
    if (options.forbidGroupOtherWrite) {
      assertNoGroupOtherWrite(directoryPath, secured);
    }
    if (options.mode !== undefined && (secured.mode & 0o777) !== options.mode) {
      throw securityError(directoryPath, '要求されたdirectory権限を設定できません');
    }
    return {
      path: directoryPath,
      canonicalPath,
      handle,
      dev: opened.dev,
      ino: opened.ino,
      ownerUid: options.ownerUid,
      forbidGroupOtherWrite: options.forbidGroupOtherWrite,
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
  const resolvedDirectory = path.resolve(directoryPath);
  const filesystemRoot = path.parse(resolvedDirectory).root;
  const relativePath = path.relative(filesystemRoot, resolvedDirectory);
  if (path.isAbsolute(relativePath) || relativePath.startsWith(`..${path.sep}`)) {
    throw securityError(directoryPath, 'filesystem root外のパスは使用できません');
  }
  const segments = relativePath.split(path.sep).filter(Boolean);

  let directory = await openDirectory(filesystemRoot, {
    create: false,
    noFollowFlag,
  });
  try {
    for (const segment of segments) {
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
  if (directory.ownerUid !== undefined) {
    assertSecureOwner(directory.path, current, directory.ownerUid);
  }
  if (directory.forbidGroupOtherWrite) {
    assertNoGroupOtherWrite(directory.path, current);
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
  expectedUid?: number,
): Promise<OpenDirectory> {
  const canonicalHome = await fs.realpath(os.homedir());
  const ownerUid = currentUserId(expectedUid);
  return openDirectory(path.join(canonicalHome, '.o2n'), {
    create,
    mode: 0o700,
    canonicalParent: canonicalHome,
    noFollowFlag,
    ownerUid,
    forbidGroupOtherWrite: true,
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
  secretOwnerUid?: number,
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
    if (secretOwnerUid !== undefined) {
      assertSecretFile(filePath, opened, secretOwnerUid);
      assertSecretFile(filePath, afterOpen, secretOwnerUid);
    }
    await assertDirectoryUnchanged(directory);
    const content = await handle.readFile('utf-8');
    const afterRead = await fs.lstat(filePath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile()) {
      throw securityError(filePath, 'I/O中にファイルが置き換えられました');
    }
    assertSameEntry(filePath, before, opened, afterRead);
    if (secretOwnerUid !== undefined) {
      assertSecretFile(filePath, afterRead, secretOwnerUid);
    }
    await assertDirectoryUnchanged(directory);
    return content;
  } finally {
    await handle.close();
  }
}

function assertSingleLinkIdentity(
  targetPath: string,
  expected: Stats,
  actual: Stats,
): void {
  if (
    !expected.isFile()
    || !actual.isFile()
    || expected.nlink !== 1
    || actual.nlink !== 1
    || expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || fileType(expected) !== fileType(actual)
  ) {
    throw securityError(targetPath, '単一リンクの検証済み通常ファイルと一致しません');
  }
}

function assertAtomicFilePolicy(
  directory: OpenDirectory,
  targetPath: string,
  stat: Stats,
  mode: number,
): void {
  if (directory.ownerUid === undefined) return;
  assertSecureOwner(targetPath, stat, directory.ownerUid);
  if ((stat.mode & 0o777) !== mode) {
    throw securityError(targetPath, '秘密ファイルの権限が要求値と一致しません');
  }
}

async function verifyRenamedDestination(
  directory: OpenDirectory,
  destination: string,
  expected: Stats,
  mode: number,
): Promise<void> {
  await assertDirectoryUnchanged(directory);
  const before = await fs.lstat(destination);
  if (before.isSymbolicLink()) throw securityError(destination, 'シンボリックリンクは使用できません');
  assertSingleLinkIdentity(destination, expected, before);
  assertAtomicFilePolicy(directory, destination, before, mode);

  const handle = await fs.open(destination, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    const after = await fs.lstat(destination);
    assertSingleLinkIdentity(destination, expected, opened);
    assertSingleLinkIdentity(destination, expected, after);
    assertAtomicFilePolicy(directory, destination, opened, mode);
    assertAtomicFilePolicy(directory, destination, after, mode);
    assertSameEntry(destination, before, opened, after);
    await assertDirectoryUnchanged(directory);
  } finally {
    await handle.close();
  }
}

async function atomicWriteToDirectory(
  directory: OpenDirectory,
  fileName: string,
  content: string,
  mode: number,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const destination = path.join(directory.path, fileName);
  await assertRegularDestination(destination);

  const temporary = path.join(
    directory.path,
    `.${fileName}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  const hookContext: AtomicWriteTestContext = {
    temporaryPath: temporary,
    destinationPath: destination,
    parentPath: directory.path,
  };
  let temporaryIdentity: Stats | undefined;
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    mode,
  );
  try {
    await options.testHooks?.afterTemporaryOpen?.(hookContext);
    await handle.chmod(mode);
    const opened = await handle.stat();
    temporaryIdentity = opened;
    const atPath = await fs.lstat(temporary);
    assertSingleLinkIdentity(temporary, opened, atPath);
    assertAtomicFilePolicy(directory, temporary, opened, mode);
    assertAtomicFilePolicy(directory, temporary, atPath, mode);
    await assertDirectoryUnchanged(directory);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    const afterWrite = await handle.stat();
    const afterWritePath = await fs.lstat(temporary);
    assertSingleLinkIdentity(temporary, opened, afterWrite);
    assertSingleLinkIdentity(temporary, opened, afterWritePath);
    assertAtomicFilePolicy(directory, temporary, afterWrite, mode);
    assertAtomicFilePolicy(directory, temporary, afterWritePath, mode);
    await assertDirectoryUnchanged(directory);
  } finally {
    await handle.close();
  }

  if (!temporaryIdentity) {
    throw securityError(temporary, '一時ファイルのidentityを取得できませんでした');
  }
  await assertDirectoryUnchanged(directory);
  await assertRegularDestination(destination);
  const beforeRename = await fs.lstat(temporary);
  assertSingleLinkIdentity(temporary, temporaryIdentity, beforeRename);
  await fs.rename(temporary, destination);
  await options.testHooks?.afterRename?.(hookContext);
  await verifyRenamedDestination(directory, destination, temporaryIdentity, mode);
  await directory.handle.sync();
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
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = await openVaultStateDirectory(vaultPath, true);
  try {
    await atomicWriteToDirectory(directory, fileName, content, 0o600, options);
  } finally {
    await directory.handle.close();
  }
}

export async function readHomeStateFile(
  fileName: HomeStateFileName,
  options: HomeStateReadOptions = {},
): Promise<string> {
  const noFollowFlag = options.noFollowFlag ?? NOFOLLOW;
  const ownerUid = currentUserId(options.expectedUid);
  const fileOwnerUid = currentUserId(options.expectedFileUid);
  const directory = await openHomeStateDirectory(false, noFollowFlag, ownerUid);
  try {
    return await readFromDirectory(directory, fileName, noFollowFlag, fileOwnerUid);
  } finally {
    await directory.handle.close();
  }
}

export async function atomicWriteHomeStateFile(
  fileName: HomeStateFileName,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = await openHomeStateDirectory(true);
  try {
    await atomicWriteToDirectory(directory, fileName, content, 0o600, options);
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

export async function atomicWriteRegularFileNoFollow(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const directory = await openOrCreateDirectoryTree(path.dirname(resolvedPath));
  try {
    await atomicWriteToDirectory(directory, path.basename(resolvedPath), content, 0o600, options);
  } finally {
    await directory.handle.close();
  }
}
