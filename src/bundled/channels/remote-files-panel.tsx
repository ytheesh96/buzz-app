import {
  useCallback,
  useEffect,
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
import {
  activeMachineIdSnapshot,
  useRemoteAgentHosts,
  useRemoteMachines,
  useRemoteMachineStatuses,
  type RemoteMachine,
} from "../../features/agents/remote-machines";
import {
  browsableRemoteMachines,
  isRemoteFsUnsupported,
  listRemoteDirectory,
  readRemoteFile,
  REMOTE_FS_UNSUPPORTED_MESSAGE,
  remotePathCrumbs,
  type RemoteFsEntry,
  type RemoteFsListResult,
  type RemoteFsReadResult,
} from "../../features/agents/remote-fs";
import {
  readWorkspace,
  workspaceDirectories,
} from "../../features/solo/workspace";
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
  FileCodeIcon,
  FileTextIcon,
  FolderOpenIcon,
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
import { Select } from "../../shared/design-system/ui/Select";
import { Switch } from "../../shared/design-system/ui/Switch";
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

const FILES_TARGET = "buzz.files";
const MAX_PREVIEW_LINES = 4_000;

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function isDirectory(entry: RemoteFsEntry) {
  return entry.kind === "dir" || entry.targetKind === "dir";
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
  onRetry,
  onClose,
}: {
  entry: RemoteFsEntry;
  result: RemoteFsReadResult | undefined;
  loading: boolean;
  error: string;
  unsupported: boolean;
  onRetry(): void;
  onClose(): void;
}) {
  const [raw, setRaw] = useState(false);
  const notify = useToastNotification();
  const name = entry.name;
  const markdown = /\.mdx?$/i.test(name);
  const copy = (value: string, label: string) => {
    void writeClipboardText(value).then(
      () => notify(`${label} copied`, "success"),
      () => notify(`Couldn't copy ${label.toLowerCase()}`, "error"),
    );
  };
  const content = result?.content ?? "";
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
          {markdown &&
            result &&
            !result.isBinary &&
            result.content !== null && (
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
            onClick={() => copy(content, "Contents")}
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
            This file is larger than the preview limit, so only the beginning is
            shown.
          </p>
        )}
        {result &&
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
    const request = useRef(0);
    const abort = useRef<AbortController | undefined>(undefined);
    const previewRequest = useRef(0);
    const previewAbort = useRef<AbortController | undefined>(undefined);
    const listingRef = useRef<Listing | undefined>(undefined);
    const machine = machineId
      ? browsable.find(({ id }) => id === machineId)
      : undefined;
    const notify = useToastNotification();
    const machineRef = useRef<RemoteMachine | undefined>(machine);
    machineRef.current = machine;
    const showHiddenRef = useRef(showHidden);
    showHiddenRef.current = showHidden;

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
          if (alive) setRoots(folderFor(head?.content ?? ""));
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
    useEffect(() => {
      if (!machine || !roots) return;
      const start = roots[0] ?? "~";
      setRoot(start);
      void load(start);
    }, [machine, roots, load]);

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

    const openFile = (entry: RemoteFsEntry) => {
      const target = machineRef.current;
      if (!target) return;
      const generation = ++previewRequest.current;
      previewAbort.current?.abort();
      const controller = new AbortController();
      previewAbort.current = controller;
      setPreviewEntry(entry);
      setPreviewResult(undefined);
      setPreviewError("");
      setPreviewUnsupported(false);
      setPreviewLoading(true);
      void readRemoteFile(
        target,
        { path: entry.path },
        { signal: controller.signal },
      ).then(
        (result) => {
          if (generation !== previewRequest.current) return;
          setPreviewResult(result);
          setPreviewLoading(false);
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

    const navigate = (path: string) => {
      if (!path.trim()) return;
      void load(path.trim());
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
              <nav className={styles.crumbs} aria-label="Folder path">
                {listing ? (
                  remotePathCrumbs(listing.displayPath).map((crumb, index) => (
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
            </div>
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
                  return (
                    <Button
                      key={entry.path}
                      variant="quiet"
                      size="row"
                      aria-current={
                        previewEntry?.path === entry.path ? "true" : undefined
                      }
                      onClick={() =>
                        directory
                          ? navigate(entry.displayPath)
                          : openFile(entry)
                      }
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
                        {!directory && (
                          <span className={styles.meta}>
                            {formatSize(entry.size)}
                          </span>
                        )}
                      </span>
                    </Button>
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
              onRetry={retryPreview}
              onClose={() => {
                previewRequest.current += 1;
                previewAbort.current?.abort();
                setPreviewEntry(undefined);
                setPreviewResult(undefined);
                setPreviewError("");
                setPreviewUnsupported(false);
                setPreviewLoading(false);
              }}
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
