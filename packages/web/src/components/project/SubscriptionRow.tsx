import type * as React from "react";

import type { SubscriptionWithState } from "@astack/shared";
import { Link } from "react-router-dom";

import { Badge, Button, StatusDot } from "../ui/index.js";
import {
  shortHash,
  subscriptionStatusInfo
} from "../../lib/format.js";

/**
 * One row in the Subscriptions table. Keeping this as a sibling to
 * SubscriptionsPanel so the table itself can stay thin and testable.
 *
 * State visual contract (v0.3 design review):
 *   synced      → green dot + "Synced" + hash                       → ⋯ menu
 *   behind      → yellow dot + "Behind" + hash                      → ⋯ menu (+ future Pull)
 *   local-ahead → yellow dot + "Local-ahead" + "N edits unpushed"   → ⋯ menu (+ future Push)
 *   conflict    → red dot + "Conflict"                              → [Resolve] primary btn
 *   pending     → muted dot + "Pending" + "never synced"            → ⋯ menu
 *
 * The primary action is visible only for conflicts (because that's the
 * blocking state). Everything else collapses into a ⋯ menu to keep rows
 * visually calm. PR7 will add the menu.
 */

export interface SubscriptionRowProps {
  row: SubscriptionWithState;
  projectId: number;
  onUnsubscribe: (skillId: number) => void | Promise<void>;
}

export function SubscriptionRow({
  row,
  projectId,
  onUnsubscribe
}: SubscriptionRowProps): React.JSX.Element {
  const info = subscriptionStatusInfo(row.state);
  return (
    <tr className="border-t border-line-subtle hover:bg-surface-1 transition-colors duration-fast">
      <td className="px-3 py-2 align-middle">
        <span className="inline-flex items-center gap-2">
          <StatusDot tone={info.tone} />
          <span className="text-fg-secondary text-xs">{info.label}</span>
        </span>
      </td>
      <td className="px-3 py-2 align-middle font-mono text-xs text-fg-primary">
        <span className="inline-flex items-center gap-1.5">
          {row.skill.name}
          {row.skill.type === "skill" ? (
            <Badge tone="neutral">dir</Badge>
          ) : row.skill.type === "agent" ? (
            <Badge tone="neutral">agent</Badge>
          ) : null}
        </span>
        {row.skill.description ? (
          <div className="mt-0.5 text-fg-tertiary font-sans text-xs max-w-[52ch] line-clamp-1">
            {row.skill.description}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2 align-middle text-xs text-fg-secondary">
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate" title={row.repo.name}>
            {row.repo.name}
          </span>
          {row.repo.kind === "open-source" ? (
            <Badge
              tone="warn"
              title="Open-source repo — pull only"
              className="shrink-0 whitespace-nowrap"
            >
              read-only
            </Badge>
          ) : null}
        </span>
      </td>
      <td className="px-3 py-2 align-middle font-mono text-xs text-fg-tertiary tabular">
        {shortHash(row.skill.version)}
      </td>
      <td className="px-3 py-2 align-middle text-right">
        {row.state === "conflict" ? (
          <Link to={`/resolve/${projectId}/${row.skill.id}`}>
            <Button size="sm" variant="primary">
              Resolve
            </Button>
          </Link>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUnsubscribe(row.skill.id)}
            className="text-fg-tertiary hover:text-error"
            aria-label={`Unsubscribe ${row.skill.name}`}
          >
            Unsubscribe
          </Button>
        )}
      </td>
    </tr>
  );
}
