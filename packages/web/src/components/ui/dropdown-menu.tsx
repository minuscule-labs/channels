import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuSub = Menu.Sub;

export function DropdownMenuContent({ className = "", sideOffset = 4, collisionPadding = 12, ...props }: ComponentProps<typeof Menu.Content>) {
  return <Menu.Portal><Menu.Content className={`action-menu ${className}`} sideOffset={sideOffset} collisionPadding={collisionPadding} {...props} /></Menu.Portal>;
}

export function DropdownMenuItem({ className = "", tone, ...props }: ComponentProps<typeof Menu.Item> & { tone?: "danger" | "warning" }) {
  return <Menu.Item className={`action-menu-item ${className}`} data-tone={tone} {...props} />;
}

export function DropdownMenuSubTrigger({ className = "", children, onPointerLeave, ...props }: ComponentProps<typeof Menu.SubTrigger>) {
  return <Menu.SubTrigger className={`action-menu-item ${className}`} {...props} onPointerLeave={(event) => {
    onPointerLeave?.(event);
    const submenuId = event.currentTarget.getAttribute("aria-controls");
    // A direct move into a collision-flipped flyout must not refocus its parent.
    if (submenuId && event.relatedTarget instanceof Node && document.getElementById(submenuId)?.contains(event.relatedTarget)) event.preventDefault();
  }}>{children}<ChevronRight aria-hidden="true" className="ml-auto h-4 w-4" /></Menu.SubTrigger>;
}

export function DropdownMenuSubContent({ className = "", collisionPadding = 12, ...props }: ComponentProps<typeof Menu.SubContent>) {
  return <Menu.Portal><Menu.SubContent className={`action-menu ${className}`} collisionPadding={collisionPadding} {...props} /></Menu.Portal>;
}

export function DropdownMenuSeparator() {
  return <Menu.Separator className="action-menu-separator" />;
}
