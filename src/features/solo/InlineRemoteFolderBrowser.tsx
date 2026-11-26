import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RemoteMachine } from "../agents/remote-machines";
import {
  isRemoteFsUnsupported,
  joinRemotePath,
  listRemoteDirectory,
  mkdirRemoteDirectory,
  REMOTE_FS_UNSUPPORTED_MESSAGE,
  remotePathCrumbs,
  type RemoteFsEntry,
  type RemoteFsListResult,
} from "../agents/remote-fs";
import {
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  CaretRightIcon,
  CheckIcon,
  EyeSlashIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { Badge } from "../../shared/design-system/ui/Badge";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import styles from "./InlineRemoteFolderBrowser.module.css";

type Listing = Readonly<{
  path: string;
  displayPath: string;
  parent: string | null;
  parentDisplay: string | null;
  entries: readonly RemoteFsEntry[];
  truncated: boolean;
}>;

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Inline remote folder browser, embedded directly in a form (no Dialog).
 * Picks one folder: `onSelect` receives its `displayPath` (`~/…`).
 */
export function InlineRemoteFolderBrowser({
  machines,
  initialMachineId,
  initialPath,
  label = "Choose a remote folder",
  onSelect,
  onClose,
}: {
  /** Browsable machines, already filtered by `browsableRemoteMachines`. */
  machines: readonly RemoteMachine[];
  initialMachineId?: string | undefined;
  initialPath?: string | undefined;
  label?: string;
  onSelect(displayPath: string): void;
  onClose(): void;
}) {
  const [machineId, setMachineId] = useState(
    () =>
      (initialMachineId &&
        machines.some(({ id }) => id === initialMachineId) &&
        initialMachineId) ||
      (machines[0]?.id ?? ""),
  );
  const [listing, setListing] = useState<Listing | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [newFolder, setNewFolder] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const request = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const startPath = useRef<string | undefined>(initialPath);
  const browserRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const crumbsRef = useRef<HTMLElement>(null);
  const crumbsPinned = useRef(true);
  const machine =
    machineId && machines.some(({ id }) => id === machineId)
      ? machines.find(({ id }) => id === machineId)
      : undefined;

  useEffect(
    () => () => {
      request.current += 1;
      abort.current?.abort();
    },
    [],
  );

  // Reserve clearance above a flow Dialog's sticky footer scrim so opening,
  // growing, or tabbing into this inline browser never leaves "Use this folder"
  // underneath Cancel / Save changes.
  useLayoutEffect(() => {
    const browser = browserRef.current;
    const dialog = browser?.closest<HTMLElement>(".buzz-dialog");
    const dialogActions = dialog?.querySelector<HTMLElement>(
      ":scope > .buzz-dialog-actions",
    );
    if (!browser || !dialog || !dialogActions) return;
    const previous = dialog.style.getPropertyValue("scroll-padding-block-end");
    const priority = dialog.style.getPropertyPriority(
      "scroll-padding-block-end",
    );
    const measure = () => {
      const height = Math.ceil(dialogActions.offsetHeight);
      if (height <= 0) return;
      dialog.style.setProperty("scroll-padding-block-end", `${height}px`);
    };
    measure();
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(measure)
        : undefined;
    observer?.observe(dialogActions);
    return () => {
      observer?.disconnect();
      if (previous) {
        dialog.style.setProperty(
          "scroll-padding-block-end",
          previous,
          priority,
        );
      } else {
        dialog.style.removeProperty("scroll-padding-block-end");
      }
    };
  }, []);

  const revealKey = `${listing?.path ?? ""}|${error}|${unsupported}|${newFolder}`;
  const lastRevealKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (lastRevealKey.current === revealKey) return;
    lastRevealKey.current = revealKey;
    const footer = footerRef.current;
    if (footer && typeof footer.scrollIntoView === "function") {
      footer.scrollIntoView({ block: "nearest" });
    }
  }, [revealKey]);

  const syncCrumbs = useCallback((pinEnd: boolean) => {
    const nav = crumbsRef.current;
    if (!nav) return;
    if (pinEnd) {
      nav.scrollLeft = Math.max(0, nav.scrollWidth - nav.clientWidth);
    }
    const start = nav.scrollLeft > 1;
    const end = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1;
    nav.toggleAttribute("data-overflow-start", start);
    nav.toggleAttribute("data-overflow-end", end);
  }, []);

  const displayPath = listing?.displayPath;
  useLayoutEffect(() => {
    if (!displayPath) return;
    crumbsPinned.current = true;
    syncCrumbs(true);
  }, [displayPath, syncCrumbs]);

  useLayoutEffect(() => {
    const nav = crumbsRef.current;
    if (!nav || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      syncCrumbs(crumbsPinned.current);
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, [syncCrumbs]);

  const load = useCallback(
    async (path?: string) => {
      if (!machine) return;
      const generation = ++request.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      setError("");
      setUnsupported(false);
      setCreateError("");
      try {
        const result: RemoteFsListResult = await listRemoteDirectory(
          machine,
          { ...(path ? { path } : {}), dirsOnly: true, showHidden },
          { signal: controller.signal },
        );
        if (generation !== request.current) return;
        setListing({
          path: result.path,
          displayPath: result.displayPath,
          parent: result.parent,
          parentDisplay: result.parentDisplay,
          entries: result.entries,
          truncated: result.truncated,
        });
        setChosen(null);
      } catch (reason) {
        if (generation !== request.current) return;
        if (reason instanceof Error && reason.name === "AbortError") return;
        setUnsupported(isRemoteFsUnsupported(reason));
        setError(message(reason));
      } finally {
        if (generation === request.current) setLoading(false);
      }
    },
    [machine, showHidden],
  );

  useEffect(() => {
    if (!machine) return;
    const requested = startPath.current;
    startPath.current = undefined;
    void load(requested);
    // Loads on mount and when the machine or the hidden setting changes.
  }, [machine, load]);

  const navigate = (path: string) => {
    if (!path.trim()) return;
    setFilter("");
    void load(path.trim());
  };

  const chooseMachine = (id: string) => {
    if (id === machineId) return;
    setMachineId(id);
  };

  const createFolder = async () => {
    const target = machine;
    const current = listing;
    const name = newName.trim();
    if (!target || !current || !name) return;
    setCreating(true);
    setCreateError("");
    try {
      const created = await mkdirRemoteDirectory(target, {
        path: joinRemotePath(current.displayPath, name),
      });
      setNewFolder(false);
      setNewName("");
      navigate(created.displayPath);
    } catch (reason) {
      if (reason instanceof Error && reason.name === "AbortError") return;
      setCreateError(message(reason));
    } finally {
      setCreating(false);
    }
  };

  const folder = filter.trim().toLowerCase();
  const visible = listing
    ? listing.entries.filter(
        (entry) => !folder || entry.name.toLowerCase().includes(folder),
      )
    : [];

  const machineSelect =
    machines.length > 1 ? (
      <Select
        label="Machine"
        variant="compact"
        value={machine?.id ?? ""}
        groups={[
          {
            label: "Machines",
            options: machines.map((candidate) => ({
              value: candidate.id,
              label: candidate.name,
            })),
          },
        ]}
        onValueChange={chooseMachine}
      />
    ) : machine ? (
      <p className={styles.machine}>
        <FolderOpenIcon size={16} aria-hidden="true" />
        {machine.name}
      </p>
    ) : null;

  const crumbs = listing ? remotePathCrumbs(listing.displayPath) : [];

  return (
    <section ref={browserRef} className={styles.browser} aria-label={label}>
      <div className={styles.header}>
        {machineSelect}
        <div className={styles.actions}>
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
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Refresh"
            title="Refresh"
            icon={<ArrowsClockwiseIcon size={16} aria-hidden="true" />}
            disabled={loading}
            onClick={() => void load(listing?.path)}
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="New folder"
            title="New folder"
            aria-expanded={newFolder}
            icon={<FolderPlusIcon size={16} aria-hidden="true" />}
            onClick={() => {
              setNewFolder((value) => !value);
              setNewName("");
              setCreateError("");
            }}
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Show hidden folders"
            title="Show hidden folders"
            aria-pressed={showHidden}
            icon={<EyeSlashIcon size={16} aria-hidden="true" />}
            onClick={() => setShowHidden((value) => !value)}
          />
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Close"
            title="Close"
            icon={<XIcon size={16} aria-hidden="true" />}
            onClick={onClose}
          />
        </div>
      </div>
      <nav
        ref={crumbsRef}
        className={styles.crumbs}
        aria-label="Folder path"
        onScroll={() => {
          const nav = crumbsRef.current;
          if (!nav) return;
          crumbsPinned.current =
            nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 1;
          syncCrumbs(false);
        }}
      >
        {crumbs.map((crumb, index) => (
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
        ))}
      </nav>
      {newFolder && (
        <div className={styles.newFolder}>
          <Input
            aria-label="New folder name"
            controlSize="sm"
            autoFocus
            value={newName}
            placeholder="Folder name"
            disabled={creating}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setNewFolder(false);
                setNewName("");
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              void createFolder();
            }}
          />
          <Button
            variant="prominent"
            size="sm"
            loading={creating}
            disabled={!newName.trim()}
            onClick={() => void createFolder()}
          >
            Create
          </Button>
          <Button
            variant="subtle"
            size="sm"
            disabled={creating}
            onClick={() => {
              setNewFolder(false);
              setNewName("");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {createError && (
        <div role="alert" className={styles.error}>
          {createError}
        </div>
      )}
      <div className={styles.filterRow}>
        <Input
          aria-label="Filter folders"
          controlSize="sm"
          value={filter}
          placeholder="Filter folders"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {loading && (
        <p role="status" className={styles.status}>
          Loading folders…
        </p>
      )}
      {error && !unsupported && (
        <div role="alert" className={styles.error}>
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(listing?.path)}
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
              onClick={() => void load(listing?.path)}
            >
              Try again
            </Button>
          }
        />
      )}
      <div className={styles.list}>
        {!unsupported && listing && visible.length === 0 && (
          <EmptyState
            icon={<FolderSimpleIcon size={20} aria-hidden="true" />}
            title={folder ? "No matching folders" : "No folders here"}
            description={
              folder
                ? "Try a different filter."
                : "Choose this folder, or go up to find another one."
            }
            frame="none"
          />
        )}
        {!unsupported &&
          visible.map((entry) => (
            <div key={entry.path} className={styles.rowShell}>
              <Button
                variant="quiet"
                size="row"
                aria-pressed={chosen === entry.path}
                onClick={() => setChosen(entry.path)}
                onDoubleClick={() => navigate(entry.displayPath)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  navigate(entry.displayPath);
                }}
              >
                <span className={styles.row}>
                  <FolderSimpleIcon size={16} aria-hidden="true" />
                  <span className={styles.rowName}>{entry.name}</span>
                  {entry.isGitRepo && (
                    <Badge>
                      <GitBranchIcon size={12} aria-hidden="true" /> Git
                    </Badge>
                  )}
                  {chosen === entry.path && (
                    <CheckIcon size={14} aria-hidden="true" />
                  )}
                </span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSelect(entry.displayPath)}
              >
                Select
              </Button>
            </div>
          ))}
        {!unsupported && listing?.truncated && (
          <p className={styles.status}>
            Some entries were omitted. Use the filter to narrow this folder.
          </p>
        )}
      </div>
      <div ref={footerRef} className={styles.footer}>
        <Button
          variant="prominent"
          size="sm"
          disabled={!listing || loading || unsupported}
          onClick={() => {
            if (!listing) return;
            onSelect(chosen ?? listing.displayPath);
          }}
        >
          Use this folder
        </Button>
        {listing && (
          <span className={styles.current} title={listing.displayPath}>
            {listing.displayPath}
          </span>
        )}
      </div>
    </section>
  );
}
