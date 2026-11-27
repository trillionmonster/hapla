# Review and deliver code changes

Open a conversation, switch to **Coder**, and choose **Changes**. Git operations
run on the machine that owns the workspace. The same screen works on a phone.
The workspace path stays visible above the tabs, including on phones. The
workspace must already be a Git repository; Hapla does not initialize one.
Older workers must be updated before they can serve the new Git RPCs. A preserved
live session without these handlers can use its upgraded daemon for Git access
without restarting that conversation. Only an explicit missing-handler response
allows this fallback; uncertain mutations are never replayed on another route.
This fallback restores Git access, but does not add checkpoint capture to an
already running worker process. Its Turn view explains that limitation and
disables native checkpoint actions until the conversation resumes with the
updated CLI. Past turn checkpoints cannot be reconstructed.

## Review

The workbench keeps changed files and commit controls beside the diff on desktop.
On smaller screens, **Changed files** opens the file list; code remains visible
first and commit controls follow it. Use the filter to find a path. **Turn** opens
the checkpoint list; choosing a checkpoint brings its diff and restore action
into view. A file's full path is available in its tooltip.
After reconnecting, the workbench refreshes read-only results. Commit and PR
drafts remain editable after a failure. Status, commit history, and checkpoints
load independently. Read requests for these resources stop after 20 seconds per
route; diff reads stop after 45 seconds. Unsupported workers, non-repositories,
and timeouts show an actionable error and Retry rather than an empty clean view.
Switching tabs keeps the load error visible. Unknown counts use a dash, and
workspace mutations remain disabled until status has loaded successfully.
An empty worktree view explains that staging or committing removes files from
that view. When commits exist, **View latest commit** opens their actual patch
directly. Staged and base comparisons identify which comparison is empty.

Formatted patches show file headers, old/new line numbers, and additions/removals
with both signs and color. Only visible rows are mounted for large patches.
**Raw patch** shows the complete loaded text for native browser find, selection,
and copying; **Formatted diff** returns to the line view. Both views use the same
paginated revision and preserve the original whitespace.

Choose **Unstaged + new files**, **Staged**, **Against base**, **Commit**, or
**Turn**. Select a file to narrow the diff. The base picker accepts a locally
available branch or commit. Branch comparison includes the current working files
and uses the merge base with HEAD. Commit comparison uses the commit's first
parent, including the initial commit. Turn comparison uses before/after workspace
snapshots: it includes changes pulled, merged, or made by another process during
that turn, rather than attempting to attribute each line to the model.

Diffs load in bounded UTF-8 pages. **Load more diff** continues the same revision;
if files change between pages, refresh before continuing. Large results that
exceed the worker's 64 MiB command output limit fail explicitly. Binary files use
Git's binary patch representation. The file preview's Diff tab shows its first
page and links to Changes for the complete review.

## Stage, commit, push, and pull requests

Stage or unstage individual files, write a commit message, and commit the staged
changes. The worker uses the repository's configured Git author and hooks. A
failed commit preserves the message. The first commit of an initialized Git
repository is supported.

**Push branch** asks for confirmation and pushes the current branch to `origin`,
setting its upstream. Detached HEADs cannot be pushed. Authentication remains on
the worker; Hapla does not move Git credentials into the browser.

**Create draft PR** uses the worker's installed and authenticated GitHub CLI
(`gh`). Its title and description remain editable after a failure. **Load PR and
checks** reads the linked pull request and its current check results. This first
integration targets GitHub repositories supported by `gh`; it does not merge a
pull request or automatically retry an uncertain publish operation.

## Checkpoints and restore

Before each Hapla-submitted main Codex turn, the worker saves a native conversation
fork (or records a fresh empty thread) and captures a file checkpoint,
then finalizes it after completion, interruption, or failure. Steering remains
part of the current turn. Codex turns started independently by the provider are
not assigned a fabricated pre-turn snapshot. **Save checkpoint** captures an idle
Codex conversation boundary explicitly.

Snapshots use hidden `refs/hapla/checkpoints/…` refs, an alternate Git index, and
a ledger in the repository's common Git directory. They include tracked and
non-ignored untracked files and retain the staged baseline separately. They do
not add commits to the current branch or change its staged content. Ignored
files, external services, and submodule working directories are not backed up.
Keep normal repository and operational backups; the refs and ledger live with
that repository and have no automatic retention cleanup yet.

**Restore files and conversation** is available for an idle Codex session in a
separate Git worktree on the checkpoint's original conversation branch. It:

1. Rejects active work, queued inputs, running side chats/subagents, other live
   Hapla sessions using overlapping directories, a changed HEAD, or changes made
   since the screen was refreshed. Claims from another worker host fail closed;
   resolve them on that host before restoring.
2. Prepares a native conversation fork from the saved pre-turn snapshot. If native
   preparation fails, files are untouched.
3. Rechecks ownership and file revision, saves a recovery snapshot, restores the
   files and original staged baseline, and selects the new conversation branch.
   The original conversation remains available through the branch picker.

Ignored files that would collide with a restore block it. Restoring may replace
your own non-ignored edits after the selected checkpoint, so review and confirm
the operation. If file application or the final session-metadata update fails, the worker attempts
to restore the pre-action files and staged baseline. Recovery snapshots are
retained. This does not provide a crash-safe transaction across Git and the
native conversation store; process failure can require manual recovery.
Checkpoint capture also works before a repository's first commit. It records an
unborn HEAD without creating a branch commit or changing staged files. Creating
the first commit changes that boundary, so restoring an earlier checkpoint is
rejected by the same HEAD check. A repository without Git metadata still cannot
provide Git checkpoints.
Claude sessions support the Git review and delivery actions; coordinated
conversation/file restore is currently Codex-only and its button is disabled
for Claude. The main checkout cannot be restored through this action.

## Worktree lifecycle

Creation, listing, and removal use validated worker-side Git operations and a
repository lock. Hapla records the exact worktrees it creates. Removal checks
ownership, other live sessions, HEAD, changed/untracked/ignored files at execution
time, and invokes Git without `--force`. Worktrees created by older Hapla versions
without the ownership ledger stay readable and can be selected, but are kept on
cleanup; manage their removal through Git after reviewing their contents.

A confirmed session-start failure attempts safe cleanup. An uncertain transport
failure retains the worktree and creation request; retrying the same browser
draft reuses the request receipt during that daemon's lifetime. If a cleanup
fails, the error and retained path are shown. Branches remain after worktree
removal. Git operation receipts do not promise idempotency across daemon restarts.

## Context display

Codex supplies its last-turn token count and context capacity through native
runtime events. The browser checks the model and thread before using that
capacity. When capacity is unavailable, **Always show context size** displays the
known token count with **capacity unknown** rather than guessing a percentage.
Claude's existing usage totals remain available without an invented context cap.

## Validation

See [testing](testing.md) and the
[browser regression runner](../scripts/acceptance/README.md#coding-workbench-regression).
