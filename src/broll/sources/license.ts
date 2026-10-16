export interface LicenseVerdict {
  attributionRequired: boolean;
}

const NO_ATTRIBUTION = /^(cc0( \d+(\.\d+)?)?|public domain|pd( (old( \d+)?|us|usgov|self|ineligible))?|pexels license|pixabay (content )?license)$/;
/** CC BY 版本号必须有，可带地区后缀（如 3.0 de）；含 NC、ND、SA 或多重许可的写法都不匹配 */
const CC_BY = /^cc by \d\.\d( [a-z]{2,3})?$/;

/**
 * 许可白名单：公有领域、CC0、CC BY x.y、Pexels/Pixabay 自有许可；其余（含空、未知、GFDL、BY-SA、NC、ND、多重许可）一律排除。
 * CC BY 必须署名。
 */
export function classifyLicense(shortName: string | undefined): LicenseVerdict | undefined {
  const name = (shortName ?? '').trim().toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ');
  if (NO_ATTRIBUTION.test(name)) return { attributionRequired: false };
  if (CC_BY.test(name)) return { attributionRequired: true };
  return undefined;
}
