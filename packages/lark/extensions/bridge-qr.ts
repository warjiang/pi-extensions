import QRCode from "qrcode";

const QUIET_ZONE = 4;

export const QR_IMAGE_MAX_WIDTH_CELLS = 24;
export const QR_IMAGE_MAX_HEIGHT_CELLS = 12;

export function compactLauncherUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (
    url.protocol !== "https:" ||
    !["open.feishu.cn", "open.larksuite.com"].includes(url.hostname) ||
    url.pathname !== "/page/launcher"
  ) {
    return value;
  }
  url.searchParams.delete("from");
  url.searchParams.delete("source");
  url.searchParams.delete("tp");
  return url.toString();
}

export async function renderQrPngBase64(value: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(value, {
    errorCorrectionLevel: "L",
    margin: QUIET_ZONE,
    width: 512,
    color: {
      dark: "#000000ff",
      light: "#ffffffff",
    },
  });
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}
