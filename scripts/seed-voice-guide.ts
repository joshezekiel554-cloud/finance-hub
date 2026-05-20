import { runVoiceGuideSeed } from "../src/modules/ai-agent/voice-seed.js";

async function main() {
  const { words } = await runVoiceGuideSeed(null);
  console.log(`Voice guide seeded (${words} words). Edit it at /ai-training.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
