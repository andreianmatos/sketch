import { useState } from "react";
import PaperStudio from "./PaperStudio";

export default function GenerateApp() {
  const [drawing, setDrawing] = useState(true);
  return (
    <PaperStudio drawing={drawing} onDrawingChange={setDrawing} showPanel />
  );
}
