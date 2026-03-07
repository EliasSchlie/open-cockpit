const { execSync } = require("child_process");
const path = require("path");

// Ad-hoc sign the app bundle so macOS doesn't reject it as "damaged".
// electron-builder with identity:null skips signing, leaving Electron's
// default signature broken after repackaging.
exports.default = async function (context) {
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  console.log(`Ad-hoc signing: ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });
};
