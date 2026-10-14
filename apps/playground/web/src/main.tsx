import "./polyfills.ts";
import "./ui/tokens.css";
import "./ui/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Boot } from "./app/App.tsx";
import { loadEngine } from "./app/load-engine.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("the page has no #root element");
createRoot(root).render(
  <StrictMode>
    <Boot load={loadEngine} />
  </StrictMode>,
);
