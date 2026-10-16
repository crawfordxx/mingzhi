export interface CratePackage {
  name: string;
  version: string;
  license: string | null;
  repository?: string | null;
  manifest_path: string;
}
export interface LicenseFile { file: string; text: string }
export function readLicenseFiles(dir: string): LicenseFile[];
export function renderNotices(packages: CratePackage[], read?: (dir: string) => LicenseFile[]): string;
