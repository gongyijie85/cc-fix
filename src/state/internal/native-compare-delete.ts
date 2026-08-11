import type { DurableFileSystem } from '../durable-file.js';

const trustedNativeAdapters = new WeakSet<object>();

export function isTrustedNativeCompareDeleteFilesystem(
  value: DurableFileSystem,
): boolean {
  return trustedNativeAdapters.has(value);
}

/** @internal T22 production composition and state test-support are the only intended issuers. */
export function issueNativeCompareDeleteFilesystem<T extends DurableFileSystem>(filesystem: T): T {
  if (
    filesystem.compareDeleteCapability !== 'native-compare-delete' ||
    filesystem.compareAndDelete === undefined
  ) throw new TypeError('Native compare-delete adapter is incomplete');
  trustedNativeAdapters.add(filesystem);
  return filesystem;
}
