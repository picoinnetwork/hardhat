import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolve({
  importPath,
  from,
}: {
  importPath: string;
  from: string;
}): string | undefined {
  try {
    return require.resolve(importPath, { paths: [from] });
  } catch (e) {
    // ensure that this is MODULE_NOT_FOUND
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      e.code === "MODULE_NOT_FOUND"
    ) {
      return undefined;
    }

    throw e;
  }
}
