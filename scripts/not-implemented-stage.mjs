const [stage] = process.argv.slice(2);

if (!stage) {
  console.error("CC_FIX_STAGE_INVALID: missing stage identifier");
  process.exit(64);
}

console.error(`CC_FIX_STAGE_NOT_IMPLEMENTED: ${stage}`);
process.exit(78);
