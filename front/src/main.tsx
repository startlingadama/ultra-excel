import React from "react";
import ReactDOM from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "./styles/global.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* accentColor/gray tuned to the ledger palette defined in global.css;
        radius kept soft to match the rounded drop-zone/card language. */}
    <Theme accentColor="teal" grayColor="sand" radius="large" panelBackground="solid">
      <App />
    </Theme>
  </React.StrictMode>,
);
