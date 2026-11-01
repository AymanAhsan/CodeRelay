import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./icon-export.ts";

/** Uses the site's CodeRelay mark for Windows executables, shortcuts, and installers. */
export async function renderCodeRelayWindowsIcon(sourceSvg: string): Promise<Buffer> {
  const images = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({
      size,
      contents: await sharp(sourceSvg, { density: 768 }).resize(size, size).png().toBuffer(),
    })),
  );
  return encodePngIco(images);
}
