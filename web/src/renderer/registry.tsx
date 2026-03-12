import React from "react";
import { defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import { baseCatalog } from "./viewCatalog";

function ResponsiveDialog(props: any) {
  const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  const Component = isMobile ? (shadcnComponents as any).Drawer : (shadcnComponents as any).Dialog;
  return <Component {...props} />;
}

const { registry } = defineRegistry(baseCatalog as any, {
  components: {
    ...(shadcnComponents as any),
    Dialog: ResponsiveDialog,
  } as any,
  actions: {
    // Runtime actions are provided by JSONUIProvider handlers in App.tsx.
    navigate: async () => {},
  } as any,
});

export { registry };
