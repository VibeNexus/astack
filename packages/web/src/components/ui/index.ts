/**
 * Primitive components for the Graphite UI design system.
 *
 * Design principles:
 *   - Typography does the work, not color
 *   - Surfaces are translucent overlays on canvas, not opaque dark greys
 *   - Rounded corners are small (6px); we're precise, not bubbly
 *   - No badges by default — status goes inline with text + symbol
 *   - Buttons have three weights: primary (rare), default, ghost
 *
 * Added in v0.3: each primitive lives in its own file under `ui/`. This
 * barrel preserves backward-compatibility with the old `from "../components/ui.js"`
 * import path that existed pre-v0.3. New code should import from either
 * this barrel or the specific file — both work.
 */

export { Button, type ButtonProps } from "./Button.js";
export { StatusDot, type StatusTone } from "./StatusDot.js";
export { InlineTag } from "./InlineTag.js";
export { Badge, type BadgeProps } from "./Badge.js";
export { Card, type CardProps } from "./Card.js";
export { EmptyState } from "./EmptyState.js";
export { Skeleton } from "./Skeleton.js";
export { Kbd } from "./Kbd.js";
export { IconButton, type IconButtonProps } from "./IconButton.js";
export { Tabs, TabPanel, type TabItem, type TabsProps, type TabPanelProps } from "./Tabs.js";
export { Drawer, DrawerHeader, type DrawerProps } from "./Drawer.js";
