import { defineRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";
import { baseCatalog } from "./viewCatalog";

const { registry } = defineRegistry(baseCatalog as any, {
  components: shadcnComponents as any,
  actions: {
    // Runtime actions are provided by JSONUIProvider handlers in App.tsx.
    navigate: async () => {},
  } as any,
});

export { registry };
