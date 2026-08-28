import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function Drawer({
  open,
  onOpenChange,
  side,
  title,
  description,
  trigger,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  side: "left" | "right";
  title: string;
  description: string;
  trigger?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in" />
        <Dialog.Content
          className={`fixed inset-y-0 z-50 h-full w-[min(22rem,92vw)] bg-[var(--panel)] shadow-2xl outline-none ${
            side === "left" ? "left-0" : "right-0"
          }`}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{description}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DrawerCloseButton({ label = "Close" }: { label?: string }) {
  return (
    <Dialog.Close className="icon-button inline-flex" aria-label={label}>
      <X className="h-4 w-4" />
    </Dialog.Close>
  );
}
