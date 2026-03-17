export declare const SEC0_PACKAGE_NAME: "sec0";
export declare const SEC0_RESERVED: true;
export declare const SEC0_RESERVED_MESSAGE: "The sec0 package name is reserved. A fuller public package will be published here later.";

export interface Sec0PackageInfo {
  name: typeof SEC0_PACKAGE_NAME;
  reserved: typeof SEC0_RESERVED;
  message: typeof SEC0_RESERVED_MESSAGE;
}

export declare function getSec0PackageInfo(): Sec0PackageInfo;

declare const sec0: Sec0PackageInfo;

export default sec0;
