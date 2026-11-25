import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import type { RemoteMachine } from "../agents/remote-machines";
import {
  isRemoteFsUnsupported,
  listRemoteDirectory,
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
  FolderOpenIcon,
  FolderSimpleIcon,
  GitBranchIcon,
} from "../../shared/design-system/icons";
import { Badge } from "../../shared/design-system/ui/Badge";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Switch } from "../../shared/design-system/ui/Switch";
import styles from "./RemoteFolderPickerDialog.module.css";

type Listing = Readonly<{
  path: string;
  displayPath: string;
  home: string;
  parent: string | null;
  parentDisplay: string | null;
  entries: readonly RemoteFsEntry[];
  truncated: boolean;
}>;

function crumbs(displayPath: string) {
  return remotePathCrumbs(displayPath);
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Browse one remote machine's folders and return one display path. */
export function RemoteFolderPickerDialog({
  open,
  onOpenChange,
  machines,
  initialMachineId,
  initialPath,
  title = "Choose a remote folder",
  description,
  finalFocus,
  onSelect,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Browsable machines, already filtered by `browsableRemoteMachines`. */
  machines: readonly RemoteMachine[];
  initialMachineId?: string | undefined;
  initialPath?: string | undefined;
  title?: string;
  description?: string | undefined;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
  onSelect(displayPath: string): void;
}) {
  const [machineId, setMachineId] = useState("");
  const [listing, setListing] = useState<Listing | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const request = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const listingRef = useRef<Listing | undefined>(undefined);
  const startPath = useRef<string | undefined>(undefined);
  const wasOpen = useRef(false);
  const machine = machineId
    ? machines.find((candidate) => candidate.id === machineId)
    : undefined;

  useEffect(
    () => () => {
      request.current += 1;
      abort.current?.abort();
    },
    [],
  );

  // Reset the surface on each open, not on every later parent render.
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (!open) {
      request.current += 1;
      abort.current?.abort();
      return;
    }
    const initial =
      initialMachineId && machines.some(({ id }) => id === initialMachineId)
        ? initialMachineId
        : (machines[0]?.id ?? "");
    startPath.current = initialPath;
    listingRef.current = undefined;
    setListing(undefined);
    setError("");
    setUnsupported(false);
    setShowHidden(false);
    setFilter("");
    setPathDraft("");
    setSelected(null);
    setMachineId(initial);
  }, [open, initialMachineId, initialPath, machines]);

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
      try {
        const result: RemoteFsListResult = await listRemoteDirectory(
          machine,
          { ...(path ? { path } : {}), dirsOnly: true, showHidden },
          { signal: controller.signal },
        );
        if (generation !== request.current) return;
        const next: Listing = {
          path: result.path,
          displayPath: result.displayPath,
          home: result.home,
          parent: result.parent,
          parentDisplay: result.parentDisplay,
          entries: result.entries,
          truncated: result.truncated,
        };
        listingRef.current = next;
        setListing(next);
        setPathDraft(result.displayPath);
        setSelected(null);
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

  // Load the requested start path when the surface opens, the machine changes,
  // or the hidden-folder setting changes.
  useEffect(() => {
    if (!open || !machine) return;
    const requested = startPath.current;
    startPath.current = undefined;
    void load(requested ?? listingRef.current?.path);
  }, [open, machine, load]);

  const navigate = (path: string) => {
    if (!path.trim()) return;
    setFilter("");
    void load(path.trim());
  };

  const chooseMachine = (id: string) => {
    if (id === machineId) return;
    listingRef.current = undefined;
    startPath.current = undefined;
    setMachineId(id);
  };

  const folder = filter.trim().toLowerCase();
  const visible = listing
    ? listing.entries.filter(
        (entry) => !folder || entry.name.toLowerCase().includes(folder),
      )
    : [];
  const chosen = selected
    ? listing?.entries.find((entry) => entry.path === selected)
    : undefined;

  const machineSelect =
    machines.length > 1 ? (
      <Select
        label="Machine"
        variant="field"
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

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="default"
      height="stable"
      bodyLayout="flex"
      finalFocus={finalFocus}
      actions={
        <>
          <Button variant="subtle" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            disabled={!listing || loading}
            onClick={() => {
              if (!listing) return;
              onSelect(chosen?.displayPath ?? listing.displayPath);
              onOpenChange(false);
            }}
          >
            Select folder
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {machineSelect}
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
            {listing
              ? crumbs(listing.displayPath).map((crumb, index) => (
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
              : null}
          </nav>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Refresh"
            title="Refresh"
            icon={<ArrowsClockwiseIcon size={16} aria-hidden="true" />}
            disabled={loading}
            onClick={() => void load(listing?.path)}
          />
        </div>
        <Input
          aria-label="Path"
          controlSize="sm"
          value={pathDraft}
          placeholder="~/Development/my-project"
          disabled={loading}
          onChange={(event) => setPathDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            navigate(pathDraft);
          }}
        />
        <div className={styles.options}>
          <Input
            aria-label="Filter folders"
            controlSize="sm"
            value={filter}
            placeholder="Filter folders"
            onChange={(event) => setFilter(event.target.value)}
          />
          <Switch
            label="Show hidden"
            checked={showHidden}
            onCheckedChange={setShowHidden}
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
            />
          )}
          {!unsupported &&
            visible.map((entry) => (
              <Button
                key={entry.path}
                variant="quiet"
                size="row"
                aria-pressed={selected === entry.path}
                onClick={() => setSelected(entry.path)}
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
                  {selected === entry.path && (
                    <CheckIcon size={14} aria-hidden="true" />
                  )}
                </span>
              </Button>
            ))}
          {!unsupported && listing?.truncated && (
            <p className={styles.status}>
              Some entries were omitted. Use the filter to narrow this folder.
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
