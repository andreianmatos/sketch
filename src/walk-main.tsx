import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WalkApp from "./WalkApp";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalkApp />
  </StrictMode>,
);
