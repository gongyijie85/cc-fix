import packageJson from "../package.json";

export const version = packageJson.version;

export const buildMetadata = Object.freeze({
  version,
});
