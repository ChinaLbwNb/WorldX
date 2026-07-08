import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

const { getImageSize } = await import("../../../generators/map/src/utils/image-utils.mjs");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i++;
  }
  return args;
}

function loadJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : fallback;
}

function toBBox(item) {
  if (!item?.topLeft || !item?.bottomRight) return null;
  return {
    x1: item.topLeft.x,
    y1: item.topLeft.y,
    x2: item.bottomRight.x,
    y2: item.bottomRight.y,
  };
}

function inferVerificationStatus({ logText, metadata, stepKey }) {
  const failurePhrase = "(?:confirmation call failed|confirmation unavailable)";
  const failurePattern = stepKey === "step3"
    ? new RegExp(`\\[Step 3\\].*${failurePhrase}`, "i")
    : new RegExp(`\\[Step 3\\.2\\].*${failurePhrase}`, "i");
  if (failurePattern.test(logText)) return "verifier_unavailable";

  const step = metadata?.steps?.[stepKey];
  if (!step) return "unknown";
  if (step.verificationStatus === "verifier_unavailable" || step.verifierUnavailable === true) {
    return "verifier_unavailable";
  }
  if (step.verificationStatus) return step.verificationStatus;
  if (step.reviewPassed === true) return "verified_pass";
  if (step.reviewPassed === false) return "verified_fail";
  return "unknown";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.run || !args["world-design"] || !args.out) {
    throw new Error("Usage: node gog-verified.mjs --run map-run-dir --world-design world-design.json --out predictions.json [--log map-pipeline.log] [--map-id P01]");
  }

  const runDir = resolve(args.run);
  const worldDesign = loadJson(resolve(args["world-design"]), {});
  const regions = loadJson(join(runDir, "03-regions.json"), []);
  const elements = loadJson(join(runDir, "03-elements.json"), []);
  const metadata = loadJson(join(runDir, "metadata.json"), {});
  const compressedMapPath = join(runDir, "02-compressed-map.png");
  if (!existsSync(compressedMapPath)) throw new Error(`Missing compressed map: ${compressedMapPath}`);

  const logText = args.log && existsSync(resolve(args.log))
    ? readFileSync(resolve(args.log), "utf-8")
    : "";
  const regionStatus = inferVerificationStatus({ logText, metadata, stepKey: "step3" });
  const elementStatus = inferVerificationStatus({ logText, metadata, stepKey: "step3_2" });

  const locatedById = new Map(
    [...regions, ...elements].map((item) => [String(item.id), item]),
  );
  const allTargets = [
    ...(worldDesign.regions || []).map((item) => ({ ...item, type: "region" })),
    ...(worldDesign.interactiveElements || []).map((item) => ({ ...item, type: "element" })),
  ];
  const targets = allTargets.map((target) => {
    const located = locatedById.get(String(target.id));
    const bbox = toBBox(located);
    return {
      id: target.id,
      type: target.type,
      status: bbox ? "located" : "missing",
      bbox,
      verificationStatus: target.type === "region" ? regionStatus : elementStatus,
    };
  });

  const imageBuffer = readFileSync(compressedMapPath);
  const { width, height } = await getImageSize(imageBuffer);
  const output = {
    schemaVersion: "1.0",
    method: "GOG-V",
    stage: "final_post_verification",
    mapId: args["map-id"] || null,
    image: compressedMapPath,
    imageWidth: width,
    imageHeight: height,
    verification: {
      regions: regionStatus,
      elements: elementStatus,
      auditLogProvided: Boolean(args.log),
      note: "verifier_unavailable overrides reviewPassed when logs or metadata record a confirmation outage; unavailable verification is never counted as a pass."
    },
    targets,
  };

  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(resolve(args.out), JSON.stringify(output, null, 2));
  console.log(`[GOG-V] wrote ${targets.length} predictions to ${resolve(args.out)}`);
}

main().catch((error) => {
  console.error(`[GOG-V] ${error.stack || error.message}`);
  process.exit(1);
});
