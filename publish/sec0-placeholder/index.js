"use strict";

const SEC0_PACKAGE_NAME = "sec0";
const SEC0_RESERVED = true;
const SEC0_RESERVED_MESSAGE =
  "The sec0 package name is reserved. A fuller public package will be published here later.";

const packageInfo = Object.freeze({
  name: SEC0_PACKAGE_NAME,
  reserved: SEC0_RESERVED,
  message: SEC0_RESERVED_MESSAGE,
});

function getSec0PackageInfo() {
  return packageInfo;
}

module.exports = {
  ...packageInfo,
  default: packageInfo,
  getSec0PackageInfo,
  SEC0_PACKAGE_NAME,
  SEC0_RESERVED,
  SEC0_RESERVED_MESSAGE,
};
