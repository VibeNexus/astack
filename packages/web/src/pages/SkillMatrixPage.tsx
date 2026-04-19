import type * as React from "react";
/**
 * Skill Matrix — projects × skills cross-view.
 *
 * Per design review decision 7.1: rows=projects, cols=skills, with
 * sticky first column (project name) and sticky header (skill name).
 * Users with "project少 / 技能多" get a wide horizontal scroller.
 */

import type {
  GetProjectStatusResponse,
  Project,
  Skill
} from "@astack/shared";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  Badge,
  Card,
  EmptyState,
  Skeleton,
  StatusDot
} from "../components/ui.js";
import { api, AstackError } from "../lib/api.js";
import {
  shortHash,
  subscriptionStatusInfo
} from "../lib/format.js";
import { useEventListener } from "../lib/sse.js";
import { useToast } from "../lib/toast.js";

interface MatrixCell {
  state: string;
  version: string | null;
}

interface MatrixData {
  projects: Project[];
  /** skills grouped in column order */
  columns: Array<{ skill: Skill; repo: string }>;
  /** cells[project_id][skill_id] */
  cells: Map<number, Map<number, MatrixCell>>;
}

export function SkillMatrixPage(): React.JSX.Element {
  const [data, setData] = useState<MatrixData | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [projectsRes, reposRes] = await Promise.all([
        api.listProjects({ limit: 500 }),
        api.listRepos({ limit: 500 })
      ]);

      // For each project, fetch its status (subscriptions + state).
      const statuses: Array<GetProjectStatusResponse | null> = await Promise.all(
        projectsRes.projects.map(async (p) => {
          try {
            return await api.projectStatus(p.id);
          } catch {
            return null;
          }
        })
      );

      // Aggregate all skills referenced by any project; order by
      // (repo name, skill name) for stable columns.
      const colMap = new Map<
        number,
        { skill: Skill; repo: string }
      >();
      for (const status of statuses) {
        if (!status) continue;
        for (const sub of status.subscriptions) {
          if (!colMap.has(sub.skill.id)) {
            colMap.set(sub.skill.id, {
              skill: sub.skill,
              repo: sub.repo.name
            });
          }
        }
      }
      const columns = Array.from(colMap.values()).sort((a, b) => {
        if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
        return a.skill.name.localeCompare(b.skill.name);
      });

      // Build cells map.
      const cells = new Map<number, Map<number, MatrixCell>>();
      projectsRes.projects.forEach((project, i) => {
        const status = statuses[i];
        const rowMap = new Map<number, MatrixCell>();
        if (status) {
          for (const sub of status.subscriptions) {
            rowMap.set(sub.skill.id, {
              state: sub.state,
              version: sub.skill.version
            });
          }
        }
        cells.set(project.id, rowMap);
      });

      setData({
        projects: projectsRes.projects,
        columns,
        cells
      });

      // Silence unused variable.
      void reposRes;
    } catch (err) {
      toast.error(
        "Could not load matrix",
        err instanceof AstackError ? err.message : String(err)
      );
      setData({
        projects: [],
        columns: [],
        cells: new Map()
      });
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEventListener("skill.updated", () => void load());
  useEventListener("conflict.detected", () => void load());
  useEventListener("sync.completed", () => void load());

  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-60" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Skill Matrix</h1>
        <div className="text-xs text-text-muted">
          <Badge tone="neutral" className="mr-2">
            {data.projects.length} project(s)
          </Badge>
          <Badge tone="neutral">{data.columns.length} skill(s)</Badge>
        </div>
      </div>

      {data.projects.length === 0 || data.columns.length === 0 ? (
        <EmptyState
          title="Nothing to show yet"
          hint="Register projects and subscribe to skills to populate the matrix."
        />
      ) : (
        <MatrixGrid data={data} />
      )}
    </div>
  );
}

function MatrixGrid({ data }: { data: MatrixData }): React.JSX.Element {
  return (
    <Card className="p-0 overflow-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-20 bg-surface border-r border-b border-border text-left px-3 py-2 font-normal text-text-muted">
              Project
            </th>
            {data.columns.map((col) => (
              <th
                key={col.skill.id}
                className="sticky top-0 z-10 bg-surface border-b border-border px-2 py-2 font-normal text-text-muted whitespace-nowrap"
                title={`${col.repo}/${col.skill.name}`}
              >
                <div className="font-mono text-text-primary">
                  {col.skill.name}
                </div>
                <div className="text-[10px] text-text-muted">{col.repo}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.projects.map((p) => {
            const row = data.cells.get(p.id) ?? new Map();
            return (
              <tr key={p.id} className="group">
                <td className="sticky left-0 z-10 bg-surface border-r border-b border-border px-3 py-2 whitespace-nowrap group-hover:bg-elevated">
                  <Link to={`/projects/${p.id}`} className="hover:text-accent">
                    {p.name}
                  </Link>
                </td>
                {data.columns.map((col) => {
                  const cell = row.get(col.skill.id);
                  return (
                    <td
                      key={col.skill.id}
                      className="border-b border-border px-2 py-1 text-center group-hover:bg-elevated"
                    >
                      {cell ? (
                        <MatrixCellView
                          state={cell.state}
                          version={cell.version}
                          projectId={p.id}
                          skillId={col.skill.id}
                        />
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function MatrixCellView({
  state,
  version,
  projectId,
  skillId
}: {
  state: string;
  version: string | null;
  projectId: number;
  skillId: number;
}): React.JSX.Element {
  const info = subscriptionStatusInfo(
    state as Parameters<typeof subscriptionStatusInfo>[0]
  );
  const cell = (
    <span
      className="inline-flex items-center gap-1"
      title={`${info.label}  ${shortHash(version)}`}
    >
      <StatusDot tone={info.tone} />
      <span className="font-mono text-[10px] text-text-muted">
        {shortHash(version)}
      </span>
    </span>
  );

  if (state === "conflict") {
    return (
      <Link
        to={`/resolve/${projectId}/${skillId}`}
        className="inline-flex items-center"
      >
        {cell}
      </Link>
    );
  }
  return cell;
}
