const REQUIRED = [
  "ORCHESTRATOR_API_KEY",
  "IMAGE_GEN_API_KEY",
  "VISION_API_KEY",
];

const OPTIONAL = [
  "SIMULATION_API_KEY",
];

const missing = REQUIRED.filter((name) => !process.env[name]);
const present = Object.fromEntries(
  [...REQUIRED, ...OPTIONAL].map((name) => [name, Boolean(process.env[name])]),
);

console.log(JSON.stringify({
  ok: missing.length === 0,
  present,
  missing,
}, null, 2));

if (missing.length > 0) process.exit(2);
