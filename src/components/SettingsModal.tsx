"use client";

import { useState, useEffect, useCallback } from "react";
import { X, Loader2, BarChart3, DollarSign, Zap, Clock } from "lucide-react";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface UsageData {
  days: number;
  totalCalls: number;
  totalInput: number;
  totalOutput: number;
  totalCostUsd: number;
  byFlow: Record<
    string,
    { inputTokens: number; outputTokens: number; calls: number }
  >;
  byDay: Record<
    string,
    { inputTokens: number; outputTokens: number; calls: number }
  >;
  byModel: Record<
    string,
    { inputTokens: number; outputTokens: number; calls: number }
  >;
  costByModel: Record<string, number>;
}

const FLOW_LABELS: Record<string, string> = {
  "chat-tier0": "Quick Chat (Doc)",
  "chat-tier1": "Search Chat",
  "chat-tier2": "Deep Search",
  "chat-context": "Context Query",
  annotate: "Annotations",
  index: "Indexing",
  "index-summary": "Summarization",
  "index-tags": "Tagging",
  "index-embed": "Embedding",
};

const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5-20251001": "Claude Haiku",
  "claude-sonnet-4-6": "Claude Sonnet",
  "claude-3-5-haiku-20241022": "Claude 3.5 Haiku",
  "claude-sonnet-4-20250514": "Claude Sonnet 4",
  "llama-3.1-8b-instant": "Llama 3.1 8B",
  "text-embedding-3-small": "Embeddings",
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatCost(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  const fetchUsage = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai/usage?days=${d}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUsage(data);
    } catch (err) {
      console.error("[SettingsModal] Failed to fetch usage:", err);
      setError("Failed to load usage data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) fetchUsage(days);
  }, [isOpen, days, fetchUsage]);

  if (!isOpen) return null;

  const dayOptions = [7, 14, 30, 90];

  // Compute bar chart data (last N days)
  const dayEntries = usage
    ? Object.entries(usage.byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-Math.min(days, 30))
    : [];
  const maxDayTokens =
    dayEntries.length > 0
      ? Math.max(
          ...dayEntries.map(([, v]) => v.inputTokens + v.outputTokens),
          1
        )
      : 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-[560px] max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-foreground">Settings</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* ─── AI Usage Dashboard ─── */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                <BarChart3 size={15} />
                AI Usage
              </h3>
              <div className="flex gap-1">
                {dayOptions.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDays(d)}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                      days === d
                        ? "bg-black text-white"
                        : "bg-black/5 text-muted-foreground hover:bg-black/10"
                    }`}
                  >
                    {d}d
                  </button>
                ))}
              </div>
            </div>

            {loading && !usage && (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
                <Loader2 size={14} className="animate-spin mr-2" />
                Loading usage data…
              </div>
            )}

            {error && (
              <div className="text-center py-6 text-xs text-red-500">
                {error}
              </div>
            )}

            {usage && (
              <>
                {/* Summary cards */}
                <div className="grid grid-cols-3 gap-3 mb-5">
                  <div className="bg-neutral-50 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] mb-1">
                      <Zap size={12} />
                      API Calls
                    </div>
                    <div className="text-lg font-semibold text-foreground">
                      {usage.totalCalls.toLocaleString()}
                    </div>
                  </div>
                  <div className="bg-neutral-50 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] mb-1">
                      <Clock size={12} />
                      Total Tokens
                    </div>
                    <div className="text-lg font-semibold text-foreground">
                      {formatTokens(usage.totalInput + usage.totalOutput)}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {formatTokens(usage.totalInput)} in /{" "}
                      {formatTokens(usage.totalOutput)} out
                    </div>
                  </div>
                  <div className="bg-neutral-50 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 text-muted-foreground text-[11px] mb-1">
                      <DollarSign size={12} />
                      Est. Cost
                    </div>
                    <div className="text-lg font-semibold text-foreground">
                      {formatCost(usage.totalCostUsd)}
                    </div>
                  </div>
                </div>

                {/* Daily usage bar chart */}
                {dayEntries.length > 0 && (
                  <div className="mb-5">
                    <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Daily Token Usage
                    </h4>
                    <div className="flex items-end gap-[2px] h-16">
                      {dayEntries.map(([day, val]) => {
                        const total = val.inputTokens + val.outputTokens;
                        const heightPct = (total / maxDayTokens) * 100;
                        const inputPct =
                          total > 0
                            ? (val.inputTokens / total) * 100
                            : 50;
                        return (
                          <div
                            key={day}
                            className="flex-1 flex flex-col justify-end group relative"
                            style={{ height: "100%" }}
                          >
                            {/* Tooltip */}
                            <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 whitespace-nowrap bg-neutral-800 text-white text-[10px] px-2 py-1 rounded shadow-lg pointer-events-none">
                              <div className="font-medium">{day}</div>
                              <div>
                                {formatTokens(total)} tokens · {val.calls}{" "}
                                calls
                              </div>
                            </div>
                            {/* Bar */}
                            <div
                              className="w-full rounded-sm overflow-hidden transition-all"
                              style={{ height: `${Math.max(heightPct, 2)}%` }}
                            >
                              <div
                                className="bg-blue-400 w-full"
                                style={{ height: `${inputPct}%` }}
                              />
                              <div
                                className="bg-blue-600 w-full"
                                style={{ height: `${100 - inputPct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-[9px] text-muted-foreground">
                        {dayEntries[0]?.[0]?.slice(5)}
                      </span>
                      <div className="flex gap-3 text-[9px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm bg-blue-400 inline-block" />
                          Input
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-sm bg-blue-600 inline-block" />
                          Output
                        </span>
                      </div>
                      <span className="text-[9px] text-muted-foreground">
                        {dayEntries[dayEntries.length - 1]?.[0]?.slice(5)}
                      </span>
                    </div>
                  </div>
                )}

                {/* By model table */}
                {Object.keys(usage.byModel).length > 0 && (
                  <div className="mb-5">
                    <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Usage by Model
                    </h4>
                    <div className="border border-border rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-neutral-50 text-muted-foreground">
                            <th className="text-left px-3 py-1.5 font-medium">
                              Model
                            </th>
                            <th className="text-right px-3 py-1.5 font-medium">
                              Calls
                            </th>
                            <th className="text-right px-3 py-1.5 font-medium">
                              Tokens
                            </th>
                            <th className="text-right px-3 py-1.5 font-medium">
                              Cost
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(usage.byModel)
                            .sort(
                              ([, a], [, b]) =>
                                b.inputTokens +
                                b.outputTokens -
                                (a.inputTokens + a.outputTokens)
                            )
                            .map(([modelName, stats]) => (
                              <tr
                                key={modelName}
                                className="border-t border-border"
                              >
                                <td className="px-3 py-1.5 text-foreground">
                                  {MODEL_LABELS[modelName] ?? modelName}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                                  {stats.calls}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                                  {formatTokens(
                                    stats.inputTokens + stats.outputTokens
                                  )}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                                  {formatCost(
                                    usage.costByModel[modelName] ?? 0
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* By flow table */}
                {Object.keys(usage.byFlow).length > 0 && (
                  <div>
                    <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                      Usage by Feature
                    </h4>
                    <div className="border border-border rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-neutral-50 text-muted-foreground">
                            <th className="text-left px-3 py-1.5 font-medium">
                              Feature
                            </th>
                            <th className="text-right px-3 py-1.5 font-medium">
                              Calls
                            </th>
                            <th className="text-right px-3 py-1.5 font-medium">
                              Input
                            </th>
                            <th className="text-right px-3 py-1.5 font-medium">
                              Output
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(usage.byFlow)
                            .sort(([, a], [, b]) => b.calls - a.calls)
                            .map(([flow, stats]) => (
                              <tr
                                key={flow}
                                className="border-t border-border"
                              >
                                <td className="px-3 py-1.5 text-foreground">
                                  {FLOW_LABELS[flow] ?? flow}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                                  {stats.calls}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                                  {formatTokens(stats.inputTokens)}
                                </td>
                                <td className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                                  {formatTokens(stats.outputTokens)}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Empty state */}
                {usage.totalCalls === 0 && (
                  <div className="text-center py-8 text-xs text-muted-foreground">
                    No AI usage recorded in the last {days} days.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
