import { describe, expect, it } from "vitest";
import { TabletSource, TabletUnavailableError, type TabletEntry, type TabletFiles } from "./tablet";

const files = (list: (path: string) => Promise<TabletEntry[]>): TabletFiles => ({ list, read: () => Promise.reject(new Error("unexpected read")) });
const dir = (name: string): TabletEntry => ({ name, type: "directory", size: 0, mtime: 0 });

// A device without BOOX notes must report TabletUnavailableError: background
// syncs stay silent on it, so an Android phone sharing the vault isn't nagged.
describe("tablet source on a device without BOOX notes", () => {
  it("reports a missing note store as unavailable", async () => {
    await expect(new TabletSource(files(() => Promise.resolve([]))).sources()).rejects.toBeInstanceOf(TabletUnavailableError);
  });
  it("ignores the shared-user database when looking for an account", async () => {
    const couch = files(path => Promise.resolve(path.endsWith("/couch") ? [dir("share_user-NOTE_TREE.cblite2")] : []));
    await expect(new TabletSource(couch).sources()).rejects.toBeInstanceOf(TabletUnavailableError);
  });
  it("reports an unreadable note store as unavailable", async () => {
    const denied = files(() => Promise.reject(new Error("Cannot read /storage/emulated/0/.ksync/couch: permission denied")));
    await expect(new TabletSource(denied).sources()).rejects.toThrow(TabletUnavailableError);
  });
});
