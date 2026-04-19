import type * as React from "react";
/**
 * 404 for unknown routes.
 */

import { Link } from "react-router-dom";

export function NotFoundPage(): React.JSX.Element {
  return (
    <div className="py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-text-secondary mt-1">
        The address you entered does not match any known page.
      </p>
      <Link
        to="/"
        className="inline-block text-sm text-accent hover:underline mt-4"
      >
        ← back to Sync Status
      </Link>
    </div>
  );
}
