import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { QueryProvider } from "./lib/query";
import { router } from "./router";
import { ToastProvider } from "./components/ui/toast";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <QueryProvider>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </QueryProvider>,
);
