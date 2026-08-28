import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { QueryProvider } from "./lib/query";
import { router } from "./router";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <QueryProvider>
    <RouterProvider router={router} />
  </QueryProvider>,
);
