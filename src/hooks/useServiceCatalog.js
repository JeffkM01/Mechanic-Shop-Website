import { createContext, useContext } from "react";

export const ServiceCatalogContext = createContext(null);

export default function useServiceCatalog() {
  const catalog = useContext(ServiceCatalogContext);
  if (!catalog) throw new Error("Service catalog provider is required.");
  return catalog;
}
