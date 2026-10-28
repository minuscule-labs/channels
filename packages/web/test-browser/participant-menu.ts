import type { Page } from "@playwright/test";

export async function openParticipantSection(page: Page, section: "Agent" | "Inspect" | "New session") {
  const trigger = page.getByRole("menuitem", { name: section, exact: true });
  if (await trigger.isVisible() && await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
}
