import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ChannelLauncherProps,
  PanelProps,
} from "../../features/panels/service";
import { usePanelTabTitle } from "../../features/panels/PanelWorkspace";
import {
  activeMachineIdSnapshot,
  useRemoteAgentHosts,
  useRemoteMachines,
  useRemoteMachineStatuses,
  type RemoteMachine,
} from "../../features/agents/remote-machines";
import {
  browsableRemoteMachines,
  cleanRemoteFsErrorMessage,
  deleteRemoteEntry,
  isRemoteFsAlreadyExists,
  isRemoteFsConflict,
  isRemoteFsUnsupported,
  joinRemotePath,
  listRemoteDirectory,
  mkdirRemoteDirectory,
  readRemoteFile,
  REMOTE_FS_UNSUPPORTED_MESSAGE,
  remotePathCrumbs,
  renameRemoteEntry,
  writeRemoteFile,
  type RemoteFsEntry,
  type RemoteFsListResult,
  type RemoteFsReadResult,
} from "../../features/agents/remote-fs";
import {
  readWorkspace,
  workspaceCanvas,
  workspaceDirectories,
} from "../../features/solo/workspace";
import { useListedChannel } from "../../features/relay/listed-channel";
import { canvasReadOnly } from "../../features/channel-templates/capability";
import {
  MarkdownDocument,
  MarkdownSource,
  sharedComponents,
} from "../../features/markdown/MarkdownDocument";
import {
  DOCUMENT_PROFILE,
  fitsDocumentRenderBudget,
} from "../../features/markdown/document-profile";
import {
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  CaretRightIcon,
  CopyIcon,
  DotsThreeVerticalIcon,
  FileCodeIcon,
  FileTextIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  ImageIcon,
  MonitorIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Badge } from "../../shared/design-system/ui/Badge";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { Select } from "../../shared/design-system/ui/Select";
import { Switch } from "../../shared/design-system/ui/Switch";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { writeClipboardText } from "../../shared/clipboard";
import styles from "./RemoteFilesPanel.module.css";

type Listing = Readonly<{
  path: string;
  displayPath: string;
  parent: string | null;
  entries: readonly RemoteFsEntry[];
  truncated: boolean;
}>;

type CanvasHead = Readonly<{ id?: string; content: string }>;

const FILES_TARGET = "buzz.files";
const MAX_PREVIEW_LINES = 4_000;
const MAX_WORKSPACE_FOLDERS = 20;

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function isDirectory(entry: RemoteFsEntry) {
  return entry.kind === "dir" || entry.targetKind === "dir";
}

/** Files this panel may edit: text, complete, and within the read budget. */
function isEditable(result: RemoteFsReadResult | undefined): boolean {
  return (
    !!result &&
    !result.isBinary &&
    !result.isImage &&
    !result.truncated &&
    result.content !== null
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function CodePreview({ content }: { content: string }) {
  const lines = content.split("\n");
  const shown = lines.slice(0, MAX_PREVIEW_LINES);
  return (
    <>
      <div className={styles.code}>
        {shown.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are the identity.
          <div key={index} className={styles.codeLine}>
            <span className={styles.lineNumber} aria-hidden="true">
              {index + 1}
            </span>
            <span className={styles.lineText}>{line || " "}</span>
          </div>
        ))}
      </div>
      {lines.length > MAX_PREVIEW_LINES && (
        <p className={styles.status}>
          Showing the first {MAX_PREVIEW_LINES} lines.
        </p>
      )}
    </>
  );
}

function sortEntries(entries: readonly RemoteFsEntry[]) {
  return [...entries].sort((a, b) => {
    const directory = Number(isDirectory(b)) - Number(isDirectory(a));
    if (directory) return directory;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function folderFor(content: string): string[] {
  try {
    return readWorkspace(content).folders;
  } catch {
    return workspaceDirectories(content);
  }
}

function FilePreview({
  entry,
  result,
  loading,
  error,
  unsupported,
  editing,
  draft,
  dirty,
  saving,
  saveError,
  conflict,
  discardGuard,
  onToggleEdit,
  onDraftChange,
  onSave,
  onReloadFromDisk,
  onDiscard,
  onKeepEditing,
  onDiscardGuard,
  onRetry,
  onClose,
}: {
  entry: RemoteFsEntry;
  result: RemoteFsReadResult | undefined;
  loading: boolean;
  error: string;
  unsupported: boolean;
  editing: boolean;
  draft: string;
  dirty: boolean;
  saving: boolean;
  saveError: string;
  conflict: boolean;
  discardGuard: { kind: "open" | "close"; name: string } | undefined;
  onToggleEdit(): void;
  onDraftChange(value: string): void;
  onSave(overwrite: boolean): void;
  onReloadFromDisk(): void;
  onDiscard(): void;
  onKeepEditing(): void;
  onDiscardGuard(): void;
  onRetry(): void;
  onClose(): void;
}) {
  const [raw, setRaw] = useState(false);
  const notify = useToastNotification();
  const name = entry.name;
  const markdown = /\.mdx?$/i.test(name);
  const editable = isEditable(result);
  const content = result?.content ?? "";
  const copy = (value: string, label: string) => {
    void writeClipboardText(value).then(
      () => notify(`${label} copied`, "success"),
      () => notify(`Couldn't copy ${label.toLowerCase()}`, "error"),
    );
  };
  return (
    <div className={styles.preview}>
      <header className={styles.previewHeader}>
        <div className={styles.previewIdentity}>
          <span className={styles.rowName} title={entry.displayPath}>
            {name}
          </span>
          <span className={styles.path}>{entry.displayPath}</span>
        </div>
        <div className={styles.previewActions}>
          {editing && dirty && (
            <Badge>
              <span>Unsaved changes</span>
            </Badge>
          )}
          {editable && !editing && (
            <Button variant="subtle" size="sm" onClick={onToggleEdit}>
              Edit
            </Button>
          )}
          {editable && editing && (
            <Button variant="subtle" size="sm" onClick={onToggleEdit}>
              {markdown ? "Preview" : "View"}
            </Button>
          )}
          {editing && (
            <>
              <Button
                variant="prominent"
                size="sm"
                loading={saving}
                disabled={!dirty || saving || conflict}
                onClick={() => onSave(false)}
              >
                Save
              </Button>
              <Button
                variant="subtle"
                size="sm"
                disabled={saving}
                onClick={onDiscard}
              >
                Discard
              </Button>
            </>
          )}
          {markdown &&
            result &&
            !result.isBinary &&
            result.content !== null &&
            !editing && (
              <Button
                variant="subtle"
                size="sm"
                aria-pressed={raw}
                onClick={() => setRaw((value) => !value)}
              >
                {raw ? "Preview" : "Raw"}
              </Button>
            )}
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Copy path"
            title="Copy path"
            icon={<CopyIcon size={16} aria-hidden="true" />}
            onClick={() => copy(entry.displayPath, "Path")}
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Copy contents"
            title="Copy contents"
            icon={<FileTextIcon size={16} aria-hidden="true" />}
            disabled={!result?.content}
            onClick={() => copy(editing ? draft : content, "Contents")}
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Close preview"
            title="Close preview"
            icon={<XIcon size={16} aria-hidden="true" />}
            onClick={onClose}
          />
        </div>
      </header>
      {discardGuard && dirty && (
        <div role="alert" className={styles.guard}>
          <span>
            You have unsaved changes to {discardGuard.name}.
            {discardGuard.kind === "open"
              ? " Opening another file discards them."
              : ""}
          </span>
          <Button variant="outline" size="sm" onClick={onKeepEditing}>
            Keep editing
          </Button>
          <Button variant="destructive" size="sm" onClick={onDiscardGuard}>
            Discard changes
          </Button>
        </div>
      )}
      <div className={styles.previewBody}>
        {loading && (
          <p role="status" className={styles.status}>
            Loading file…
          </p>
        )}
        {error && !unsupported && (
          <div role="alert" className={styles.status}>
            <span>{error}</span>{" "}
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {unsupported && (
          <EmptyState
            icon={<FileTextIcon size={20} aria-hidden="true" />}
            title="Files are unavailable"
            description={REMOTE_FS_UNSUPPORTED_MESSAGE}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            }
          />
        )}
        {result?.truncated && (
          <p className={styles.status}>
            This file is larger than the edit size limit, so it is read-only
            here. Only the beginning is shown.
          </p>
        )}
        {editing && result && !result.isBinary && result.content !== null && (
          <div className={styles.editor}>
            {conflict && (
              <div role="alert" className={styles.conflict}>
                <span>
                  This file changed on disk since it was loaded. Save your
                  changes elsewhere, or resolve the conflict.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={onReloadFromDisk}
                >
                  Reload from disk
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={saving}
                  onClick={() => onSave(true)}
                >
                  Overwrite anyway
                </Button>
              </div>
            )}
            {saveError && (
              <p role="alert" className={styles.danger}>
                {saveError}
              </p>
            )}
            <Textarea
              aria-label={`Edit ${entry.name}`}
              variant="code"
              rows={16}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key.toLowerCase() === "s"
                ) {
                  event.preventDefault();
                  if (dirty && !saving && !conflict) onSave(false);
                }
              }}
            />
          </div>
        )}
        {!editing &&
          result &&
          !error &&
          (result.isImage && result.encoding === "base64" && content ? (
            <img
              className={styles.image}
              src={`data:${result.mimeType};base64,${content}`}
              alt={result.name}
            />
          ) : result.isBinary || result.content === null ? (
            <EmptyState
              icon={<FileTextIcon size={20} aria-hidden="true" />}
              title="Binary file"
              description={`${formatSize(result.size)} · ${result.mimeType}`}
              frame="none"
            />
          ) : markdown && !raw ? (
            fitsDocumentRenderBudget(content) ? (
              <MarkdownDocument
                content={content}
                profile={DOCUMENT_PROFILE}
                components={sharedComponents}
                capabilities={{ copy: true }}
                scale="document"
              />
            ) : (
              <MarkdownSource content={content} />
            )
          ) : (
            <CodePreview content={content} />
          ))}
      </div>
    </div>
  );
}

// One element keeps the tab identity stable across renders.
const tabIcon = <FolderOpenIcon size="1rem" />;

export function registerRemoteFiles(ctx: Context) {
  function Launcher({ toggle, pressed }: ChannelLauncherProps) {
    const machines = useRemoteMachines();
    const statuses = useRemoteMachineStatuses();
    if (!browsableRemoteMachines(machines, statuses).length) return null;
    return (
      <IconButton
        size="toolbar"
        icon={<FolderOpenIcon size={16} aria-hidden="true" />}
        aria-label="Toggle files"
        title="Files"
        aria-expanded={pressed}
        onClick={(event) => {
          event.currentTarget.focus();
          toggle(FILES_TARGET);
        }}
      />
    );
  }

  function Panel({ channelContext }: PanelProps) {
    usePanelTabTitle("Files", tabIcon);
    const state = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    const machines = useRemoteMachines();
    const statuses = useRemoteMachineStatuses();
    const hosts = useRemoteAgentHosts();
    const browsable = useMemo(
      () => browsableRemoteMachines(machines, statuses),
      [machines, statuses],
    );
    const channelId = channelContext?.channelId;
    const session = state.status === "ready" ? state.session : undefined;
    const scope = state.status === "ready" ? state.scope : undefined;
    const channel = session?.channels
      .list()
      .channels.find(({ id }) => id === channelId);
    const membersKey = channel?.members?.join(",") ?? "";
    const canvasWritable = !useListedChannel(
      state.status === "ready" ? state.session.channels : undefined,
      channelId,
      canvasReadOnly,
    );
    const [machineId, setMachineId] = useState("");
    const [roots, setRoots] = useState<readonly string[] | undefined>();
    const [root, setRoot] = useState("~");
    const [showHidden, setShowHidden] = useState(false);
    const [filter, setFilter] = useState("");
    const [listing, setListing] = useState<Listing | undefined>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [unsupported, setUnsupported] = useState(false);
    const [previewEntry, setPreviewEntry] = useState<
      RemoteFsEntry | undefined
    >();
    const [previewResult, setPreviewResult] = useState<
      RemoteFsReadResult | undefined
    >();
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState("");
    const [previewUnsupported, setPreviewUnsupported] = useState(false);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState("");
    const [conflict, setConflict] = useState(false);
    const [discardGuard, setDiscardGuard] = useState<
      { kind: "open"; entry: RemoteFsEntry } | { kind: "close" } | undefined
    >();
    const [createKind, setCreateKind] = useState<"file" | "folder">();
    const [createName, setCreateName] = useState("");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState("");
    const [renaming, setRenaming] = useState<string | undefined>();
    const [renameDraft, setRenameDraft] = useState("");
    const [renameBusy, setRenameBusy] = useState(false);
    const [renameError, setRenameError] = useState("");
    const [deleting, setDeleting] = useState<string | undefined>();
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [deleteError, setDeleteError] = useState("");
    const [addingFolder, setAddingFolder] = useState(false);
    const [addFolderError, setAddFolderError] = useState("");
    const request = useRef(0);
    const abort = useRef<AbortController | undefined>(undefined);
    const previewRequest = useRef(0);
    const previewAbort = useRef<AbortController | undefined>(undefined);
    const listingRef = useRef<Listing | undefined>(undefined);
    const [crumbsNode, setCrumbsNode] = useState<HTMLElement | null>(null);
    const crumbsPinned = useRef(true);
    const machine = machineId
      ? browsable.find(({ id }) => id === machineId)
      : undefined;
    const notify = useToastNotification();
    const machineRef = useRef<RemoteMachine | undefined>(machine);
    machineRef.current = machine;
    const showHiddenRef = useRef(showHidden);
    showHiddenRef.current = showHidden;
    const sessionRef = useRef(session);
    sessionRef.current = session;
    const [canvasHead, setCanvasHead] = useState<CanvasHead | undefined>();
    const canvasHeadRef = useRef<CanvasHead | undefined>(canvasHead);
    canvasHeadRef.current = canvasHead;
    const rootsRef = useRef<readonly string[] | undefined>(roots);
    rootsRef.current = roots;

    const dirty = editing && draft !== (previewResult?.content ?? "");

    const syncCrumbs = useCallback(
      (pinEnd: boolean) => {
        if (!crumbsNode) return;
        if (pinEnd) {
          crumbsNode.scrollLeft = Math.max(
            0,
            crumbsNode.scrollWidth - crumbsNode.clientWidth,
          );
        }
        const start = crumbsNode.scrollLeft > 1;
        const end =
          crumbsNode.scrollLeft + crumbsNode.clientWidth <
          crumbsNode.scrollWidth - 1;
        crumbsNode.toggleAttribute("data-overflow-start", start);
        crumbsNode.toggleAttribute("data-overflow-end", end);
      },
      [crumbsNode],
    );

    const displayPath = listing?.displayPath;
    useLayoutEffect(() => {
      if (!crumbsNode || !displayPath) return;
      crumbsPinned.current = true;
      syncCrumbs(true);
    }, [crumbsNode, displayPath, syncCrumbs]);

    useLayoutEffect(() => {
      if (!crumbsNode || typeof ResizeObserver !== "function") return;
      const observer = new ResizeObserver(() => {
        syncCrumbs(crumbsPinned.current);
      });
      observer.observe(crumbsNode);
      return () => observer.disconnect();
    }, [crumbsNode, syncCrumbs]);

    useEffect(() => {
      setMachineId((current) => {
        if (current && browsable.some(({ id }) => id === current))
          return current;
        for (const member of membersKey ? membersKey.split(",") : []) {
          const mapped = hosts[member.toLowerCase()];
          if (mapped && browsable.some(({ id }) => id === mapped))
            return mapped;
        }
        const active = activeMachineIdSnapshot();
        if (active && browsable.some(({ id }) => id === active)) return active;
        return browsable[0]?.id ?? "";
      });
      // The member key changes with the chat's roster and the machine map.
    }, [browsable, hosts, membersKey]);

    // The chat's Canvas names its workspace folders; a hand-edited block still
    // names the directories its agent may work in.
    useEffect(() => {
      if (!session || !channelId) return;
      let alive = true;
      void session.canvas.read(channelId).then(
        (head) => {
          if (!alive) return;
          setCanvasHead(
            head ? { id: head.id, content: head.content } : undefined,
          );
          setRoots(folderFor(head?.content ?? ""));
        },
        () => {
          if (alive) setRoots([]);
        },
      );
      return () => {
        alive = false;
      };
    }, [session, channelId]);

    const load = useCallback(async (path?: string, keepPreview = false) => {
      const target = machineRef.current;
      if (!target) return;
      const generation = ++request.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      setError("");
      setUnsupported(false);
      if (!keepPreview) {
        previewRequest.current += 1;
        previewAbort.current?.abort();
        setPreviewEntry(undefined);
        setPreviewResult(undefined);
        setPreviewError("");
        setPreviewUnsupported(false);
        setPreviewLoading(false);
        setEditing(false);
        setDraft("");
        setSaveError("");
        setConflict(false);
        setDiscardGuard(undefined);
      }
      try {
        const result: RemoteFsListResult = await listRemoteDirectory(
          target,
          {
            ...(path ? { path } : {}),
            showHidden: showHiddenRef.current,
          },
          { signal: controller.signal },
        );
        if (generation !== request.current) return;
        const next: Listing = {
          path: result.path,
          displayPath: result.displayPath,
          parent: result.parent,
          entries: result.entries,
          truncated: result.truncated,
        };
        listingRef.current = next;
        setListing(next);
        setFilter("");
      } catch (reason) {
        if (generation !== request.current) return;
        if (reason instanceof Error && reason.name === "AbortError") return;
        setUnsupported(isRemoteFsUnsupported(reason));
        setError(message(reason));
      } finally {
        if (generation === request.current) setLoading(false);
      }
    }, []);

    // Start at the chat's first workspace folder, or home when it has none.
    // Waiting for the Canvas read avoids loading home first, then the folder.
    // Keyed on whether the Canvas has been read, not its contents, so adding a
    // folder to the workspace does not navigate away from the current listing.
    const rootsReady = roots !== undefined;
    useEffect(() => {
      if (!machine || !rootsReady) return;
      const start = rootsRef.current?.[0] ?? "~";
      setRoot(start);
      void load(start);
    }, [machine, rootsReady, load]);

    const lastShowHidden = useRef(showHidden);
    useEffect(() => {
      if (lastShowHidden.current === showHidden) return;
      lastShowHidden.current = showHidden;
      void load(listingRef.current?.path ?? root, true);
    }, [showHidden, root, load]);

    useEffect(
      () => () => {
        request.current += 1;
        abort.current?.abort();
        previewRequest.current += 1;
        previewAbort.current?.abort();
      },
      [],
    );

    const clearPreview = () => {
      previewRequest.current += 1;
      previewAbort.current?.abort();
      setPreviewEntry(undefined);
      setPreviewResult(undefined);
      setPreviewError("");
      setPreviewUnsupported(false);
      setPreviewLoading(false);
      setEditing(false);
      setDraft("");
      setSaving(false);
      setSaveError("");
      setConflict(false);
      setDiscardGuard(undefined);
    };

    const openFile = (
      entry: RemoteFsEntry,
      keepEditing = false,
      force = false,
    ) => {
      // Clicking the open file while a draft is dirty keeps the draft.
      if (!force && dirty && previewEntry?.path === entry.path) return;
      if (
        !force &&
        !keepEditing &&
        dirty &&
        previewEntry?.path !== entry.path
      ) {
        setDiscardGuard({ kind: "open", entry });
        return;
      }
      const target = machineRef.current;
      if (!target) return;
      const generation = ++previewRequest.current;
      previewAbort.current?.abort();
      const controller = new AbortController();
      previewAbort.current = controller;
      setDiscardGuard(undefined);
      setPreviewEntry(entry);
      setPreviewResult(undefined);
      setPreviewError("");
      setPreviewUnsupported(false);
      setPreviewLoading(true);
      setEditing(false);
      setDraft("");
      setSaveError("");
      setConflict(false);
      void readRemoteFile(
        target,
        { path: entry.path },
        { signal: controller.signal },
      ).then(
        (result) => {
          if (generation !== previewRequest.current) return;
          setPreviewResult(result);
          setPreviewLoading(false);
          setDraft(result.content ?? "");
          setEditing(keepEditing && isEditable(result));
        },
        (reason) => {
          if (generation !== previewRequest.current) return;
          if (reason instanceof Error && reason.name === "AbortError") return;
          setPreviewUnsupported(isRemoteFsUnsupported(reason));
          setPreviewError(message(reason));
          setPreviewLoading(false);
        },
      );
    };

    const retryPreview = () => {
      if (previewEntry) openFile(previewEntry);
    };

    const closePreview = () => {
      if (dirty) {
        setDiscardGuard({ kind: "close" });
        return;
      }
      clearPreview();
    };

    const discardChanges = () => {
      const pending = discardGuard;
      setEditing(false);
      setDraft("");
      setConflict(false);
      setSaveError("");
      setDiscardGuard(undefined);
      if (pending?.kind === "close") clearPreview();
      else if (pending?.kind === "open") openFile(pending.entry, false, true);
    };

    const saveFile = async (overwrite = false) => {
      const target = machineRef.current;
      const result = previewResult;
      if (!target || !result) return;
      setSaving(true);
      setSaveError("");
      setConflict(false);
      try {
        const written = await writeRemoteFile(target, {
          path: result.path,
          content: draft,
          ...(!overwrite && result.mtimeMs
            ? { expectedMtimeMs: result.mtimeMs }
            : {}),
        });
        setPreviewResult({
          ...result,
          content: draft,
          mtimeMs: written.mtimeMs,
          size: written.size,
        });
        setDraft(draft);
        notify("Saved", "success");
      } catch (reason) {
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (isRemoteFsConflict(reason)) setConflict(true);
        else setSaveError(message(reason));
      } finally {
        setSaving(false);
      }
    };

    const reloadFromDisk = () => {
      if (previewEntry) openFile(previewEntry, true, true);
    };

    const navigate = (path: string) => {
      if (!path.trim()) return;
      void load(path.trim());
    };

    const createEntry = async () => {
      const target = machineRef.current;
      const current = listing;
      const name = createName.trim();
      if (!target || !current || !name) return;
      setCreating(true);
      setCreateError("");
      try {
        if (createKind === "folder") {
          await mkdirRemoteDirectory(target, {
            path: joinRemotePath(current.displayPath, name),
          });
          notify("Folder created", "success");
        } else {
          const created = await writeRemoteFile(target, {
            path: joinRemotePath(current.path, name),
            content: "",
            createOnly: true,
          });
          notify("File created", "success");
          const entry: RemoteFsEntry = Object.freeze({
            name: created.name,
            path: created.path,
            displayPath: created.displayPath,
            kind: "file",
            targetKind: null,
            size: created.size,
            mtimeMs: created.mtimeMs,
            hidden: false,
            isGitRepo: false,
          });
          openFile(entry, true);
        }
        setCreateKind(undefined);
        setCreateName("");
        void load(current.path, true);
      } catch (reason) {
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (isRemoteFsAlreadyExists(reason))
          setCreateError(
            cleanRemoteFsErrorMessage(
              reason instanceof Error ? reason.message : String(reason),
            ),
          );
        else setCreateError(message(reason));
      } finally {
        setCreating(false);
      }
    };

    const confirmRename = async (entry: RemoteFsEntry) => {
      const target = machineRef.current;
      const current = listing;
      const name = renameDraft.trim();
      if (!target || !current || !name || name === entry.name) {
        setRenaming(undefined);
        setRenameError("");
        return;
      }
      setRenameBusy(true);
      setRenameError("");
      try {
        const renamed = await renameRemoteEntry(target, {
          from: entry.path,
          to: joinRemotePath(current.path, name),
        });
        setRenaming(undefined);
        setRenameDraft("");
        setPreviewEntry((open) =>
          open?.path === entry.path
            ? {
                ...open,
                name: renamed.name,
                path: renamed.path,
                displayPath: renamed.displayPath,
              }
            : open,
        );
        setPreviewResult((open) =>
          open?.path === entry.path
            ? {
                ...open,
                name: renamed.name,
                path: renamed.path,
                displayPath: renamed.displayPath,
              }
            : open,
        );
        void load(current.path, true);
      } catch (reason) {
        if (reason instanceof Error && reason.name === "AbortError") return;
        if (isRemoteFsAlreadyExists(reason))
          setRenameError(
            cleanRemoteFsErrorMessage(
              reason instanceof Error ? reason.message : String(reason),
            ),
          );
        else setRenameError(message(reason));
      } finally {
        setRenameBusy(false);
      }
    };

    const confirmDelete = async (entry: RemoteFsEntry) => {
      const target = machineRef.current;
      if (!target) return;
      setDeleteBusy(true);
      setDeleteError("");
      try {
        await deleteRemoteEntry(target, {
          path: entry.path,
          recursive: entry.kind === "dir",
        });
        setDeleting(undefined);
        setPreviewEntry((open) =>
          open?.path === entry.path ? undefined : open,
        );
        if (previewEntry?.path === entry.path) clearPreview();
        void load(listingRef.current?.path, true);
      } catch (reason) {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setDeleteError(message(reason));
      } finally {
        setDeleteBusy(false);
      }
    };

    const addFolderToWorkspace = async (path: string) => {
      const currentSession = sessionRef.current;
      const head = canvasHeadRef.current;
      if (!currentSession || !channelId) return;
      const existing = rootsRef.current ?? [];
      if (existing.includes(path)) return;
      if (existing.length >= MAX_WORKSPACE_FOLDERS) {
        setAddFolderError(
          `This chat already has the maximum of ${MAX_WORKSPACE_FOLDERS} workspace folders.`,
        );
        return;
      }
      setAddingFolder(true);
      setAddFolderError("");
      try {
        const workspace = readWorkspace(head?.content ?? "");
        const content = workspaceCanvas({
          ...workspace,
          folders: [...workspace.folders, path],
        });
        const event = await currentSession.canvas.save(
          channelId,
          content,
          head?.id,
        );
        setCanvasHead({
          id: event.id,
          content: event.content,
        });
        setRoots(folderFor(event.content));
        notify(`Added ${path} to chat workspace`, "success");
      } catch (reason) {
        setAddFolderError(message(reason));
      } finally {
        setAddingFolder(false);
      }
    };

    const folder = filter.trim().toLowerCase();
    const entries = sortEntries(
      (listing?.entries ?? []).filter(
        (entry) =>
          !folder ||
          entry.name.toLowerCase().includes(folder) ||
          entry.displayPath.toLowerCase().includes(folder),
      ),
    );

    if (
      !channelContext ||
      !session ||
      (state.status === "ready" && scope !== channelContext.scope)
    ) {
      return (
        <p role="status" className={styles.status}>
          Files are unavailable while the connection recovers.
        </p>
      );
    }

    if (!browsable.length) {
      return (
        <div className={styles.panel}>
          <EmptyState
            icon={<MonitorIcon size={20} aria-hidden="true" />}
            title="No remote machines"
            description="Connect a machine that runs buzz-host to browse its files here."
          />
        </div>
      );
    }

    const currentInWorkspace = listing
      ? (roots ?? []).includes(listing.displayPath)
      : false;
    const crumbs = listing ? remotePathCrumbs(listing.displayPath) : [];

    return (
      <div className={styles.panel}>
        <div className={styles.roots}>
          {browsable.length > 1 && (
            <Select
              label="Machine"
              variant="compact"
              value={machine?.id ?? ""}
              groups={[
                {
                  label: "Machines",
                  options: browsable.map((candidate) => ({
                    value: candidate.id,
                    label: candidate.name,
                  })),
                },
              ]}
              onValueChange={setMachineId}
            />
          )}
          <Select
            label="Folder"
            variant="compact"
            value={root}
            groups={[
              {
                label: "Folders",
                options: [
                  { value: "~", label: "Home (~)" },
                  ...(roots ?? [])
                    .filter((path) => path !== "~")
                    .map((path) => ({ value: path, label: path })),
                ],
              },
            ]}
            onValueChange={(value) => {
              setRoot(value);
              navigate(value);
            }}
          />
        </div>
        <div
          className={styles.body}
          data-preview={previewEntry ? "true" : "false"}
        >
          <div className={styles.directory}>
            <div className={styles.toolbar}>
              <IconButton
                variant="ghost"
                size="sm"
                aria-label="Go up"
                title="Go up"
                icon={<ArrowUpIcon size={16} aria-hidden="true" />}
                disabled={!listing?.parent || loading}
                onClick={() => {
                  if (listing?.parent) navigate(listing.parent);
                }}
              />
              <nav
                ref={setCrumbsNode}
                className={styles.crumbs}
                aria-label="Folder path"
                onScroll={() => {
                  if (!crumbsNode) return;
                  crumbsPinned.current =
                    crumbsNode.scrollLeft + crumbsNode.clientWidth >=
                    crumbsNode.scrollWidth - 1;
                  syncCrumbs(false);
                }}
              >
                {listing ? (
                  crumbs.map((crumb, index) => (
                    <span key={crumb.path} className={styles.crumb}>
                      {index > 0 && (
                        <CaretRightIcon
                          size={12}
                          aria-hidden="true"
                          className={styles.separator}
                        />
                      )}
                      <Button
                        variant="link"
                        size="inline"
                        title={crumb.path}
                        aria-current={
                          index === crumbs.length - 1 ? "location" : undefined
                        }
                        onClick={() => navigate(crumb.path)}
                      >
                        {crumb.label}
                      </Button>
                    </span>
                  ))
                ) : (
                  <span className={styles.path}>{machine?.name}</span>
                )}
              </nav>
              <div className={styles.toolbarActions}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={
                    currentInWorkspace
                      ? "Already in chat workspace"
                      : "Add this folder to chat workspace"
                  }
                  title={
                    currentInWorkspace
                      ? "Already in chat workspace"
                      : "Add this folder to chat workspace"
                  }
                  icon={<FolderPlusIcon size={16} aria-hidden="true" />}
                  disabled={
                    !listing || loading || currentInWorkspace || !canvasWritable
                  }
                  onClick={() => {
                    if (listing) void addFolderToWorkspace(listing.displayPath);
                  }}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label="Copy path"
                  title="Copy path"
                  icon={<CopyIcon size={16} aria-hidden="true" />}
                  disabled={!listing}
                  onClick={() => {
                    if (!listing) return;
                    void writeClipboardText(listing.displayPath).then(
                      () => notify("Path copied", "success"),
                      () => notify("Couldn't copy path", "error"),
                    );
                  }}
                />
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label="Refresh"
                  title="Refresh"
                  icon={<ArrowsClockwiseIcon size={16} aria-hidden="true" />}
                  disabled={loading}
                  onClick={() => void load(listing?.path, true)}
                />
              </div>
            </div>
            <div className={styles.options}>
              <div className={styles.filter}>
                <Input
                  aria-label="Filter files"
                  controlSize="sm"
                  value={filter}
                  placeholder="Filter files"
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
              <Switch
                label="Show hidden"
                checked={showHidden}
                onCheckedChange={setShowHidden}
              />
              <div className={styles.createActions}>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={createKind === "folder"}
                  disabled={!listing || loading || creating}
                  onClick={() => {
                    setCreateKind((kind) =>
                      kind === "folder" ? undefined : "folder",
                    );
                    setCreateName("");
                    setCreateError("");
                  }}
                >
                  <FolderPlusIcon size={16} aria-hidden="true" />
                  New folder
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={createKind === "file"}
                  disabled={!listing || loading || creating}
                  onClick={() => {
                    setCreateKind((kind) =>
                      kind === "file" ? undefined : "file",
                    );
                    setCreateName("");
                    setCreateError("");
                  }}
                >
                  <FileTextIcon size={16} aria-hidden="true" />
                  New file
                </Button>
              </div>
            </div>
            {addFolderError && (
              <p role="alert" className={styles.status}>
                {addFolderError}
              </p>
            )}
            {createKind && (
              <div className={styles.createBar}>
                <Input
                  aria-label={
                    createKind === "folder"
                      ? "New folder name"
                      : "New file name"
                  }
                  controlSize="sm"
                  autoFocus
                  value={createName}
                  placeholder={
                    createKind === "folder" ? "Folder name" : "File name"
                  }
                  disabled={creating}
                  onChange={(event) => setCreateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCreateKind(undefined);
                      setCreateName("");
                      setCreateError("");
                    }
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void createEntry();
                  }}
                />
                <Button
                  variant="prominent"
                  size="sm"
                  loading={creating}
                  disabled={!createName.trim()}
                  onClick={() => void createEntry()}
                >
                  Create
                </Button>
                <Button
                  variant="subtle"
                  size="sm"
                  disabled={creating}
                  onClick={() => {
                    setCreateKind(undefined);
                    setCreateName("");
                    setCreateError("");
                  }}
                >
                  Cancel
                </Button>
                {createError && (
                  <span role="alert" className={styles.createError}>
                    {createError}
                  </span>
                )}
              </div>
            )}
            {loading && (
              <p role="status" className={styles.status}>
                Loading files…
              </p>
            )}
            {error && !unsupported && (
              <div role="alert" className={styles.error}>
                <span>{error}</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void load(listing?.path ?? root, true)}
                >
                  Try again
                </Button>
              </div>
            )}
            {unsupported && (
              <EmptyState
                icon={<FolderOpenIcon size={20} aria-hidden="true" />}
                title="Files are unavailable"
                description={REMOTE_FS_UNSUPPORTED_MESSAGE}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void load(listing?.path ?? root, true)}
                  >
                    Try again
                  </Button>
                }
                frame="none"
              />
            )}
            <div className={styles.list}>
              {listing && entries.length === 0 && !unsupported && (
                <EmptyState
                  icon={<FolderSimpleIcon size={20} aria-hidden="true" />}
                  title={folder ? "No matching files" : "This folder is empty"}
                  description={folder ? "Try a different filter." : undefined}
                  action={
                    folder ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setFilter("")}
                      >
                        Clear filter
                      </Button>
                    ) : undefined
                  }
                  frame="none"
                />
              )}
              {!unsupported &&
                entries.map((entry) => {
                  const directory = isDirectory(entry);
                  const inWorkspace = (roots ?? []).includes(entry.displayPath);
                  if (renaming === entry.path) {
                    return (
                      <div key={entry.path} className={styles.renameBar}>
                        <Input
                          aria-label={`Rename ${entry.name}`}
                          controlSize="sm"
                          autoFocus
                          value={renameDraft}
                          disabled={renameBusy}
                          onChange={(event) =>
                            setRenameDraft(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setRenaming(undefined);
                              setRenameDraft("");
                              setRenameError("");
                            }
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            void confirmRename(entry);
                          }}
                        />
                        <Button
                          variant="prominent"
                          size="sm"
                          loading={renameBusy}
                          disabled={!renameDraft.trim()}
                          onClick={() => void confirmRename(entry)}
                        >
                          Save
                        </Button>
                        <Button
                          variant="subtle"
                          size="sm"
                          disabled={renameBusy}
                          onClick={() => {
                            setRenaming(undefined);
                            setRenameDraft("");
                            setRenameError("");
                          }}
                        >
                          Cancel
                        </Button>
                        {renameError && (
                          <span role="alert" className={styles.entryError}>
                            {renameError}
                          </span>
                        )}
                      </div>
                    );
                  }
                  if (deleting === entry.path) {
                    return (
                      <div key={entry.path} className={styles.deleteBar}>
                        <span className={styles.rowName}>
                          Delete {entry.name}?
                        </span>
                        <Button
                          variant="destructive"
                          size="sm"
                          loading={deleteBusy}
                          onClick={() => void confirmDelete(entry)}
                        >
                          Delete
                        </Button>
                        <Button
                          variant="subtle"
                          size="sm"
                          disabled={deleteBusy}
                          onClick={() => {
                            setDeleting(undefined);
                            setDeleteError("");
                          }}
                        >
                          Cancel
                        </Button>
                        {deleteError && (
                          <span role="alert" className={styles.entryError}>
                            {deleteError}
                          </span>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div key={entry.path} className={styles.rowShell}>
                      <Button
                        variant="quiet"
                        size="row"
                        aria-current={
                          previewEntry?.path === entry.path ? "true" : undefined
                        }
                        onClick={() => {
                          if (directory) navigate(entry.displayPath);
                          else openFile(entry);
                        }}
                        title={entry.displayPath}
                      >
                        <span className={styles.row}>
                          {directory ? (
                            <FolderSimpleIcon size={16} aria-hidden="true" />
                          ) : entry.name.match(/\.(mdx?|txt)$/i) ? (
                            <FileTextIcon size={16} aria-hidden="true" />
                          ) : (
                            <FileCodeIcon size={16} aria-hidden="true" />
                          )}
                          <span className={styles.rowName}>{entry.name}</span>
                          {entry.isGitRepo && (
                            <Badge>
                              <GitBranchIcon size={12} aria-hidden="true" /> Git
                            </Badge>
                          )}
                          {directory && inWorkspace && (
                            <Badge>
                              <FolderPlusIcon size={12} aria-hidden="true" />
                              In workspace
                            </Badge>
                          )}
                          {!directory && (
                            <span className={styles.meta}>
                              {formatSize(entry.size)}
                            </span>
                          )}
                        </span>
                      </Button>
                      <MenuRoot>
                        <MenuTrigger
                          render={
                            <IconButton
                              variant="ghost"
                              size="sm"
                              aria-label={`Actions for ${entry.name}`}
                              title={`Actions for ${entry.name}`}
                              icon={
                                <DotsThreeVerticalIcon
                                  size={16}
                                  aria-hidden="true"
                                />
                              }
                            />
                          }
                        />
                        <MenuPopup>
                          <MenuItem
                            onClick={() => {
                              setRenaming(entry.path);
                              setRenameDraft(entry.name);
                              setRenameError("");
                            }}
                          >
                            Rename
                          </MenuItem>
                          <MenuItem
                            onClick={() => {
                              setDeleting(entry.path);
                              setDeleteError("");
                            }}
                          >
                            Delete
                          </MenuItem>
                          {directory && (
                            <MenuItem
                              disabled={
                                inWorkspace || !canvasWritable || addingFolder
                              }
                              onClick={() =>
                                void addFolderToWorkspace(entry.displayPath)
                              }
                            >
                              Add to chat workspace
                            </MenuItem>
                          )}
                        </MenuPopup>
                      </MenuRoot>
                    </div>
                  );
                })}
              {listing?.truncated && (
                <p className={styles.status}>
                  Some entries were omitted. Use the filter to narrow this
                  folder.
                </p>
              )}
            </div>
          </div>
          {previewEntry ? (
            <FilePreview
              key={previewEntry.path}
              entry={previewEntry}
              result={previewResult}
              loading={previewLoading}
              error={previewError}
              unsupported={previewUnsupported}
              editing={editing}
              draft={draft}
              dirty={dirty}
              saving={saving}
              saveError={saveError}
              conflict={conflict}
              discardGuard={
                discardGuard && previewEntry
                  ? { kind: discardGuard.kind, name: previewEntry.name }
                  : undefined
              }
              onToggleEdit={() => setEditing((value) => !value)}
              onDraftChange={setDraft}
              onSave={(overwrite) => void saveFile(overwrite)}
              onReloadFromDisk={reloadFromDisk}
              onDiscard={() => {
                setEditing(false);
                setDraft(previewResult?.content ?? "");
                setConflict(false);
                setSaveError("");
              }}
              onKeepEditing={() => setDiscardGuard(undefined)}
              onDiscardGuard={discardChanges}
              onRetry={retryPreview}
              onClose={closePreview}
            />
          ) : (
            <div className={styles.preview}>
              <EmptyState
                icon={<ImageIcon size={20} aria-hidden="true" />}
                title="No file selected"
                description="Choose a file to preview it here."
                frame="none"
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  ctx.panels.register({
    id: "files",
    title: "Files",
    matches: () => false,
    channelPlacement: "tab",
    channelLauncher: Launcher,
    component: Panel,
  });
}
