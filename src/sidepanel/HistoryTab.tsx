/**
 * History tab: a top-level panel tab aggregating every kind of record the
 * extension persists — conversations (对话历史), workflow runs (工作流运行历史),
 * task runs (任务运行历史), and the raw action-history entries (数据操作记录).
 *
 * Each sub-section supports expandable detail, single delete (× button), and
 * batch delete (checkbox + "delete selected"), keeping the audit trail under
 * the user's control. A live activity board at the top shows currently running
 * workflow/task runs (the board previously duplicated on the Workflows and
 * Tasks tabs) so all run-related history — live and persisted — lives in one
 * place.
 *
 * Workflow and task runs both live in `tasks.runs` (`TaskRunLog[]`) and are
 * distinguished by `source`: interactions initiated from the UI or chat
 * (`manual`/`chat`) are workflow runs; schedule/Feishu-initiated ones
 * (`schedule`/`feishu`) are task runs. A single top-level load of the run log
 * is shared between the two sections so the worker is only queried once.
 *
 * @module sidepanel/HistoryTab
 */
import { useCallback, useEffect, useState } from "react";
import { sendCommand } from "../lib/messages";
import { workflowFromHistory } from "../lib/storage";
import { saveWorkflow } from "../lib/workflow/storage";
import {
  applyNodeKeepSelection,
  reviewStepsOf,
  type ReviewStep,
  type WorkflowReview,
} from "../lib/workflow/review-patch";
import type { Workflow } from "../lib/workflow/types";
import type { ConversationMeta, HistoryEntry } from "../lib/types";
import type { TaskRunLog } from "../lib/scheduler-types";
import { useT } from "./i18n";
import { confirmDialog } from "../ui/confirm";
import RunningBoard from "./RunningBoard";
import { WorkflowReviewDialog } from "./WorkflowReviewList";

type Section = "conversations" | "workflowRuns" | "taskRuns" | "operations";

type Banner = { kind: "ok" | "error"; text: string } | null;

interface SectionProps {
  t: ReturnType<typeof useT>;
  flash: (kind: "ok" | "error", text: string) => void;
}

/** Same-day → time only, otherwise date + time. */
function formatWhen(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return `${date.toLocaleDateString()} ${time}`;
}

/**
 * Ask the Chat tab to open a conversation and continue chatting in it.
 *
 * The side panel keeps every tab mounted so Chat can hold a live port; we
 * don't import it directly (that would drag its streaming state into the
 * history bundle), we dispatch a custom window event that ChatTab + App
 * listen for. App flips the active tab, ChatTab resumes the thread.
 */
function continueConversation(id: string): void {
  window.dispatchEvent(new CustomEvent("bc:open-conversation", { detail: { id } }));
}

// --- Operations: grouping ---------------------------------------------------

interface HistoryGroup {
  key: string;
  title: string;
  entries: HistoryEntry[];
}

/** Groups action-history entries by conversationId, newest-first. */
function groupHistory(history: HistoryEntry[], conversations: ConversationMeta[]): HistoryGroup[] {
  const titleOf = (id: string): string => {
    if (id.startsWith("task:")) return id.slice(5) || "Scheduled task";
    if (id.startsWith("feishu:")) return "Feishu";
    const meta = conversations.find((c) => c.id === id);
    return meta?.title || id;
  };
  const order: string[] = [];
  const map = new Map<string, HistoryEntry[]>();
  for (const entry of history) {
    const key = entry.conversationId || "unknown";
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(entry);
  }
  // history is already newest-first; groups follow their newest entry.
  return order.map((key) => ({ key, title: titleOf(key), entries: map.get(key)! }));
}

export default function HistoryTab() {
  const t = useT();
  const [section, setSection] = useState<Section>("conversations");
  const [banner, setBanner] = useState<Banner>(null);
  // One shared load of the full run log, split by `source` in the two run
  // sections so the service worker is only queried once.
  const [runs, setRuns] = useState<TaskRunLog[] | null>(null);
  // Deep-linked run (from another tab's failed-run banner): the matching run
  // card in the run sections auto-expands and briefly highlights itself.
  const [focusRunId, setFocusRunId] = useState<string | null>(null);

  const flash = useCallback((kind: "ok" | "error", text: string): void => {
    setBanner({ kind, text });
  }, []);

  const reloadRuns = useCallback(async (): Promise<void> => {
    try {
      const result = await sendCommand({ type: "tasks.runs" });
      if (result.type === "tasks.runs") setRuns(result.runs);
    } catch (error) {
      flash("error", (error as Error).message);
    }
  }, [flash]);

  useEffect(() => {
    void reloadRuns();
  }, [reloadRuns]);

  // Deep links from other tabs (Workflows tab failed-run banner) arrive as a
  // `bc:open-history` window event; App flips to this tab, and here we switch
  // sub-section and hand the run id to the matching RunsSection so it can
  // expand + flash the failing run's detail.
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ section?: Section; runId?: string }>).detail;
      if (detail?.section) setSection(detail.section);
      if (detail?.runId) setFocusRunId(detail.runId);
    };
    window.addEventListener("bc:open-history", handler);
    return () => window.removeEventListener("bc:open-history", handler);
  }, []);

  const sections: Array<{ id: Section; label: string }> = [
    { id: "conversations", label: t.histConversations },
    { id: "workflowRuns", label: t.histWorkflowRuns },
    { id: "taskRuns", label: t.histTaskRuns },
    { id: "operations", label: t.histOperations },
  ];

  return (
    <div className="pane history-tab">
      {banner && (
        <div className="banner" data-kind={banner.kind} onClick={() => setBanner(null)}>
          {banner.text}
        </div>
      )}

      <RunningBoard onSettled={() => void reloadRuns()} />

      <div className="tabs history-sections" role="tablist">
        {sections.map(({ id, label }) => (
          <button
            key={id}
            className="tab"
            data-active={section === id}
            onClick={() => setSection(id)}
            type="button"
            role="tab"
            aria-selected={section === id}
          >
            {label}
          </button>
        ))}
      </div>

      {section === "conversations" && <ConversationsSection t={t} flash={flash} />}
      {section === "workflowRuns" && (
        <RunsSection
          t={t}
          flash={flash}
          runs={runs}
          reload={reloadRuns}
          filter={(run) => run.source === "manual" || run.source === "chat"}
          focusRunId={focusRunId}
          onFocused={() => setFocusRunId(null)}
        />
      )}
      {section === "taskRuns" && (
        <RunsSection
          t={t}
          flash={flash}
          runs={runs}
          reload={reloadRuns}
          filter={(run) => run.source === "schedule" || run.source === "feishu"}
          focusRunId={focusRunId}
          onFocused={() => setFocusRunId(null)}
        />
      )}
      {section === "operations" && <OperationsSection t={t} flash={flash} />}
    </div>
  );
}

// --- Shared helpers ---------------------------------------------------------

/** Toggle a string id in a Set, returning a new Set (immutable). */
function toggleId(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Select-all / deselect-all toggle based on current all-selected state. */
function selectAllToggle<T extends { id: string }>(
  items: T[] | null,
  selected: Set<string>,
): Set<string> {
  const allSelected = items !== null && items.length > 0 && items.every((i) => selected.has(i.id));
  if (allSelected) return new Set();
  return new Set((items ?? []).map((i) => i.id));
}

type BadgeKind = "ok" | "err" | "cancel" | "skip";

function badgeKind(run: TaskRunLog): BadgeKind {
  if (run.skipped) return "skip";
  if (run.ok) return "ok";
  return run.outcome === "cancelled" ? "cancel" : "err";
}

function badgeLabel(t: ReturnType<typeof useT>, run: TaskRunLog): string {
  if (run.skipped) return t.histOutcomeSkipped;
  if (run.ok) return t.histOutcomeOk;
  return run.outcome === "cancelled" ? t.histOutcomeCancelled : t.histOutcomeFailed;
}

/** Human-readable trigger source, reused from the Tasks tab vocabulary. */
function sourceLabel(t: ReturnType<typeof useT>, source: TaskRunLog["source"] | undefined): string {
  switch (source) {
    case "chat":
      return t.taskSourceChat;
    case "schedule":
      return t.taskSourceSchedule;
    case "manual":
      return t.taskSourceManual;
    case "feishu":
      return t.taskSourceFeishu;
    default:
      return "";
  }
}

interface BatchBarProps {
  count: number;
  total: number;
  onSelectAll: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useT>;
  /** Optional extra control on the right (e.g. "clear all" for operations). */
  extra?: React.ReactNode;
}

/** Sticky batch-delete toolbar shared by every list section. */
function BatchBar({ count, total, onSelectAll, onDelete, t, extra }: BatchBarProps) {
  const allSelected = total > 0 && count === total;
  const noneSelected = total === 0;
  return (
    <div className="card record-batchbar">
      <label className="record-batchbar-check">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(el) => {
            // Indeterminate when some, but not all, visible items are selected.
            if (el) el.indeterminate = count > 0 && !allSelected;
          }}
          disabled={noneSelected}
          onChange={onSelectAll}
          aria-label={t.histSelectAll}
        />
        <span>{t.histSelectAll}</span>
      </label>
      <div className="record-batchbar-count">
        {count > 0 ? `${count} / ${total}` : total > 0 ? `共 ${total} 条` : ""}
      </div>
      <div className="record-batchbar-actions">
        {extra}
        <button className="danger" onClick={onDelete} type="button" disabled={count === 0}>
          {t.histBatchDelete}
        </button>
      </div>
    </div>
  );
}

// --- Conversations ----------------------------------------------------------

interface ConvState {
  /** True while the transcript is being fetched for the first time. */
  loading: boolean;
  /** Cached transcript; persists across collapse/re-expand. */
  messages: { role: "user" | "assistant" | "tool"; text: string }[];
  /** Whether the detail panel is currently visible. */
  open: boolean;
}

function ConversationsSection({ t, flash }: SectionProps) {
  const [items, setItems] = useState<ConversationMeta[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // One entry per conversation the user has ever expanded. `messages` is
  // cached so collapse + re-open is instant and we never query the worker
  // twice for the same transcript.
  const [state, setState] = useState<Record<string, ConvState>>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await sendCommand({ type: "conversations.list" });
      if (result.type === "conversations.list") setItems(result.conversations);
    } catch (error) {
      flash("error", (error as Error).message);
    }
  }, [flash]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (id: string): Promise<void> => {
      const current = state[id];
      if (current) {
        // Already loaded at least once — toggle open/closed, keep messages.
        setState((prev) => ({
          ...prev,
          [id]: { ...current, open: !current.open },
        }));
        return;
      }
      // First expansion: mark loading + open, fetch once.
      setState((prev) => ({
        ...prev,
        [id]: { loading: true, messages: [], open: true },
      }));
      try {
        const result = await sendCommand({ type: "conversations.get", id });
        const messages = result.type === "conversations.get" ? result.messages : [];
        setState((prev) => ({
          ...prev,
          [id]: { loading: false, messages, open: prev[id]?.open ?? true },
        }));
      } catch (error) {
        flash("error", (error as Error).message);
        setState((prev) => ({ ...prev, [id]: { loading: false, messages: [], open: false } }));
      }
    },
    [state, flash],
  );

  const removeOne = useCallback(
    async (id: string): Promise<void> => {
      try {
        await sendCommand({ type: "conversations.delete", id });
        setSelected((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        await load();
      } catch (error) {
        flash("error", (error as Error).message);
      }
    },
    [flash, load],
  );

  const removeSelected = useCallback(async (): Promise<void> => {
    if (selected.size === 0) return;
    if (
      !(await confirmDialog({
        title: t.dialogDeleteTitle,
        message: t.histDeleteConfirm({ count: selected.size }),
        confirmText: t.delete,
        cancelText: t.cancel,
        danger: true,
      }))
    )
      return;
    const count = selected.size;
    try {
      for (const id of selected) {
        await sendCommand({ type: "conversations.delete", id });
      }
      setSelected(new Set());
      await load();
      flash("ok", `${count}`);
    } catch (error) {
      flash("error", (error as Error).message);
      await load();
    }
  }, [selected, t, flash, load]);

  return (
    <div className="record-section">
      {items !== null && items.length > 0 && (
        <BatchBar
          count={selected.size}
          total={items.length}
          onSelectAll={() => setSelected((prev) => selectAllToggle(items, prev))}
          onDelete={() => void removeSelected()}
          t={t}
        />
      )}
      {items !== null && items.length === 0 && <div className="empty">{t.histEmpty}</div>}
      {items?.map((conv) => {
        const detail = state[conv.id];
        const isOpen = detail?.open ?? false;
        return (
          <div className="record-card conv-record" key={conv.id}>
            <div
              className="record-head"
              onClick={() => void toggle(conv.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void toggle(conv.id);
                }
              }}
            >
              <input
                type="checkbox"
                className="record-check"
                checked={selected.has(conv.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => setSelected((prev) => toggleId(prev, conv.id))}
                aria-label={conv.title}
              />
              <span className={`record-caret${isOpen ? " open" : ""}`} aria-hidden="true" />
              <span className="record-title">{conv.title}</span>
              <span className="record-meta">
                <span className="record-time">{formatWhen(conv.createdAt)}</span>
              </span>
              <button
                className="icon-btn danger record-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeOne(conv.id);
                }}
                title={t.delete}
                aria-label={t.delete}
                type="button"
              >
                ×
              </button>
            </div>
            {conv.preview && <div className="record-summary">{conv.preview}</div>}
            {detail && isOpen && (
              <div className="record-detail conv-msgs">
                {detail.loading ? (
                  <div className="hint">{t.loading}</div>
                ) : detail.messages.length === 0 ? (
                  <div className="hint">{t.convHistoryEmpty}</div>
                ) : (
                  <>
                    {detail.messages.map((m, i) => (
                      <div key={i} className={`record-msg record-msg-${m.role}`}>
                        {m.text}
                      </div>
                    ))}
                    <div className="conv-actions">
                      <button
                        className="primary conv-continue"
                        onClick={(e) => {
                          e.stopPropagation();
                          continueConversation(conv.id);
                        }}
                        type="button"
                      >
                        {t.convContinue}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Runs: shared by workflow-runs and task-runs sections -------------------

interface RunsSectionProps extends SectionProps {
  runs: TaskRunLog[] | null;
  reload: () => Promise<void>;
  filter: (run: TaskRunLog) => boolean;
  /** Run id deep-linked from another tab; its card auto-expands + highlights. */
  focusRunId?: string | null;
  /** Called once the deep-linked run was found in this section. */
  onFocused?: () => void;
}

function RunsSection({ t, flash, runs, reload, filter, focusRunId, onFocused }: RunsSectionProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Ids of deep-linked cards currently playing the highlight flash.
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const items = (runs ?? [])
    .filter(filter)
    .slice()
    .sort((a, b) => (b.startedAt ?? b.at) - (a.startedAt ?? a.at));

  // Expand + flash a run another tab deep-linked to (e.g. the Workflows tab's
  // failed-run banner). No-op when the id belongs to the other run section.
  useEffect(() => {
    if (!focusRunId) return;
    const match = items.find((run) => run.id === focusRunId);
    if (!match) return;
    setOpen((prev) => (prev[focusRunId] ? prev : { ...prev, [focusRunId]: true }));
    setFlashing((prev) => {
      const next = new Set(prev);
      next.add(focusRunId);
      return next;
    });
    onFocused?.();
    const timer = setTimeout(() => {
      setFlashing((prev) => {
        const next = new Set(prev);
        next.delete(focusRunId);
        return next;
      });
    }, 2600);
    // Wait a tick for the card to render before scrolling it into view.
    const scrollTimer = setTimeout(() => {
      document
        .querySelector(`[data-run-id="${focusRunId}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    return () => {
      clearTimeout(timer);
      clearTimeout(scrollTimer);
    };
    // items identity changes on every reload; the effect should only refire for
    // a new deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRunId]);

  const removeOne = useCallback(
    async (id: string): Promise<void> => {
      try {
        await sendCommand({ type: "tasks.runs.delete", id });
        setSelected((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        await reload();
      } catch (error) {
        flash("error", (error as Error).message);
      }
    },
    [flash, reload],
  );

  const removeSelected = useCallback(async (): Promise<void> => {
    if (selected.size === 0) return;
    if (
      !(await confirmDialog({
        title: t.dialogDeleteTitle,
        message: t.histDeleteConfirm({ count: selected.size }),
        confirmText: t.delete,
        cancelText: t.cancel,
        danger: true,
      }))
    )
      return;
    const count = selected.size;
    try {
      for (const id of selected) {
        await sendCommand({ type: "tasks.runs.delete", id });
      }
      setSelected(new Set());
      await reload();
      flash("ok", `${count}`);
    } catch (error) {
      flash("error", (error as Error).message);
      await reload();
    }
  }, [selected, t, flash, reload]);

  const clearAll = useCallback(async (): Promise<void> => {
    if (items.length === 0) return;
    if (
      !(await confirmDialog({
        title: t.dialogDeleteTitle,
        message: t.histDeleteConfirm({ count: items.length }),
        confirmText: t.delete,
        cancelText: t.cancel,
        danger: true,
      }))
    )
      return;
    try {
      await sendCommand({ type: "tasks.runs.clear" });
      setSelected(new Set());
      await reload();
    } catch (error) {
      flash("error", (error as Error).message);
    }
  }, [items.length, t, flash, reload]);

  return (
    <div className="record-section">
      {items.length > 0 && (
        <BatchBar
          count={selected.size}
          total={items.length}
          onSelectAll={() => setSelected((prev) => selectAllToggle(items, prev))}
          onDelete={() => void removeSelected()}
          t={t}
          extra={
            <button className="danger ghost" onClick={() => void clearAll()} type="button">
              {t.taskRunsClear}
            </button>
          }
        />
      )}
      {items.length === 0 && <div className="empty">{t.histEmptyRuns}</div>}
      {items.map((run) => {
        const isOpen = open[run.id] ?? false;
        const label = run.label || run.taskId || run.id;
        const kind = badgeKind(run);
        const src = sourceLabel(t, run.source);
        return (
          <div
            className={`record-card run-record${flashing.has(run.id) ? " run-record-flash" : ""}`}
            key={run.id}
            data-run-id={run.id}
          >
            <div
              className="record-head"
              onClick={() => setOpen((prev) => ({ ...prev, [run.id]: !isOpen }))}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((prev) => ({ ...prev, [run.id]: !isOpen }));
                }
              }}
            >
              <input
                type="checkbox"
                className="record-check"
                checked={selected.has(run.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => setSelected((prev) => toggleId(prev, run.id))}
                aria-label={label}
              />
              <span className={`record-caret${isOpen ? " open" : ""}`} aria-hidden="true" />
              <span className="record-title">{label}</span>
              <span className="record-meta">
                {src && <span className="record-source">{src}</span>}
                {run.startedAt && <span className="record-time">{formatWhen(run.startedAt)}</span>}
                <span className={`status-badge ${kind}`}>{badgeLabel(t, run)}</span>
              </span>
              <button
                className="icon-btn danger record-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeOne(run.id);
                }}
                title={t.delete}
                aria-label={t.delete}
                type="button"
              >
                ×
              </button>
            </div>
            {run.summary && <div className="record-summary">{run.summary}</div>}
            {/* Show failure detail even on a collapsed card so a broken run is
                visible without having to expand every failed row. */}
            {!isOpen && run.error && run.error !== run.summary && (
              <div className="record-error-inline">{run.error}</div>
            )}
            {isOpen && (
              <div className="record-detail">
                {run.error && <div className="record-error">{run.error}</div>}
                {run.steps && run.steps.length > 0 ? (
                  <ul className="record-steps">
                    {run.steps.map((step, i) => (
                      <li key={i} className="record-step" data-kind={step.kind}>
                        <span className="record-step-time">{formatWhen(step.at)}</span>
                        <span className="record-step-tag">{step.kind}</span>
                        <span className="record-step-text">{step.text}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="hint">{t.histNoSteps}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Operations (action history) --------------------------------------------

function OperationsSection({ t, flash }: SectionProps) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  // Selection is per CONVERSATION/group, never per individual operation row:
  // the stored ids are group keys (conversation ids / "task:…" / "feishu:…").
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** Open AI node-review dialog for a rebuilt workflow (null = closed). */
  const [review, setReview] = useState<{
    workflow: Workflow;
    stepList: ReviewStep[];
    reviewing: boolean;
    review: WorkflowReview | null;
    keep: Record<string, boolean> | null;
  } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [histResult, convResult] = await Promise.all([
        sendCommand({ type: "history.list" }),
        sendCommand({ type: "conversations.list" }),
      ]);
      if (histResult.type === "history.list") setEntries(histResult.entries);
      if (convResult.type === "conversations.list") setConversations(convResult.conversations);
    } catch (error) {
      flash("error", (error as Error).message);
    }
  }, [flash]);

  useEffect(() => {
    void load();
  }, [load]);

  const removeOne = useCallback(
    async (id: string): Promise<void> => {
      try {
        await sendCommand({ type: "history.delete", id });
        setSelected((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        await load();
      } catch (error) {
        flash("error", (error as Error).message);
      }
    },
    [flash, load],
  );

  // `selected` holds GROUP keys (conversations); deleting removes every action
  // record inside each selected group.
  const groups = entries ? groupHistory(entries, conversations) : [];
  const entryCountOf = (groupKeys: Set<string>): number =>
    groups.reduce(
      (sum, g) => sum + (groupKeys.has(g.key) ? g.entries.length : 0),
      0,
    );

  const removeSelected = useCallback(async (): Promise<void> => {
    if (selected.size === 0) return;
    const toDelete = (entries ?? []).filter((e) => selected.has(e.conversationId || "unknown"));
    if (toDelete.length === 0) {
      setSelected(new Set());
      return;
    }
    if (
      !(await confirmDialog({
        title: t.dialogDeleteTitle,
        message: t.histDeleteConfirm({ count: toDelete.length }),
        confirmText: t.delete,
        cancelText: t.cancel,
        danger: true,
      }))
    )
      return;
    try {
      for (const entry of toDelete) {
        await sendCommand({ type: "history.delete", id: entry.id });
      }
      setSelected(new Set());
      await load();
      flash("ok", `${toDelete.length}`);
    } catch (error) {
      flash("error", (error as Error).message);
      await load();
    }
  }, [selected, entries, t, flash, load]);

  const clearAll = useCallback(async (): Promise<void> => {
    const total = entries?.length ?? 0;
    if (total === 0) return;
    if (
      !(await confirmDialog({
        title: t.dialogDeleteTitle,
        message: t.histDeleteConfirm({ count: total }),
        confirmText: t.delete,
        cancelText: t.cancel,
        danger: true,
      }))
    )
      return;
    try {
      await sendCommand({ type: "history.clear" });
      setSelected(new Set());
      await load();
      flash("ok", `${total}`);
    } catch (error) {
      flash("error", (error as Error).message);
    }
  }, [entries, t, flash, load]);

  /**
   * Rebuilds a linear workflow from a group's action steps (oldest first) and
   * opens the AI node-review dialog; the save happens only on confirm. A late
   * review reply for a closed/superseded dialog is dropped by the workflow-id
   * guard.
   */
  const rebuild = useCallback(
    async (groupTitle: string, groupEntries: HistoryEntry[]): Promise<void> => {
      const workflow = workflowFromHistory([...groupEntries].reverse(), `从历史: ${groupTitle}`);
      if (!workflow) {
        flash("error", t.dataHistoryToWorkflowEmpty);
        return;
      }
      const stepList = reviewStepsOf(workflow);
      setReview({
        workflow,
        stepList,
        reviewing: stepList.length > 0,
        review: null,
        keep: null,
      });
      const applyVerdict = (verdict: WorkflowReview | null): void => {
        setReview((prev) => {
          if (!prev || prev.workflow.id !== workflow.id) return prev;
          // Materialize the verdicts into the keep set so the checkboxes AND
          // the saved result both reflect the AI judgment; unmentioned steps
          // stay keep=true.
          const keep: Record<string, boolean> = { ...prev.keep };
          if (verdict) {
            for (const item of verdict.steps) keep[item.id] = item.keep;
          }
          return { ...prev, reviewing: false, review: verdict, keep };
        });
      };
      try {
        const result = await sendCommand({ type: "workflows.review", workflow });
        if (result.type === "workflows.review") applyVerdict(result.review);
      } catch {
        applyVerdict(null);
      }
    },
    [flash, t],
  );

  /** Keep/drop one reviewed step (primary + its satellites) in the dialog. */
  const toggleStepKeep = (stepId: string, kept: boolean): void => {
    setReview((prev) => (prev ? { ...prev, keep: { ...prev.keep, [stepId]: kept } } : prev));
  };

  /** Applies the keep set and persists; unavailable review keeps everything. */
  const confirmReview = useCallback(async (): Promise<void> => {
    const current = review;
    if (!current) return;
    setReview(null);
    try {
      const workflow = applyNodeKeepSelection(current.workflow, current.keep ?? {});
      await saveWorkflow(workflow);
      flash("ok", t.dataHistoryToWorkflowDone);
    } catch (error) {
      flash("error", (error as Error).message);
    }
  }, [review, flash, t]);

  const toggleGroup = (key: string): void => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleGroupSelected = (key: string): void => {
    setSelected((prev) => toggleId(prev, key));
  };

  return (
    <div className="record-section">
      {entries !== null && entries.length > 0 && (
        <BatchBar
          count={entryCountOf(selected)}
          total={entries.length}
          onSelectAll={() =>
            setSelected((prev) =>
              prev.size === groups.length
                ? new Set()
                : new Set(groups.map((g) => g.key)),
            )
          }
          onDelete={() => void removeSelected()}
          t={t}
          extra={
            <button className="danger ghost" onClick={() => void clearAll()} type="button">
              {t.dataClearHistory}
            </button>
          }
        />
      )}
      {entries !== null && entries.length === 0 && <div className="empty">{t.histEmpty}</div>}
      {groups.map((group) => {
        const okCount = group.entries.filter((e) => e.ok && e.approved).length;
        const failCount = group.entries.filter((e) => !e.ok).length;
        const isOpen = expanded[group.key] ?? false;
        const groupChecked = selected.has(group.key);
        return (
          <div className="record-card history-group" key={group.key}>
            <div
              className="record-head history-group-head"
              onClick={() => toggleGroup(group.key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleGroup(group.key);
                }
              }}
            >
              <input
                type="checkbox"
                className="record-check"
                checked={groupChecked}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleGroupSelected(group.key)}
                aria-label={group.title}
              />
              <span className={`record-caret${isOpen ? " open" : ""}`} aria-hidden="true" />
              <span className="record-title history-group-title">{group.title}</span>
              <span className="record-meta">
                <span className="history-count">{group.entries.length}</span>
                {failCount > 0 ? (
                  <span className="history-stat history-stat-err">{failCount} ✕</span>
                ) : (
                  <span className="history-stat history-stat-ok">{okCount} ✓</span>
                )}
              </span>
              <button
                className="icon-btn history-rebuild"
                title={t.dataHistoryToWorkflow}
                aria-label={t.dataHistoryToWorkflow}
                onClick={(e) => {
                  e.stopPropagation();
                  void rebuild(group.title, group.entries);
                }}
                type="button"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <path d="M10 6.5h4" />
                  <path d="M6.5 10v4a2 2 0 0 0 2 2h5.5" />
                </svg>
              </button>
            </div>
            {isOpen && (
              <ul className="history-steps">
                {group.entries.map((entry) => (
                  <li
                    className={`history-step history-step-${entry.ok ? "ok" : "err"}`}
                    key={entry.id}
                  >
                    <div className="history-step-head">
                      <span className="history-step-time">{formatWhen(entry.at)}</span>
                      <span className="history-meta">
                        {entry.host && <span className="history-host">{entry.host}</span>}
                        {!entry.approved && (
                          <span className="history-declined">{t.dataDeclined}</span>
                        )}
                      </span>
                      <button
                        className="icon-btn danger history-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeOne(entry.id);
                        }}
                        title={t.delete}
                        aria-label={t.delete}
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                    <div className="history-summary">{entry.summary || entry.action}</div>
                    {entry.detail && entry.detail.length > 0 && (
                      <ul className="history-detail">
                        {entry.detail.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    )}
                    {entry.args && Object.keys(entry.args).length > 0 && (
                      <div className="record-args">
                        <span className="record-json-label">{t.histArgs}</span>
                        <pre className="record-json">{JSON.stringify(entry.args, null, 2)}</pre>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {review && (
        <WorkflowReviewDialog
          keep={review.keep}
          review={review.review}
          reviewing={review.reviewing}
          steps={review.stepList}
          subtitle={review.workflow.name}
          title={t.workflowReviewDialogTitle}
          onCancel={() => setReview(null)}
          onConfirm={() => void confirmReview()}
          onToggle={toggleStepKeep}
        />
      )}
    </div>
  );
}
