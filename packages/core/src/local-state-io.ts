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
  trustUid?: number;
  requireCurrentOwner?: boolean;
  afterStickyRoot?: boolean;
  noFollowFlag?: number;
  finalMode?: number;
  finalRequireCurrentOwner?: boolean;
}

export interface NoFollowReadOptions {
  noFollowFlag?: number;
  testHooks?: {
    afterParentOpen?: (parentPath: string) => Promise<void>;
  };
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
    beforeTemporaryValidation?: (context: AtomicWriteTestContext) => Promise<void>;
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

function assertTrustedDirectory(
  targetPath: string,
  stat: Stats,
  effectiveUid: number,
  requireCurrentOwner: boolean,
): boolean {
  if (!stat.isDirectory()) throw securityError(targetPath, '通常のディレクトリではありません');
  const ownedByCurrentUser = stat.uid === effectiveUid;
  const ownedByRoot = stat.uid === 0;
  if (!ownedByCurrentUser && !ownedByRoot) {
    throw securityError(targetPath, '信頼できないユーザーが所有するancestorです');
  }
  if (requireCurrentOwner && !ownedByCurrentUser) {
    throw securityError(targetPath, 'sticky root配下は現在ユーザー所有である必要があります');
  }

  const groupOrOtherWritable = (stat.mode & 0o022) !== 0;
  const rootOwnedSticky = ownedByRoot && (stat.mode & 0o1000) !== 0;
  if (groupOrOtherWritable && !rootOwnedSticky) {
    throw securityError(targetPath, '信頼できないwritable ancestorです');
  }
  return requireCurrentOwner || rootOwnedSticky;
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
    trustUid?: number;
    requireCurrentOwner?: boolean;
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
    let afterStickyRoot: boolean | undefined;
    if (options.trustUid !== undefined) {
      const openedAfterSticky = assertTrustedDirectory(
        directoryPath,
        opened,
        options.trustUid,
        options.requireCurrentOwner ?? false,
      );
      const pathAfterSticky = assertTrustedDirectory(
        directoryPath,
        after,
        options.trustUid,
        options.requireCurrentOwner ?? false,
      );
      afterStickyRoot = openedAfterSticky || pathAfterSticky;
    }
    if (options.ownerUid !== undefined) {
      assertSecureOwner(directoryPath, opened, options.ownerUid);
    }
    if (options.forbidGroupOtherWrite) {
      assertNoGroupOtherWrite(directoryPath, opened);
    }
    const secured = await handle.stat();
    if (options.trustUid !== undefined) {
      afterStickyRoot = afterStickyRoot || assertTrustedDirectory(
        directoryPath,
        secured,
        options.trustUid,
        options.requireCurrentOwner ?? false,
      );
    }
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
      trustUid: options.trustUid,
      requireCurrentOwner: options.requireCurrentOwner,
      afterStickyRoot,
      noFollowFlag,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openDirectoryTree(
  directoryPath: string,
  options: {
    createMissing: boolean;
    noFollowFlag?: number;
    effectiveUid: number;
    finalMode?: number;
    finalRequireCurrentOwner?: boolean;
  },
): Promise<OpenDirectory> {
  const noFollowFlag = options.noFollowFlag ?? NOFOLLOW;
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
    trustUid: options.effectiveUid,
  });
  try {
    for (const [index, segment] of segments.entries()) {
      await assertDirectoryUnchanged(directory);
      const childPath = path.join(directory.canonicalPath, segment);
      let created = false;
      if (options.createMissing) {
        try {
          await fs.mkdir(childPath, { mode: 0o700 });
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }

      const isFinal = index === segments.length - 1;
      const requireCurrentOwner = Boolean(
        directory.afterStickyRoot
        || created
        || (isFinal && options.finalRequireCurrentOwner),
      );
      const child = await openDirectory(childPath, {
        create: false,
        canonicalParent: directory.canonicalPath,
        noFollowFlag,
        mode: created ? 0o700 : (isFinal ? options.finalMode : undefined),
        trustUid: options.effectiveUid,
        requireCurrentOwner,
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
    directory.finalMode = options.finalMode;
    directory.finalRequireCurrentOwner = options.finalRequireCurrentOwner;
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
  if (directory.trustUid !== undefined) {
    assertTrustedDirectory(
      directory.path,
      current,
      directory.trustUid,
      directory.requireCurrentOwner ?? false,
    );
  }
}

async function assertTrustedAncestryUnchanged(directory: OpenDirectory): Promise<void> {
  await assertDirectoryUnchanged(directory);
  if (directory.trustUid === undefined) return;

  const reopened = await openDirectoryTree(directory.path, {
    createMissing: false,
    noFollowFlag: directory.noFollowFlag,
    effectiveUid: directory.trustUid,
    finalMode: directory.finalMode,
    finalRequireCurrentOwner: directory.finalRequireCurrentOwner,
  });
  try {
    if (reopened.dev !== directory.dev || reopened.ino !== directory.ino) {
      throw securityError(directory.path, 'ancestor再検証中に最終directoryが置き換えられました');
    }
  } finally {
    await reopened.handle.close();
  }
}

async function openVaultStateDirectory(
  vaultPath: string,
  create: boolean,
  noFollowFlag?: number,
): Promise<OpenDirectory> {
  const effectiveUid = currentUserId();
  const vaultDirectory = await openDirectoryTree(path.resolve(vaultPath), {
    createMissing: false,
    noFollowFlag,
    effectiveUid,
  });
  try {
    const stateDirectory = await openDirectoryTree(path.join(vaultDirectory.canonicalPath, '.o2n'), {
      createMissing: create,
      noFollowFlag,
      effectiveUid,
      finalMode: 0o700,
    });
    try {
      await assertDirectoryUnchanged(vaultDirectory);
      return stateDirectory;
    } catch (error) {
      await stateDirectory.handle.close();
      throw error;
    }
  } finally {
    await vaultDirectory.handle.close();
  }
}

async function openHomeStateDirectory(
  create: boolean,
  noFollowFlag?: number,
  expectedUid?: number,
): Promise<OpenDirectory> {
  const ownerUid = currentUserId(expectedUid);
  const homeDirectory = await openDirectoryTree(path.resolve(os.homedir()), {
    createMissing: false,
    noFollowFlag,
    effectiveUid: ownerUid,
    finalRequireCurrentOwner: true,
  });
  try {
    const directory = await openDirectoryTree(path.join(homeDirectory.canonicalPath, '.o2n'), {
      createMissing: create,
      noFollowFlag,
      effectiveUid: ownerUid,
      finalMode: 0o700,
      finalRequireCurrentOwner: true,
    });
    try {
      await assertDirectoryUnchanged(homeDirectory);
      directory.ownerUid = ownerUid;
      directory.forbidGroupOtherWrite = true;
      return directory;
    } catch (error) {
      await directory.handle.close();
      throw error;
    }
  } finally {
    await homeDirectory.handle.close();
  }
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
  await assertTrustedAncestryUnchanged(directory);
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
    await assertTrustedAncestryUnchanged(directory);
    const content = await handle.readFile('utf-8');
    const afterRead = await fs.lstat(filePath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile()) {
      throw securityError(filePath, 'I/O中にファイルが置き換えられました');
    }
    assertSameEntry(filePath, before, opened, afterRead);
    if (secretOwnerUid !== undefined) {
      assertSecretFile(filePath, afterRead, secretOwnerUid);
    }
    await assertTrustedAncestryUnchanged(directory);
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
  if (!stat.isFile() || stat.nlink !== 1) {
    throw securityError(targetPath, '単一リンクの通常ファイルではありません');
  }
  if (directory.ownerUid !== undefined) {
    assertSecureOwner(targetPath, stat, directory.ownerUid);
  }
  if ((stat.mode & 0o777) !== mode) {
    throw securityError(targetPath, 'atomicファイルの権限が要求値と一致しません');
  }
}

async function verifyRenamedDestination(
  directory: OpenDirectory,
  destination: string,
  expected: Stats,
  mode: number,
): Promise<void> {
  await assertTrustedAncestryUnchanged(directory);
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
    await assertTrustedAncestryUnchanged(directory);
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
  await assertTrustedAncestryUnchanged(directory);
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
    await options.testHooks?.beforeTemporaryValidation?.(hookContext);
    const opened = await handle.stat();
    temporaryIdentity = opened;
    const atPath = await fs.lstat(temporary);
    assertSingleLinkIdentity(temporary, opened, atPath);
    assertAtomicFilePolicy(directory, temporary, opened, mode);
    assertAtomicFilePolicy(directory, temporary, atPath, mode);
    await assertTrustedAncestryUnchanged(directory);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    const afterWrite = await handle.stat();
    const afterWritePath = await fs.lstat(temporary);
    assertSingleLinkIdentity(temporary, opened, afterWrite);
    assertSingleLinkIdentity(temporary, opened, afterWritePath);
    assertAtomicFilePolicy(directory, temporary, afterWrite, mode);
    assertAtomicFilePolicy(directory, temporary, afterWritePath, mode);
    await assertTrustedAncestryUnchanged(directory);
  } finally {
    await handle.close();
  }

  if (!temporaryIdentity) {
    throw securityError(temporary, '一時ファイルのidentityを取得できませんでした');
  }
  await assertTrustedAncestryUnchanged(directory);
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
    await assertTrustedAncestryUnchanged(directory);
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
  const directory = await openDirectoryTree(path.dirname(resolvedPath), {
    createMissing: false,
    noFollowFlag,
    effectiveUid: currentUserId(),
  });
  try {
    await options.testHooks?.afterParentOpen?.(directory.path);
    return await readFromDirectory(directory, path.basename(resolvedPath), noFollowFlag);
  } finally {
    await directory.handle.close();
  }
}

export async function validateTrustedDirectoryAncestry(
  directoryPath: string,
  expectedUid?: number,
): Promise<void> {
  const directory = await openDirectoryTree(directoryPath, {
    createMissing: false,
    effectiveUid: currentUserId(expectedUid),
  });
  await directory.handle.close();
}

export async function atomicWriteRegularFileNoFollow(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const directory = await openDirectoryTree(path.dirname(resolvedPath), {
    createMissing: true,
    effectiveUid: currentUserId(),
  });
  try {
    await atomicWriteToDirectory(directory, path.basename(resolvedPath), content, 0o600, options);
  } finally {
    await directory.handle.close();
  }
}
