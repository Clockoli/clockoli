# Advanced sync recovery

Clockoli keeps time changes locally until GitHub accepts them and helps resolve conflicts without losing queued work.

**Do not clear browser data or discard pending time unless you have confirmed it is saved elsewhere.**

## Sync and conflict review

Completed additions check the starting month, preceding day, any crossed month boundary, and active timer; running Starts check the starting and preceding-day files. Monthly records and the task index update atomically. Accepted entry dates and timezones remain unchanged, even after midnight or a timezone change. Overlaps and concurrent GitHub changes leave operations queued for review.

Open **Activity → Review sync issues**. The **Resolve time conflict** dialog shows affected entries; multiple conflicts share a selectable list. Expand **All queued changes** to inspect waiting operations. **Resolve blocking Start** and **Go to unresolved conflict** return to the change that needs attention.

Entries display local dates and HH:MM, but validation uses their exact saved timestamps. Background retries do not reset the selected resolution. If the reviewed time or a dependency changes, actions are disabled until **Recheck GitHub**. Unknown operations offer recheck and **Technical details**, never automatic deletion.

## Edit or delete overlapping time

For a stopped timer overlapping saved time, the dialog shows the saved entry and **Pending time · saved in this browser**. Each card has its own **Edit saved time / Edit pending time** and **Delete saved time / Delete pending time** actions.

- **Edit** opens the standard **Edit time** form: task, Start/End dates and times, description, and Non-billable. Editing pending time keeps its record ID and queues one corrected completion. Editing saved time uses a guarded GitHub update before retrying the pending timer. Both paths reject overlaps, changed GitHub records, and unsafe dependencies.
- **Delete** requires confirmation. Deleting pending time irreversibly removes its local Start/Stop only after checking GitHub history, the task index, and the active timer for an existing record. A saved entry is deleted with a guarded GitHub write; any linked queued edit is removed only after that succeeds. Unrelated work stays queued. If a record is already saved, depends on another change, or cannot be verified, deletion is blocked.

Unlike ordinary **Add time**, conflict edits try to sync immediately. Save blocks repeat submissions and closes after confirmation; failures keep corrected time locally queued. A stopped timer remains recoverable at the pre-save `appendMonthly` stage if GitHub confirms it has not been saved.

## Start-time conflicts

For `editActiveStart`, **Undo the start-time change** restores the original Start; **Start after the saved entry** moves it past the overlap when safe. A still-running timer offers **Adjust running timer Start** (Start only). A locally stopped timer offers the full **Edit pending time** form or a guarded **Delete pending time** instead. Retrying the same rejected Start does not resolve an overlap.

For a queued `startTimer`, **Start after previous entry** is available only when its Start overlaps one completed entry and no later changes depend on it. It moves Start to that entry's exact End without changing the timer ID. **Discard queued start** loses unsaved time and is offered only after checking that GitHub does not have that timer and no later operation depends on it. A newer remote active timer is never overwritten during recovery.

## Interrupted Stops and task switches

If `completeTimer` or `completeTimerAndStart` fails at `verifyActive`, `appendMonthly`, or `commitCompletion`, **Edit pending time** can recover the unsaved completion with its original ID; **Delete pending time** is a separately verified, destructive choice. A task switch keeps its next timer queued and checks it independently against GitHub.

Recovery also preserves later queued switches when their timer chain can be verified; an unrelated local running timer blocks unsafe recovery. If the completion was already saved, **Recover queued next timer** first confirms it in the monthly file and task index. No recovery may overwrite a newer GitHub active timer or save the same completion twice.

## Other queued operations

- `discardActive`: recheck and retry removal without deleting another running timer.
- `addTime` / `bulkAddTimes`: retry after verification, replan free intervals where available, or explicitly discard only after checking GitHub.
- `editEntry` / `editEntries`: compare original and pending records, retry guarded edits, or discard the queued edit.
- `deleteEntry`: retry deletion; cancellation is allowed only if the original record still exists in both the monthly file and task index.

Closing the dialog never discards queued time. Saved entries that already overlap switch Timeline and Calendar to **List** for ordinary editing; queued conflicts use **Review sync issues**.

## Related guides

- [Add and edit time](editing-time.md)
- [Sync and offline work](sync.md)
- [Troubleshooting](troubleshooting.md#synchronization-and-conflicts)
