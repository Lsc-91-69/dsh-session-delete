# Delete session

Adds a **Delete session** entry to the session row menu — the `…` button and the right-click menu — and removes that session's stored log from disk, together with the subagent sessions it created.

## Install

1. Clone this repository anywhere:

   ```sh
   git clone https://github.com/Lsc-91-69/dsh-session-delete.git
   ```

2. In DSH open **Plugins → Add plugin** and choose the cloned directory (or call the `plugin_manager` tool with `install_bundle` and that absolute path). The bundle declares its own `cordis.patch.yml`, so no manual patch editing is needed.
3. Refresh the Web UI once (`Ctrl+R`). The menu entry appears on every session row.

Built and tested against **DSH 0.2.2-rc.3** (Desktop build). It uses the Host services `connection` and `sessionPersistence`, and the Client services `contextMenus`, `slots`, and `locale`; a different DSH release may need small adjustments.

## What happens

1. Choose **Delete session** in the `…` menu of a session row.
2. The dialog runs a read-only preflight and shows the exact storage directory, the total size on disk, and how many subagent sessions would disappear with it.
3. **Delete permanently** has two outcomes:
   - A session **this DSH run has never opened** is erased immediately: its directory goes, and the row leaves the sidebar without a page reload.
   - A session that is **open, or still running**, still has its Agent resident in the Host and its log open for writing; erasing files underneath it would be written back. The dialog says so, the button reads **Mark for deletion**, and the session is removed by the next DSH start, before the catalog is loaded.

## Why a resident session waits for a restart

In DSH, a session that has been opened keeps its Agent (and the log's write handle) until the process exits, and the sidebar fills live sessions from memory. For those sessions erasing files neither removes the row nor stays erased. After a restart it is an ordinary cold session and one delete removes it cleanly.

## Other limits

- `Archive session` is the reversible option: it hides the row and keeps the log.
- Deleting is irreversible. There is no trash and no undo.
- The workspace registry keeps its own membership list; the deleted id is dropped from its pinned and archived sets, and the remaining stale membership entry is ignored by the sidebar because the log is gone.
- Attachments (images, files) are content-addressed and shared between sessions, so they are not deleted.
- The pending queue lives in `~/.dsh/session-delete/pending.json` (under `DSH_HOME` when set); deleting that file cancels every queued removal.

## Turning it off

Disable the bundle in **Plugins** (or remove it). The menu entry and the dialog disappear, sessions already deleted stay deleted, and the pending queue is no longer swept at startup. No model request is ever made by this plugin.

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
