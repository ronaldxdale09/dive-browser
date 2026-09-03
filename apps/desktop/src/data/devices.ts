/**
 * Device presets for the simulator. Values follow Chrome DevTools'
 * emulated device descriptors (screen size in CSS px, DPR, UA, touch).
 * Kept small and hand-picked; a refresh script can extend it later.
 */
export interface DevicePreset {
  id: string;
  name: string;
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  touch: boolean;
  userAgent: string;
  platform: "iOS" | "Android" | "macOS" | "Windows";
}

const IOS_UA = (v: string) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v.split("_")[0]}.0 Mobile/15E148 Safari/604.1`;
const IPAD_UA = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = (model: string) =>
  `Mozilla/5.0 (Linux; Android 15; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36`;

export const DEVICES: DevicePreset[] = [
  { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, dpr: 2, mobile: true, touch: true, userAgent: IOS_UA("18_0"), platform: "iOS" },
  { id: "iphone-15", name: "iPhone 15", width: 393, height: 852, dpr: 3, mobile: true, touch: true, userAgent: IOS_UA("18_0"), platform: "iOS" },
  { id: "iphone-15-pro-max", name: "iPhone 15 Pro Max", width: 430, height: 932, dpr: 3, mobile: true, touch: true, userAgent: IOS_UA("18_0"), platform: "iOS" },
  { id: "pixel-8", name: "Pixel 8", width: 412, height: 915, dpr: 2.625, mobile: true, touch: true, userAgent: ANDROID_UA("Pixel 8"), platform: "Android" },
  { id: "galaxy-s24", name: "Galaxy S24", width: 360, height: 780, dpr: 3, mobile: true, touch: true, userAgent: ANDROID_UA("SM-S921B"), platform: "Android" },
  { id: "ipad-mini", name: "iPad Mini", width: 768, height: 1024, dpr: 2, mobile: true, touch: true, userAgent: IPAD_UA, platform: "iOS" },
  { id: "ipad-pro-11", name: "iPad Pro 11", width: 834, height: 1194, dpr: 2, mobile: true, touch: true, userAgent: IPAD_UA, platform: "iOS" },
  { id: "laptop", name: "Laptop 1366", width: 1366, height: 768, dpr: 1, mobile: false, touch: false, userAgent: "", platform: "Windows" },
  { id: "desktop", name: "Desktop 1920", width: 1920, height: 1080, dpr: 1, mobile: false, touch: false, userAgent: "", platform: "macOS" },
];

export function deviceById(id: string): DevicePreset | undefined {
  return DEVICES.find((d) => d.id === id);
}

/** Swap width and height for landscape. */
export function rotate(d: DevicePreset): DevicePreset {
  return { ...d, width: d.height, height: d.width };
}
