// Turns an app's manifest icon into a square PNG, inside the page.
//
// Doing it here rather than in Rust means an SVG or WebP icon needs no
// rasterizer on our side, and the fetch carries the page's cookies for the
// occasional icon that wants them. A blob fetched with credentials can be
// drawn without tainting the canvas; an icon on a CDN without CORS fails the
// fetch instead, and the host falls back to downloading it itself.

const ICON_URL = __ICON_URL__;
const SIZE = __SIZE__;

return (async () => {
  let blob;
  try {
    const response = await fetch(ICON_URL, { credentials: "same-origin", cache: "force-cache" });
    if (!response.ok) return { error: "icon " + response.status };
    blob = await response.blob();
  } catch (error) {
    return { error: "icon fetch failed: " + (error && error.message ? error.message : String(error)) };
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (error) {
    return { error: "icon undecodable: " + (error && error.message ? error.message : String(error)) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { error: "no 2d context" };
  // Fit inside the square, centred, on a transparent ground; a non-square
  // icon is letterboxed rather than stretched.
  const scale = Math.min(SIZE / bitmap.width, SIZE / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  ctx.drawImage(bitmap, Math.floor((SIZE - w) / 2), Math.floor((SIZE - h) / 2), w, h);
  bitmap.close();
  try {
    return { png: canvas.toDataURL("image/png") };
  } catch (error) {
    return { error: "canvas tainted: " + (error && error.message ? error.message : String(error)) };
  }
})();
