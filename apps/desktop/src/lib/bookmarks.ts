import { ipc } from "./ipc";

/** Give the bookmark for `url` a new title; a blank title changes nothing. */
export async function renameBookmark(url: string, title: string): Promise<void> {
  if (!title.trim()) return;
  await ipc.bookmarkRename(url, title.trim());
}
