import { readFile } from "node:fs/promises";
import path from "node:path";

const PUBLIC_DIRECTORY = path.resolve("public");
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export async function readPublicFile(
  pathname: string,
): Promise<{ body: Buffer; contentType: string } | undefined> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = path.resolve(PUBLIC_DIRECTORY, `.${requested}`);
  if (!absolutePath.startsWith(`${PUBLIC_DIRECTORY}${path.sep}`)) return undefined;

  try {
    return {
      body: await readFile(absolutePath),
      contentType:
        MIME_TYPES[path.extname(absolutePath)] ?? "application/octet-stream",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
